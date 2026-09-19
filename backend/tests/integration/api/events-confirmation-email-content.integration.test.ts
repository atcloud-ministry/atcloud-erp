import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import request from "supertest";
import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import { EmailService } from "../../../src/services/infrastructure/EmailServiceFacade";

async function createAdminAndLogin(seed: string) {
  const admin = {
    ...TEST_REGISTRATION_PROFILE,
    username: `confemailadmin${seed}`,
    email: `confemailadmin${seed}@example.com`,
    password: "AdminPass123!",
    confirmPassword: "AdminPass123!",
    firstName: "ConfFmt",
    lastName: "Admin",
    role: "Administrator",
    gender: "male",
    isAtCloudLeader: false,
    acceptTerms: true,
    registrationNoticeVersion: "registration-privacy-v1",
  } as const;
  await request(app).post("/api/auth/register").send(admin);
  await User.findOneAndUpdate(
    { email: admin.email },
    { isVerified: true, role: "Administrator" },
  );
  const login = await request(app)
    .post("/api/auth/login")
    .send({ emailOrUsername: admin.email, password: admin.password });
  return login.body.data.accessToken as string;
}

async function createAndPublish(
  token: string,
  payload: Record<string, unknown>,
): Promise<{ eventId: string; roleId: string }> {
  const create = await request(app)
    .post("/api/events")
    .set("Authorization", `Bearer ${token}`)
    .send(payload);
  expect(create.status).toBe(201);
  const eventId: string = create.body.data.event.id;
  // Open the first role to public (some flows require this for publish eligibility)
  await Event.findByIdAndUpdate(eventId, {
    $set: { "roles.0.openToPublic": true },
  });
  const pub = await request(app)
    .post(`/api/events/${eventId}/publish`)
    .set("Authorization", `Bearer ${token}`)
    .send();
  expect(pub.status).toBe(200);
  const fresh = await Event.findById(eventId); // not lean: retain mongoose getters
  const firstRole: any = fresh?.roles?.[0];
  const roleId = firstRole?._id?.toString?.() || firstRole?.id;
  expect(roleId, "Expected first role id present after publish").toBeTruthy();
  return { eventId, roleId };
}

interface GuestConfirmationPayload {
  guestEmail: string;
  guestName: string;
  event: {
    title: string;
    date: unknown;
    location?: string;
    time?: string;
    endTime?: string;
    endDate?: unknown;
    timeZone?: string;
    format?: string;
    zoomLink?: string;
    meetingId?: string;
    passcode?: string;
  };
  role: { name: string; description?: string };
  registrationId: string;
  manageToken?: string;
}

