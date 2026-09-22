import request from "supertest";
import app from "../../../src/app";
import mongoose from "mongoose";
import Event from "../../../src/models/Event";
import User from "../../../src/models/User";
import ShortLink from "../../../src/models/ShortLink";
import { beforeAll, afterAll, afterEach, describe, test, expect } from "vitest";
import {
  buildValidEventPayload,
  ensureCreatorUser,
} from "../../test-utils/eventTestHelpers";

let openedLocal = false;
const originalShortLinkEnvironment = {
  TEST_DISABLE_PUBLIC_RL: process.env.TEST_DISABLE_PUBLIC_RL,
  SLC_RESERVED_KEYS: process.env.SLC_RESERVED_KEYS,
};

function restoreEnvironment(
  name: keyof typeof originalShortLinkEnvironment,
  value: string | undefined,
): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(async () => {
  process.env.TEST_DISABLE_PUBLIC_RL = "true"; // simplify (we are not testing rate limit here)
  process.env.SLC_RESERVED_KEYS = "admin,metrics,login";
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
    originalShortLinkEnvironment.TEST_DISABLE_PUBLIC_RL,
  );
  restoreEnvironment(
    "SLC_RESERVED_KEYS",
    originalShortLinkEnvironment.SLC_RESERVED_KEYS,
  );
  if (openedLocal && mongoose.connection.readyState !== 0) {
    // Shared integration harness owns connection lifecycle.
  }
});

afterEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    Event.deleteMany({}),
    ShortLink.deleteMany({}),
  ]);
});

async function makePublishedEvent(creatorId: string) {
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
  return evt._id.toString();
}

describe("Custom short link keys", () => {
  test("creates with custom key and idempotent reuse", async () => {
    const creatorId = await ensureCreatorUser();
    const authHeader = `Bearer test-${creatorId}`;
    const eventId = await makePublishedEvent(creatorId);
    const res1 = await request(app)
      .post("/api/public/short-links")
      .set("Authorization", authHeader)
      .send({ eventId, customKey: "my-custom_key" })
      .expect(201);
    expect(res1.body.data.key).toBe("my-custom_key");

    // Second call (different custom key) should ignore new key and return existing link
    const res2 = await request(app)
      .post("/api/public/short-links")
      .set("Authorization", authHeader)
      .send({ eventId, customKey: "another-key" })
      .expect(200);
    expect(res2.body.data.key).toBe("my-custom_key");
  });

  test("rejects invalid pattern", async () => {
    const creatorId = await ensureCreatorUser();
    const authHeader = `Bearer test-${creatorId}`;
    const eventId = await makePublishedEvent(creatorId);
    const bad = await request(app)
      .post("/api/public/short-links")
      .set("Authorization", authHeader)
      .send({ eventId, customKey: "Bad Space" })
      .expect(400);
    expect(bad.body.code).toBe("CUSTOM_KEY_INVALID");
  });

  test("rejects reserved key", async () => {
    const creatorId = await ensureCreatorUser();
    const authHeader = `Bearer test-${creatorId}`;
    const eventId = await makePublishedEvent(creatorId);
    const bad = await request(app)
      .post("/api/public/short-links")
      .set("Authorization", authHeader)
      .send({ eventId, customKey: "metrics" })
      .expect(400);
    expect(bad.body.code).toBe("CUSTOM_KEY_RESERVED");
  });

  test("rejects taken key (collision)", async () => {
    const creator1 = await ensureCreatorUser();
    const auth1 = `Bearer test-${creator1}`;
    const event1 = await makePublishedEvent(creator1);
    await request(app)
      .post("/api/public/short-links")
      .set("Authorization", auth1)
      .send({ eventId: event1, customKey: "shared-key" })
      .expect(201);

    const creator2 = await ensureCreatorUser();
    const auth2 = `Bearer test-${creator2}`;
    const event2 = await makePublishedEvent(creator2);
    const taken = await request(app)
      .post("/api/public/short-links")
      .set("Authorization", auth2)
      .send({ eventId: event2, customKey: "shared-key" })
      .expect(409);
    expect(taken.body.code).toBe("CUSTOM_KEY_TAKEN");
  });
});
