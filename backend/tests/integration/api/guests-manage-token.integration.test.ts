import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import Registration from "../../../src/models/Registration";
import GuestRegistration from "../../../src/models/GuestRegistration";

describe("Guests Manage Token API Integration", () => {
  let adminToken: string;
  let eventId: string;
  let roleId: string;
  const roleName = "Zoom Host";

  beforeEach(async () => {
    await Promise.all([
      User.deleteMany({}),
      Event.deleteMany({}),
      Registration.deleteMany({}),
      GuestRegistration.deleteMany({}),
    ]);

    // Admin user
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
    };

    await request(app).post("/api/auth/register").send(adminData);
    await User.findOneAndUpdate(
      { email: adminData.email },
      { isVerified: true, role: "Administrator" }
    );
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: adminData.email, password: adminData.password });
    adminToken = loginRes.body.data.accessToken;

    // Event with one role
    const eventRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Guest Token Test Event",
        description: "Event for token self-service tests",
        date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        time: "10:00",
        endTime: "12:00",
        location: "Test Location",
        type: "Effective Communication Workshop",
        format: "In-person",
        purpose: "Validate guest token endpoints",
        agenda: "1. Intro\n2. Test\n3. Close",
        organizer: "Test Organizer",
        maxParticipants: 50,
        category: "general",
        roles: [
          { name: roleName, maxParticipants: 3, description: "Attendee" },
        ],
      })
      .expect(201);

    const createdEvent = eventRes.body.data.event;
    eventId = createdEvent.id || createdEvent._id;
    roleId = (createdEvent.roles || []).find(
      (r: any) => r.name === roleName
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

  const payload = (overrides: Partial<Record<string, any>> = {}) => ({
    roleId,
    fullName: "John Doe",
    gender: "male",
    email: "john.token@example.com",
    phone: "+1 555 123 4567",
    notes: "Hello",
    ...overrides,
  });

  async function registerGuest() {
    const res = await request(app)
      .post(`/api/events/${eventId}/guest-signup`)
      .send(payload())
      .expect(201);
    const token = res.body?.data?.manageToken as string;
    expect(token, "manageToken should be in response").toBeTruthy();
    return token;
  }

  it("should fetch, update, and cancel via valid token", async () => {
    const token = await registerGuest();

    // GET
    const getRes = await request(app)
      .get(`/api/guest/manage/${token}`)
      .expect(200);
    expect(getRes.body).toMatchObject({ success: true });
    const guestId =
      getRes.body?.data?.guest?._id || getRes.body?.data?.guest?.id;
    expect(guestId).toBeTruthy();

    // PUT
    const updatedName = "Johnny Token";
    const putRes = await request(app)
      .put(`/api/guest/manage/${token}`)
      .send({ fullName: updatedName, notes: "Updated" })
      .expect(200);
    expect(putRes.body).toMatchObject({ success: true });
    expect(
      (putRes.body?.data?.fullName || putRes.body?.data?.guest?.fullName) ?? ""
    ).toContain("Johnny");
    // Token rotates on successful update
    const rotatedToken = putRes.body?.data?.manageToken || token;

    // DELETE first time
    const delRes = await request(app)
      .delete(`/api/guest/manage/${rotatedToken}`)
      .send({ reason: "Change of plans" })
      .expect(200);
    expect(delRes.body).toMatchObject({ success: true });

    // After cancellation, GET should 404 (helper excludes cancelled)
    await request(app).get(`/api/guest/manage/${rotatedToken}`).expect(404);

    // Second DELETE after cancel should 404 because token is invalidated immediately
    const delAgain = await request(app)
      .delete(`/api/guest/manage/${rotatedToken}`)
      .expect(404);
    expect(String(delAgain.body?.message || "").toLowerCase()).toContain(
      "invalid or expired"
    );
  });

  it("should return 404 for invalid token", async () => {
    await registerGuest();
    await request(app).get(`/api/guest/manage/invalid-token`).expect(404);
    await request(app)
      .put(`/api/guest/manage/invalid-token`)
      .send({ fullName: "X" })
      .expect(404);
    await request(app).delete(`/api/guest/manage/invalid-token`).expect(404);
  });

  it("should return 404 for expired token", async () => {
    const token = await registerGuest();

    // Expire token by moving expiry into the past
    await GuestRegistration.updateOne(
      { email: payload().email.toLowerCase() },
      { $set: { manageTokenExpires: new Date(Date.now() - 60_000) } }
    );

    await request(app).get(`/api/guest/manage/${token}`).expect(404);
    await request(app)
      .put(`/api/guest/manage/${token}`)
      .send({ fullName: "Late" })
      .expect(404);
    await request(app).delete(`/api/guest/manage/${token}`).expect(404);
  });
});
