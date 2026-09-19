import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";

// Socket service mock - MUST be before app import
vi.mock("../../../src/services/infrastructure/SocketService", () => ({
  socketService: {
    emitBellNotificationUpdate: vi.fn(),
    emitSystemMessageUpdate: vi.fn(),
    emitUnreadCountUpdate: vi.fn(),
  },
}));

import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import Registration from "../../../src/models/Registration";
import GuestRegistration from "../../../src/models/GuestRegistration";
import { EmailService } from "../../../src/services/infrastructure/EmailServiceFacade";

describe("Guests Admin Resend Manage Link API", () => {
  let adminToken: string;
  let participantToken: string;
  let eventId: string;
  let roleId: string;
  const roleName = "Zoom Host"; // valid role for "Effective Communication Workshop"

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
    const adminLogin = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: adminData.email, password: adminData.password });
    adminToken = adminLogin.body.data.accessToken;

    // Participant user
    const userData = {
      ...TEST_REGISTRATION_PROFILE,
      username: "parti",
      email: "parti@example.com",
      password: "PartiPass123!",
      confirmPassword: "PartiPass123!",
      firstName: "Parti",
      lastName: "User",
      role: "Participant",
      gender: "female",
      isAtCloudLeader: false,
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
    };
    await request(app).post("/api/auth/register").send(userData);
    await User.findOneAndUpdate(
      { email: userData.email },
      { isVerified: true, role: "Participant" }
    );
    const userLogin = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: userData.email, password: userData.password });
    participantToken = userLogin.body.data.accessToken;

    // Create an event with one role
    const eventRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Resend Manage Link Test Event",
        description: "Event for admin re-send manage link tests",
        date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        time: "10:00",
        endTime: "12:00",
        location: "Test Location",
        type: "Effective Communication Workshop",
        format: "In-person",
        purpose: "Validate resend manage link endpoint",
        agenda: "1. Intro\n2. Resend Flow\n3. Close",
        organizer: "Test Organizer",
        maxParticipants: 20,
        category: "general",
        roles: [
          {
            name: roleName,
            maxParticipants: 3,
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
    expect(eventId).toBeTruthy();
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

  async function registerGuest() {
    const res = await request(app)
      .post(`/api/events/${eventId}/guest-signup`)
      .send({
        roleId,
        fullName: "Guest One",
        gender: "male",
        email: "guest.resend@example.com",
        phone: "+1 555 000 0000",
        notes: "",
      })
      .expect(201);
    const id = res.body?.data?.registrationId as string;
    expect(id).toBeTruthy();
    return id;
  }

  it("regenerates token and sends email for admin (200)", async () => {
    const regId = await registerGuest();
    const before = await GuestRegistration.findById(regId).lean();
    expect(before?.manageToken).toBeTruthy();
    const beforeToken = String(before?.manageToken);
    const beforeExp = new Date(before?.manageTokenExpires as any).getTime();

    await request(app)
      .post(`/api/guest-registrations/${regId}/resend-manage-link`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200)
      .expect((r) => {
        expect(r.body).toMatchObject({ success: true });
      });

    const after = await GuestRegistration.findById(regId).lean();
    expect(after?.manageToken).toBeTruthy();
    const afterToken = String(after?.manageToken);
    const afterExp = new Date(after?.manageTokenExpires as any).getTime();

    expect(afterToken).not.toBe(beforeToken);
    expect(afterExp).toBeGreaterThanOrEqual(beforeExp);
  });

  it("returns 400 when registration is cancelled", async () => {
    const regId = await registerGuest();
    await GuestRegistration.updateOne(
      { _id: regId },
      { $set: { status: "cancelled" } }
    );
    const res = await request(app)
      .post(`/api/guest-registrations/${regId}/resend-manage-link`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(400);
    expect(String(res.body?.message || "").toLowerCase()).toContain(
      "cancelled"
    );
  });

  it("returns 404 for non-existent id", async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    await request(app)
      .post(`/api/guest-registrations/${fakeId}/resend-manage-link`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(404);
  });

  it("requires auth (401) and admin role (403)", async () => {
    const regId = await registerGuest();
    // 401 no token
    await request(app)
      .post(`/api/guest-registrations/${regId}/resend-manage-link`)
      .expect(401);

    // 403 participant
    await request(app)
      .post(`/api/guest-registrations/${regId}/resend-manage-link`)
      .set("Authorization", `Bearer ${participantToken}`)
      .expect(403);
  });

  it("does not fail when email sending fails (still 200)", async () => {
    const regId = await registerGuest();
    const spy = vi
      .spyOn(EmailService, "sendGuestConfirmationEmail")
      .mockRejectedValue(new Error("SMTP failure"));

    try {
      await request(app)
        .post(`/api/guest-registrations/${regId}/resend-manage-link`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200)
        .expect((r) => expect(r.body?.success).toBe(true));

      // Token should still be regenerated even if email fails
      const after = await GuestRegistration.findById(regId).lean();
      expect(after?.manageToken).toBeTruthy();
    } finally {
      // Always restore spy, even if test fails
      spy.mockRestore();
    }
  });
});
