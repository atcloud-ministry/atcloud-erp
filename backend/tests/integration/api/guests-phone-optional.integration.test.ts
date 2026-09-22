import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import Registration from "../../../src/models/Registration";
import GuestRegistration from "../../../src/models/GuestRegistration";
import mongoose from "mongoose";
import { ensureIntegrationDB } from "../setup/connect";

// Enable verbose validation diagnostics for this spec (helps when event creation fails)
process.env.TEST_VALIDATION_LOG = "1";

describe("Guests API - phone optional on signup", () => {
  let adminToken: string;
  let eventId: string;
  let roleId: string;

  beforeAll(async () => {
    await ensureIntegrationDB();
  });

  afterAll(async () => {
    // Connection is shared, don't close it
  });

  beforeEach(async () => {
    await Promise.all([
      User.deleteMany({}),
      Event.deleteMany({}),
      Registration.deleteMany({}),
      GuestRegistration.deleteMany({}),
    ]);

    const adminData = {
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
      registrationNoticeVersion: "registration-privacy-v1",
    } as const;

    await request(app).post("/api/auth/register").send(adminData);
    await User.findOneAndUpdate(
      { email: adminData.email },
      { isVerified: true, role: "Administrator" }
    );
    const loginRes = await request(app).post("/api/auth/login").send({
      emailOrUsername: adminData.email,
      password: adminData.password,
    });
    adminToken = loginRes.body.data.accessToken;

    const eventRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Phone Optional Guest Event",
        description: "Event for guest phone optional test",
        date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        time: "15:00",
        endTime: "16:00",
        location: "Test Location",
        type: "Effective Communication Workshop",
        format: "In-person",
        purpose: "Validate optional phone",
        agenda:
          "Intro, main content, discussion, Q&A, and closing remarks for testing.",
        organizer: "Tester",
        maxParticipants: 50,
        category: "general",
        roles: [
          {
            name: "Zoom Host",
            maxParticipants: 2,
            description: "Guest attendee",
          },
        ],
      })
      .expect(201);

    const createdEvent = eventRes.body.data.event;
    eventId = createdEvent.id || createdEvent._id;
    roleId = (createdEvent.roles || []).find(
      (r: any) => r.name === "Zoom Host"
    )?.id;
    expect(roleId).toBeTruthy();
  });

  // Removed aggressive afterEach cleanup to reduce connection churn / ECONNRESET risk in CI.

  it("accepts signup without phone and persists", async () => {
    const res = await request(app)
      .post(`/api/events/${eventId}/guest-signup`)
      .send({
        roleId,
        fullName: "Jane Doe",
        gender: "female",
        email: "jane.doe@example.com",
        // no phone provided
        notes: "optional",
      })
      .expect(201);

    expect(res.body?.success).toBe(true);
    const docs = await GuestRegistration.find({
      eventId,
      email: "jane.doe@example.com",
    }).lean();
    expect(docs.length).toBe(1);
    expect(docs[0].phone === undefined || docs[0].phone === "").toBe(true);
  });
});
