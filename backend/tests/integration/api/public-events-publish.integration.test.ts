import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import request from "supertest";
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import { publishFieldsForFormat } from "../../test-utils/eventTestHelpers";

/**
 * Integration tests for publish / unpublish lifecycle endpoints
 */

describe("Public Events API - publish/unpublish lifecycle", () => {
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
    await User.deleteMany({});
    await Event.deleteMany({});
    const adminData = {
      ...TEST_REGISTRATION_PROFILE,
      username: "pubadmin",
      email: "pubadmin@example.com",
      password: "AdminPass123!",
      confirmPassword: "AdminPass123!",
      firstName: "Pub",
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

    // Create base event via controller to ensure validations
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 10); // 10 days from now
    const futureDateStr = futureDate.toISOString().split("T")[0]; // YYYY-MM-DD

    const createRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Lifecycle Event",
        type: "Webinar",
        date: futureDateStr,
        endDate: futureDateStr,
        time: "10:00",
        endTime: "11:00",
        ...publishFieldsForFormat("Online", "lifecycle"),
        organizer: "Org",
        roles: [
          { name: "Attendee", description: "Desc", maxParticipants: 10 },
          { name: "Internal", description: "Desc", maxParticipants: 5 },
        ],
        purpose:
          "Testing lifecycle full description to satisfy any length expectations for strict mode.",
        timeZone: "America/Los_Angeles",
        // Skip emails/system messages to keep test fast & deterministic
        suppressNotifications: true,
      });
    expect(createRes.status).toBe(201);
    // Response shape: { success, message, data: { event: {...}, series? } }
    const createdEvent = createRes.body?.data?.event;
    expect(createdEvent).toBeTruthy();
    eventId = createdEvent?.id || createdEvent?._id; // Mongoose may expose both
    expect(eventId).toBeTruthy();
  });

  it("rejects publish when no role is openToPublic", async () => {
    const res = await request(app)
      .post(`/api/events/${eventId}/publish`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send();
    expect(res.status).toBe(422); // 422 Unprocessable Entity for validation errors
  });

  it("publishes when at least one role openToPublic and generates slug once", async () => {
    // Make one role open to public directly (simpler than update route for test purpose)
    await Event.findByIdAndUpdate(eventId, {
      $set: { "roles.0.openToPublic": true },
    });

    const first = await request(app)
      .post(`/api/events/${eventId}/publish`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send();
    expect(first.status).toBe(200);
    const slug = first.body?.data?.slug;
    expect(slug).toBeTruthy();

    // Calling publish again is idempotent and keeps same slug
    const second = await request(app)
      .post(`/api/events/${eventId}/publish`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send();
    expect(second.status).toBe(200);
    expect(second.body.data.slug).toBe(slug);

    // Public GET works
    const getRes = await request(app).get(`/api/public/events/${slug}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.title).toBe("Lifecycle Event");
  });

  it("unpublishes and public GET returns 404", async () => {
    await Event.findByIdAndUpdate(eventId, {
      $set: { "roles.0.openToPublic": true },
    });
    const pub = await request(app)
      .post(`/api/events/${eventId}/publish`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send();
    const slug = pub.body.data.slug;
    const unpub = await request(app)
      .post(`/api/events/${eventId}/unpublish`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send();
    expect(unpub.status).toBe(200);
    const getRes = await request(app).get(`/api/public/events/${slug}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.registrationOpen).toBe(false);
  });

  it("reflects real capacity remaining after registration", async () => {
    await Event.findByIdAndUpdate(eventId, {
      $set: { "roles.0.openToPublic": true },
    });
    const pub = await request(app)
      .post(`/api/events/${eventId}/publish`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send();
    const slug = pub.body.data.slug;
    // participant user
    const userData = {
      ...TEST_REGISTRATION_PROFILE,
      username: "part1",
      email: "part1@example.com",
      password: "UserPass123!",
      confirmPassword: "UserPass123!",
      firstName: "Part",
      lastName: "One",
      role: "Participant",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
    } as const;
    await request(app).post("/api/auth/register").send(userData);
    await User.findOneAndUpdate(
      { email: userData.email },
      { isVerified: true },
    );
    const login = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: userData.email, password: userData.password });
    const userToken = login.body.data.accessToken;
    const ev: any = await Event.findById(eventId).lean();
    const roleId = ev.roles[0].id;
    const signup = await request(app)
      .post(`/api/events/${eventId}/register`)
      .set("Authorization", `Bearer ${userToken}`)
      .send({ roleId });
    expect(signup.status).toBe(200);
    const getAfter = await request(app).get(`/api/public/events/${slug}`);
    expect(getAfter.status).toBe(200);
    expect(getAfter.body.data.roles[0].capacityRemaining).toBe(9);
  });
});
