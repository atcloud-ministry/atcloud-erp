import type { ClientSession, Connection } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import {
  RESTORE_RECOVERY_LIMITS,
  RESTORE_RECOVERY_MEMBERSHIP_RUNTIME_READER,
  RestoreMembershipCheckpointService,
  RestoreOutboxReconciliationService,
  RestoreRecoveryConcurrentRunError,
  RestoreRecoveryService,
  RestoreRecoveryTransactionTopologyError,
  RestoreTtlCleanupService,
  parseRestoreAccountDeletionManifest,
} from "../../../../src/services/operations/RestoreRecoveryService";

const NOW = new Date("2030-09-19T12:00:00.000Z");
const SOURCE_SNAPSHOT_AT = "2030-09-18T12:00:00.000Z";
const USER_A = "507f1f77bcf86cd799439011";
const USER_B = "507f1f77bcf86cd799439012";
const IDEMPOTENCY_KEY = "11111111-1111-4111-8111-111111111111";
const PRIVATE_OPERATOR = "restore-operator-private";

function manifest(userIds: readonly string[] = [USER_A, USER_B]) {
  return {
    schemaVersion: 1,
    kind: "alumni_account_deletion_reconciliation" as const,
    sourceSnapshotAt: SOURCE_SNAPSHOT_AT,
    entries: userIds.map((userId, index) => ({
      userId,
      deletedAt: new Date(
        Date.parse("2030-09-18T12:00:00.000Z") + index * 60_000,
      ).toISOString(),
    })),
  };
}

function retentionResult(overrides: Record<string, unknown> = {}) {
  return {
    importCandidatesScanned: 0,
    importBatchesPurged: 0,
    invitationCandidatesScanned: 0,
    invitationsPurged: 0,
    ...overrides,
  };
}

function membershipResult(overrides: Record<string, unknown> = {}) {
  return {
    paused: false,
    candidatesScanned: 0,
    reconciledPrograms: 0,
    createdMemberships: 0,
    updatedRoles: 0,
    closedMemberships: 0,
    reactivatedMemberships: 0,
    archivedRooms: 0,
    ignoredPurchasesMissingStudentRoleId: 0,
    ignoredPurchasesUnmappedStudentRoleId: 0,
    deferredRevocations: 0,
    deferredReactivations: 0,
    racedOrUnavailable: 0,
    hasMore: false,
    capacityPerRun: RESTORE_RECOVERY_LIMITS.membership,
    ...overrides,
  };
}

function outcomeResult(overrides: Record<string, unknown> = {}) {
  return {
    candidatesScanned: 0,
    automaticallyConfirmed: 0,
    racedOrUnavailable: 0,
    remainingOverdue: 0,
    paused: false,
    ...overrides,
  };
}

function roomGraceResult(overrides: Record<string, unknown> = {}) {
  return {
    candidatesScanned: 0,
    archived: 0,
    racedOrUnavailable: 0,
    remainingOverdue: 0,
    ...overrides,
  };
}

