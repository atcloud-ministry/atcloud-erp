import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import Registration from "../../../src/models/Registration";
import GuestRegistration from "../../../src/models/GuestRegistration";
import { socketService } from "../../../src/services/infrastructure/SocketService";

describe("Guests Manage Token Realtime Emission", () => {
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

    const eventRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Guest Token Realtime Test Event",
        description: "Event for realtime emit tests",
        date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        time: "10:00",
        endTime: "12:00",
        location: "Test Location",
        type: "Effective Communication Workshop",
        format: "In-person",
        purpose: "Validate guest token realtime emits",
        agenda: "1. Intro\n2. Test\n3. Close",
        organizer: "Test Organizer",
        maxParticipants: 50,
        category: "general",
        roles: [
          { name: "Zoom Host", maxParticipants: 3, description: "Attendee" },
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

  const guestPayload = (overrides: Partial<Record<string, any>> = {}) => ({
    roleId,
    fullName: "Realtime Guest",
    gender: "male",
    email: "realtime.token@example.com",
    phone: "+1 555 000 1111",
    notes: "Initial",
    ...overrides,
  });

  async function registerGuest() {
    const res = await request(app)
      .post(`/api/events/${eventId}/guest-signup`)
      .send(guestPayload())
      .expect(201);
    const token = res.body?.data?.manageToken as string;
    expect(token).toBeTruthy();
    return token;
  }

  it("emits guest_updated via socket when updating by token", async () => {
    const token = await registerGuest();
    const emitSpy = vi
      .spyOn(socketService, "emitEventUpdate")
      .mockImplementation(() => {});

    const updatedName = "Realtime Token Updated";
    await request(app)
      .put(`/api/guest/manage/${token}`)
      .send({ fullName: updatedName, notes: "updated" })
      .expect(200);

    const call = emitSpy.mock.calls.find(
      ([eid, type]) =>
        String(eid) === String(eventId) && type === "guest_updated"
    );
    expect(call, "expected a guest_updated emit for this event").toBeTruthy();

    const [eid, type, payload] = call!;
    expect(String(eid)).toBe(String(eventId));
    expect(type).toBe("guest_updated");
    expect(payload).toEqual(
      expect.objectContaining({ roleId, guestName: updatedName })
    );

    emitSpy.mockRestore();
  });
});
