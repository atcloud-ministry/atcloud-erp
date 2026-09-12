import mongoose from "mongoose";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import NotificationOutbox from "../../../src/models/NotificationOutbox";
import { MongoTransactionService } from "../../../src/services/reliability/MongoTransactionService";
import {
  NotificationOutboxLeaseLostError,
  NotificationOutboxService,
} from "../../../src/services/reliability/NotificationOutboxService";
import { ensureIntegrationDB } from "../setup/connect";

const SUPPORTED_DELIVERIES = [
  { topic: "m0.reliability", payloadVersion: 1 },
] as const;

async function assertTransactionalTestTopology(): Promise<void> {
  const db = mongoose.connection.db;
  expect(db).toBeDefined();
  const hello = (await db!.admin().command({ hello: 1 })) as {
    msg?: unknown;
    setName?: unknown;
  };
  expect(
    hello.setName === "rs0" || hello.msg === "isdbgrid",
    `M0 reliability tests require rs0 or a sharded deployment; received ${JSON.stringify(
      { setName: hello.setName, msg: hello.msg },
    )}`,
  ).toBe(true);

  const capability = await new MongoTransactionService(
    mongoose.connection,
  ).assertTopologyCapability(true);
  expect(capability.supported).toBe(true);
  expect(["replica_set", "sharded"]).toContain(capability.topology);
}

