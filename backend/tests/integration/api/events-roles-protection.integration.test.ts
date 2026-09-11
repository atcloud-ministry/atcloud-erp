import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";

describe("Events API — role deletion/capacity protections", () => {
  let adminToken: string;
  let userToken: string;
  let adminId: string;
  let userId: string;

  beforeEach(async () => {
    await User.deleteMany({});
    await Event.deleteMany({});

    // Admin
    const adminResp = await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      username: "admin",
      email: "admin@example.com",
      password: "AdminPass123!",
      confirmPassword: "AdminPass123!",
      firstName: "Admin",
      lastName: "User",
      role: "Administrator",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
    });
    await User.findOneAndUpdate(
      { email: "admin@example.com" },
      { isVerified: true, role: "Administrator" }
    );
    const adminLogin = await request(app).post("/api/auth/login").send({
      emailOrUsername: "admin@example.com",
      password: "AdminPass123!",
    });
    adminToken = adminLogin.body.data.accessToken;
    adminId = adminResp.body.data.user.id;

    // Regular user
    const userResp = await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      username: "user1",
      email: "user1@example.com",
      password: "UserPass123!",
      confirmPassword: "UserPass123!",
      firstName: "User",
      lastName: "One",
      role: "Participant",
      gender: "female",
      isAtCloudLeader: false,
      acceptTerms: true,
    });
    await User.findOneAndUpdate(
      { email: "user1@example.com" },
      { isVerified: true, role: "Participant" }
    );
    const userLogin = await request(app).post("/api/auth/login").send({
      emailOrUsername: "user1@example.com",
      password: "UserPass123!",
    });
    userToken = userLogin.body.data.accessToken;
    userId = userResp.body.data.user.id;
  });

  afterEach(async () => {
    await User.deleteMany({});
    await Event.deleteMany({});
  });

  it("409 when deleting a role that has registrants", async () => {
    // Create event
    const create = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Protected Roles",
        description: "",
        organizer: "Admin Team",
        agenda:
          "This is a detailed agenda for integration testing that exceeds twenty characters.",
        date: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
        endDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
        time: "10:00",
        endTime: "11:00",
        location: "Online",
        type: "Webinar", // Ensuring the event type is set to Webinar for the test
        format: "Online",
        timeZone: "America/Los_Angeles",
        roles: [
          {
            id: "r1",
            name: "Zoom Master",
            description: "Manages Zoom meeting settings and flow",
            maxParticipants: 1,
          },
          {
            id: "r2",
            name: "Attendee",
            description: "No special role",
            maxParticipants: 5,
          },
        ],
      });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const eventId = create.body.data.event.id as string;
    const createdRoles = create.body.data.event.roles as Array<{
      id: string;
      name: string;
    }>;
    const attendeeRoleId = createdRoles.find((r) => r.name === "Attendee")!.id;
    const zoomMasterRoleId = createdRoles.find(
      (r) => r.name === "Zoom Master"
    )!.id;

    // Register user into r2
    const reg = await request(app)
      .post(`/api/events/${eventId}/register`)
      .set("Authorization", `Bearer ${userToken}`)
      .send({ roleId: attendeeRoleId });
    expect(reg.status, JSON.stringify(reg.body)).toBe(200);

    // Attempt to update removing r2
    const update = await request(app)
      .put(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        roles: [
          {
            id: zoomMasterRoleId,
            name: "Zoom Master",
            description: "Manages Zoom meeting settings and flow",
            maxParticipants: 1,
          },
        ],
      });
    expect(update.status).toBe(409);
    expect(update.body).toMatchObject({
      success: false,
      message: expect.stringContaining("cannot be removed"),
      errors: expect.arrayContaining([
        expect.stringContaining('Cannot delete role "Attendee"'),
      ]),
    });
  });

  it("409 when reducing capacity below current registrations", async () => {
    const create = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Capacity Guard",
        description: "",
        organizer: "Admin Team",
        agenda:
          "This is a detailed agenda for integration testing that exceeds twenty characters.",
        date: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
        endDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
        time: "12:00",
        endTime: "13:00",
        location: "Online",
        type: "Webinar",
        format: "Online",
        timeZone: "America/Los_Angeles",
        roles: [
          {
            id: "ra",
            name: "Attendee",
            description: "No special role",
            maxParticipants: 2,
          },
        ],
      });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const eventId = create.body.data.event.id as string;
    const createdRoles2 = create.body.data.event.roles as Array<{
      id: string;
      name: string;
    }>;
    const attendeeRoleId2 = createdRoles2.find(
      (r) => r.name === "Attendee"
    )!.id;

    // Register user into ra (1st registration)
    const reg = await request(app)
      .post(`/api/events/${eventId}/register`)
      .set("Authorization", `Bearer ${userToken}`)
      .send({ roleId: attendeeRoleId2 });
    expect(reg.status, JSON.stringify(reg.body)).toBe(200);

    // Register admin into ra (2nd registration) to ensure currentCount = 2
    const regAdmin = await request(app)
      .post(`/api/events/${eventId}/register`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ roleId: attendeeRoleId2 });
    expect(regAdmin.status, JSON.stringify(regAdmin.body)).toBe(200);

    // Attempt to reduce capacity below 1
    const update = await request(app)
      .put(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        // Reduce capacity to 1 (valid positive integer) which is below current registrations (2)
        roles: [
          {
            id: attendeeRoleId2,
            name: "Attendee",
            description: "No special role",
            maxParticipants: 1,
          },
        ],
      });
    expect(update.status).toBe(409);
    expect(update.body).toMatchObject({
      success: false,
      message: expect.stringContaining("Capacity cannot be reduced"),
      errors: expect.arrayContaining([
        expect.stringContaining(
          'Cannot reduce capacity for role "Attendee" below 2'
        ),
      ]),
    });
  });
});
