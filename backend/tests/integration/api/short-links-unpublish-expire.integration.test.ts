/**
 * Integration test: short links always redirect even after event unpublish.
 * Expiration checks are removed — links persist and resolve as active.
 */
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../src/app";
import Event from "../../../src/models/Event";
import ShortLink from "../../../src/models/ShortLink";
import User from "../../../src/models/User";
import { __TEST__ as ShortLinkTestHooks } from "../../../src/services/ShortLinkService";
import {
  createPublishedEvent,
  ensureCreatorUser,
} from "../../test-utils/eventTestHelpers";
import { describe, it, beforeAll, afterAll, beforeEach, expect } from "vitest";
import { ensureIntegrationDB } from "../setup/connect";

beforeAll(async () => {
  await ensureIntegrationDB();
});

afterAll(async () => {
  // Connection is shared, don't close it
});

async function createTestUser() {
  const uname = `u${Math.random().toString(36).slice(2, 8)}`;
  return User.create({
    username: uname,
    email: `${uname}@example.com`,
    password: "Password123!",
    firstName: "Test",
    lastName: "User",
    role: "Participant",
    isVerified: true,
    gender: "male",
    isAtCloudLeader: false,
  } as any);
}

async function authHeaders() {
  const user = await createTestUser();
  return { user, headers: { Authorization: `Bearer test-${user._id}` } };
}

describe("Short Link persistence after unpublish", () => {
  beforeEach(async () => {
    ShortLinkTestHooks.clearCache();
    await ShortLink.deleteMany({});
    await Event.deleteMany({});
    await User.deleteMany({});
  });

  it("still resolves after event is unpublished (no expiration check)", async () => {
    // Ensure we act as the creator (Administrator) so unpublish is authorized
    const creatorId = await ensureCreatorUser();
    const creatorHeaders = { Authorization: `Bearer test-admin-${creatorId}` };
    const event = await createPublishedEvent();

    // Create short link
    const createRes = await request(app)
      .post(`/api/public/short-links`)
      .set(creatorHeaders)
      .send({ eventId: event._id.toString() })
      .expect(201);
    const key = createRes.body.data.key;

    // Sanity: status active
    await request(app).get(`/api/public/short-links/${key}`).expect(200);

    // Unpublish event
    await request(app)
      .post(`/api/events/${event._id.toString()}/unpublish`)
      .set(creatorHeaders)
      .send({})
      .expect(200);

    // Short link should still resolve (200 active, not 410)
    const res = await request(app)
      .get(`/api/public/short-links/${key}`)
      .expect(200);

    expect(res.body.data?.status).toBe("active");

    // Redirect should still work (302)
    const redirectRes = await request(app).get(`/s/${key}`).expect(302);
    expect(redirectRes.headers.location).toContain(`/#/p/${event.publicSlug}`);
  });

  it("restores the same short link key after event is republished", async () => {
    // Ensure we act as the creator (Administrator)
    const creatorId = await ensureCreatorUser();
    const creatorHeaders = { Authorization: `Bearer test-admin-${creatorId}` };
    const event = await createPublishedEvent();

    // Create short link
    const createRes = await request(app)
      .post(`/api/public/short-links`)
      .set(creatorHeaders)
      .send({ eventId: event._id.toString() })
      .expect(201);
    const originalKey = createRes.body.data.key;

    // Sanity: status active
    await request(app)
      .get(`/api/public/short-links/${originalKey}`)
      .expect(200);

    // Unpublish event
    await request(app)
      .post(`/api/events/${event._id.toString()}/unpublish`)
      .set(creatorHeaders)
      .send({})
      .expect(200);

    // Short link still resolves even after unpublish
    await request(app)
      .get(`/api/public/short-links/${originalKey}`)
      .expect(200);

    // Republish event directly in DB (simulates publish action)
    await Event.findByIdAndUpdate(event._id, {
      publish: true,
      publishedAt: new Date(),
    });

    // Request short link again - should return the SAME key (restored)
    const reCreateRes = await request(app)
      .post(`/api/public/short-links`)
      .set(creatorHeaders)
      .send({ eventId: event._id.toString() })
      .expect(200); // 200 because it's idempotent (not created)

    expect(reCreateRes.body.data.key).toBe(originalKey);

    // Status should now be active again
    const activeRes = await request(app)
      .get(`/api/public/short-links/${originalKey}`)
      .expect(200);
    expect(activeRes.body.data?.status).toBe("active");

    // Redirect should work again
    const redirectRes = await request(app).get(`/s/${originalKey}`).expect(302);
    expect(redirectRes.headers.location).toContain(`/#/p/${event.publicSlug}`);
  });

  it("fixes stale expiresAt when existing link has incorrect timezone", async () => {
    // This test simulates the bug where expiresAt was stored incorrectly
    // due to treating local time as UTC
    const creatorId = await ensureCreatorUser();
    const creatorHeaders = { Authorization: `Bearer test-admin-${creatorId}` };

    // Create event with future end date
    const futureEndDate = "2030-06-15";
    const futureEndTime = "18:00"; // 6 PM local time
    const event = await createPublishedEvent({
      endDate: futureEndDate,
      endTime: futureEndTime,
      timeZone: "America/Los_Angeles", // PST/PDT
    });

    // Manually create a short link with WRONG expiresAt (simulating the old bug)
    // The bug was: local time treated as UTC, causing early expiration
    const wrongExpiresAt = new Date("2020-01-01T00:00:00Z"); // In the past!
    const shortLink = await ShortLink.create({
      key: "stale-test-key",
      eventId: event._id,
      targetSlug: event.publicSlug,
      createdBy: new mongoose.Types.ObjectId(creatorId),
      expiresAt: wrongExpiresAt, // Incorrectly in the past
      isExpired: false,
    });

    // Before fix: this would return 410 (expired) because expiresAt is in past
    // After fix: calling getOrCreateForEvent should correct the expiresAt

    // Request short link - should trigger correction and return active
    const res = await request(app)
      .post(`/api/public/short-links`)
      .set(creatorHeaders)
      .send({ eventId: event._id.toString() })
      .expect(200);

    // Should return the same key (not create a new one)
    expect(res.body.data.key).toBe("stale-test-key");

    // Verify expiresAt was corrected in the database
    const updatedLink = await ShortLink.findById(shortLink._id);
    expect(updatedLink).toBeTruthy();
    // The new expiresAt should be in the future (2030)
    expect(updatedLink!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(updatedLink!.expiresAt!.getFullYear()).toBe(2030);

    // Status should be active
    const statusRes = await request(app)
      .get(`/api/public/short-links/stale-test-key`)
      .expect(200);
    expect(statusRes.body.data?.status).toBe("active");
  });
});
