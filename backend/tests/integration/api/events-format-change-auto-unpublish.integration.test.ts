import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import request from "supertest";
import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import { EmailService } from "../../../src/services/infrastructure/EmailServiceFacade";
import {
  domainEvents,
  EVENT_AUTO_UNPUBLISHED,
} from "../../../src/services/domainEvents";
import { futureDateString } from "../../test-utils/eventTestHelpers";

async function createAdminAndLogin() {
  const admin = {
    ...TEST_REGISTRATION_PROFILE,
    username: "fmtchangeadmin",
    email: "fmtchangeadmin@example.com",
    password: "AdminPass123!",
    confirmPassword: "AdminPass123!",
    firstName: "Format",
    lastName: "Changer",
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

describe("Auto-unpublish on format change introducing new missing necessary fields", () => {
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

  it("schedules unpublish when changing In-person -> Hybrid Participation without adding virtual fields", async () => {
    const eventDate = futureDateString();
    const spy = vi
      .spyOn(
        EmailService as unknown as {
          sendEventUnpublishWarningNotification: any;
        },
        "sendEventUnpublishWarningNotification"
      )
      .mockResolvedValue(true);

    const create = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Format Change Auto Unpublish",
        type: "Webinar",
        date: eventDate,
        endDate: eventDate,
        time: "09:00",
        endTime: "10:00",
        location: "Room 1",
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

    // Now change format to Hybrid Participation WITHOUT zoomLink/meetingId/passcode
    const update = await request(app)
      .put(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ format: "Hybrid Participation" });
    expect(update.status).toBe(200);
    // Event stays published during grace period
    expect(update.body.data.event.publish).toBe(true);
    // Scheduled unpublish should be set ~48 hours from now
    expect(update.body.data.event.unpublishScheduledAt).toBeTruthy();
    // Warning fields should contain the missing virtual fields
    const warningFields = update.body.data.event.unpublishWarningFields || [];
    expect(
      warningFields.includes("zoomLink") ||
        warningFields.includes("meetingId") ||
        warningFields.includes("passcode")
    ).toBe(true);
    // Warning notification should have been sent
    expect(spy.mock.calls.length).toBe(1);
    // Domain event should NOT be emitted during grace period (only on actual unpublish)
  });
});
