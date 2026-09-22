import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import request from "supertest";
import { assertDbReady } from "../_utils/assertDbReady";
import { describe, it, expect, beforeEach } from "vitest";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";

/**
 * Integration tests for GET /api/public/events/:slug
 * Pattern aligns with other API integration tests:
 *  - Use auth flows to create events (ensures controller validations run)
 *  - Cleanup collections between tests
 */

describe("Public Events API - GET /api/public/events/:slug", () => {
  let adminToken: string;

  beforeEach(async () => {
    assertDbReady();
    await Promise.all([User.deleteMany({}), Event.deleteMany({})]);

    // Register & promote admin
    const adminData = {
      ...TEST_REGISTRATION_PROFILE,
      username: "publicadmin",
      email: "publicadmin@example.com",
      password: "AdminPass123!",
      confirmPassword: "AdminPass123!",
      firstName: "Public",
      lastName: "Admin",
      role: "Administrator",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
    } as const;
    await request(app).post("/api/auth/register").send(adminData);
    await User.findOneAndUpdate(
      { email: adminData.email },
      { isVerified: true, role: "Administrator" },
    );
    const loginRes = await request(app).post("/api/auth/login").send({
      emailOrUsername: adminData.email,
      password: adminData.password,
    });
    adminToken = loginRes.body.data.accessToken;
  });

  it("returns 404 for missing slug", async () => {
    const res = await request(app).get("/api/public/events/non-existent");
    expect(res.status).toBe(404);
  }, 20000);

  it("returns 200 with registrationOpen false for existing but unpublished event", async () => {
    // Create event (unpublished) directly via model (simpler) respecting required fields
    await Event.create({
      title: "Unpublished Event",
      type: "Webinar",
      date: "2025-10-10",
      endDate: "2025-10-10",
      time: "10:00",
      endTime: "11:00",
      location: "Online",
      format: "Online",
      organizer: "Org",
      createdBy: (await User.findOne({ email: "publicadmin@example.com" }))!
        ._id,
      roles: [
        {
          id: "r1",
          name: "Attendee",
          description: "Role",
          maxParticipants: 10,
          openToPublic: true,
        },
      ],
      publish: false,
      publicSlug: "unpub-test",
    });

    const res = await request(app).get("/api/public/events/unpub-test");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.registrationOpen).toBe(false);
  }, 20000);

  it("returns sanitized public payload for published event", async () => {
    await Event.create({
      title: "  Public Event  ",
      type: "Webinar",
      date: "2025-10-11",
      endDate: "2025-10-11",
      time: "09:00",
      endTime: "10:30",
      timeZone: "America/Los_Angeles",
      location: "Online",
      format: "Online",
      organizer: "Org",
      createdBy: (await User.findOne({ email: "publicadmin@example.com" }))!
        ._id,
      purpose: " Purpose with extra   spaces ",
      agenda: " Agenda content ",
      roles: [
        {
          id: "r1",
          name: "Attendee",
          description: "Att role",
          maxParticipants: 25,
          openToPublic: true,
        },
        {
          id: "r2",
          name: "Internal",
          description: "Hidden role",
          maxParticipants: 5,
          openToPublic: false,
        },
      ],
      publish: true,
      publicSlug: "public-event",
    });

    const res = await request(app).get("/api/public/events/public-event");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const data = res.body.data;
    expect(data.title).toBe("Public Event");
    expect(typeof data.id).toBe("string");
    expect(data.id).toMatch(/^[a-f0-9]{24}$/); // Mongo ObjectId string
    expect(data.purpose).toBe("Purpose with extra spaces");
    expect(data.roles.length).toBe(1);
    expect(data.roles[0].roleId).toBe("r1");
    expect(data.roles[0].name).toBe("Attendee");
    expect(data.slug).toBe("public-event");
    expect(data.registrationOpen).toBe(true);
    // The event's local wall time 09:00 is stored with its IANA timeZone (default seeded in model)
    // Serializer now converts to the true UTC instant instead of naively appending 'Z'.
    // Previously this test expected the incorrect naive UTC ("09:00Z"). With a Pacific offset (-07:00)
    // the correct UTC instant is 16:00Z.
    expect(data.start).toMatch(/^2025-10-11T16:00:00\.000Z$/);
    // New raw wall-clock fields exposed for precise client-side formatting
    expect(data.date).toBe("2025-10-11");
    expect(data.time).toBe("09:00");
    expect(["string", "undefined"]).toContain(typeof data.timeZone);
  }, 20000);
});