function setup(options: {
  readonly initialExistingUserIds?: readonly string[];
  readonly finalExistingUserIds?: readonly string[];
  readonly topologySupported?: boolean;
  readonly retention?: Record<string, unknown>;
  readonly membership?: Record<string, unknown>;
  readonly outcome?: Record<string, unknown>;
  readonly roomGrace?: Record<string, unknown>;
  readonly outboxHasMore?: boolean;
} = {}) {
  const retentionContext = Object.freeze({ kind: "retention-context" });
  const outcomeContext = Object.freeze({ kind: "outcome-context" });
  const roomGraceContext = Object.freeze({ kind: "room-grace-context" });
  const membershipContext = Object.freeze({ kind: "membership-context" });
  const contexts = {
    createRetention: vi.fn(() => retentionContext),
    createOutcome: vi.fn(() => outcomeContext),
    createRoomGrace: vi.fn(() => roomGraceContext),
    createMembership: vi.fn(() => membershipContext),
  };
  const accountDeletion = {
    findExistingUserIds: vi
      .fn()
      .mockResolvedValueOnce(options.initialExistingUserIds ?? [])
      .mockResolvedValue(options.finalExistingUserIds ?? []),
    deleteAccount: vi.fn().mockResolvedValue(undefined),
  };
  const transactions = {
    assertTopologyCapability: vi.fn().mockResolvedValue({
      supported: options.topologySupported ?? true,
      topology: (options.topologySupported ?? true) ? "replica_set" : "standalone",
    }),
  };
  const retention = { runBounded: vi.fn().mockResolvedValue(retentionResult(options.retention)) };
  const membership = {
    runBoundedFromCheckpoint: vi.fn().mockResolvedValue({
      result: membershipResult(options.membership),
      checkpoint: { settingsAfterId: null, anomalyAfterId: null },
    }),
  };
  const outcome = { runBounded: vi.fn().mockResolvedValue(outcomeResult(options.outcome)) };
  const roomGrace = {
    runBounded: vi.fn().mockResolvedValue(roomGraceResult(options.roomGrace)),
  };
  const outbox = {
    reconcile: vi.fn().mockResolvedValue({
      recoveredExpiredLeases: 2,
      deadLetteredExhausted: 1,
      hasMore: options.outboxHasMore ?? false,
      replayed: false,
    }),
  };
  const auditRetention = {
    purgeOldAuditLogsBounded: vi
      .fn()
      .mockResolvedValue({ deletedCount: 3, hasMore: false }),
  };
  const ttlRetention = {
    purgeBounded: vi.fn().mockResolvedValue({ recordsDeleted: 4, hasMore: false }),
  };
  const membershipCheckpoints = {
    load: vi.fn().mockResolvedValue({
      checkpoint: { settingsAfterId: null, anomalyAfterId: null },
      completed: false,
      revision: 0,
    }),
    save: vi.fn().mockResolvedValue(undefined),
  };
  const service = new RestoreRecoveryService({
    now: () => new Date(NOW),
    transactions: transactions as any,
    accountDeletion: accountDeletion as any,
    retention: retention as any,
    membership: membership as any,
    outcome: outcome as any,
    roomGrace: roomGrace as any,
    outbox,
    auditRetention,
    ttlRetention,
    membershipCheckpoints,
    contexts: contexts as any,
  });
  return {
    service,
    contexts,
    accountDeletion,
    transactions,
    retention,
    membership,
    outcome,
    roomGrace,
    outbox,
    auditRetention,
    ttlRetention,
    membershipCheckpoints,
    retentionContext,
    outcomeContext,
    roomGraceContext,
    membershipContext,
  };
}

