import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import Registration from "../../../src/models/Registration";
import GuestRegistration from "../../../src/models/GuestRegistration";

// This spec verifies the legacy admin endpoint also clears phone

describe("Guests API - admin legacy update clears phone", () => {
  let adminToken: string;
  let eventId: string;
  let roleId: string;

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
        title: "Legacy Update Test",
        description: "",
        date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        time: "15:00",
        endTime: "16:00",
        location: "Test Location",
        // Use a valid event type from ALLOWED_EVENT_TYPES
        type: "Effective Communication Workshop",
        format: "Online",
        purpose: "",
        agenda: "Introductions, workshop session, and Q&A",
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

  afterEach(async () => {
    await Promise.all([
      GuestRegistration.deleteMany({}),
      Registration.deleteMany({}),
      Event.deleteMany({}),
      User.deleteMany({}),
    ]);
  });

  it("clears phone via legacy PUT /api/guest-registrations/:id when phone is empty string", async () => {
    // Create guest
    const signupRes = await request(app)
      .post(`/api/events/${eventId}/guest-signup`)
      .send({
        roleId,
        fullName: "Legacy Jane",
        gender: "female",
        email: "legacy.jane@example.com",
        phone: "555-777-8888",
      })
      .expect(201);
    const registrationId = signupRes.body.data.registrationId as string;

    // Legacy admin update clears phone
    await request(app)
      .put(`/api/guest-registrations/${registrationId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ phone: "" })
      .expect(200);

    const doc = await GuestRegistration.findById(registrationId).lean();
    expect(doc).toBeTruthy();
    expect(doc?.phone === undefined || doc?.phone === "").toBe(true);
  });
});