describe("M0 durable outbox leases", () => {
  beforeAll(async () => {
    expect(process.env.MONGODB_TEST_URI).toBeTruthy();
    await ensureIntegrationDB();
    await NotificationOutbox.init();
    await assertTransactionalTestTopology();
  });

  beforeEach(async () => {
    await NotificationOutbox.deleteMany({});
  });

  afterAll(async () => {
    await NotificationOutbox.deleteMany({});
  });

  it("allows two concurrent claimers to claim an event only once", async () => {
    const now = new Date("2026-09-08T12:00:00.000Z");
    const clock = () => new Date(now);
    const producer = new NotificationOutboxService({ now: clock });
    const claimerA = new NotificationOutboxService({
      now: clock,
      leaseToken: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      config: { leaseDurationMs: 1_000 },
    });
    const claimerB = new NotificationOutboxService({
      now: clock,
      leaseToken: () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      config: { leaseDurationMs: 1_000 },
    });
    const event = await producer.enqueueStandalone({
      topic: "m0.reliability",
      dedupeKey: "concurrent-claim",
      payloadVersion: 1,
      payload: { notificationId: "notification-one" },
    });

    const claims = await Promise.all([
      claimerA.claimNext("worker-a", SUPPORTED_DELIVERIES),
      claimerB.claimNext("worker-b", SUPPORTED_DELIVERIES),
    ]);
    const successfulClaims = claims.filter((claim) => claim !== null);

    expect(successfulClaims).toHaveLength(1);
    expect(successfulClaims[0]).toMatchObject({
      eventId: event.eventId,
      status: "processing",
      attemptCount: 1,
    });
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);

    const persisted = await NotificationOutbox.findOne({
      eventId: event.eventId,
    }).lean();
    expect(persisted).toMatchObject({
      status: "processing",
      attemptCount: 1,
      revision: 1,
    });
  });

  it("defers a live claim without consuming its final allowed attempt", async () => {
    let nowMs = Date.parse("2026-09-08T12:30:00.000Z");
    const service = new NotificationOutboxService({
      now: () => new Date(nowMs),
      leaseToken: () => "abababab-abab-4bab-8bab-abababababab",
      config: { leaseDurationMs: 10_000, baseBackoffMs: 2_000 },
    });
    const event = await service.enqueueStandalone({
      topic: "m0.reliability",
      dedupeKey: "runtime-gate-deferred",
      payloadVersion: 1,
      payload: { notificationId: "notification-deferred" },
      maxAttempts: 1,
    });
    const claimed = await service.claimNext(
      "worker-deferred",
      SUPPORTED_DELIVERIES,
    );
    expect(claimed).not.toBeNull();
    if (!claimed) throw new Error("Expected an outbox claim");
    expect(claimed.attemptCount).toBe(1);

    const deferred = await service.deferClaim(claimed);

    expect(deferred).toMatchObject({
      eventId: event.eventId,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: new Date(nowMs + 2_000),
      revision: 2,
    });
    expect(deferred.lastErrorCode ?? null).toBeNull();
    expect(deferred.deadAt ?? null).toBeNull();
    expect(deferred.leaseToken ?? null).toBeNull();
    await expect(
      service.claimNext("worker-deferred", SUPPORTED_DELIVERIES),
    ).resolves.toBeNull();

    nowMs += 2_000;
    const reclaimed = await service.claimNext(
      "worker-deferred",
      SUPPORTED_DELIVERIES,
    );
    expect(reclaimed).toMatchObject({
      eventId: event.eventId,
      status: "processing",
      attemptCount: 1,
      revision: 3,
    });
  });

  it("reconciles an expired lease and fences its old token", async () => {
    let nowMs = Date.parse("2026-09-08T13:00:00.000Z");
    const clock = () => new Date(nowMs);
    const oldWorker = new NotificationOutboxService({
      now: clock,
      leaseToken: () => "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      config: { leaseDurationMs: 1_000 },
    });
    const newWorker = new NotificationOutboxService({
      now: clock,
      leaseToken: () => "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      config: { leaseDurationMs: 1_000 },
    });
    const event = await oldWorker.enqueueStandalone({
      topic: "m0.reliability",
      dedupeKey: "expired-lease",
      payloadVersion: 1,
      payload: { notificationId: "notification-two" },
    });
    const oldClaim = await oldWorker.claimNext(
      "worker-old",
      SUPPORTED_DELIVERIES,
    );
    expect(oldClaim).not.toBeNull();
    if (!oldClaim) throw new Error("Expected the first worker to claim the event");

    nowMs += 1_001;
    const reconciliation = await newWorker.reconcile(10);
    expect(reconciliation).toEqual({
      recoveredExpiredLeases: 1,
      deadLetteredExhausted: 0,
    });

    const recovered = await NotificationOutbox.findOne({
      eventId: event.eventId,
    }).lean();
    expect(recovered).toMatchObject({
      status: "pending",
      attemptCount: 1,
      revision: 2,
      lastErrorCode: "LEASE_EXPIRED",
    });
    expect(recovered?.leaseToken ?? null).toBeNull();
    expect(recovered?.leaseOwner ?? null).toBeNull();

    const newClaim = await newWorker.claimNext(
      "worker-new",
      SUPPORTED_DELIVERIES,
    );
    expect(newClaim).not.toBeNull();
    if (!newClaim) throw new Error("Expected the recovered event to be reclaimed");
    expect(newClaim).toMatchObject({
      eventId: event.eventId,
      leaseToken: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      leaseOwner: "worker-new",
      attemptCount: 2,
      revision: 3,
    });

    const staleLeaseError = await oldWorker.finalizeDelivered(oldClaim).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(staleLeaseError).toBeInstanceOf(NotificationOutboxLeaseLostError);
    expect(staleLeaseError).toMatchObject({
      eventId: event.eventId,
    });

    const stillOwnedByNewWorker = await NotificationOutbox.findOne({
      eventId: event.eventId,
    }).lean();
    expect(stillOwnedByNewWorker).toMatchObject({
      status: "processing",
      leaseToken: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      leaseOwner: "worker-new",
      revision: 3,
    });

    const delivered = await newWorker.finalizeDelivered(newClaim);
    expect(delivered).toMatchObject({
      status: "delivered",
      attemptCount: 2,
      revision: 4,
    });
  });

  it("fences both success and failure finalization at the expiry boundary", async () => {
    let nowMs = Date.parse("2026-09-08T14:00:00.000Z");
    const service = new NotificationOutboxService({
      now: () => new Date(nowMs),
      leaseToken: () => "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      config: { leaseDurationMs: 1_000 },
    });
    const event = await service.enqueueStandalone({
      topic: "m0.reliability",
      dedupeKey: "expiry-boundary",
      payloadVersion: 1,
      payload: { notificationId: "notification-three" },
    });
    const claimed = await service.claimNext(
      "worker-boundary",
      SUPPORTED_DELIVERIES,
    );
    expect(claimed).not.toBeNull();
    if (!claimed) throw new Error("Expected an outbox claim");

    nowMs += 1_000;
    await expect(service.finalizeDelivered(claimed)).rejects.toBeInstanceOf(
      NotificationOutboxLeaseLostError,
    );
    await expect(
      service.finalizeFailure(claimed, {
        code: "DELIVERY_FAILED",
        retryable: true,
      }),
    ).rejects.toBeInstanceOf(NotificationOutboxLeaseLostError);

    const persisted = await NotificationOutbox.findOne({
      eventId: event.eventId,
    }).lean();
    expect(persisted).toMatchObject({
      status: "processing",
      leaseToken: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      revision: 1,
    });
  });

  it("starts unsupported grace on observation and resets it when support returns", async () => {
    let nowMs = Date.parse("2026-09-08T15:00:00.000Z");
    const service = new NotificationOutboxService({
      now: () => new Date(nowMs),
    });
    const event = await service.enqueueStandalone({
      topic: "m0.unsupported",
      dedupeKey: "unsupported-grace",
      payloadVersion: 1,
      payload: { notificationId: "notification-four" },
    });

    await expect(
      service.reconcileUnsupportedDeliveries(SUPPORTED_DELIVERIES, 1_000, 10),
    ).resolves.toEqual({
      unsupportedPending: 1,
      unsupportedDeadLettered: 0,
    });
    let persisted = await NotificationOutbox.findOne({
      eventId: event.eventId,
    }).lean();
    expect(persisted?.unsupportedSince).toEqual(new Date(nowMs));

    nowMs += 500;
    await expect(
      service.reconcileUnsupportedDeliveries(
        [{ topic: "m0.unsupported", payloadVersion: 1 }],
        1_000,
        10,
      ),
    ).resolves.toEqual({
      unsupportedPending: 0,
      unsupportedDeadLettered: 0,
    });
    persisted = await NotificationOutbox.findOne({ eventId: event.eventId }).lean();
    expect(persisted?.unsupportedSince ?? null).toBeNull();

    nowMs += 100;
    await service.reconcileUnsupportedDeliveries(
      SUPPORTED_DELIVERIES,
      1_000,
      10,
    );
    const restartedGraceAt = new Date(nowMs);
    nowMs += 999;
    await expect(
      service.reconcileUnsupportedDeliveries(SUPPORTED_DELIVERIES, 1_000, 10),
    ).resolves.toEqual({
      unsupportedPending: 1,
      unsupportedDeadLettered: 0,
    });

    nowMs += 1;
    await expect(
      service.reconcileUnsupportedDeliveries(SUPPORTED_DELIVERIES, 1_000, 10),
    ).resolves.toEqual({
      unsupportedPending: 0,
      unsupportedDeadLettered: 1,
    });
    persisted = await NotificationOutbox.findOne({ eventId: event.eventId }).lean();
    expect(persisted).toMatchObject({
      status: "dead",
      unsupportedSince: restartedGraceAt,
      lastErrorCode: "HANDLER_NOT_REGISTERED",
    });
  });
});
