import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import { socketService } from "../../../src/services/infrastructure/SocketService";

// Spy on socket emits to validate payloads without real websockets
let emitSpy: any;

describe("Workshop privacy realtime contact updates", () => {
  let adminToken: string;
  let leaderAToken: string; // Group A leader (will already be in A)
  let participantAToken: string; // Group A participant (viewer)
  let participantBToken: string; // Group B participant (will sign up later)
  let eventId: string;
  let roleIds: Record<string, string>;

  beforeEach(async () => {
    // Ensure a clean slate for spies/mocks, then re-create the spy
    vi.restoreAllMocks();
    emitSpy = vi.spyOn(socketService, "emitEventUpdate");
    await User.deleteMany({});
    await Event.deleteMany({});

    // Admin
    await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      username: "admin",
      email: "admin@example.com",
      password: "Pass123!@#",
      confirmPassword: "Pass123!@#",
      firstName: "Admin",
      lastName: "User",
      role: "Administrator",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
    });
    await User.findOneAndUpdate(
      { email: "admin@example.com" },
      { role: "Administrator", isVerified: true }
    );
    adminToken = (
      await request(app)
        .post("/api/auth/login")
        .send({ emailOrUsername: "admin@example.com", password: "Pass123!@#" })
    ).body.data.accessToken;

    // Group A Leader
    await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      username: "leadA",
      email: "leada@example.com",
      password: "Pass123!@#",
      confirmPassword: "Pass123!@#",
      firstName: "Lead",
      lastName: "A",
      role: "Participant",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
      phone: "+12065550111",
    });
    await User.findOneAndUpdate(
      { email: "leada@example.com" },
      { isVerified: true }
    );
    leaderAToken = (
      await request(app)
        .post("/api/auth/login")
        .send({ emailOrUsername: "leada@example.com", password: "Pass123!@#" })
    ).body.data.accessToken;

    // Group A Participant (viewer for GET and to receive realtime updates visually in UI)
    await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      username: "partA",
      email: "parta@example.com",
      password: "Pass123!@#",
      confirmPassword: "Pass123!@#",
      firstName: "Part",
      lastName: "A",
      role: "Participant",
      gender: "female",
      isAtCloudLeader: false,
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
      phone: "+12065550333",
    });
    await User.findOneAndUpdate(
      { email: "parta@example.com" },
      { isVerified: true }
    );
    participantAToken = (
      await request(app)
        .post("/api/auth/login")
        .send({ emailOrUsername: "parta@example.com", password: "Pass123!@#" })
    ).body.data.accessToken;

    // Group B Participant (will sign up later to trigger realtime update)
    await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      username: "partB",
      email: "partb@example.com",
      password: "Pass123!@#",
      confirmPassword: "Pass123!@#",
      firstName: "Part",
      lastName: "B",
      role: "Participant",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
      phone: "+12065550444",
    });
    await User.findOneAndUpdate(
      { email: "partb@example.com" },
      { isVerified: true }
    );
    participantBToken = (
      await request(app)
        .post("/api/auth/login")
        .send({ emailOrUsername: "partb@example.com", password: "Pass123!@#" })
    ).body.data.accessToken;

    // Create workshop event with A and B groups
    const createRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "WS Realtime",
        description: "desc",
        date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        time: "09:00",
        endTime: "11:00",
        location: "loc",
        type: "Effective Communication Workshop",
        format: "In-person",
        purpose: "Purpose long enough for validation",
        agenda: "Agenda long enough for validation",
        organizer: "org",
        roles: [
          {
            id: "ga-l",
            name: "Group A Leader",
            maxParticipants: 1,
            description: "Leads Group A",
          },
          {
            id: "ga-p",
            name: "Group A Participants",
            maxParticipants: 3,
            description: "Participants in Group A",
          },
          {
            id: "gb-l",
            name: "Group B Leader",
            maxParticipants: 1,
            description: "Leads Group B",
          },
          {
            id: "gb-p",
            name: "Group B Participants",
            maxParticipants: 3,
            description: "Participants in Group B",
          },
        ],
      })
      .expect(201);

    const createdRoles: Array<{ id: string; name: string }> =
      createRes.body.data.event.roles.map((r: any) => ({
        id: r.id,
        name: r.name,
      }));
    const getRoleIdByName = (name: string) =>
      createdRoles.find((r) => r.name === name)!.id;
    roleIds = {
      gaL: getRoleIdByName("Group A Leader"),
      gaP: getRoleIdByName("Group A Participants"),
      gbL: getRoleIdByName("Group B Leader"),
      gbP: getRoleIdByName("Group B Participants"),
    };

    // Initial signups: Leader A to Group A Leader, Participant A to Group A Participants
    await request(app)
      .post(`/api/events/${createRes.body.data.event.id}/signup`)
      .set("Authorization", `Bearer ${leaderAToken}`)
      .send({ roleId: roleIds.gaL })
      .expect(200);
    await request(app)
      .post(`/api/events/${createRes.body.data.event.id}/signup`)
      .set("Authorization", `Bearer ${participantAToken}`)
      .send({ roleId: roleIds.gaP })
      .expect(200);

    // Save for later
    eventId = createRes.body.data.event.id;
  });

  afterEach(async () => {
    await User.deleteMany({});
    await Event.deleteMany({});
    vi.restoreAllMocks();
  });

  it("emits signup update containing viewer-specific contacts (no refresh needed)", async () => {
    // Act: Participant B signs up for Group B Participants (different group)
    const signupRes = await request(app)
      .post(`/api/events/${eventId}/signup`)
      .set("Authorization", `Bearer ${participantBToken}`)
      .send({ roleId: roleIds.gbP })
      .expect(200);

    // Assert: API response to actor contains updatedEvent with actor's viewer context
    const updatedEventForActor = signupRes.body.data.event;
    const actorGbP = updatedEventForActor.roles.find(
      (r: any) => r.name === "Group B Participants"
    );
    const actorGbPFirst = actorGbP.registrations.find(
      (reg: any) => reg.user.email === "partb@example.com"
    ).user;
    expect(actorGbPFirst.email).toBe("partb@example.com");

    // Assert: socket emit called with updated event payload
    expect(emitSpy).toHaveBeenCalled();
    const lastEmit = emitSpy.mock.calls[emitSpy.mock.calls.length - 1];
    expect(lastEmit[0]).toBe(eventId);
    expect(lastEmit[1]).toBe("user_signed_up");
    const payload: any = lastEmit[2];
    expect(payload.event).toBeTruthy();
    expect(Array.isArray(payload.event.roles)).toBe(true);
  });
});
