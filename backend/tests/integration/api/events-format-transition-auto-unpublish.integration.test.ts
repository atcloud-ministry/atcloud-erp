import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import request from "supertest";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";

async function createAdminAndLogin() {
  const admin = {
    ...TEST_REGISTRATION_PROFILE,
    username: "fmtTransAdmin",
    email: "formattransitionadmin@example.com",
    password: "AdminPass123!",
    confirmPassword: "AdminPass123!",
    firstName: "Format",
    lastName: "Transition",
    role: "Administrator",
    gender: "male",
    isAtCloudLeader: false,
    acceptTerms: true,
  } as const;
  const registerRes = await request(app).post("/api/auth/register").send(admin);
  if (registerRes.status !== 201) {
    // Emit helpful debug for failing scenario
    // eslint-disable-next-line no-console
    console.error(
      "Registration failed in format transition test",
      registerRes.status,
      registerRes.body,
    );
  }
  expect(registerRes.status).toBe(201);
  await User.findOneAndUpdate(
    { email: admin.email },
    { isVerified: true, role: "Administrator" },
  );
  const login = await request(app)
    .post("/api/auth/login")
    .send({ emailOrUsername: admin.email, password: admin.password });
  if (login.status !== 200) {
    // eslint-disable-next-line no-console
    console.error(
      "Login failed in format transition test",
      login.status,
      login.body,
    );
  }
  expect(login.status).toBe(200);
  return login.body.data.accessToken as string;
}

describe("Format transition publish validation behavior", () => {
  let token: string;
  let openedLocal = false;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(
        process.env.MONGODB_TEST_URI ||
          "mongodb://127.0.0.1:27017/atcloud-signup-test",
      );
      openedLocal = true;
    }
    await Promise.all([User.deleteMany({}), Event.deleteMany({})]);
    token = await createAdminAndLogin();
  });

  afterAll(async () => {
    if (openedLocal && mongoose.connection.readyState !== 0) {
      // Shared integration harness owns connection lifecycle.
    }
  });

  async function publishEvent(eventId: string) {
    const res = await request(app)
      .post(`/api/events/${eventId}/publish`)
      .set("Authorization", `Bearer ${token}`)
      .send();
    expect(res.status).toBe(200);
  }

  it("Online → Hybrid (missing newly-required location) schedules unpublish with 48-hour grace period", async () => {
    const create = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Online To Hybrid Missing Location",
        type: "Webinar",
        date: "2027-06-15",
        endDate: "2027-06-15",
        time: "09:00",
        endTime: "10:00",
        location: "Online", // acceptable placeholder while still Online
        format: "Online",
        organizer: "Org",
        roles: [{ name: "Attendee", description: "Desc", maxParticipants: 5 }],
        purpose:
          "Long enough purpose statement for tests to pass length checks.",
        timeZone: "America/Los_Angeles",
        zoomLink: "https://zoom.example/onlinehybrid",
        meetingId: "MEETONHY",
        passcode: "code1",
        suppressNotifications: true,
      });
    expect(create.status).toBe(201);
    const eventId = create.body.data.event.id;
    await Event.findByIdAndUpdate(eventId, {
      $set: { "roles.0.openToPublic": true },
    });
    await publishEvent(eventId);

    // Transition to Hybrid Participation BUT clear location (now required)
    // -> should stay published but schedule unpublish for 48 hours later
    const update = await request(app)
      .put(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ format: "Hybrid Participation", location: "" });
    expect(update.status).toBe(200);
    // With 48-hour grace period, event stays published
    expect(update.body.data.event.publish).toBe(true);
    // Scheduled unpublish should be set ~48 hours from now
    expect(update.body.data.event.unpublishScheduledAt).toBeTruthy();
    const scheduledTime = new Date(
      update.body.data.event.unpublishScheduledAt,
    ).getTime();
    const expectedTime = Date.now() + 48 * 60 * 60 * 1000;
    // Allow 5 second tolerance
    expect(Math.abs(scheduledTime - expectedTime)).toBeLessThan(5000);
    // Warning fields should include location
    expect(update.body.data.event.unpublishWarningFields).toContain("location");
    // Should NOT be unpublished yet (no immediate unpublish)
    expect(update.body.data.event.autoUnpublishedAt).toBeFalsy();
    expect(update.body.data.event.autoUnpublishedReason).toBeFalsy();
  });

  it("Hybrid → In-person (removing virtual fields) stays published if location present", async () => {
    const create = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Hybrid To In-person Keeps Publish",
        type: "Conference",
        date: "2027-06-16",
        endDate: "2027-06-16",
        time: "11:00",
        endTime: "12:00",
        location: "Main Hall",
        format: "Hybrid Participation",
        organizer: "Org",
        roles: [{ name: "Attendee", description: "Desc", maxParticipants: 5 }],
        purpose:
          "Another sufficiently long purpose statement to satisfy validation.",
        timeZone: "America/Los_Angeles",
        zoomLink: "https://zoom.example/hybrid2inperson",
        meetingId: "MEETHYIN",
        passcode: "code2",
        suppressNotifications: true,
      });
    expect(create.status).toBe(201);
    const eventId = create.body.data.event.id;
    await Event.findByIdAndUpdate(eventId, {
      $set: { "roles.0.openToPublic": true },
    });
    await publishEvent(eventId);

    // Transition to In-person while clearing virtual-only fields -> should remain published
    const update = await request(app)
      .put(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        format: "In-person",
        zoomLink: "",
        meetingId: "",
        passcode: "",
      });
    expect(update.status).toBe(200);
    expect(update.body.data.event.publish).toBe(true);
    expect(update.body.data.event.autoUnpublishedReason).toBeFalsy();
    expect(update.body.data.event.autoUnpublishedAt).toBeFalsy();
  });
});