describe("RestoreRecoveryService", () => {
  it("runs one bounded recovery batch for each repair without exposing manifest identifiers", async () => {
    const fixture = setup({
      initialExistingUserIds: [USER_A, USER_B],
      finalExistingUserIds: [],
    });

    const report = await fixture.service.run({
      accountDeletionManifest: manifest(),
      idempotencyKey: IDEMPOTENCY_KEY,
      correlationId: "restore-recovery-1",
    });

    expect(RESTORE_RECOVERY_LIMITS).toEqual({
      accountDeletion: 100,
      retentionPerKind: 500,
      outcome: 500,
      roomGrace: 500,
      membership: 100,
      outbox: 100,
      ttl: 500,
    });
    expect(fixture.transactions.assertTopologyCapability).toHaveBeenCalledWith(true);
    expect(fixture.accountDeletion.deleteAccount).toHaveBeenCalledTimes(2);
    expect(fixture.accountDeletion.deleteAccount).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        targetUserId: USER_A,
        actor: { type: "system", key: "restore-recovery" },
        occurredAt: new Date("2030-09-18T12:00:00.000Z"),
        correlationId: "restore-recovery-1",
      }),
    );
    expect(fixture.accountDeletion.deleteAccount).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        targetUserId: USER_B,
        actor: { type: "system", key: "restore-recovery" },
        occurredAt: new Date("2030-09-18T12:01:00.000Z"),
      }),
    );
    expect(fixture.contexts.createRetention).toHaveBeenCalledOnce();
    expect(fixture.retention.runBounded).toHaveBeenCalledOnce();
    expect(fixture.retention.runBounded).toHaveBeenCalledWith(
      fixture.retentionContext,
    );
    expect(fixture.auditRetention.purgeOldAuditLogsBounded).toHaveBeenCalledWith(
      500,
      12,
    );
    expect(fixture.contexts.createMembership).toHaveBeenCalledOnce();
    expect(fixture.membership.runBoundedFromCheckpoint).toHaveBeenCalledOnce();
    expect(fixture.membership.runBoundedFromCheckpoint).toHaveBeenCalledWith(
      fixture.membershipContext,
      { settingsAfterId: null, anomalyAfterId: null },
    );
    expect(fixture.membershipCheckpoints.save).toHaveBeenCalledWith(
      expect.stringMatching(/^[a-f0-9]{64}$/),
      {
        checkpoint: { settingsAfterId: null, anomalyAfterId: null },
        completed: true,
        revision: 0,
      },
      0,
    );
    expect(fixture.contexts.createOutcome).toHaveBeenCalledOnce();
    expect(fixture.outcome.runBounded).toHaveBeenCalledOnce();
    expect(fixture.outcome.runBounded).toHaveBeenCalledWith(
      fixture.outcomeContext,
    );
    expect(fixture.contexts.createRoomGrace).toHaveBeenCalledOnce();
    expect(fixture.roomGrace.runBounded).toHaveBeenCalledOnce();
    expect(fixture.roomGrace.runBounded).toHaveBeenCalledWith(
      fixture.roomGraceContext,
    );
    expect(fixture.outbox.reconcile).toHaveBeenCalledOnce();
    expect(fixture.outbox.reconcile).toHaveBeenCalledWith({
      idempotencyKey: IDEMPOTENCY_KEY,
      correlationId: "restore-recovery-1",
    });
    expect(report).toMatchObject({
      kind: "restore_recovery",
      status: "completed",
      accountDeletion: {
        manifestEntries: 2,
        reconciledAccounts: 2,
        outstandingAccounts: 0,
        hasMore: false,
      },
      retention: { auditLogsPurged: 3, ttlRecordsPurged: 4, hasMore: false },
      issues: [],
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(USER_A);
    expect(serialized).not.toContain(USER_B);
    expect(serialized).not.toContain(PRIVATE_OPERATOR);
    expect(serialized).not.toContain(SOURCE_SNAPSHOT_AT);
  });

  it("limits account-deletion reconciliation to 100 and stops before all other repair work", async () => {
    const userIds = Array.from({ length: 101 }, (_, index) =>
      (index + 1).toString(16).padStart(24, "0"),
    );
    const fixture = setup({
      initialExistingUserIds: userIds,
      finalExistingUserIds: userIds,
    });

    const report = await fixture.service.run({
      accountDeletionManifest: manifest(userIds),
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(fixture.accountDeletion.deleteAccount).toHaveBeenCalledTimes(
      RESTORE_RECOVERY_LIMITS.accountDeletion,
    );
    expect(fixture.retention.runBounded).not.toHaveBeenCalled();
    expect(fixture.auditRetention.purgeOldAuditLogsBounded).not.toHaveBeenCalled();
    expect(fixture.membership.runBoundedFromCheckpoint).not.toHaveBeenCalled();
    expect(fixture.outcome.runBounded).not.toHaveBeenCalled();
    expect(fixture.roomGrace.runBounded).not.toHaveBeenCalled();
    expect(fixture.outbox.reconcile).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      status: "incomplete",
      accountDeletion: {
        manifestEntries: 101,
        reconciledAccounts: 100,
        outstandingAccounts: 101,
        hasMore: true,
      },
      issues: [
        { code: "RESTORE_ACCOUNT_DELETION_RECONCILIATION_REQUIRED" },
      ],
    });
  });

  it("fails closed before reading a manifest account when MongoDB transactions are unsupported", async () => {
    const fixture = setup({
      topologySupported: false,
      initialExistingUserIds: [USER_A],
    });

    await expect(
      fixture.service.run({
        accountDeletionManifest: manifest([USER_A]),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toBeInstanceOf(RestoreRecoveryTransactionTopologyError);

    expect(fixture.accountDeletion.findExistingUserIds).not.toHaveBeenCalled();
    expect(fixture.accountDeletion.deleteAccount).not.toHaveBeenCalled();
    expect(fixture.retention.runBounded).not.toHaveBeenCalled();
    expect(fixture.roomGrace.runBounded).not.toHaveBeenCalled();
    expect(fixture.outbox.reconcile).not.toHaveBeenCalled();
  });

  it("marks each unresolved bounded recovery as incomplete without another pass", async () => {
    const fixture = setup({
      retention: {
        importCandidatesScanned: RESTORE_RECOVERY_LIMITS.retentionPerKind,
      },
      membership: { hasMore: true },
      outcome: { remainingOverdue: 1 },
      roomGrace: { remainingOverdue: 1 },
      outboxHasMore: true,
    });

    const report = await fixture.service.run({
      accountDeletionManifest: manifest([]),
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(fixture.retention.runBounded).toHaveBeenCalledOnce();
    expect(fixture.membership.runBoundedFromCheckpoint).toHaveBeenCalledOnce();
    expect(fixture.outcome.runBounded).toHaveBeenCalledOnce();
    expect(fixture.roomGrace.runBounded).toHaveBeenCalledOnce();
    expect(fixture.outbox.reconcile).toHaveBeenCalledOnce();
    expect(report).toMatchObject({
      status: "incomplete",
      issues: [
        { code: "RESTORE_RETENTION_RECOVERY_INCOMPLETE" },
        { code: "RESTORE_MEMBERSHIP_RECOVERY_INCOMPLETE" },
        { code: "RESTORE_OUTCOME_RECOVERY_INCOMPLETE" },
        { code: "RESTORE_ALUMNI_HELP_ROOM_GRACE_RECOVERY_INCOMPLETE" },
        { code: "RESTORE_OUTBOX_RECOVERY_INCOMPLETE" },
      ],
    });
  });

  it("replays account deletions by source deletion time, not manifest checksum order", async () => {
    const fixture = setup({
      initialExistingUserIds: [USER_A, USER_B],
      finalExistingUserIds: [],
    });
    const reverseChronological = {
      ...manifest(),
      entries: [
        { userId: USER_A, deletedAt: "2030-09-18T12:01:00.000Z" },
        { userId: USER_B, deletedAt: "2030-09-18T12:00:00.000Z" },
      ],
    };

    await fixture.service.run({
      accountDeletionManifest: reverseChronological,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(fixture.accountDeletion.deleteAccount).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        targetUserId: USER_B,
        occurredAt: new Date("2030-09-18T12:00:00.000Z"),
      }),
    );
    expect(fixture.accountDeletion.deleteAccount).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        targetUserId: USER_A,
        occurredAt: new Date("2030-09-18T12:01:00.000Z"),
      }),
    );
  });

  it("resumes a restore-only membership checkpoint without exposing its cursors", async () => {
    const fixture = setup();
    const previousCheckpoint = {
      settingsAfterId: "507f1f77bcf86cd799439021",
      anomalyAfterId: null,
    };
    const nextCheckpoint = {
      settingsAfterId: "507f1f77bcf86cd799439022",
      anomalyAfterId: null,
    };
    fixture.membershipCheckpoints.load.mockResolvedValue({
      checkpoint: previousCheckpoint,
      completed: false,
      revision: 7,
    });
    fixture.membership.runBoundedFromCheckpoint.mockResolvedValue({
      result: membershipResult({ hasMore: true }),
      checkpoint: nextCheckpoint,
    });

    const report = await fixture.service.run({
      accountDeletionManifest: manifest([]),
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(fixture.membership.runBoundedFromCheckpoint).toHaveBeenCalledWith(
      fixture.membershipContext,
      previousCheckpoint,
    );
    expect(fixture.membershipCheckpoints.save).toHaveBeenCalledWith(
      expect.stringMatching(/^[a-f0-9]{64}$/),
      { checkpoint: nextCheckpoint, completed: false, revision: 7 },
      7,
    );
    expect(report.status).toBe("incomplete");
    expect(JSON.stringify(report)).not.toContain(previousCheckpoint.settingsAfterId);
    expect(JSON.stringify(report)).not.toContain(nextCheckpoint.settingsAfterId);
  });

  it("retains a completed checkpoint so a retry does not restart membership reconciliation", async () => {
    const fixture = setup();
    fixture.membershipCheckpoints.load.mockResolvedValue({
      checkpoint: { settingsAfterId: null, anomalyAfterId: null },
      completed: true,
      revision: 8,
    });

    const report = await fixture.service.run({
      accountDeletionManifest: manifest([]),
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(report.status).toBe("completed");
    expect(fixture.membership.runBoundedFromCheckpoint).not.toHaveBeenCalled();
    expect(fixture.membershipCheckpoints.save).not.toHaveBeenCalled();
  });

  it("fails closed when another recovery saves the same membership checkpoint first", async () => {
    const fixture = setup();
    fixture.membershipCheckpoints.save.mockRejectedValue(
      new RestoreRecoveryConcurrentRunError(),
    );

    await expect(
      fixture.service.run({
        accountDeletionManifest: manifest([]),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toBeInstanceOf(RestoreRecoveryConcurrentRunError);

    expect(fixture.outcome.runBounded).not.toHaveBeenCalled();
    expect(fixture.roomGrace.runBounded).not.toHaveBeenCalled();
    expect(fixture.outbox.reconcile).not.toHaveBeenCalled();
  });

  it("accepts only a canonical account-deletion manifest and normalizes its order", () => {
    expect(
      parseRestoreAccountDeletionManifest(manifest([USER_B.toUpperCase(), USER_A])),
    ).toMatchObject({
      entries: [
        { userId: USER_A, deletedAt: "2030-09-18T12:01:00.000Z" },
        { userId: USER_B, deletedAt: "2030-09-18T12:00:00.000Z" },
      ],
    });
    expect(() =>
      parseRestoreAccountDeletionManifest({
        ...manifest([USER_A]),
        entries: [
          { userId: USER_A, deletedAt: "2030-09-18T12:00:00.000Z" },
          { userId: USER_A.toUpperCase(), deletedAt: "2030-09-18T12:01:00.000Z" },
        ],
      }),
    ).toThrow("duplicate");
    expect(() =>
      parseRestoreAccountDeletionManifest({
        ...manifest([USER_A]),
        entries: [
          { userId: USER_A, deletedAt: "2030-09-17T12:00:00.000Z" },
        ],
      }),
    ).toThrow("before the source snapshot");
  });
});

describe("Restore recovery raw-store safeguards", () => {
  it("wires the isolated membership reader into both reconciliation layers", async () => {
    const defaultService = new RestoreRecoveryService();
    const membership = (
      defaultService as unknown as {
        membership: {
          runtimeReader?: unknown;
          sync?: { runtimeReader?: unknown };
        };
      }
    ).membership;

    expect(membership.runtimeReader).toBe(
      RESTORE_RECOVERY_MEMBERSHIP_RUNTIME_READER,
    );
    expect(membership.sync?.runtimeReader).toBe(
      RESTORE_RECOVERY_MEMBERSHIP_RUNTIME_READER,
    );
    await expect(
      RESTORE_RECOVERY_MEMBERSHIP_RUNTIME_READER.getOperationalRuntimeConfig(),
    ).resolves.toMatchObject({
      data: { alumniNetwork: { mode: "on", writable: true } },
    });
  });

  it("uses a TTL-index-compatible bounded query shape", async () => {
    const query = {
      sort: vi.fn(),
      limit: vi.fn(),
      maxTimeMS: vi.fn(),
      toArray: vi.fn(async () => [{ _id: "first-expired" }]),
    };
    query.sort.mockReturnValue(query);
    query.limit.mockReturnValue(query);
    query.maxTimeMS.mockReturnValue(query);
    const collection = {
      find: vi.fn(() => query),
      deleteMany: vi.fn(async () => ({ deletedCount: 1 })),
    };
    const database = { collection: vi.fn(() => collection) };
    const service = new RestoreTtlCleanupService({
      connection: { db: database } as unknown as Connection,
      now: () => new Date(NOW),
      definitions: [
        { collectionName: "restore_ttl_test", field: "expiresAt" },
      ],
      limit: 3,
    });

    await expect(service.purgeBounded()).resolves.toEqual({
      recordsDeleted: 1,
      hasMore: false,
    });
    expect(collection.find).toHaveBeenCalledWith(
      { expiresAt: { $lte: NOW } },
      { projection: { _id: 1 } },
    );
    expect(query.sort).toHaveBeenCalledWith({ expiresAt: 1 });
    expect(query.limit).toHaveBeenCalledWith(4);
    expect(query.maxTimeMS).toHaveBeenCalledWith(5_000);
    expect(collection.deleteMany).toHaveBeenCalledWith({
      _id: { $in: ["first-expired"] },
      expiresAt: { $lte: NOW },
    });
  });

  it("uses compare-and-set when persisting a membership checkpoint", async () => {
    const updates = vi
      .fn()
      .mockResolvedValueOnce({ matchedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 1 });
    const collection = {
      findOne: vi.fn().mockResolvedValue(null),
      updateOne: updates,
    };
    const service = new RestoreMembershipCheckpointService({
      connection: {
        db: { collection: vi.fn(() => collection) },
      } as unknown as Connection,
      now: () => new Date(NOW),
    });
    const digest = "a".repeat(64);
    const state = await service.load(digest);

    await service.save(digest, state, state.revision);

    expect(updates).toHaveBeenNthCalledWith(
      2,
      { _id: `alumni_network:${digest}`, revision: 0 },
      expect.objectContaining({ $inc: { revision: 1 } }),
    );
  });

  it("rejects a lost membership-checkpoint compare-and-set", async () => {
    const updates = vi
      .fn()
      .mockResolvedValueOnce({ matchedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 0 });
    const collection = {
      findOne: vi.fn().mockResolvedValue(null),
      updateOne: updates,
    };
    const service = new RestoreMembershipCheckpointService({
      connection: {
        db: { collection: vi.fn(() => collection) },
      } as unknown as Connection,
      now: () => new Date(NOW),
    });
    const digest = "b".repeat(64);
    const state = await service.load(digest);

    await expect(service.save(digest, state, state.revision)).rejects.toBeInstanceOf(
      RestoreRecoveryConcurrentRunError,
    );
  });
});

describe("RestoreOutboxReconciliationService", () => {
  it("repairs durable outbox state in one idempotent transaction without loading delivery", async () => {
    const session = { inTransaction: () => true } as unknown as ClientSession;
    const outbox = {
      reconcile: vi.fn().mockResolvedValue({
        recoveredExpiredLeases: 2,
        deadLetteredExhausted: 1,
      }),
    };
    const status = {
      countDocuments: vi.fn().mockResolvedValue(0),
    };
    const audit = { recordRequiredInTransaction: vi.fn().mockResolvedValue(undefined) };
    const idempotency = {
      execute: vi.fn(async (input) => {
        const executed = await input.execute(session);
        return {
          receiptId: "receipt-private",
          replayed: false,
          ...executed,
        };
      }),
    };
    const service = new RestoreOutboxReconciliationService({
      outbox: outbox as any,
      status: status as any,
      audit: audit as any,
      idempotency: idempotency as any,
      now: () => new Date(NOW),
    });

    const result = await service.reconcile({
      idempotencyKey: IDEMPOTENCY_KEY,
      correlationId: "restore-recovery-2",
    });

    expect(idempotency.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "operations.restore_recovery.notification_outbox",
        actorKey: IDEMPOTENCY_KEY,
        key: IDEMPOTENCY_KEY,
        requestPayload: {
          operation: "restore_recovery_notification_outbox",
          limit: RESTORE_RECOVERY_LIMITS.outbox,
        },
      }),
    );
    expect(outbox.reconcile).toHaveBeenCalledWith(
      RESTORE_RECOVERY_LIMITS.outbox,
      { session, recordMetrics: false, maxTimeMS: 1_000 },
    );
    expect(audit.recordRequiredInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "operations.restore_recovery.notification_outbox",
        actor: { type: "system", key: "restore-recovery" },
        source: "system",
      }),
      session,
    );
    expect(result).toEqual({
      recoveredExpiredLeases: 2,
      deadLetteredExhausted: 1,
      hasMore: false,
      replayed: false,
    });
    expect(JSON.stringify(result)).not.toContain(IDEMPOTENCY_KEY);
    expect(JSON.stringify(result)).not.toContain("receipt-private");
  });
});
