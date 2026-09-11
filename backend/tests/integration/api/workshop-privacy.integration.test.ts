import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";

describe("Workshop contact visibility - simplified public access", () => {
  let adminToken: string;
  let leaderAToken: string;
  let leaderBToken: string;
  let participantAToken: string;
  let eventId: string;
  let roleIds: Record<string, string>;

  beforeEach(async () => {
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

    // Group B Leader
    await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      username: "leadB",
      email: "leadb@example.com",
      password: "Pass123!@#",
      confirmPassword: "Pass123!@#",
      firstName: "Lead",
      lastName: "B",
      role: "Participant",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
      phone: "+12065550222",
    });
    await User.findOneAndUpdate(
      { email: "leadb@example.com" },
      { isVerified: true }
    );
    leaderBToken = (
      await request(app)
        .post("/api/auth/login")
        .send({ emailOrUsername: "leadb@example.com", password: "Pass123!@#" })
    ).body.data.accessToken;

    // Group A Participant
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

    // Create workshop event
    const createRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "WS Privacy",
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

    eventId = createRes.body.data.event.id;
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

    // Signups: leadA -> Group A Leader, leadB -> Group B Leader, partA -> Group A Participants
    await request(app)
      .post(`/api/events/${eventId}/signup`)
      .set("Authorization", `Bearer ${leaderAToken}`)
      .send({ roleId: roleIds.gaL })
      .expect(200);
    await request(app)
      .post(`/api/events/${eventId}/signup`)
      .set("Authorization", `Bearer ${leaderBToken}`)
      .send({ roleId: roleIds.gbL })
      .expect(200);
    await request(app)
      .post(`/api/events/${eventId}/signup`)
      .set("Authorization", `Bearer ${participantAToken}`)
      .send({ roleId: roleIds.gaP })
      .expect(200);
  });

  afterEach(async () => {
    await User.deleteMany({});
    await Event.deleteMany({});
  });

  it("keeps registered-user email visibility while limiting exact phones to self", async () => {
    // Viewer: Group A Participant retains existing email visibility.
    const resAView = await request(app)
      .get(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${participantAToken}`)
      .expect(200);
    const eventAView = resAView.body.data.event;
    const gaLeaderRole = eventAView.roles.find(
      (r: any) => r.name === "Group A Leader"
    );
    const gbLeaderRole = eventAView.roles.find(
      (r: any) => r.name === "Group B Leader"
    );
    const gaLeaderUser = gaLeaderRole.registrations[0].user;
    const gbLeaderUser = gbLeaderRole.registrations[0].user;

    // Exact phone values belong only to their account owners or user managers.
    expect(gaLeaderUser.email).toBe("leada@example.com");
    expect(gaLeaderUser.phone).toBeUndefined();
    expect(gbLeaderUser.email).toBe("leadb@example.com");
    expect(gbLeaderUser.phone).toBeUndefined();

    // Viewer: Group B Leader sees their own phone, not another user's.
    const resBView = await request(app)
      .get(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${leaderBToken}`)
      .expect(200);
    const eventBView = resBView.body.data.event;
    const gaLeaderUser2 = eventBView.roles.find(
      (r: any) => r.name === "Group A Leader"
    ).registrations[0].user;
    const gbLeaderUser2 = eventBView.roles.find(
      (r: any) => r.name === "Group B Leader"
    ).registrations[0].user;

    expect(gbLeaderUser2.email).toBe("leadb@example.com");
    expect(gbLeaderUser2.phone).toBe("+12065550222");
    expect(gaLeaderUser2.email).toBe("leada@example.com");
    expect(gaLeaderUser2.phone).toBeUndefined();
  });

  it("always shows viewer's own email/phone on their card", async () => {
    const resSelf = await request(app)
      .get(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${leaderAToken}`)
      .expect(200);
    const eventSelf = resSelf.body.data.event;
    const selfUser = eventSelf.roles.find(
      (r: any) => r.name === "Group A Leader"
    ).registrations[0].user;
    expect(selfUser.email).toBe("leada@example.com");
    expect(selfUser.phone).toBe("+12065550111");
  });

  it("shows exact participant phones to a MANAGE_USERS viewer", async () => {
    const response = await request(app)
      .get(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    const phones = response.body.data.event.roles
      .flatMap((role: any) => role.registrations)
      .map((registration: any) => registration.user.phone)
      .filter(Boolean);
    expect(phones).toEqual(
      expect.arrayContaining([
        "+12065550111",
        "+12065550222",
        "+12065550333",
      ]),
    );
  });

  it("multi-group registration does not broaden exact-phone visibility", async () => {
    // Register Group A Leader in Group B Participants as well (multiple groups)
    await request(app)
      .post(`/api/events/${eventId}/signup`)
      .set("Authorization", `Bearer ${leaderAToken}`)
      .send({ roleId: roleIds.gbP })
      .expect(200);

    // Viewer: Group A Leader (also in Group B) retains broad email visibility.
    const resMultiGroup = await request(app)
      .get(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${leaderAToken}`)
      .expect(200);

    const eventMultiGroupView = resMultiGroup.body.data.event;

    // Should see Group A Leader contact (self)
    const gaLeaderRole = eventMultiGroupView.roles.find(
      (r: any) => r.name === "Group A Leader"
    );
    const gaLeaderUser = gaLeaderRole.registrations[0].user;
    expect(gaLeaderUser.email).toBe("leada@example.com");
    expect(gaLeaderUser.phone).toBe("+12065550111");

    // Should see Group A Participant contact
    const gaParticipantRole = eventMultiGroupView.roles.find(
      (r: any) => r.name === "Group A Participants"
    );
    const gaParticipantUser = gaParticipantRole.registrations[0].user;
    expect(gaParticipantUser.email).toBe("parta@example.com");
    expect(gaParticipantUser.phone).toBeUndefined();

    // Group membership does not grant another account's exact phone.
    const gbLeaderRole = eventMultiGroupView.roles.find(
      (r: any) => r.name === "Group B Leader"
    );
    const gbLeaderUser = gbLeaderRole.registrations[0].user;
    expect(gbLeaderUser.email).toBe("leadb@example.com");
    expect(gbLeaderUser.phone).toBeUndefined();
  });
});
