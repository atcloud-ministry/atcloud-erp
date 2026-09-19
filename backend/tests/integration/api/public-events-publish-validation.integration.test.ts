import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import request from "supertest";
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import { publishFieldsForFormat } from "../../test-utils/eventTestHelpers";

/**
 * Integration tests focusing on extended publish validation & publishedAt preservation
 */

describe("Public Events API - publish validation", () => {
  // Ensure strict validation is enabled for this suite regardless of global env so we can
  // assert extended error codes like TOO_SHORT and MISSING.
  let openedLocal = false;
  beforeAll(async () => {
    process.env.PUBLISH_STRICT_VALIDATION = "true";
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(
        process.env.MONGODB_TEST_URI ||
          "mongodb://127.0.0.1:27017/atcloud-signup-test",
      );
      openedLocal = true;
    }
  });
  afterAll(async () => {
    if (openedLocal && mongoose.connection.readyState !== 0) {
      // Shared integration harness owns connection lifecycle.
    }
  });
  let adminToken: string;
  let baseEventId: string;

  beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Event.deleteMany({})]);

    const adminData = {
      ...TEST_REGISTRATION_PROFILE,
      username: "valadmin",
      email: "valadmin@example.com",
      password: "AdminPass123!",
      confirmPassword: "AdminPass123!",
      firstName: "Val",
      lastName: "Admin",
      role: "Administrator",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
    } as const;
    await request(app).post("/api/auth/register").send(adminData);
    await User.findOneAndUpdate(
      { email: adminData.email },
      { isVerified: true, role: "Administrator" },
    );
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: adminData.email, password: adminData.password });
    adminToken = loginRes.body.data.accessToken;

    const createRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Validation Event",
        type: "Webinar",
        date: "2027-06-15",
        endDate: "2027-06-15",
        time: "09:00",
        endTime: "10:00",
        ...publishFieldsForFormat("Online", "val"),
        organizer: "Org",
        roles: [{ name: "Attendee", description: "Desc", maxParticipants: 5 }],
        purpose: "Short desc", // intentionally too short (<30)
        suppressNotifications: true,
      });
    expect(createRes.status).toBe(201);
    baseEventId = createRes.body.data.event.id;
  });

  it("fails publish with no open role + short purpose + missing timeZone + missing zoomLink (online)", async () => {
    const res = await request(app)
      .post(`/api/events/${baseEventId}/publish`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send();
    // Helper populated zoomLink; missing fields now: timeZone + no open role + short purpose -> 422 (validation error).
    expect(res.status).toBe(422); // 422 Unprocessable Entity for validation errors
    const errors = res.body.errors || [];
    const codes = errors.map((e: any) => e.code).sort();
    expect(codes).toContain("NO_PUBLIC_ROLE");
    expect(codes).toContain("TOO_SHORT");
    expect(codes).toContain("MISSING"); // timeZone
  });

  it("publishes successfully when requirements satisfied and preserves publishedAt on republish", async () => {
    // Fix fields
    await Event.findByIdAndUpdate(baseEventId, {
      $set: {
        purpose:
          "This is a sufficiently long description that meets the minimum length requirement for publishing.",
        timeZone: "America/Los_Angeles",
        zoomLink: "https://example.com/zoom/abc",
        meetingId: "mtg-abc-123",
        passcode: "passA",
        "roles.0.openToPublic": true,
      },
    });

    const first = await request(app)
      .post(`/api/events/${baseEventId}/publish`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send();
    expect(first.status).toBe(200);
    const slug = first.body?.data?.slug;
    expect(slug).toBeTruthy();

    const afterFirst = (await Event.findById(baseEventId).lean()) as any;
    const firstPublishedAt = afterFirst?.publishedAt as Date | undefined;
    expect(firstPublishedAt).toBeTruthy();

    // Unpublish
    const unpub = await request(app)
      .post(`/api/events/${baseEventId}/unpublish`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send();
    expect(unpub.status).toBe(200);

    // Republish (should keep original publishedAt, not overwrite)
    const second = await request(app)
      .post(`/api/events/${baseEventId}/publish`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send();
    expect(second.status).toBe(200);
    const afterSecond = (await Event.findById(baseEventId).lean()) as any;
    expect(afterSecond?.publishedAt?.toISOString()).toBe(
      firstPublishedAt?.toISOString(),
    );
  });

  it("allows publishing when purpose is empty as long as other requirements are met", async () => {
    await Event.findByIdAndUpdate(baseEventId, {
      $set: {
        purpose: "",
        timeZone: "America/Los_Angeles",
        zoomLink: "https://example.com/zoom/xyz",
        meetingId: "mtg-xyz-789",
        passcode: "passB",
        "roles.0.openToPublic": true,
      },
    });

    const res = await request(app)
      .post(`/api/events/${baseEventId}/publish`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
    const errors = res.body?.errors;
    expect(errors).toBeFalsy();
    const after = (await Event.findById(baseEventId).lean()) as any;
    expect(after?.publish).toBe(true);
    expect(after?.purpose).toBe("");
  });
});
