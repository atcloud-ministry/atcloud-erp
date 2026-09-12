import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientSession } from "mongoose";
import type { INotificationOutbox } from "../../../../src/models/NotificationOutbox";
import {
  NotificationOutboxIdempotencyConflictError,
  NotificationOutboxLeaseLostError,
  NotificationOutboxService,
  type ClaimedNotificationOutbox,
} from "../../../../src/services/reliability/NotificationOutboxService";
import { NotificationOutboxMetrics } from "../../../../src/services/reliability/NotificationOutboxMetrics";
import {
  hashOutboxDedupeKey,
  hashOutboxPayload,
  normalizeOutboxPayload,
} from "../../../../src/services/reliability/OutboxPayload";

const NOW = new Date("2026-09-08T12:00:00.000Z");
const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_EVENT_ID = "22222222-2222-4222-8222-222222222222";
const LEASE_TOKEN = "33333333-3333-4333-8333-333333333333";

function document(
  overrides: Partial<INotificationOutbox> = {},
): INotificationOutbox {
  const payload = normalizeOutboxPayload({ messageId: "message-1" });
  return {
    eventId: EVENT_ID,
    topic: "system_message.created",
    dedupeKeyHash: hashOutboxDedupeKey("message-1:user-1"),
    payloadVersion: 1,
    payload,
    payloadHash: hashOutboxPayload(1, payload),
    status: "pending",
    attemptCount: 0,
    maxAttempts: 3,
    nextAttemptAt: NOW,
    leaseToken: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastHeartbeatAt: null,
    unsupportedSince: null,
    lastAttemptAt: null,
    deliveredAt: null,
    deadAt: null,
    lastErrorCode: null,
    lastErrorDigest: null,
    lastErrorAt: null,
    correlationId: null,
    revision: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as unknown as INotificationOutbox;
}

function claim(
  overrides: Partial<ClaimedNotificationOutbox> = {},
): ClaimedNotificationOutbox {
  return {
    ...document({
      status: "processing",
      attemptCount: 1,
      leaseToken: LEASE_TOKEN,
      leaseOwner: "worker-1",
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      lastHeartbeatAt: NOW,
      lastAttemptAt: NOW,
    }),
    status: "processing",
    leaseToken: LEASE_TOKEN,
    leaseOwner: "worker-1",
    leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    ...overrides,
  } as ClaimedNotificationOutbox;
}

describe("NotificationOutboxService", () => {
  let model: {
    findOneAndUpdate: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    countDocuments: ReturnType<typeof vi.fn>;
  };
  let metrics: NotificationOutboxMetrics;
  let service: NotificationOutboxService;

  beforeEach(() => {
    model = {
      findOneAndUpdate: vi.fn(),
      findOne: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ acknowledged: true }),
      countDocuments: vi.fn().mockResolvedValue(0),
    };
    metrics = new NotificationOutboxMetrics();
    service = new NotificationOutboxService({
      model,
      metrics,
      now: () => NOW,
      eventId: () => EVENT_ID,
      leaseToken: () => LEASE_TOKEN,
      random: () => 0,
      config: {
        leaseDurationMs: 60_000,
        defaultMaxAttempts: 3,
        baseBackoffMs: 2_000,
        maxBackoffMs: 30_000,
      },
    });
  });

  it("enqueues an event without persisting the raw dedupe key", async () => {
    model.findOneAndUpdate.mockResolvedValue(document());

    const result = await service.enqueueStandalone({
      topic: "system_message.created",
      dedupeKey: " message-1:user-1 ",
      payloadVersion: 1,
      payload: { messageId: "message-1" },
    });

    expect(result.eventId).toBe(EVENT_ID);
    const [filter, update] = model.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({
      topic: "system_message.created",
      dedupeKeyHash: hashOutboxDedupeKey("message-1:user-1"),
    });
    expect(JSON.stringify(update)).not.toContain("message-1:user-1");
    expect(update.$setOnInsert).not.toHaveProperty("createdAt");
    expect(update.$setOnInsert).not.toHaveProperty("updatedAt");
    expect(metrics.snapshot()).toMatchObject({ enqueued: 1, deduplicated: 0 });
  });

  it("returns the stable existing event for an idempotent retry", async () => {
    model.findOneAndUpdate.mockResolvedValue(
      document({ eventId: OTHER_EVENT_ID }),
    );

    const result = await service.enqueueStandalone({
      topic: "system_message.created",
      dedupeKey: "message-1:user-1",
      payloadVersion: 1,
      payload: { messageId: "message-1" },
    });

    expect(result.eventId).toBe(OTHER_EVENT_ID);
    expect(metrics.snapshot().deduplicated).toBe(1);
  });

  it("rejects a non-UUID generated eventId before enqueueing", async () => {
    const invalidEventIdService = new NotificationOutboxService({
      model,
      metrics,
      now: () => NOW,
      eventId: () => "event-id",
    });

    await expect(
      invalidEventIdService.enqueueStandalone({
        topic: "system_message.created",
        dedupeKey: "message-1:user-1",
        payloadVersion: 1,
        payload: { messageId: "message-1" },
      }),
    ).rejects.toThrow("Invalid notification outbox eventId");
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("rejects reuse of a topic/key with different content", async () => {
    model.findOneAndUpdate.mockResolvedValue(
      document({ payloadHash: "f".repeat(64) }),
    );

    await expect(
      service.enqueueStandalone({
        topic: "system_message.created",
        dedupeKey: "message-1:user-1",
        payloadVersion: 1,
        payload: { messageId: "message-1" },
      }),
    ).rejects.toBeInstanceOf(NotificationOutboxIdempotencyConflictError);
    expect(metrics.snapshot().idempotencyConflicts).toBe(1);
  });

  it("recovers a concurrent duplicate insert outside a transaction", async () => {
    model.findOneAndUpdate.mockRejectedValue({ code: 11000 });
    model.findOne.mockResolvedValue(document({ eventId: OTHER_EVENT_ID }));

    const result = await service.enqueueStandalone({
      topic: "system_message.created",
      dedupeKey: "message-1:user-1",
      payloadVersion: 1,
      payload: { messageId: "message-1" },
    });

    expect(result.eventId).toBe(OTHER_EVENT_ID);
    expect(model.findOne).toHaveBeenCalledOnce();
  });

  it("requires an active ClientSession for transactional enqueue", async () => {
    const activeSession = {
      inTransaction: vi.fn(() => true),
    } as unknown as ClientSession;
    model.findOneAndUpdate.mockResolvedValue(document());

    await service.enqueueInTransaction({
      topic: "system_message.created",
      dedupeKey: "message-1:user-1",
      payloadVersion: 1,
      payload: { messageId: "message-1" },
      session: activeSession,
    });

    expect(activeSession.inTransaction).toHaveBeenCalledOnce();
    expect(model.findOneAndUpdate.mock.calls[0][2]).toMatchObject({
      session: activeSession,
    });

    const inactiveSession = {
      inTransaction: vi.fn(() => false),
    } as unknown as ClientSession;
    await expect(
      service.enqueueInTransaction({
        topic: "system_message.created",
        dedupeKey: "message-2:user-1",
        payloadVersion: 1,
        payload: { messageId: "message-2" },
        session: inactiveSession,
      }),
    ).rejects.toThrow("requires an active ClientSession");
    expect(model.findOneAndUpdate).toHaveBeenCalledOnce();
  });

  it("rejects a hidden session at the standalone boundary", async () => {
    await expect(
      service.enqueueStandalone({
        topic: "system_message.created",
        dedupeKey: "message-1:user-1",
        payloadVersion: 1,
        payload: { messageId: "message-1" },
        session: {} as never,
      }),
    ).rejects.toThrow("standalone enqueue does not accept a ClientSession");
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("atomically claims only supported topic versions with a fenced lease", async () => {
    model.findOneAndUpdate.mockResolvedValue(
      document({
        status: "processing",
        attemptCount: 1,
        leaseToken: LEASE_TOKEN,
        leaseOwner: "worker-1",
        leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      }),
    );

    const result = await service.claimNext("worker-1", [
      { topic: "system_message.created", payloadVersion: 1 },
    ]);

    expect(result).toMatchObject({
      eventId: EVENT_ID,
      status: "processing",
      attemptCount: 1,
      leaseToken: LEASE_TOKEN,
    });
    const [filter, update, options] = model.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({
      status: "pending",
      $or: [{ topic: "system_message.created", payloadVersion: 1 }],
      $expr: { $lt: ["$attemptCount", "$maxAttempts"] },
    });
    expect(update).toMatchObject({
      $set: {
        status: "processing",
        leaseToken: LEASE_TOKEN,
        leaseOwner: "worker-1",
      },
      $inc: { attemptCount: 1, revision: 1 },
    });
    expect(options.sort).toEqual({ nextAttemptAt: 1, createdAt: 1, _id: 1 });
    expect(metrics.snapshot().claimed).toBe(1);
  });

  it("does not query when no handler version is supported", async () => {
    await expect(service.claimNext("worker-1", [])).resolves.toBeNull();
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID lease token before claiming", async () => {
    const invalidTokenService = new NotificationOutboxService({
      model,
      metrics,
      now: () => NOW,
      leaseToken: () => "lease-token",
    });

    await expect(
      invalidTokenService.claimNext("worker-1", [
        { topic: "system_message.created", payloadVersion: 1 },
      ]),
    ).rejects.toThrow("Invalid notification outbox leaseToken");
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("renews only a live matching lease", async () => {
    model.findOneAndUpdate.mockResolvedValue(
      document({
        status: "processing",
        attemptCount: 1,
        leaseToken: LEASE_TOKEN,
        leaseOwner: "worker-1",
        leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      }),
    );

    await service.renewLease(claim());
    expect(model.findOneAndUpdate.mock.calls[0][0]).toMatchObject({
      eventId: EVENT_ID,
      status: "processing",
      leaseToken: LEASE_TOKEN,
      leaseOwner: "worker-1",
      leaseExpiresAt: { $gt: NOW },
    });
    expect(model.findOneAndUpdate.mock.calls[0][1]).toEqual({
      $set: {
        lastHeartbeatAt: NOW,
        updatedAt: NOW,
      },
      $max: {
        leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      },
    });
    expect(metrics.snapshot().leasesRenewed).toBe(1);
  });

  it("atomically defers a live claim without consuming its attempt", async () => {
    const deferredAt = new Date(NOW.getTime() + 2_000);
    model.findOneAndUpdate.mockResolvedValue(
      document({
        status: "pending",
        attemptCount: 0,
        nextAttemptAt: deferredAt,
        revision: 2,
      }),
    );

    const result = await service.deferClaim(claim());

    expect(result).toMatchObject({
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: deferredAt,
    });
    const [filter, update] = model.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({
      eventId: EVENT_ID,
      status: "processing",
      attemptCount: 1,
      leaseToken: LEASE_TOKEN,
      leaseOwner: "worker-1",
      leaseExpiresAt: { $gt: NOW },
    });
    expect(update).toEqual({
      $set: {
        status: "pending",
        nextAttemptAt: deferredAt,
        updatedAt: NOW,
      },
      $unset: {
        leaseToken: "",
        leaseOwner: "",
        leaseExpiresAt: "",
        lastHeartbeatAt: "",
      },
      $inc: { attemptCount: -1, revision: 1 },
    });
    expect(update.$set).not.toHaveProperty("lastErrorCode");
  });

  it("cannot defer a claim whose attempt count could decrement below zero", async () => {
    await expect(
      service.deferClaim(claim({ attemptCount: 0 })),
    ).rejects.toThrow("Deferred notification outbox claim is invalid");
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("fences deferred claim release with the live lease", async () => {
    model.findOneAndUpdate.mockResolvedValue(null);

    await expect(service.deferClaim(claim())).rejects.toBeInstanceOf(
      NotificationOutboxLeaseLostError,
    );
    expect(metrics.snapshot().leaseLost).toBe(1);
  });

  it("rejects stale-token finalization", async () => {
    model.findOneAndUpdate.mockResolvedValue(null);
    await expect(service.finalizeDelivered(claim())).rejects.toBeInstanceOf(
      NotificationOutboxLeaseLostError,
    );
    expect(model.findOneAndUpdate.mock.calls[0][0]).toMatchObject({
      leaseToken: LEASE_TOKEN,
      leaseOwner: "worker-1",
    });
    expect(metrics.snapshot().leaseLost).toBe(1);
  });

  it("fences success and failure finalization when the lease expires at now", async () => {
    model.findOneAndUpdate.mockResolvedValue(null);
    const expired = claim({ leaseExpiresAt: NOW });

    await expect(service.finalizeDelivered(expired)).rejects.toBeInstanceOf(
      NotificationOutboxLeaseLostError,
    );
    await expect(
      service.finalizeFailure(expired, {
        code: "DELIVERY_FAILED",
        retryable: true,
      }),
    ).rejects.toBeInstanceOf(NotificationOutboxLeaseLostError);

    expect(model.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(model.findOneAndUpdate.mock.calls[0][0]).toMatchObject({
      leaseExpiresAt: { $gt: NOW },
    });
    expect(model.findOneAndUpdate.mock.calls[1][0]).toMatchObject({
      leaseExpiresAt: { $gt: NOW },
    });
    expect(metrics.snapshot().leaseLost).toBe(2);
  });

  it("finalizes successful delivery and clears its lease", async () => {
    model.findOneAndUpdate.mockResolvedValue(
      document({ status: "delivered", deliveredAt: NOW, nextAttemptAt: null }),
    );

    const result = await service.finalizeDelivered(claim());

    expect(result.status).toBe("delivered");
    expect(model.findOneAndUpdate.mock.calls[0][1]).toMatchObject({
      $set: { status: "delivered", deliveredAt: NOW },
      $unset: { leaseToken: "", leaseOwner: "", leaseExpiresAt: "" },
    });
    expect(metrics.snapshot().delivered).toBe(1);
  });

  it("schedules retry with exponential backoff and no raw error", async () => {
    const retryAt = new Date(NOW.getTime() + 1_000);
    model.findOneAndUpdate.mockResolvedValue(
      document({
        status: "pending",
        attemptCount: 1,
        nextAttemptAt: retryAt,
        lastErrorCode: "SMTP_TIMEOUT",
      }),
    );

    const result = await service.finalizeFailure(claim(), {
      code: "smtp-timeout",
      retryable: true,
      cause: new Error("private recipient details"),
    });

    expect(result.status).toBe("pending");
    const update = model.findOneAndUpdate.mock.calls[0][1];
    expect(update.$set).toMatchObject({
      status: "pending",
      nextAttemptAt: retryAt,
      lastErrorCode: "SMTP_TIMEOUT",
    });
    expect(JSON.stringify(update)).not.toContain("private recipient details");
    expect(metrics.snapshot().retryScheduled).toBe(1);
  });

  it.each([
    [{ retryable: false, code: "invalid-target" }, 1],
    [{ retryable: true, code: "temporary" }, 3],
  ])("dead-letters permanent or exhausted failures", async (failure, attempts) => {
    model.findOneAndUpdate.mockResolvedValue(
      document({
        status: "dead",
        attemptCount: attempts,
        nextAttemptAt: null,
        deadAt: NOW,
      }),
    );

    const result = await service.finalizeFailure(
      claim({ attemptCount: attempts }),
      failure,
    );

    expect(result.status).toBe("dead");
    expect(model.findOneAndUpdate.mock.calls[0][1].$set).toMatchObject({
      status: "dead",
      deadAt: NOW,
    });
    expect(metrics.snapshot().deadLettered).toBe(1);
  });

  it("reconciles exhausted pending events and expired processing leases", async () => {
    model.findOneAndUpdate
      .mockResolvedValueOnce(document({ status: "dead", deadAt: NOW }))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        document({
          status: "pending",
          attemptCount: 1,
          nextAttemptAt: NOW,
          lastErrorCode: "LEASE_EXPIRED",
        }),
      )
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const result = await service.reconcile(5);

    expect(result).toEqual({
      recoveredExpiredLeases: 1,
      deadLetteredExhausted: 1,
    });
    expect(metrics.snapshot()).toMatchObject({
      expiredLeasesRecovered: 1,
      deadLettered: 1,
    });
  });

  it("joins a caller-owned recovery transaction without publishing metrics before commit", async () => {
    const session = {
      inTransaction: vi.fn(() => true),
    } as unknown as ClientSession;
    const abortController = new AbortController();
    model.findOneAndUpdate.mockResolvedValueOnce(
      document({ status: "dead", deadAt: NOW }),
    );

    const result = await service.reconcile(1, {
      session,
      recordMetrics: false,
      maxTimeMS: 1_000,
      signal: abortController.signal,
    });

    expect(result).toEqual({
      recoveredExpiredLeases: 0,
      deadLetteredExhausted: 1,
    });
    expect(model.findOneAndUpdate.mock.calls[0][2]).toMatchObject({
      session,
      runValidators: true,
      maxTimeMS: 1_000,
      signal: abortController.signal,
    });
    expect(metrics.snapshot()).toMatchObject({
      expiredLeasesRecovered: 0,
      deadLettered: 0,
    });
  });

  it("rejects an invalid recovery query deadline before writing", async () => {
    await expect(service.reconcile(1, { maxTimeMS: 0 })).rejects.toThrow(
      "Invalid notification outbox reconciliation timeout",
    );
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("stops reconciliation when its caller signal is already aborted", async () => {
    const abortController = new AbortController();
    const reason = new Error("recovery deadline exceeded");
    abortController.abort(reason);

    await expect(
      service.reconcile(1, { signal: abortController.signal }),
    ).rejects.toBe(reason);
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("rejects recovery sessions that are not in an active transaction", async () => {
    const session = {
      inTransaction: vi.fn(() => false),
    } as unknown as ClientSession;

    await expect(service.reconcile(1, { session })).rejects.toThrow(
      "requires an active ClientSession",
    );
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("observes, counts, and dead-letters unsupported deliveries after grace", async () => {
    model.findOneAndUpdate
      .mockResolvedValueOnce(
        document({
          status: "dead",
          unsupportedSince: new Date(NOW.getTime() - 60_001),
          nextAttemptAt: null,
          deadAt: NOW,
          lastErrorCode: "HANDLER_NOT_REGISTERED",
        }),
      )
      .mockResolvedValueOnce(null);
    model.countDocuments.mockResolvedValue(2);

    const result = await service.reconcileUnsupportedDeliveries(
      [{ topic: "system_message.created", payloadVersion: 1 }],
      60_000,
      10,
    );

    expect(model.updateMany).toHaveBeenCalledTimes(2);
    expect(model.updateMany.mock.calls[0][0]).toMatchObject({
      status: "pending",
      unsupportedSince: { $ne: null },
      $or: [{ topic: "system_message.created", payloadVersion: 1 }],
    });
    expect(model.updateMany.mock.calls[1][0]).toMatchObject({
      status: "pending",
      $and: [
        {
          $nor: [{ topic: "system_message.created", payloadVersion: 1 }],
        },
        expect.objectContaining({ $or: expect.any(Array) }),
      ],
    });
    expect(model.findOneAndUpdate.mock.calls[0][0]).toMatchObject({
      status: "pending",
      unsupportedSince: {
        $lte: new Date(NOW.getTime() - 60_000),
      },
      $nor: [{ topic: "system_message.created", payloadVersion: 1 }],
    });
    expect(model.findOneAndUpdate.mock.calls[0][1]).toMatchObject({
      $set: {
        status: "dead",
        lastErrorCode: "HANDLER_NOT_REGISTERED",
      },
    });
    expect(result).toEqual({
      unsupportedPending: 2,
      unsupportedDeadLettered: 1,
    });
    expect(metrics.snapshot()).toMatchObject({
      unsupportedPending: 2,
      unsupportedDeadLettered: 1,
      deadLettered: 1,
    });
  });

  it("requires at least one supported delivery before unsupported reconciliation", async () => {
    await expect(
      service.reconcileUnsupportedDeliveries([], 60_000),
    ).rejects.toThrow("Invalid supported notification outbox deliveries");
    expect(model.updateMany).not.toHaveBeenCalled();
    expect(model.countDocuments).not.toHaveBeenCalled();
  });
});
