import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import NotificationOutbox, {
  notificationOutboxTerminalPurgeAt,
} from "../../../src/models/NotificationOutbox";
import { NotificationOutboxService } from "../../../src/services/reliability/NotificationOutboxService";
import { ensureIntegrationDB } from "../setup/connect";

const SUPPORTED_DELIVERIES = [
  { topic: "retention.integration", payloadVersion: 1 },
] as const;

describe("NotificationOutbox retention", () => {
  beforeAll(async () => {
    expect(process.env.MONGODB_TEST_URI).toBeTruthy();
    await ensureIntegrationDB();
    await NotificationOutbox.init();
  });

  beforeEach(async () => {
    await NotificationOutbox.deleteMany({});
  });

  afterAll(async () => {
    await NotificationOutbox.deleteMany({});
  });

  it("persists exact terminal purge clocks while active events remain unarmed", async () => {
    const now = new Date();
    const service = new NotificationOutboxService({ now: () => new Date(now) });
    const deliveredEvent = await service.enqueueStandalone({
      topic: "retention.integration",
      dedupeKey: "delivered",
      payloadVersion: 1,
      payload: { kind: "delivered" },
    });
    const deliveredClaim = await service.claimNext(
      "retention-worker",
      SUPPORTED_DELIVERIES,
    );
    expect(deliveredClaim?.eventId).toBe(deliveredEvent.eventId);
    if (!deliveredClaim) throw new Error("Expected delivered-event claim");
    await service.finalizeDelivered(deliveredClaim);

    const deadEvent = await service.enqueueStandalone({
      topic: "retention.integration",
      dedupeKey: "dead",
      payloadVersion: 1,
      payload: { kind: "dead" },
    });
    const deadClaim = await service.claimNext(
      "retention-worker",
      SUPPORTED_DELIVERIES,
    );
    expect(deadClaim?.eventId).toBe(deadEvent.eventId);
    if (!deadClaim) throw new Error("Expected dead-event claim");
    await service.finalizeFailure(deadClaim, {
      code: "PERMANENT_FAILURE",
      retryable: false,
    });

    await service.enqueueStandalone({
      topic: "retention.integration",
      dedupeKey: "pending",
      payloadVersion: 1,
      payload: { kind: "pending" },
      nextAttemptAt: new Date(now.getTime() + 60_000),
    });

    await expect(
      NotificationOutbox.findOne({ eventId: deliveredEvent.eventId }).lean(),
    ).resolves.toMatchObject({
      status: "delivered",
      deliveredAt: now,
      purgeAt: notificationOutboxTerminalPurgeAt("delivered", now),
    });
    await expect(
      NotificationOutbox.findOne({ eventId: deadEvent.eventId }).lean(),
    ).resolves.toMatchObject({
      status: "dead",
      deadAt: now,
      purgeAt: notificationOutboxTerminalPurgeAt("dead", now),
    });
    const pending = await NotificationOutbox.findOne({
      dedupeKeyHash: { $nin: [deliveredEvent.dedupeKeyHash, deadEvent.dedupeKeyHash] },
    }).lean();
    expect(pending).toMatchObject({ status: "pending", purgeAt: null });

    const indexes = await NotificationOutbox.collection.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "purgeAt_1",
          key: { purgeAt: 1 },
          expireAfterSeconds: 0,
        }),
      ]),
    );
  });
});
