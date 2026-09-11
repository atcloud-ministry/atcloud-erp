import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import request from "supertest";
import { describe, it, beforeEach, expect } from "vitest";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import { buildValidEventPayload } from "../../test-utils/eventTestHelpers";
import { retryRequest } from "../_utils/retryRequest";
import { ensureIntegrationDB } from "../setup/connect";

/**
 * Integration tests for event flyerUrl update/removal behavior.
 * Verifies that empty string or null can clear an existing flyerUrl.
 */

describe("Events API - flyerUrl update/removal", () => {
  let adminToken: string;

  beforeEach(async () => {
    await ensureIntegrationDB();
    await Promise.all([User.deleteMany({}), Event.deleteMany({})]);

    // Create and verify admin user
    const adminData = {
      ...TEST_REGISTRATION_PROFILE,
      username: "flyeradmin",
      email: "flyeradmin@example.com",
      password: "AdminPass123!",
      confirmPassword: "AdminPass123!",
      firstName: "Flyer",
      lastName: "Admin",
      role: "Administrator",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
    } as const;
    await retryRequest(() =>
      request(app).post("/api/auth/register").send(adminData).expect(201),
    );
    await User.findOneAndUpdate(
      { email: adminData.email },
      { isVerified: true, role: "Administrator" },
    );
    const loginRes = await retryRequest(() =>
      request(app)
        .post("/api/auth/login")
        .send({
          emailOrUsername: adminData.email,
          password: adminData.password,
        })
        .expect(200),
    );
    adminToken = loginRes.body.data.accessToken;
  }, 30000);

  it("creates event with flyerUrl then removes it via empty string", async () => {
    // Create event with flyerUrl
    const eventPayload = buildValidEventPayload({
      title: "Event with Flyer",
      purpose: "Testing flyerUrl removal with empty string.",
      overrides: {
        flyerUrl: "/uploads/test-flyer.png",
      },
    });

    const createRes = await retryRequest(() =>
      request(app)
        .post("/api/events")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(eventPayload)
        .expect(201),
    );

    const eventId =
      createRes.body.data.event.id || createRes.body.data.event._id;
    expect(createRes.body.data.event.flyerUrl).toBe("/uploads/test-flyer.png");

    // Update event with empty string flyerUrl
    const updateRes = await retryRequest(() =>
      request(app)
        .put(`/api/events/${eventId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          flyerUrl: "",
          suppressNotifications: true,
        })
        .expect(200),
    );

    // Verify flyerUrl was removed
    expect(updateRes.body.data.event.flyerUrl).toBeUndefined();

    // Double-check by fetching event
    const fetchRes = await retryRequest(() =>
      request(app)
        .get(`/api/events/${eventId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200),
    );
    expect(fetchRes.body.data.flyerUrl).toBeUndefined();
  });

  it("creates event with flyerUrl then removes it via null", async () => {
    // Create event with flyerUrl
    const eventPayload = buildValidEventPayload({
      title: "Event with Flyer (null test)",
      purpose: "Testing flyerUrl removal with null.",
      overrides: {
        flyerUrl: "/uploads/another-flyer.jpg",
      },
    });

    const createRes = await retryRequest(() =>
      request(app)
        .post("/api/events")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(eventPayload)
        .expect(201),
    );

    const eventId =
      createRes.body.data.event.id || createRes.body.data.event._id;
    expect(createRes.body.data.event.flyerUrl).toBe(
      "/uploads/another-flyer.jpg",
    );

    // Update event with null flyerUrl
    const updateRes = await retryRequest(() =>
      request(app)
        .put(`/api/events/${eventId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          flyerUrl: null,
          suppressNotifications: true,
        })
        .expect(200),
    );

    // Verify flyerUrl was removed
    expect(updateRes.body.data.event.flyerUrl).toBeUndefined();
  });

  it("preserves flyerUrl when not included in update payload", async () => {
    // Create event with flyerUrl
    const eventPayload = buildValidEventPayload({
      title: "Event with Persistent Flyer",
      purpose: "Testing flyerUrl preservation when omitted from update.",
      overrides: {
        flyerUrl: "/uploads/persistent-flyer.png",
      },
    });

    const createRes = await retryRequest(() =>
      request(app)
        .post("/api/events")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(eventPayload)
        .expect(201),
    );

    const eventId =
      createRes.body.data.event.id || createRes.body.data.event._id;
    expect(createRes.body.data.event.flyerUrl).toBe(
      "/uploads/persistent-flyer.png",
    );

    // Update event without flyerUrl in payload
    const updateRes = await retryRequest(() =>
      request(app)
        .put(`/api/events/${eventId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          title: "Updated Event Title",
          suppressNotifications: true,
        })
        .expect(200),
    );

    // Verify flyerUrl was preserved
    expect(updateRes.body.data.event.flyerUrl).toBe(
      "/uploads/persistent-flyer.png",
    );
  });
});
