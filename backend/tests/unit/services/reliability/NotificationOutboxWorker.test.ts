import { beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../../../../src/services/LoggerService";
import {
  NotificationOutboxDeliveryRegistry,
  type NotificationOutboxDeliveryHandler,
} from "../../../../src/services/reliability/NotificationOutboxDeliveryRegistry";
import type {
  ClaimedNotificationOutbox,
  NotificationOutboxRecord,
} from "../../../../src/services/reliability/NotificationOutboxService";
import {
  DeferredNotificationOutboxDeliveryError,
  NotificationOutboxWorker,
  PermanentNotificationOutboxDeliveryError,
  type NotificationOutboxWorkerAuthorizer,
  type NotificationOutboxWorkerConfig,
  type NotificationOutboxWorkerTimers,
} from "../../../../src/services/reliability/NotificationOutboxWorker";

const NOW = new Date("2026-09-08T12:00:00.000Z");

function claim(
  overrides: Partial<ClaimedNotificationOutbox> = {},
): ClaimedNotificationOutbox {
  return {
    eventId: "11111111-1111-4111-8111-111111111111",
    topic: "system_message.created",
    dedupeKeyHash: "a".repeat(64),
    payloadVersion: 1,
    payload: { messageId: "message-1" },
    payloadHash: "b".repeat(64),
    status: "processing",
    attemptCount: 1,
    maxAttempts: 3,
    nextAttemptAt: NOW,
    leaseToken: "22222222-2222-4222-8222-222222222222",
    leaseOwner: "worker-1",
    leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    lastHeartbeatAt: NOW,
    lastAttemptAt: NOW,
    deliveredAt: null,
    deadAt: null,
    lastErrorCode: null,
    lastErrorDigest: null,
    lastErrorAt: null,
    correlationId: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function completed(
  source: ClaimedNotificationOutbox,
  status: "pending" | "delivered" | "dead",
): NotificationOutboxRecord {
  return {
    ...source,
    status,
    leaseToken: null,
    leaseOwner: null,
    leaseExpiresAt: null,
  } as NotificationOutboxRecord;
}

describe("NotificationOutboxDeliveryRegistry", () => {
  it("is immutable and rejects duplicate topic versions", () => {
    const handler: NotificationOutboxDeliveryHandler = {
      topic: "system_message.created",
      payloadVersion: 1,
      assertCanDeliver: vi.fn(),
      deliver: vi.fn(),
    };
    const registry = new NotificationOutboxDeliveryRegistry([handler]);

    expect(registry.supportedDeliveries).toEqual([
      { topic: "system_message.created", payloadVersion: 1 },
    ]);
    expect(Object.isFrozen(registry.supportedDeliveries)).toBe(true);
    expect(registry.get("system_message.created", 1)).toMatchObject({
      topic: handler.topic,
      payloadVersion: handler.payloadVersion,
    });
    expect(registry.get("system_message.created", 2)).toBeUndefined();
    expect(
      () => new NotificationOutboxDeliveryRegistry([handler, handler]),
    ).toThrow("Duplicate notification outbox handler");
    expect(
      () =>
        new NotificationOutboxDeliveryRegistry([
          { ...handler, topic: "INVALID TOPIC" },
        ]),
    ).toThrow("Invalid notification outbox handler");
    expect(
      () =>
        new NotificationOutboxDeliveryRegistry([
          {
            topic: handler.topic,
            payloadVersion: handler.payloadVersion,
            deliver: handler.deliver,
          } as NotificationOutboxDeliveryHandler,
        ]),
    ).toThrow("Invalid notification outbox handler");
  });

  it("keeps unavailable handlers supported for reconciliation but not claiming", async () => {
    const enabled: NotificationOutboxDeliveryHandler = {
      topic: "delivery.enabled",
      payloadVersion: 1,
      canClaim: vi.fn().mockResolvedValue(true),
      assertCanDeliver: vi.fn(),
      deliver: vi.fn(),
    };
    const disabled: NotificationOutboxDeliveryHandler = {
      topic: "delivery.disabled",
      payloadVersion: 1,
      canClaim: vi.fn().mockResolvedValue(false),
      assertCanDeliver: vi.fn(),
      deliver: vi.fn(),
    };
    const failed: NotificationOutboxDeliveryHandler = {
      topic: "delivery.failed",
      payloadVersion: 1,
      canClaim: vi.fn().mockRejectedValue(new Error("private config value")),
      assertCanDeliver: vi.fn(),
      deliver: vi.fn(),
    };
    const registry = new NotificationOutboxDeliveryRegistry([
      enabled,
      disabled,
      failed,
    ]);

    expect(registry.supportedDeliveries).toEqual([
      { topic: "delivery.enabled", payloadVersion: 1 },
      { topic: "delivery.disabled", payloadVersion: 1 },
      { topic: "delivery.failed", payloadVersion: 1 },
    ]);
    await expect(
      registry.getClaimableDeliveries(new AbortController().signal),
    ).resolves.toEqual([{ topic: "delivery.enabled", payloadVersion: 1 }]);
  });
});

describe("NotificationOutboxWorker", () => {
  let outbox: {
    leaseDurationMs: number;
    claimNext: ReturnType<typeof vi.fn>;
    renewLease: ReturnType<typeof vi.fn>;
    deferClaim: ReturnType<typeof vi.fn>;
    finalizeDelivered: ReturnType<typeof vi.fn>;
    finalizeFailure: ReturnType<typeof vi.fn>;
    reconcile: ReturnType<typeof vi.fn>;
    reconcileUnsupportedDeliveries: ReturnType<typeof vi.fn>;
  };
  let authorizer: NotificationOutboxWorkerAuthorizer;
  let handler: NotificationOutboxDeliveryHandler;

  beforeEach(() => {
    outbox = {
      leaseDurationMs: 60_000,
      claimNext: vi.fn(),
      renewLease: vi.fn(),
      deferClaim: vi.fn(),
      finalizeDelivered: vi.fn(),
      finalizeFailure: vi.fn(),
      reconcile: vi.fn().mockResolvedValue({
        recoveredExpiredLeases: 0,
        deadLetteredExhausted: 0,
      }),
      reconcileUnsupportedDeliveries: vi.fn().mockResolvedValue({
        unsupportedPending: 0,
        unsupportedDeadLettered: 0,
      }),
    };
    authorizer = {
      assertCanReconcile: vi.fn().mockResolvedValue(undefined),
      assertCanDeliver: vi.fn().mockResolvedValue(undefined),
    };
    handler = {
      topic: "system_message.created",
      payloadVersion: 1,
      assertCanDeliver: vi.fn().mockResolvedValue(undefined),
      deliver: vi.fn().mockResolvedValue(undefined),
    };
  });

  function worker(
    registry = new NotificationOutboxDeliveryRegistry([handler]),
    config: Partial<NotificationOutboxWorkerConfig> = {},
    timers?: NotificationOutboxWorkerTimers,
  ): NotificationOutboxWorker {
    return new NotificationOutboxWorker({
      outbox,
      registry,
      authorizer,
      workerId: "worker-1",
      config: {
        pollIntervalMs: 1_000,
        batchSize: 5,
        reconciliationLimit: 10,
        heartbeatIntervalMs: 15_000,
        ...config,
      },
      ...(timers ? { timers } : {}),
    });
  }

  it("authorizes reconciliation and delivery, then finalizes success", async () => {
    const event = claim();
    outbox.claimNext.mockResolvedValueOnce(event).mockResolvedValueOnce(null);
    outbox.finalizeDelivered.mockResolvedValue(completed(event, "delivered"));

    const result = await worker().runOnce();

    expect(authorizer.assertCanReconcile).toHaveBeenCalledOnce();
    expect(outbox.reconcile).toHaveBeenCalledWith(10);
    expect(outbox.reconcileUnsupportedDeliveries).toHaveBeenCalledWith(
      [{ topic: "system_message.created", payloadVersion: 1 }],
      24 * 60 * 60_000,
      10,
    );
    expect(outbox.claimNext).toHaveBeenCalledWith("worker-1", [
      { topic: "system_message.created", payloadVersion: 1 },
    ]);
    expect(authorizer.assertCanDeliver).toHaveBeenCalledWith(event);
    expect(handler.assertCanDeliver).toHaveBeenCalledWith(
      event,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        renewLease: expect.any(Function),
      }),
    );
    expect(handler.deliver).toHaveBeenCalledWith(
      event,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        renewLease: expect.any(Function),
      }),
    );
    expect(outbox.finalizeDelivered).toHaveBeenCalledWith(event);
    expect(result).toMatchObject({ claimed: 1, delivered: 1 });
  });

  it("does not claim when reconciliation authorization fails", async () => {
    vi.mocked(authorizer.assertCanReconcile).mockRejectedValue(
      new Error("denied"),
    );

    await expect(worker().runOnce()).rejects.toThrow("denied");
    expect(outbox.reconcile).not.toHaveBeenCalled();
    expect(outbox.claimNext).not.toHaveBeenCalled();
  });

  it("does not claim unavailable handlers while reconciling them as supported", async () => {
    handler = { ...handler, canClaim: vi.fn().mockResolvedValue(false) };

    const result = await worker().runOnce();

    expect(outbox.reconcileUnsupportedDeliveries).toHaveBeenCalledWith(
      [{ topic: "system_message.created", payloadVersion: 1 }],
      24 * 60 * 60_000,
      10,
    );
    expect(outbox.claimNext).toHaveBeenCalledWith("worker-1", []);
    expect(outbox.claimNext).toHaveBeenCalledOnce();
    expect(handler.assertCanDeliver).not.toHaveBeenCalled();
    expect(handler.deliver).not.toHaveBeenCalled();
    expect(result).toMatchObject({ claimed: 0, deferred: 0 });
  });

  it("bounds a hanging handler availability check before any claim", async () => {
    vi.useFakeTimers();
    try {
      handler = {
        ...handler,
        canClaim: vi.fn(() => new Promise<boolean>(() => undefined)),
      };
      const run = worker(undefined, { authorizationTimeoutMs: 100 }).runOnce();
      const rejection = expect(run).rejects.toMatchObject({
        code: "WORKER_AVAILABILITY_TIMEOUT",
      });

      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      expect(outbox.claimNext).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a hanging run-level authorization", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(authorizer.assertCanReconcile).mockImplementation(
        () => new Promise<void>(() => undefined),
      );
      const run = worker(undefined, { authorizationTimeoutMs: 100 }).runOnce();
      const rejection = expect(run).rejects.toMatchObject({
        code: "WORKER_AUTHORIZATION_TIMEOUT",
      });

      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      expect(outbox.reconcile).not.toHaveBeenCalled();
      expect(outbox.claimNext).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs scheduled run failures without raw error fields", async () => {
    vi.useFakeTimers();
    try {
      const sensitiveError = Object.assign(
        new Error("private-recipient@example.com"),
        {
          name: "private-recipient-name",
          code: "private-recipient-code",
        },
      );
      vi.mocked(authorizer.assertCanReconcile).mockRejectedValue(sensitiveError);
      const errorLog = vi
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => undefined);
      const instance = worker();

      instance.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(errorLog).toHaveBeenCalledWith(
        "Notification outbox worker run failed",
        undefined,
        undefined,
        { outcome: "run_failed" },
      );
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
        "private-recipient",
      );
      await instance.stop();
      errorLog.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists retryable handler failures", async () => {
    const event = claim();
    outbox.claimNext.mockResolvedValueOnce(event).mockResolvedValueOnce(null);
    vi.mocked(handler.deliver).mockRejectedValue(new Error("temporary"));
    outbox.finalizeFailure.mockResolvedValue(completed(event, "pending"));

    const result = await worker().runOnce();

    expect(outbox.finalizeFailure).toHaveBeenCalledWith(
      event,
      expect.objectContaining({
        code: "DELIVERY_FAILED",
        retryable: true,
      }),
    );
    expect(result.retried).toBe(1);
  });

  it("releases a post-claim runtime deferral without consuming an attempt", async () => {
    const event = claim({ attemptCount: 3, maxAttempts: 3 });
    outbox.claimNext.mockResolvedValueOnce(event).mockResolvedValueOnce(null);
    vi.mocked(handler.assertCanDeliver).mockRejectedValue(
      new DeferredNotificationOutboxDeliveryError(
        "ALUMNI_NETWORK_NOT_WRITABLE",
      ),
    );
    outbox.deferClaim.mockResolvedValue(
      completed({ ...event, attemptCount: 2 }, "pending"),
    );

    const result = await worker().runOnce();

    expect(handler.deliver).not.toHaveBeenCalled();
    expect(outbox.deferClaim).toHaveBeenCalledWith(event);
    expect(outbox.finalizeFailure).not.toHaveBeenCalled();
    expect(outbox.finalizeDelivered).not.toHaveBeenCalled();
    expect(result).toMatchObject({ claimed: 1, deferred: 1, deadLettered: 0 });
  });

  it("persists permanent handler failures as dead", async () => {
    const event = claim();
    outbox.claimNext.mockResolvedValueOnce(event).mockResolvedValueOnce(null);
    vi.mocked(handler.deliver).mockRejectedValue(
      new PermanentNotificationOutboxDeliveryError("INVALID_TARGET"),
    );
    outbox.finalizeFailure.mockResolvedValue(completed(event, "dead"));

    const result = await worker().runOnce();

    expect(outbox.finalizeFailure).toHaveBeenCalledWith(
      event,
      expect.objectContaining({ code: "INVALID_TARGET", retryable: false }),
    );
    expect(result.deadLettered).toBe(1);
  });

  it("requires handler recipient/resource authorization before delivery", async () => {
    const event = claim();
    outbox.claimNext.mockResolvedValueOnce(event).mockResolvedValueOnce(null);
    vi.mocked(handler.assertCanDeliver).mockRejectedValue(
      new PermanentNotificationOutboxDeliveryError(
        "RECIPIENT_ACCESS_REVOKED",
      ),
    );
    outbox.finalizeFailure.mockResolvedValue(completed(event, "dead"));

    const result = await worker().runOnce();

    expect(handler.deliver).not.toHaveBeenCalled();
    expect(outbox.finalizeFailure).toHaveBeenCalledWith(
      event,
      expect.objectContaining({
        code: "RECIPIENT_ACCESS_REVOKED",
        retryable: false,
      }),
    );
    expect(result.deadLettered).toBe(1);
  });

  it("bounds a hanging generic authorization with the claim timeout", async () => {
    vi.useFakeTimers();
    try {
      const event = claim();
      outbox.claimNext.mockResolvedValueOnce(event).mockResolvedValueOnce(null);
      vi.mocked(authorizer.assertCanDeliver).mockImplementation(
        () => new Promise<void>(() => undefined),
      );
      outbox.finalizeFailure.mockResolvedValue(completed(event, "pending"));

      const run = worker(undefined, { deliveryTimeoutMs: 100 }).runOnce();
      await vi.advanceTimersByTimeAsync(101);
      const result = await run;

      expect(handler.assertCanDeliver).not.toHaveBeenCalled();
      expect(handler.deliver).not.toHaveBeenCalled();
      expect(outbox.finalizeFailure).toHaveBeenCalledWith(
        event,
        expect.objectContaining({ code: "DELIVERY_TIMEOUT", retryable: true }),
      );
      expect(result.retried).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("automatically renews a lease during a long delivery", async () => {
    vi.useFakeTimers();
    try {
      const event = claim();
      let finishDelivery: (() => void) | undefined;
      outbox.claimNext.mockResolvedValueOnce(event).mockResolvedValueOnce(null);
      outbox.renewLease.mockResolvedValue(event);
      outbox.finalizeDelivered.mockResolvedValue(completed(event, "delivered"));
      vi.mocked(handler.deliver).mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishDelivery = resolve;
          }),
      );

      const run = worker().runOnce();
      await vi.advanceTimersByTimeAsync(15_001);

      expect(outbox.renewLease).toHaveBeenCalledWith(event);
      finishDelivery?.();
      await run;
    } finally {
      vi.useRealTimers();
    }
  });

  it("abandons an in-flight delivery without finalizing when stopping", async () => {
    const event = claim();
    outbox.claimNext.mockResolvedValueOnce(event).mockResolvedValueOnce(null);
    vi.mocked(handler.deliver).mockImplementation(
      () => new Promise<void>(() => undefined),
    );
    const instance = worker();
    const run = instance.runOnce();
    await vi.waitFor(() => expect(handler.deliver).toHaveBeenCalledOnce());

    const stopping = instance.stop();
    const result = await run;
    await stopping;

    expect(result.abandoned).toBe(1);
    expect(outbox.finalizeDelivered).not.toHaveBeenCalled();
    expect(outbox.finalizeFailure).not.toHaveBeenCalled();
    expect(outbox.claimNext).toHaveBeenCalledOnce();
    const deliveryContext = vi.mocked(handler.deliver).mock.calls[0][1];
    await expect(deliveryContext.renewLease()).rejects.toThrow(
      "worker is stopping",
    );
    expect(outbox.renewLease).not.toHaveBeenCalled();
  });

  it("bounds shutdown even when a database reconciliation does not drain", async () => {
    vi.useFakeTimers();
    try {
      let finishReconciliation: (() => void) | undefined;
      outbox.reconcile.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishReconciliation = () =>
              resolve({
                recoveredExpiredLeases: 0,
                deadLetteredExhausted: 0,
              });
          }),
      );
      const timers: NotificationOutboxWorkerTimers = {
        now: () => Date.now(),
        setTimeout: vi.fn((callback, delayMs) =>
          setTimeout(callback, delayMs),
        ),
        clearTimeout: vi.fn((timer) => clearTimeout(timer)),
        setInterval: vi.fn((callback, delayMs) =>
          setInterval(callback, delayMs),
        ),
        clearInterval: vi.fn((timer) => clearInterval(timer)),
      };
      const instance = worker(undefined, { stopTimeoutMs: 25 }, timers);
      const run = instance.runOnce();
      await vi.waitFor(() => expect(outbox.reconcile).toHaveBeenCalledOnce());

      let stopped = false;
      const stopping = instance.stop().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(24);
      expect(stopped).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await stopping;
      expect(stopped).toBe(true);
      expect(timers.setTimeout).toHaveBeenCalledWith(expect.any(Function), 25);
      expect(outbox.claimNext).not.toHaveBeenCalled();

      finishReconciliation?.();
      await expect(run).rejects.toThrow("worker is stopping");
      expect(outbox.reconcileUnsupportedDeliveries).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off idle claims while running reconciliation on its own cadence", async () => {
    vi.useFakeTimers();
    try {
      outbox.claimNext.mockResolvedValue(null);
      const timers: NotificationOutboxWorkerTimers = {
        now: () => Date.now(),
        setTimeout: vi.fn((callback, delayMs) =>
          setTimeout(callback, delayMs),
        ),
        clearTimeout: vi.fn((timer) => clearTimeout(timer)),
        setInterval: vi.fn((callback, delayMs) =>
          setInterval(callback, delayMs),
        ),
        clearInterval: vi.fn((timer) => clearInterval(timer)),
      };
      const instance = worker(
        undefined,
        {
          pollIntervalMs: 1_000,
          maxIdlePollIntervalMs: 4_000,
          reconciliationIntervalMs: 10_000,
        },
        timers,
      );

      instance.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(outbox.claimNext).toHaveBeenCalledTimes(1);
      expect(outbox.reconcile).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_999);
      expect(outbox.claimNext).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(outbox.claimNext).toHaveBeenCalledTimes(2);
      expect(outbox.reconcile).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(4_000);
      expect(outbox.claimNext).toHaveBeenCalledTimes(3);
      expect(outbox.reconcile).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(4_000);
      expect(outbox.claimNext).toHaveBeenCalledTimes(4);
      expect(outbox.reconcile).toHaveBeenCalledTimes(2);
      await instance.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects heartbeat intervals greater than one third of the lease", () => {
    outbox.leaseDurationMs = 300;
    expect(() => worker(undefined, { heartbeatIntervalMs: 101 })).toThrow(
      "at most one third",
    );
    expect(() => worker(undefined, { heartbeatIntervalMs: 100 })).not.toThrow();
  });

  it("reports lease loss without stale finalization", async () => {
    const event = claim();
    outbox.claimNext.mockResolvedValueOnce(event).mockResolvedValueOnce(null);
    outbox.finalizeDelivered.mockRejectedValue(
      new (await import(
        "../../../../src/services/reliability/NotificationOutboxService"
      )).NotificationOutboxLeaseLostError(event.eventId),
    );

    const result = await worker().runOnce();

    expect(result.leaseLost).toBe(1);
    expect(outbox.finalizeFailure).not.toHaveBeenCalled();
  });
});
