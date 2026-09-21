import { randomUUID } from "crypto";
import { beforeEach, describe, expect, it } from "vitest";
import AuditLog from "../../../src/models/AuditLog";
import IdempotencyRecord from "../../../src/models/IdempotencyRecord";
import NotificationOutbox from "../../../src/models/NotificationOutbox";
import { IdempotencyKeyConflictError } from "../../../src/services/reliability/IdempotencyService";
import { notificationOutboxService } from "../../../src/services/reliability/NotificationOutboxService";
import { RecoveryControlService } from "../../../src/services/operations/RecoveryControlService";

const ACTOR = {
  id: "507f1f77bcf86cd799439011",
  role: "Super Admin",
};

async function enqueueFixture(suffix: string, maxAttempts = 3) {
  return notificationOutboxService.enqueueStandalone({
    topic: "system_message.created",
    dedupeKey: `recovery-integration:${suffix}`,
    payloadVersion: 1,
    payload: { messageId: suffix },
    maxAttempts,
  });
}

describe("RecoveryControlService MongoDB transaction", () => {
  beforeEach(async () => {
    await Promise.all([
      NotificationOutbox.deleteMany({}),
      IdempotencyRecord.deleteMany({}),
      AuditLog.deleteMany({
        action: "operations.recovery.notification_outbox",
      }),
    ]);
  });

  it("atomically reconciles, audits, and replays a bounded recovery request", async () => {
    const expired = await enqueueFixture("expired");
    const exhausted = await enqueueFixture("exhausted", 1);
    const expiredExhausted = await enqueueFixture("expired-exhausted", 1);
    const activeExhausted = await enqueueFixture("active-exhausted", 1);
    const expiredAt = new Date(Date.now() - 60_000);
    const activeUntil = new Date(Date.now() + 60_000);
    await NotificationOutbox.updateOne(
      { eventId: expired.eventId },
      {
        $set: {
          status: "processing",
          attemptCount: 1,
          leaseToken: randomUUID(),
          leaseOwner: "integration-worker",
          leaseExpiresAt: expiredAt,
          lastHeartbeatAt: expiredAt,
          lastAttemptAt: expiredAt,
        },
        $unset: { nextAttemptAt: "" },
      },
      { runValidators: true },
    );
    await NotificationOutbox.updateOne(
      { eventId: exhausted.eventId },
      { $set: { attemptCount: 1 } },
      { runValidators: true },
    );
    await NotificationOutbox.updateOne(
      { eventId: expiredExhausted.eventId },
      {
        $set: {
          status: "processing",
          attemptCount: 1,
          leaseToken: randomUUID(),
          leaseOwner: "integration-worker",
          leaseExpiresAt: expiredAt,
          lastHeartbeatAt: expiredAt,
          lastAttemptAt: expiredAt,
        },
        $unset: { nextAttemptAt: "" },
      },
      { runValidators: true },
    );
    await NotificationOutbox.updateOne(
      { eventId: activeExhausted.eventId },
      {
        $set: {
          status: "processing",
          attemptCount: 1,
          leaseToken: randomUUID(),
          leaseOwner: "integration-worker",
          leaseExpiresAt: activeUntil,
          lastHeartbeatAt: new Date(),
          lastAttemptAt: new Date(),
        },
        $unset: { nextAttemptAt: "" },
      },
      { runValidators: true },
    );

    const service = new RecoveryControlService();
    await expect(service.getStatusSnapshot()).resolves.toEqual({
      operation: "notification_outbox_reconcile",
      backlog: { pending: 1, processing: 3, dead: 0 },
      recoverable: { expiredLeases: 1, exhaustedAttempts: 2 },
    });
    const idempotencyKey = randomUUID();
    const first = await service.executeNotificationOutboxReconciliation({
      actor: ACTOR,
      idempotencyKey,
      limit: 10,
      correlationId: "recovery-integration",
    });

    expect(first).toMatchObject({
      recoveredExpiredLeases: 1,
      deadLetteredExhausted: 2,
      replayed: false,
    });
    await expect(
      NotificationOutbox.findOne({ eventId: expired.eventId }).lean(),
    ).resolves.toMatchObject({
      status: "pending",
      lastErrorCode: "LEASE_EXPIRED",
    });
    await expect(
      NotificationOutbox.findOne({ eventId: exhausted.eventId }).lean(),
    ).resolves.toMatchObject({
      status: "dead",
      lastErrorCode: "MAX_ATTEMPTS_EXHAUSTED",
    });
    await expect(
      NotificationOutbox.findOne({ eventId: expiredExhausted.eventId }).lean(),
    ).resolves.toMatchObject({
      status: "dead",
      lastErrorCode: "MAX_ATTEMPTS_EXHAUSTED",
    });
    await expect(
      NotificationOutbox.findOne({ eventId: activeExhausted.eventId }).lean(),
    ).resolves.toMatchObject({
      status: "processing",
      leaseOwner: "integration-worker",
    });
    await expect(
      AuditLog.countDocuments({
        action: "operations.recovery.notification_outbox",
      }),
    ).resolves.toBe(1);

    const replay = await service.executeNotificationOutboxReconciliation({
      actor: ACTOR,
      idempotencyKey,
      limit: 10,
      correlationId: "recovery-integration",
    });
    expect(replay).toMatchObject({
      recoveredExpiredLeases: 1,
      deadLetteredExhausted: 2,
      replayed: true,
      receiptId: first.receiptId,
    });
    await expect(
      AuditLog.countDocuments({
        action: "operations.recovery.notification_outbox",
      }),
    ).resolves.toBe(1);

    await expect(
      service.executeNotificationOutboxReconciliation({
        actor: ACTOR,
        idempotencyKey,
        limit: 11,
      }),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
  });

  it("rolls reconciliation back when its mandatory audit cannot commit", async () => {
    const expired = await enqueueFixture("audit-rollback");
    const expiredAt = new Date(Date.now() - 60_000);
    await NotificationOutbox.updateOne(
      { eventId: expired.eventId },
      {
        $set: {
          status: "processing",
          attemptCount: 1,
          leaseToken: randomUUID(),
          leaseOwner: "integration-worker",
          leaseExpiresAt: expiredAt,
          lastHeartbeatAt: expiredAt,
          lastAttemptAt: expiredAt,
        },
        $unset: { nextAttemptAt: "" },
      },
      { runValidators: true },
    );
    const service = new RecoveryControlService({
      audit: {
        recordRequiredInTransaction: async () => {
          throw new Error("audit unavailable");
        },
      },
    });

    await expect(
      service.executeNotificationOutboxReconciliation({
        actor: ACTOR,
        idempotencyKey: randomUUID(),
        limit: 10,
      }),
    ).rejects.toThrow("audit unavailable");

    await expect(
      NotificationOutbox.findOne({ eventId: expired.eventId }).lean(),
    ).resolves.toMatchObject({
      status: "processing",
      leaseOwner: "integration-worker",
    });
    await expect(IdempotencyRecord.countDocuments({})).resolves.toBe(0);
  });
});
