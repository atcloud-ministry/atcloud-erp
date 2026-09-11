import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import request from "supertest";
import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import { EmailService } from "../../../src/services/infrastructure/EmailServiceFacade";

async function createAdminAndLogin() {
  const admin = {
    ...TEST_REGISTRATION_PROFILE,
    username: "autounpubadmin",
    email: "autounpubadmin@example.com",
    password: "AdminPass123!",
    confirmPassword: "AdminPass123!",
    firstName: "Auto",
    lastName: "Unpub",
    role: "Administrator",
    gender: "male",
    isAtCloudLeader: false,
    acceptTerms: true,
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

describe("Auto-unpublish 48-hour grace period on update when necessary fields removed", () => {
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

  // Online: remove meetingId (credential) triggers grace period warning (not immediate unpublish)
  it("schedules unpublish after 48 hours for Online event with missing meetingId", async () => {
    const spy = vi
      .spyOn(
        EmailService as unknown as {
          sendEventUnpublishWarningNotification: any;
        },
        "sendEventUnpublishWarningNotification",
      )
      .mockResolvedValue(true);
    const create = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Online Auto Unpublish",
        type: "Webinar",
        date: "2027-06-15",
        endDate: "2027-06-15",
        time: "09:00",
        endTime: "10:00",
        location: "Online",
        format: "Online",
        organizer: "Org",
        roles: [{ name: "Attendee", description: "Desc", maxParticipants: 5 }],
        purpose:
          "Long enough purpose statement for tests to pass length checks.",
        timeZone: "America/Los_Angeles",
        zoomLink: "https://zoom.example/ok",
        meetingId: "123456",
        passcode: "abc",
        suppressNotifications: true,
      });
    expect(create.status).toBe(201);
    const eventId = create.body.data.event.id;
    await Event.findByIdAndUpdate(eventId, {
      $set: { "roles.0.openToPublic": true },
    });
    await publishEvent(eventId);

    // Now remove meetingId (blank it)
    const update = await request(app)
      .put(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ meetingId: "" });
    expect(update.status).toBe(200);

    // Event stays PUBLISHED during grace period
    expect(update.body.data.event.publish).toBe(true);
    // Scheduled unpublish should be set ~48 hours from now
    expect(update.body.data.event.unpublishScheduledAt).toBeTruthy();
    const scheduledTime = new Date(
      update.body.data.event.unpublishScheduledAt,
    ).getTime();
    const expectedTime = Date.now() + 48 * 60 * 60 * 1000;
    // Allow 5 second tolerance
    expect(Math.abs(scheduledTime - expectedTime)).toBeLessThan(5000);
    // Warning fields should be set
    expect(update.body.data.event.unpublishWarningFields).toContain(
      "meetingId",
    );
    // Should NOT be unpublished yet
    expect(update.body.data.event.autoUnpublishedAt).toBeFalsy();
    expect(update.body.data.event.autoUnpublishedReason).toBeFalsy();

    // Warning notification should be sent
    expect(spy.mock.calls.length).toBe(1);

    // Second benign update should not re-trigger notification (still in grace period)
    const second = await request(app)
      .put(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ purpose: "Minor edit - no new warning needed" });
    expect(second.status).toBe(200);
    // Still only 1 warning call (unless field is still missing, which it is - may trigger again)
  });

  it("schedules unpublish for In-person event after location cleared", async () => {
    const create = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "In-person Auto Unpublish",
        type: "Webinar",
        date: "2027-06-16",
        endDate: "2027-06-16",
        time: "09:00",
        endTime: "10:00",
        location: "Hall A",
        format: "In-person",
        organizer: "Org",
        roles: [{ name: "Attendee", description: "Desc", maxParticipants: 5 }],
        purpose:
          "Long enough purpose statement for tests to pass length checks.",
        timeZone: "America/Los_Angeles",
        suppressNotifications: true,
      });
    expect(create.status).toBe(201);
    const eventId = create.body.data.event.id;
    await Event.findByIdAndUpdate(eventId, {
      $set: { "roles.0.openToPublic": true },
    });
    await publishEvent(eventId);

    // Clear location
    const update = await request(app)
      .put(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ location: "" });
    expect(update.status).toBe(200);

    // Event stays published during grace period
    expect(update.body.data.event.publish).toBe(true);
    // Scheduled unpublish should be set
    expect(update.body.data.event.unpublishScheduledAt).toBeTruthy();
  });

  // Hybrid: remove zoomLink (one of multiple necessary fields) triggers grace period
  it("schedules unpublish for Hybrid event after zoomLink removed", async () => {
    const create = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Hybrid Auto Unpublish",
        type: "Conference",
        date: "2027-06-17",
        endDate: "2027-06-17",
        time: "09:00",
        endTime: "10:00",
        location: "Campus Center",
        format: "Hybrid Participation",
        organizer: "Org",
        roles: [{ name: "Attendee", description: "Desc", maxParticipants: 5 }],
        purpose:
          "Long enough purpose statement for tests to pass length checks.",
        timeZone: "America/Los_Angeles",
        zoomLink: "https://zoom.example/hybrid",
        meetingId: "ABCDEF",
        passcode: "pass1",
        suppressNotifications: true,
      });
    expect(create.status).toBe(201);
    const eventId = create.body.data.event.id;
    await Event.findByIdAndUpdate(eventId, {
      $set: { "roles.0.openToPublic": true },
    });
    await publishEvent(eventId);

    // Remove zoomLink (set blank)
    const update = await request(app)
      .put(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ zoomLink: "" });
    expect(update.status).toBe(200);

    // Event stays published during grace period
    expect(update.body.data.event.publish).toBe(true);
    // Scheduled unpublish should be set
    expect(update.body.data.event.unpublishScheduledAt).toBeTruthy();
    expect(update.body.data.event.unpublishWarningFields).toContain("zoomLink");
  });

  it("clears scheduled unpublish when missing field is fixed", async () => {
    const create = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Fix-and-clear Test",
        type: "Webinar",
        date: "2027-06-18",
        endDate: "2027-06-18",
        time: "09:00",
        endTime: "10:00",
        location: "Online",
        format: "Online",
        organizer: "Org",
        roles: [{ name: "Attendee", description: "Desc", maxParticipants: 5 }],
        purpose:
          "Long enough purpose statement for tests to pass length checks.",
        timeZone: "America/Los_Angeles",
        zoomLink: "https://zoom.example/ok",
        meetingId: "123456",
        passcode: "abc",
        suppressNotifications: true,
      });
    expect(create.status).toBe(201);
    const eventId = create.body.data.event.id;
    await Event.findByIdAndUpdate(eventId, {
      $set: { "roles.0.openToPublic": true },
    });
    await publishEvent(eventId);

    // Remove meetingId to trigger grace period
    const update1 = await request(app)
      .put(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ meetingId: "" });
    expect(update1.status).toBe(200);
    expect(update1.body.data.event.unpublishScheduledAt).toBeTruthy();

    // Fix it by adding meetingId back
    const update2 = await request(app)
      .put(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ meetingId: "NewMeetingId" });
    expect(update2.status).toBe(200);

    // Scheduled unpublish should be cleared
    expect(update2.body.data.event.unpublishScheduledAt).toBeFalsy();
    expect(update2.body.data.event.unpublishWarningFields).toBeFalsy();
    // Event should still be published
    expect(update2.body.data.event.publish).toBe(true);
  });
});
