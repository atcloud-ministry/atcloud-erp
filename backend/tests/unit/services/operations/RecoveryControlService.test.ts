import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientSession } from "mongoose";
import {
  RECOVERY_QUERY_MAX_TIME_MS,
  RECOVERY_OPERATION,
  RECOVERY_STATUS_READ_TIMEOUT_MS,
  RecoveryControlBusyError,
  RecoveryControlInputError,
  RecoveryControlOutcomeUncertainError,
  RecoveryControlService,
  isRecoveryControlCommitUncertain,
  isRecoveryControlConflict,
} from "../../../../src/services/operations/RecoveryControlService";
import {
  buildExhaustedOutboxRecoveryFilter,
  buildExpiredLeaseOutboxRecoveryFilter,
} from "../../../../src/services/reliability/NotificationOutboxService";

const ACTOR = {
  id: "507f1f77bcf86cd799439011",
  role: "Super Admin",
};
const IDEMPOTENCY_KEY = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-09T20:00:00.000Z");

describe("RecoveryControlService", () => {
  const session = {
    inTransaction: vi.fn(() => true),
  } as unknown as ClientSession;
  let outbox: { reconcile: ReturnType<typeof vi.fn> };
  let audit: { recordRequiredInTransaction: ReturnType<typeof vi.fn> };
  let metrics: { increment: ReturnType<typeof vi.fn> };
  let statusModel: { countDocuments: ReturnType<typeof vi.fn> };
  let idempotency: { execute: ReturnType<typeof vi.fn> };
  let service: RecoveryControlService;

  beforeEach(() => {
    outbox = {
      reconcile: vi.fn().mockResolvedValue({
        recoveredExpiredLeases: 2,
        deadLetteredExhausted: 1,
      }),
    };
    audit = { recordRequiredInTransaction: vi.fn().mockResolvedValue(undefined) };
    metrics = { increment: vi.fn() };
    statusModel = {
      countDocuments: vi
        .fn()
        .mockResolvedValueOnce(7)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(4),
    };
    idempotency = {
      execute: vi.fn(async (input) => {
        const operation = await input.execute(session);
        return {
          receiptId: "507f1f77bcf86cd799439012",
          replayed: false,
          ...operation,
        };
      }),
    };
    service = new RecoveryControlService({
      outbox,
      audit,
      metrics,
      statusModel,
      idempotency,
      now: () => NOW,
    });
  });

  it("returns a bounded, payload-free recovery status snapshot", async () => {
    await expect(service.getStatusSnapshot()).resolves.toEqual({
      operation: RECOVERY_OPERATION,
      backlog: { pending: 7, processing: 2, dead: 3 },
      recoverable: { expiredLeases: 1, exhaustedAttempts: 4 },
    });

    expect(statusModel.countDocuments).toHaveBeenCalledTimes(5);
    expect(statusModel.countDocuments.mock.calls[3][0]).toEqual(
      buildExpiredLeaseOutboxRecoveryFilter(NOW),
    );
    expect(statusModel.countDocuments.mock.calls[4][0]).toEqual(
      buildExhaustedOutboxRecoveryFilter(NOW),
    );
    for (const [, options] of statusModel.countDocuments.mock.calls) {
      expect(options).toMatchObject({
        maxTimeMS: RECOVERY_STATUS_READ_TIMEOUT_MS,
        signal: expect.any(AbortSignal),
      });
    }
    const serializedFilters = JSON.stringify(
      statusModel.countDocuments.mock.calls.map(([filter]) => filter),
    );
    expect(serializedFilters).not.toContain("payload");
    expect(serializedFilters).not.toContain("userId");
  });

  it("runs reconciliation and required audit in one idempotent transaction", async () => {
    const result = await service.executeNotificationOutboxReconciliation({
      actor: ACTOR,
      idempotencyKey: IDEMPOTENCY_KEY,
      limit: 25,
      correlationId: "correlation-1",
    });

    expect(result).toEqual({
      operation: RECOVERY_OPERATION,
      recoveredExpiredLeases: 2,
      deadLetteredExhausted: 1,
      receiptId: "507f1f77bcf86cd799439012",
      replayed: false,
    });
    expect(idempotency.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "operations.recovery.notification_outbox",
        actorKey: ACTOR.id,
        key: IDEMPOTENCY_KEY,
        requestPayload: { operation: RECOVERY_OPERATION, limit: 25 },
      }),
    );
    expect(outbox.reconcile).toHaveBeenCalledWith(25, {
      session,
      recordMetrics: false,
      maxTimeMS: RECOVERY_QUERY_MAX_TIME_MS,
      signal: expect.any(AbortSignal),
    });
    expect(audit.recordRequiredInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "operations.recovery.notification_outbox",
        actor: { type: "user", ...ACTOR },
        source: "http",
        outcome: "success",
        details: {
          limit: 25,
          recoveredExpiredLeases: 2,
          deadLetteredExhausted: 1,
        },
      }),
      session,
    );
    expect(metrics.increment).toHaveBeenNthCalledWith(
      1,
      "expiredLeasesRecovered",
      2,
    );
    expect(metrics.increment).toHaveBeenNthCalledWith(2, "deadLettered", 1);
  });

  it("uses the bounded default limit", async () => {
    await service.executeNotificationOutboxReconciliation({
      actor: ACTOR,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(outbox.reconcile).toHaveBeenCalledWith(25, {
      session,
      recordMetrics: false,
      maxTimeMS: RECOVERY_QUERY_MAX_TIME_MS,
      signal: expect.any(AbortSignal),
    });
  });

  it.each([0, -1, 26, 1.5, "10", null])(
    "rejects invalid reconciliation limit %# before persistence",
    async (limit) => {
      await expect(
        service.executeNotificationOutboxReconciliation({
          actor: ACTOR,
          idempotencyKey: IDEMPOTENCY_KEY,
          limit: limit as never,
        }),
      ).rejects.toBeInstanceOf(RecoveryControlInputError);
      expect(idempotency.execute).not.toHaveBeenCalled();
    },
  );

  it("does not publish duplicate metrics when replaying a receipt", async () => {
    idempotency.execute.mockResolvedValue({
      receiptId: "507f1f77bcf86cd799439012",
      replayed: true,
      httpStatus: 200,
      response: {
        operation: RECOVERY_OPERATION,
        recoveredExpiredLeases: 2,
        deadLetteredExhausted: 1,
      },
    });

    const result = await service.executeNotificationOutboxReconciliation({
      actor: ACTOR,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(result.replayed).toBe(true);
    expect(outbox.reconcile).not.toHaveBeenCalled();
    expect(metrics.increment).not.toHaveBeenCalled();
  });

  it("propagates a required audit failure through the transaction", async () => {
    audit.recordRequiredInTransaction.mockRejectedValue(
      new Error("audit unavailable"),
    );

    await expect(
      service.executeNotificationOutboxReconciliation({
        actor: ACTOR,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toThrow("audit unavailable");
    expect(metrics.increment).not.toHaveBeenCalled();
  });

  it("bounds recovery status reads even when the model ignores cancellation", async () => {
    statusModel.countDocuments.mockReset();
    statusModel.countDocuments.mockReturnValue(new Promise(() => undefined));
    service = new RecoveryControlService({
      outbox,
      audit,
      metrics,
      statusModel,
      idempotency,
      now: () => NOW,
      statusReadTimeoutMs: 5,
    });

    await expect(service.getStatusSnapshot()).rejects.toBeDefined();
  });

  it("bounds execution and classifies the unknown outcome for same-key retry", async () => {
    idempotency.execute.mockReturnValue(new Promise(() => undefined));
    service = new RecoveryControlService({
      outbox,
      audit,
      metrics,
      statusModel,
      idempotency,
      executionTimeoutMs: 5,
    });

    const error = await service
      .executeNotificationOutboxReconciliation({
        actor: ACTOR,
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(RecoveryControlOutcomeUncertainError);
    expect(isRecoveryControlCommitUncertain(error)).toBe(true);

    const retryWhileUnderlyingExecutionIsPending = await service
      .executeNotificationOutboxReconciliation({
        actor: ACTOR,
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .catch((failure: unknown) => failure);
    expect(retryWhileUnderlyingExecutionIsPending).toBeInstanceOf(
      RecoveryControlBusyError,
    );
    expect(idempotency.execute).toHaveBeenCalledTimes(1);
  });

  it("admits only one recovery execution until the underlying operation settles", async () => {
    let resolveExecution!: (value: {
      receiptId: string;
      replayed: boolean;
      httpStatus: number;
      response: {
        operation: typeof RECOVERY_OPERATION;
        recoveredExpiredLeases: number;
        deadLetteredExhausted: number;
      };
    }) => void;
    const heldExecution = new Promise<
      Parameters<typeof resolveExecution>[0]
    >((resolve) => {
      resolveExecution = resolve;
    });
    idempotency.execute.mockReturnValueOnce(heldExecution);

    const first = service.executeNotificationOutboxReconciliation({
      actor: ACTOR,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    const concurrentError = await service
      .executeNotificationOutboxReconciliation({
        actor: ACTOR,
        idempotencyKey: "22222222-2222-4222-8222-222222222222",
      })
      .catch((failure: unknown) => failure);

    expect(concurrentError).toBeInstanceOf(RecoveryControlBusyError);
    expect(isRecoveryControlConflict(concurrentError)).toBe(true);
    expect(idempotency.execute).toHaveBeenCalledTimes(1);

    resolveExecution({
      receiptId: "507f1f77bcf86cd799439012",
      replayed: false,
      httpStatus: 200,
      response: {
        operation: RECOVERY_OPERATION,
        recoveredExpiredLeases: 2,
        deadLetteredExhausted: 1,
      },
    });
    await expect(first).resolves.toMatchObject({ replayed: false });

    await expect(
      service.executeNotificationOutboxReconciliation({
        actor: ACTOR,
        idempotencyKey: "22222222-2222-4222-8222-222222222222",
      }),
    ).resolves.toMatchObject({ replayed: false });
    expect(idempotency.execute).toHaveBeenCalledTimes(2);
  });
});
