/**
 * Integration test for short link creation per-IP rate limiting.
 */
import request from "supertest";
import app from "../../../src/app";
import mongoose from "mongoose";
import Event from "../../../src/models/Event";
import User from "../../../src/models/User";
import ShortLink from "../../../src/models/ShortLink";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  buildValidEventPayload,
  ensureCreatorUser,
} from "../../test-utils/eventTestHelpers";

let openedLocal = false;
const originalRateLimitEnvironment = {
  TEST_DISABLE_PUBLIC_RL: process.env.TEST_DISABLE_PUBLIC_RL,
  RESET_RATE_LIMITER: process.env.RESET_RATE_LIMITER,
  SHORTLINK_CREATE_LIMIT_PER_USER: process.env.SHORTLINK_CREATE_LIMIT_PER_USER,
  SHORTLINK_CREATE_LIMIT_PER_IP: process.env.SHORTLINK_CREATE_LIMIT_PER_IP,
};

function restoreEnvironment(
  name: keyof typeof originalRateLimitEnvironment,
  value: string | undefined,
): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(async () => {
  process.env.TEST_DISABLE_PUBLIC_RL = "false";
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(
      process.env.MONGODB_TEST_URI ||
        "mongodb://127.0.0.1:27017/atcloud-signup-test"
    );
    openedLocal = true;
  }
});

afterAll(async () => {
  restoreEnvironment(
    "TEST_DISABLE_PUBLIC_RL",
    originalRateLimitEnvironment.TEST_DISABLE_PUBLIC_RL,
  );
  restoreEnvironment(
    "RESET_RATE_LIMITER",
    originalRateLimitEnvironment.RESET_RATE_LIMITER,
  );
  restoreEnvironment(
    "SHORTLINK_CREATE_LIMIT_PER_USER",
    originalRateLimitEnvironment.SHORTLINK_CREATE_LIMIT_PER_USER,
  );
  restoreEnvironment(
    "SHORTLINK_CREATE_LIMIT_PER_IP",
    originalRateLimitEnvironment.SHORTLINK_CREATE_LIMIT_PER_IP,
  );
  if (openedLocal && mongoose.connection.readyState !== 0) {
    // Shared integration harness owns connection lifecycle.
  }
});

afterEach(async () => {
  await User.deleteMany({});
  await Event.deleteMany({});
  await ShortLink.deleteMany({});
});

describe("Short link creation per-IP rate limiting", () => {
  test("blocks after IP limit reached across multiple users", async () => {
    process.env.RESET_RATE_LIMITER = "true";
    process.env.SHORTLINK_CREATE_LIMIT_PER_USER = "100"; // ensure user limit not hit first
    process.env.SHORTLINK_CREATE_LIMIT_PER_IP = "4"; // small IP limit for test

    // We'll create 4 events and 4 users, each making one short link successfully, then the 5th attempt (new user/event) should be blocked by IP limit.
    const createdEvents: string[] = [];

    for (let i = 0; i < 4; i++) {
      const creatorId = await ensureCreatorUser();
      const authHeader = `Bearer test-${creatorId}`;
      const evt = await Event.create({
        ...buildValidEventPayload(),
        publish: true,
        roles: [
          {
            name: "Public",
            description: "Public role",
            maxParticipants: 10,
            openToPublic: true,
            id: new mongoose.Types.ObjectId().toString(),
          },
        ],
        createdBy: creatorId,
      });
      if (!(evt as any).publicSlug) {
        (evt as any).publicSlug = `test-event-${evt._id.toString().slice(-6)}`;
      }
      if (!(evt as any).publishedAt) {
        (evt as any).publishedAt = new Date();
      }
      await evt.save();
      createdEvents.push(evt._id.toString());
      const res = await request(app)
        .post("/api/public/short-links")
        .set("Authorization", authHeader)
        .send({ eventId: evt._id.toString() })
        .expect(201);
      expect(res.body.data.key).toBeTruthy();
    }

    // 5th attempt with a new user and event should now hit IP limit.
    const creatorId5 = await ensureCreatorUser();
    const authHeader5 = `Bearer test-${creatorId5}`;
    const evt5 = await Event.create({
      ...buildValidEventPayload(),
      publish: true,
      roles: [
        {
          name: "Public",
          description: "Public role",
          maxParticipants: 10,
          openToPublic: true,
          id: new mongoose.Types.ObjectId().toString(),
        },
      ],
      createdBy: creatorId5,
    });
    if (!(evt5 as any).publicSlug) {
      (evt5 as any).publicSlug = `test-event-${evt5._id.toString().slice(-6)}`;
    }
    if (!(evt5 as any).publishedAt) {
      (evt5 as any).publishedAt = new Date();
    }
    await evt5.save();

    const blocked = await request(app)
      .post("/api/public/short-links")
      .set("Authorization", authHeader5)
      .send({ eventId: evt5._id.toString() })
      .expect(429);
    expect(blocked.body.code).toBe("RATE_LIMIT_IP");
  });
});
