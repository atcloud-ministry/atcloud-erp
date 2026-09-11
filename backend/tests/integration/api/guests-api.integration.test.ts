import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
/**
 * Guests API Integration Tests
 *
 * Covers guest registration happy path and key edges:
 * - Success signup
 * - Duplicate email prevention per event
 * - Capacity-full enforcement (users + guests)
 * - Event/role not found handling
 * - Guest listing endpoint for an event
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import Registration from "../../../src/models/Registration";
import GuestRegistration from "../../../src/models/GuestRegistration";

describe("Guests API Integration", () => {
  let adminToken: string;
  let eventId: string;
  let roleId: string;
  const roleName = "Zoom Host"; // valid template role for Effective Communication Workshop (capacity 1)

  beforeEach(async () => {
    // Clean all relevant collections with proper ordering to avoid race conditions
    await GuestRegistration.deleteMany({});
    await Registration.deleteMany({});
    await Event.deleteMany({});
    await User.deleteMany({});

    // Create admin user and login
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
    };

    await request(app).post("/api/auth/register").send(adminData);
    // Verify and set role to Administrator explicitly
    await User.findOneAndUpdate(
      { email: adminData.email },
      { isVerified: true, role: "Administrator" }
    );

    const loginRes = await request(app).post("/api/auth/login").send({
      emailOrUsername: adminData.email,
      password: adminData.password,
    });
    adminToken = loginRes.body.data.accessToken;

    // Create an event with a single valid template role capacity=1 for capacity tests
    const eventRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Guest Test Event",
        description: "Event for guest integration tests",
        date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        time: "13:00", // avoid conflict with the 10:00-12:00 event created in beforeEach
        endTime: "14:00",
        location: "Test Location",
        type: "Effective Communication Workshop",
        format: "In-person",
        purpose: "Validate guest endpoints",
        agenda: "1. Intro\n2. Test\n3. Close",
        organizer: "Test Organizer",
        maxParticipants: 50,
        category: "general",
        roles: [
          {
            name: roleName,
            maxParticipants: 1,
            description: "Guest attendee",
          },
        ],
      })
      .expect(201);

    const createdEvent = eventRes.body.data.event;
    eventId = createdEvent.id || createdEvent._id;
    roleId = (createdEvent.roles || []).find(
      (r: any) => r.name === roleName
    )?.id;
    expect(
      roleId,
      "roleId should be captured from created event roles"
    ).toBeTruthy();
  });

  afterEach(async () => {
    // Clean in reverse dependency order
    await GuestRegistration.deleteMany({});
    await Registration.deleteMany({});
    await Event.deleteMany({});
    await User.deleteMany({});
  });

  const makeGuestPayload = (overrides: Partial<Record<string, any>> = {}) => ({
    roleId,
    fullName: "John Doe",
    gender: "male",
    email: "john.doe@example.com",
    phone: "+1 555 123 4567",
    notes: "Looking forward",
    ...overrides,
  });

  it("should register a guest successfully (201)", async () => {
    const res = await request(app)
      .post(`/api/events/${eventId}/guest-signup`)
      .send(makeGuestPayload())
      .expect(201);

    expect(res.body).toMatchObject({
      success: true,
      message: expect.stringContaining("successful"),
      data: {
        eventTitle: "Guest Test Event",
        roleName: roleName,
        confirmationEmailSent: true,
      },
    });

    // Verify persisted
    const count = await GuestRegistration.countDocuments({ eventId });
    expect(count).toBe(1);
  });

  it("should prevent duplicate guest registration by email for the same event (400)", async () => {
    // Create a dedicated event with role capacity=2 so uniqueness check is the failing branch (not capacity)
    const dupEventRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Guest Duplicate Test Event",
        description: "Event for duplicate guest test",
        date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        time: "10:00",
        endTime: "12:00",
        location: "Test Location",
        type: "Effective Communication Workshop",
        format: "In-person",
        purpose: "Validate duplicate guest prevention",
        agenda: "1. Intro\n2. Test\n3. Close",
        organizer: "Test Organizer",
        maxParticipants: 50,
        category: "general",
        roles: [
          {
            name: roleName,
            maxParticipants: 2,
            description: "Guest attendee",
          },
        ],
      })
      .expect(201);

    const dupEvent = dupEventRes.body.data.event;
    const dupEventId = dupEvent.id || dupEvent._id;
    const dupRoleId = (dupEvent.roles || []).find(
      (r: any) => r.name === roleName
    )?.id;
    expect(
      dupRoleId,
      "dupRoleId should be captured from created event roles"
    ).toBeTruthy();

    await request(app)
      .post(`/api/events/${dupEventId}/guest-signup`)
      .send(makeGuestPayload({ roleId: dupRoleId }))
      .expect(201);

    const res = await request(app)
      .post(`/api/events/${dupEventId}/guest-signup`)
      .send(makeGuestPayload({ roleId: dupRoleId }))
      .expect(400);

    // With DB-level uniqueness, duplicates should yield a clear message
    expect(res.body).toMatchObject({ success: false });
    const msg = String(res.body?.message || "").toLowerCase();
    expect(msg).toContain("already registered");
  });

  it("should enforce role capacity across guests+users (400 when full)", async () => {
    // First guest takes the only slot
    await request(app)
      .post(`/api/events/${eventId}/guest-signup`)
      .send(makeGuestPayload())
      .expect(201);

    // Second different guest should hit capacity full
    const res = await request(app)
      .post(`/api/events/${eventId}/guest-signup`)
      .send(
        makeGuestPayload({
          fullName: "Jane Roe",
          email: "jane.roe@example.com",
          phone: "+1 555 987 6543",
        })
      )
      .expect(400);

    expect(res.body).toMatchObject({
      success: false,
      message: expect.stringContaining("full capacity"),
    });
  });

  it("should return 404 for non-existent roleId", async () => {
    const res = await request(app)
      .post(`/api/events/${eventId}/guest-signup`)
      .send(makeGuestPayload({ roleId: "missing-role" }))
      .expect(404);

    expect(res.body).toMatchObject({
      success: false,
      message: expect.stringContaining("role not found"),
    });
  });

  it("should return 404 for non-existent eventId", async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    const res = await request(app)
      .post(`/api/events/${fakeId}/guest-signup`)
      .send(makeGuestPayload())
      .expect(404);

    expect(res.body).toMatchObject({
      success: false,
      message: expect.stringContaining("Event not found"),
    });
  });

  it("should list event guests with count", async () => {
    await request(app)
      .post(`/api/events/${eventId}/guest-signup`)
      .send(makeGuestPayload())
      .expect(201);

    const res = await request(app)
      .get(`/api/events/${eventId}/guests`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body).toMatchObject({ success: true, data: { count: 1 } });
    expect(Array.isArray(res.body.data.guests)).toBe(true);
    expect(res.body.data.guests[0]).toMatchObject({
      eventId: expect.any(String),
      roleId,
      fullName: "John Doe",
      email: "john.doe@example.com",
      status: "active",
    });
  });
});
