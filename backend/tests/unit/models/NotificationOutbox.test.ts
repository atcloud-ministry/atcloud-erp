import { describe, expect, it } from "vitest";
import NotificationOutbox from "../../../src/models/NotificationOutbox";
import {
  hashOutboxDedupeKey,
  hashOutboxPayload,
  normalizeOutboxPayload,
} from "../../../src/services/reliability/OutboxPayload";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";

function validDocument() {
  const payload = normalizeOutboxPayload({ messageId: "message-1" });
  return new NotificationOutbox({
    eventId: EVENT_ID,
    topic: "system_message.created",
    dedupeKeyHash: hashOutboxDedupeKey("message-1:user-1"),
    payloadVersion: 1,
    payload,
    payloadHash: hashOutboxPayload(1, payload),
    status: "pending",
    attemptCount: 0,
    maxAttempts: 8,
    nextAttemptAt: new Date("2026-09-08T12:00:00.000Z"),
  });
}

describe("NotificationOutbox model", () => {
  it("accepts a bounded pending event", async () => {
    await expect(validDocument().validate()).resolves.toBeUndefined();
  });

  it("requires complete leases only for processing events", async () => {
    const missingLease = validDocument();
    missingLease.status = "processing";
    await expect(missingLease.validate()).rejects.toThrow("complete lease");

    const pendingWithPartialLease = validDocument();
    pendingWithPartialLease.leaseToken =
      "22222222-2222-4222-8222-222222222222";
    await expect(pendingWithPartialLease.validate()).rejects.toThrow(
      "Only processing",
    );
  });

  it("requires a UUID lease token", async () => {
    const invalidToken = validDocument();
    invalidToken.status = "processing";
    invalidToken.leaseToken = "lease-token";
    invalidToken.leaseOwner = "worker-1";
    invalidToken.leaseExpiresAt = new Date("2026-09-08T12:01:00.000Z");

    await expect(invalidToken.validate()).rejects.toThrow(
      "Path `leaseToken` is invalid",
    );
  });

  it("requires terminal timestamps", async () => {
    const delivered = validDocument();
    delivered.status = "delivered";
    delivered.nextAttemptAt = null;
    await expect(delivered.validate()).rejects.toThrow("deliveredAt");

    const dead = validDocument();
    dead.status = "dead";
    dead.nextAttemptAt = null;
    await expect(dead.validate()).rejects.toThrow("deadAt");
  });

  it("rejects unsafe or oversized payloads", async () => {
    const unsafe = validDocument();
    unsafe.payload = { "$operator": "not-allowed" };
    await expect(unsafe.validate()).rejects.toThrow("bounded JSON");

    const oversized = validDocument();
    oversized.payload = { content: "x".repeat(8_193) };
    await expect(oversized.validate()).rejects.toThrow("bounded JSON");
  });

  it("declares stable event and topic/dedupe uniqueness indexes", () => {
    const indexes = NotificationOutbox.schema.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        [{ eventId: 1 }, expect.objectContaining({ unique: true })],
        [
          { topic: 1, dedupeKeyHash: 1 },
          expect.objectContaining({ unique: true }),
        ],
      ]),
    );
  });
});
