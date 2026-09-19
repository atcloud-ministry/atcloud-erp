import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import request from "supertest";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import Message from "../../../src/models/Message";
import { futureDateString } from "../../test-utils/eventTestHelpers";

async function createAdminAndLogin() {
  const admin = {
    ...TEST_REGISTRATION_PROFILE,
    username: "autounpubsysmsgadmin",
    email: "autounpubsysmsgadmin@example.com",
    password: "AdminPass123!",
    confirmPassword: "AdminPass123!",
    firstName: "Auto",
    lastName: "SysMsg",
    role: "Administrator",
    gender: "male",
    isAtCloudLeader: false,
    acceptTerms: true,
    registrationNoticeVersion: "registration-privacy-v1",
  } as const;
  await request(app).post("/api/auth/register").send(admin);
  await User.findOneAndUpdate(
    { email: admin.email },
    { isVerified: true, role: "Administrator" }
  );
  const login = await request(app)
    .post("/api/auth/login")
    .send({ emailOrUsername: admin.email, password: admin.password });
  return login.body.data.accessToken as string;
}

describe("Auto-unpublish system message emission", () => {
  let token: string;
  let openedLocal = false;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(
        process.env.MONGODB_TEST_URI ||
          "mongodb://127.0.0.1:27017/atcloud-signup-test"
      );
      openedLocal = true;
    }
    await Promise.all([
      User.deleteMany({}),
      Event.deleteMany({}),
      Message.deleteMany({}),
    ]);
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

  it("creates exactly one system message on grace-period warning and none on subsequent benign edits", async () => {
    const eventDate = futureDateString();
    const create = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "System Msg Auto Unpublish",
        type: "Webinar",
        date: eventDate,
        endDate: eventDate,
        time: "09:00",
        endTime: "10:00",
        location: "Online",
        format: "Online",
        organizer: "Org",
        roles: [{ name: "Attendee", description: "Desc", maxParticipants: 5 }],
        purpose:
          "Long enough purpose statement for tests to pass length checks.",
        timeZone: "America/Los_Angeles",
        zoomLink: "https://zoom.example/sysmsg",
        meetingId: "MEETSYS",
        passcode: "pass2",
        suppressNotifications: true,
      });
    expect(create.status).toBe(201);
    const eventId = create.body.data.event.id;
    await Event.findByIdAndUpdate(eventId, {
      $set: { "roles.0.openToPublic": true },
    });
    await publishEvent(eventId);

    // Trigger grace period warning (remove meetingId)
    const update = await request(app)
      .put(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ meetingId: "" });
    expect(update.status).toBe(200);
    // With 48-hour grace period, event stays published
    expect(update.body.data.event.publish).toBe(true);
    expect(update.body.data.event.unpublishScheduledAt).toBeTruthy();
    expect(update.body.data.event.unpublishWarningFields).toContain(
      "meetingId"
    );

    // Verify one system message with expected metadata (warning message)
    const messages = await Message.find({
      "metadata.eventId": eventId,
      "metadata.reason": "GRACE_PERIOD_WARNING",
    });
    expect(messages.length).toBe(1);
    expect(messages[0].title).toContain("Action Required");
    expect(messages[0].metadata?.missing).toBeTruthy();
    expect(Array.isArray(messages[0].metadata?.missing)).toBe(true);
    expect((messages[0].metadata as any).missing.length).toBeGreaterThan(0);

    // Second benign edit should not create a second system message
    const second = await request(app)
      .put(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ purpose: "Another minor edit" });
    expect(second.status).toBe(200);
    const messagesAfter = await Message.find({
      "metadata.eventId": eventId,
      "metadata.reason": "GRACE_PERIOD_WARNING",
    });
    expect(messagesAfter.length).toBe(1);
  });
});
