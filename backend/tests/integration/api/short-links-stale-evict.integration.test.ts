import request from "supertest";
import mongoose from "mongoose";
import { describe, it, beforeEach, beforeAll, afterAll, expect } from "vitest";
import app from "../../../src/app";
import ShortLinkService, {
  __TEST__ as ShortLinkTestHooks,
} from "../../../src/services/ShortLinkService";
import ShortLink from "../../../src/models/ShortLink";
import Event from "../../../src/models/Event";
import User from "../../../src/models/User";
import { createPublishedEvent } from "../../test-utils/eventTestHelpers";
import { ensureIntegrationDB } from "../setup/connect";

/**
 * Short links no longer expire. This test verifies that stale cached entries
 * still resolve successfully (200 active) after cache expiry is forced.
 */

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

describe("Short Links stale cached entry eviction", () => {
  beforeEach(async () => {
    await ShortLink.deleteMany({});
    await Event.deleteMany({});
    await User.deleteMany({});
    ShortLinkTestHooks.clearCache();
  });

  it("resolves a stale-cached link as active even when the DB record is expired", async () => {
    const { headers } = await authHeaders();
    const event = await createPublishedEvent();
    // Create short link (active)
    const createRes = await request(app)
      .post(`/api/public/short-links`)
      .set(headers)
      .send({ eventId: event._id.toString() })
      .expect(201);
    const key = createRes.body.data.key as string;

    // Prime cache by resolving once (status endpoint) -> 200 active
    await request(app).get(`/api/public/short-links/${key}`).expect(200);

    // Force the cached entry's per-link expiry into the past without touching DB record
    ShortLinkTestHooks.forceCacheExpiry(key);

    // Mark DB record as expired with past expiresAt
    await ShortLink.updateMany(
      { key },
      { $set: { isExpired: true, expiresAt: new Date(Date.now() - 1000) } },
    );

    // Should still resolve as active (200), not expired (410)
    const res = await request(app)
      .get(`/api/public/short-links/${key}`)
      .expect(200);
    expect(res.body.data?.status).toBe("active");
  });
});
