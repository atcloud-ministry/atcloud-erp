import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import request from "supertest";
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import AuditLog from "../../../src/models/AuditLog";

/**
 * Verifies audit logs are created for publish/unpublish lifecycle.
 */

describe("Public Events API - audit logs", () => {
  let adminToken: string;
  let eventId: string;
  let openedLocal = false;

  beforeAll(async () => {
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
  beforeEach(async () => {
    console.log("[audit-test] beforeEach start");
    console.log("[audit-test] clearing collections");
    await User.deleteMany({});
    await Event.deleteMany({});
    await AuditLog.deleteMany({});
    console.log("[audit-test] collections cleared");
    const adminData = {
      ...TEST_REGISTRATION_PROFILE,
      username: "auditadmin",
      email: "auditadmin@example.com",
      password: "AdminPass123!",
      confirmPassword: "AdminPass123!",
      firstName: "Audit",
      lastName: "Admin",
      role: "Administrator",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
    } as const;
    await request(app).post("/api/auth/register").send(adminData);
    console.log("[audit-test] admin registered");
    await User.findOneAndUpdate(
      { email: adminData.email },
      { isVerified: true, role: "Administrator" },
    );
    console.log("[audit-test] admin elevated");
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: adminData.email, password: adminData.password });
    console.log("[audit-test] login response status", loginRes.status);
    adminToken = loginRes.body.data.accessToken;
    const createRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Audit Event",
        type: "Webinar",
        date: "2027-06-15",
        endDate: "2027-06-15",
        time: "10:00",
        endTime: "11:00",
        location: "Online",
        format: "Online",
        timeZone: "America/Los_Angeles", // Added to satisfy strict validation
        zoomLink: "https://example.test/zoom/abc123", // Added for Online format strict requirement
        meetingId: "AUD123",
        passcode: "audit",
        organizer: "Org",
        roles: [
          {
            name: "Open",
            description: "Desc",
            maxParticipants: 10,
            openToPublic: true,
          },
        ],
        // Purpose extended beyond 30 chars for strict validation
        purpose:
          "This is a sufficiently long audit purpose text for validation.",
        suppressNotifications: true,
      });
    console.log("[audit-test] create event status", createRes.status);
    expect(createRes.status).toBe(201);
    const createdEvent = createRes.body?.data?.event;
    console.log(
      "[audit-test] createdEvent keys",
      createdEvent && Object.keys(createdEvent),
    );
    expect(createdEvent).toBeTruthy();
    eventId = createdEvent?.id || createdEvent?._id;
    expect(eventId).toBeTruthy();
    console.log("[audit-test] beforeEach complete eventId", eventId);
  });

  it("creates EventPublished and EventUnpublished audit logs", async () => {
    // Ensure the role has openToPublic set (extra safety check)
    await Event.findByIdAndUpdate(eventId, {
      $set: { "roles.0.openToPublic": true },
    });

    const pub = await request(app)
      .post(`/api/events/${eventId}/publish`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send();
    expect(pub.status).toBe(200);
    const publishedLogs = await AuditLog.find({
      eventId,
      action: "EventPublished",
    });
    expect(publishedLogs.length).toBe(1);
    const unpub = await request(app)
      .post(`/api/events/${eventId}/unpublish`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send();
    expect(unpub.status).toBe(200);
    const unpublishedLogs = await AuditLog.find({
      eventId,
      action: "EventUnpublished",
    });
    expect(unpublishedLogs.length).toBe(1);
  });
});
