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

async function fetchMetricsLines() {
  const res = await request(app).get("/metrics");
  expect(res.status).toBe(200);
  return res.text.split("\n");
}

function counter(
  lines: string[],
  name: string,
  matcher?: (l: string) => boolean
): number {
  const candidates = lines.filter((l) => l.startsWith(name));
  if (!candidates.length) return 0;
  if (!matcher) {
    const plain = candidates.find((c) => c.startsWith(name + " "));
    if (plain) return Number(plain.split(/\s+/)[1]) || 0;
  }
  const line = candidates.find(matcher!);
  if (!line) return 0;
  const parts = line.split(/\s+/);
  return Number(parts[parts.length - 1]) || 0;
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

describe("Short link creation metrics", () => {
  test("attempt and failure counters increment (rate limit failure)", async () => {
    process.env.RESET_RATE_LIMITER = "true";
    process.env.SHORTLINK_CREATE_LIMIT_PER_USER = "2"; // small limit to trigger failure
    process.env.SHORTLINK_CREATE_LIMIT_PER_IP = "100"; // avoid IP limit interfering

    const creatorId = await ensureCreatorUser();
    const authHeader = `Bearer test-${creatorId}`;

    const before = await fetchMetricsLines();
    const attemptsBefore = counter(before, "shortlink_create_attempts_total");
    const failuresBeforeUser = counter(
      before,
      "shortlink_create_failures_total",
      (l) => l.includes('reason="rate_limit_user"')
    );

    // Two successful creates (within limit)
    for (let i = 0; i < 2; i++) {
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
      if (!(evt as any).publicSlug)
        (evt as any).publicSlug = `test-event-${evt._id.toString().slice(-6)}`;
      if (!(evt as any).publishedAt) (evt as any).publishedAt = new Date();
      await evt.save();
      const ok = await request(app)
        .post("/api/public/short-links")
        .set("Authorization", authHeader)
        .send({ eventId: evt._id.toString() });
      expect(ok.status).toBe(201);
    }

    // Third should hit user rate limit
    const evtFail = await Event.create({
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
    if (!(evtFail as any).publicSlug)
      (evtFail as any).publicSlug = `test-event-${evtFail._id
        .toString()
        .slice(-6)}`;
    if (!(evtFail as any).publishedAt)
      (evtFail as any).publishedAt = new Date();
    await evtFail.save();
    const blocked = await request(app)
      .post("/api/public/short-links")
      .set("Authorization", authHeader)
      .send({ eventId: evtFail._id.toString() });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("RATE_LIMIT_USER");

    const after = await fetchMetricsLines();
    const attemptsAfter = counter(after, "shortlink_create_attempts_total");
    const failuresAfterUser = counter(
      after,
      "shortlink_create_failures_total",
      (l) => l.includes('reason="rate_limit_user"')
    );

    expect(attemptsAfter).toBeGreaterThanOrEqual(attemptsBefore + 3); // 3 creation attempts total
    expect(failuresAfterUser).toBeGreaterThanOrEqual(failuresBeforeUser + 1); // 1 user rate limit failure
  });
});