describe("Guest confirmation email content varies by format", () => {
  let openedLocal = false;
  const spy = vi.spyOn(
    EmailService as unknown as { sendGuestConfirmationEmail: any },
    "sendGuestConfirmationEmail",
  );

  beforeAll(async () => {
    // Only connect if completely disconnected (defensive); many suites share the same connection.
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(
        process.env.MONGODB_TEST_URI ||
          "mongodb://127.0.0.1:27017/atcloud-signup-test",
      );
      openedLocal = true;
    }
    await Promise.all([User.deleteMany({}), Event.deleteMany({})]);
  });

  afterAll(async () => {
    spy.mockRestore();
    // Intentionally do NOT close the connection; global teardown handles it. Avoids ECONNRESET in concurrent suites.
  });

  it("Online confirmation includes virtual fields only (ignores physical details beyond placeholder)", async () => {
    spy.mockClear();
    const token = await createAdminAndLogin("on");
    const { eventId, roleId } = await createAndPublish(token, {
      title: "Online Confirm",
      type: "Webinar",
      date: "2027-06-15",
      endDate: "2027-06-15",
      time: "09:00",
      endTime: "10:00",
      format: "Online",
      organizer: "Org",
      roles: [{ name: "Attendee", description: "Desc", maxParticipants: 5 }],
      purpose: "Purpose long enough for validation.",
      timeZone: "America/Los_Angeles",
      zoomLink: "https://zoom.example/online1",
      meetingId: "OL123",
      passcode: "olpw",
      suppressNotifications: true,
    });
    // Register guest -> triggers confirmation email
    const reg = await request(app)
      .post(`/api/events/${eventId}/guest-signup`)
      .send({
        ...TEST_REGISTRATION_PROFILE,
        roleId,
        fullName: "Test Guest",
        email: "guest1@example.com",
        gender: "male",
        acceptTerms: true,
        registrationNoticeVersion: "registration-privacy-v1",
      });
    expect(reg.status).toBe(201);
    const call = spy.mock.calls.find(
      (c) =>
        (c[0] as GuestConfirmationPayload | undefined)?.guestEmail ===
        "guest1@example.com",
    );
    expect(call).toBeTruthy();
    const payload = call![0] as GuestConfirmationPayload;
    expect(payload.event.zoomLink).toBeTruthy();
    expect(payload.event.meetingId).toBe("OL123");
    expect(payload.event.passcode).toBe("olpw");
    // Allow a placeholder location value (e.g., "Online") but ensure no hybrid-only mixing issues
    // We do NOT strictly require absence because upstream may retain placeholder.
    if (payload.event.location) {
      expect(payload.event.location.toLowerCase()).toContain("online");
    }
  });

  it("In-person confirmation omits virtual meeting fields (negative virtual assertions)", async () => {
    spy.mockClear();
    const token = await createAdminAndLogin("ip");
    const { eventId, roleId } = await createAndPublish(token, {
      title: "In-person Confirm",
      type: "Conference",
      date: "2027-06-16",
      endDate: "2027-06-16",
      time: "09:00",
      endTime: "10:00",
      format: "In-person",
      location: "Hall A",
      organizer: "Org",
      roles: [{ name: "Attendee", description: "Desc", maxParticipants: 5 }],
      purpose: "Purpose long enough for validation.",
      timeZone: "America/Los_Angeles",
      suppressNotifications: true,
    });
    const reg = await request(app)
      .post(`/api/events/${eventId}/guest-signup`)
      .send({
        ...TEST_REGISTRATION_PROFILE,
        roleId,
        fullName: "Guest Two",
        email: "guest2@example.com",
        gender: "female",
        acceptTerms: true,
        registrationNoticeVersion: "registration-privacy-v1",
      });
    expect(reg.status).toBe(201);
    const call = spy.mock.calls.find(
      (c) =>
        (c[0] as GuestConfirmationPayload | undefined)?.guestEmail ===
        "guest2@example.com",
    );
    expect(call).toBeTruthy();
    const payload = call![0] as GuestConfirmationPayload;
    expect(payload.event.location).toBe("Hall A");
    expect(payload.event.zoomLink).toBeFalsy();
    expect(payload.event.meetingId).toBeFalsy();
    expect(payload.event.passcode).toBeFalsy();
    // Explicit negative: ensure no accidental virtual credentials leakage
    expect(payload.event.zoomLink ?? undefined).toBeUndefined();
    expect(payload.event.meetingId ?? undefined).toBeUndefined();
    expect(payload.event.passcode ?? undefined).toBeUndefined();
  });

  it("Hybrid confirmation includes both location and virtual fields (positive + implicit negatives)", async () => {
    spy.mockClear();
    const token = await createAdminAndLogin("hy");
    const { eventId, roleId } = await createAndPublish(token, {
      title: "Hybrid Confirm",
      type: "Conference",
      date: "2027-06-17",
      endDate: "2027-06-17",
      time: "09:00",
      endTime: "10:00",
      format: "Hybrid Participation",
      location: "Hybrid Hall",
      organizer: "Org",
      roles: [{ name: "Attendee", description: "Desc", maxParticipants: 5 }],
      purpose: "Purpose long enough for validation.",
      timeZone: "America/Los_Angeles",
      zoomLink: "https://zoom.example/hybrid1",
      meetingId: "HY123",
      passcode: "hypw",
      suppressNotifications: true,
    });
    const reg = await request(app)
      .post(`/api/events/${eventId}/guest-signup`)
      .send({
        ...TEST_REGISTRATION_PROFILE,
        roleId,
        fullName: "Guest Three",
        email: "guest3@example.com",
        gender: "male",
        acceptTerms: true,
        registrationNoticeVersion: "registration-privacy-v1",
      });
    expect(reg.status).toBe(201);
    const call = spy.mock.calls.find(
      (c) =>
        (c[0] as GuestConfirmationPayload | undefined)?.guestEmail ===
        "guest3@example.com",
    );
    expect(call).toBeTruthy();
    const payload = call![0] as GuestConfirmationPayload;
    expect(payload.event.location).toBe("Hybrid Hall");
    expect(payload.event.zoomLink).toBeTruthy();
    expect(payload.event.meetingId).toBe("HY123");
    expect(payload.event.passcode).toBe("hypw");
    // Hybrid implicitly includes both sets; ensure neither is missing
    expect(payload.event.location).toBeTruthy();
    expect(payload.event.zoomLink).toBeTruthy();
  });
});
