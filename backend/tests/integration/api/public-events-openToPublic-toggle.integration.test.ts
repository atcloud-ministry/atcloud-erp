import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import request from "supertest";
import { describe, it, beforeEach, expect } from "vitest";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";

/**
 * Integration tests focusing on toggling openToPublic false -> true for existing role.
 */

describe("Public Events API - openToPublic toggle", () => {
  let adminToken: string;
  let eventId: string;
  let roleId: string;

  beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Event.deleteMany({})]);

    const adminData = {
      ...TEST_REGISTRATION_PROFILE,
      username: "toggleadmin",
      email: "toggleadmin@example.com",
      password: "AdminPass123!",
      confirmPassword: "AdminPass123!",
      firstName: "Toggle",
      lastName: "Admin",
      role: "Administrator",
      gender: "female",
      isAtCloudLeader: false,
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
    } as const;
    await request(app).post("/api/auth/register").send(adminData);
    await User.findOneAndUpdate(
      { email: adminData.email },
      { isVerified: true, role: "Administrator" }
    );
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: adminData.email, password: adminData.password });
    adminToken = loginRes.body.data.accessToken;

    // Create event with role openToPublic false (omitted means false)
    const createRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Toggle Event",
        type: "Webinar",
        date: "2099-01-01",
        endDate: "2099-01-01",
        time: "09:00",
        endTime: "10:00",
        location: "Online",
        format: "Online",
        organizer: "Org",
        roles: [
          { name: "Participant", description: "Role", maxParticipants: 5 },
        ],
        purpose:
          "Toggle test purpose that is long enough to satisfy validation requirements for event creation.",
        zoomLink: "https://example.com/zoom/toggle",
        meetingId: "TOGGLE123",
        passcode: "toggle",
        timeZone: "America/Los_Angeles",
        suppressNotifications: true,
      });
    expect(createRes.status).toBe(201);
    const ev = createRes.body.data?.event || createRes.body.data;
    eventId = ev.id || ev._id;
    roleId = ev.roles[0].id;
    expect(ev.roles[0].openToPublic || false).toBe(false);
  });

  it("updates openToPublic to true when explicitly set boolean true", async () => {
    const updateRes = await request(app)
      .put(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        roles: [
          {
            id: roleId,
            name: "Participant",
            description: "Role",
            maxParticipants: 5,
            openToPublic: true,
          },
        ],
        suppressNotifications: true,
      });
    expect(updateRes.status).toBe(200);
    const updatedRole = updateRes.body.data.event.roles[0];
    expect(updatedRole.openToPublic).toBe(true);
  });

  it("updates openToPublic to true when provided as string 'true'", async () => {
    const updateRes = await request(app)
      .put(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        roles: [
          {
            id: roleId,
            name: "Participant",
            description: "Role",
            maxParticipants: 5,
            openToPublic: "true",
          },
        ],
        suppressNotifications: true,
      });
    expect(updateRes.status).toBe(200);
    const updatedRole = updateRes.body.data.event.roles[0];
    expect(updatedRole.openToPublic).toBe(true);
  });
});
