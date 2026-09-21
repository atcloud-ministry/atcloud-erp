import type { ConnectOptions } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import type { RestoreRecoveryReport } from "../../../../src/services/operations/RestoreRecoveryService";
import {
  runRestoreRecoveryCli,
  type RestoreRecoveryCliEnvironment,
} from "../../../../src/scripts/recovery/runRestoreRecovery";

const SECRET_URI =
  "mongodb+srv://restore-user:private-password@example.invalid/atcloud-production";
const DATABASE_NAME = "atcloud-restore-test";
const PRIVATE_OPERATOR = "travis-private-release-code";
const PRIVATE_USER_ID = "507f1f77bcf86cd799439011";
const IDEMPOTENCY_KEY = "11111111-1111-4111-8111-111111111111";

function arguments_(): string[] {
  return [
    "execute",
    "--confirm-db",
    DATABASE_NAME,
    "--operator",
    PRIVATE_OPERATOR,
    "--idempotency-key",
    IDEMPOTENCY_KEY,
    "--account-deletion-manifest",
    "/restricted/account-deletions.json",
    "--execute",
    "--yes",
    "--json",
  ];
}

function accountDeletionManifest() {
  return {
    schemaVersion: 1,
    kind: "alumni_account_deletion_reconciliation",
    sourceSnapshotAt: "2030-09-18T12:00:00.000Z",
    entries: [
      {
        userId: PRIVATE_USER_ID,
        deletedAt: "2030-09-18T12:01:00.000Z",
      },
    ],
  };
}

function report(
  status: "completed" | "incomplete" = "completed",
): RestoreRecoveryReport {
  return {
    schemaVersion: 1,
    kind: "restore_recovery",
    generatedAt: "2030-09-19T12:00:00.000Z",
    status,
    transaction: { supported: true, topology: "replica_set" },
    accountDeletion: {
      manifestEntries: 1,
      reconciledAccounts: 1,
      outstandingAccounts: 0,
      hasMore: false,
      manifestDigest: "a".repeat(64),
    },
    retention: {
      importCandidatesScanned: 0,
      importBatchesPurged: 0,
      invitationCandidatesScanned: 0,
      invitationsPurged: 0,
      auditLogsPurged: 0,
      ttlRecordsPurged: 0,
      hasMore: false,
    },
    membership: {
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
      capacityPerRun: 100,
    },
    outcome: {
      candidatesScanned: 0,
      automaticallyConfirmed: 0,
      racedOrUnavailable: 0,
      remainingOverdue: 0,
      paused: false,
      hasMore: false,
    },
    outbox: {
      recoveredExpiredLeases: 0,
      deadLetteredExhausted: 0,
      hasMore: false,
      replayed: false,
    },
    issues: [],
  };
}

function safeEnvironment(
  overrides: Partial<RestoreRecoveryCliEnvironment> = {},
): RestoreRecoveryCliEnvironment {
  return {
    MONGODB_URI: SECRET_URI,
    RESTORE_ISOLATION_MODE: "true",
    RESTORE_ISOLATION_DATABASE: DATABASE_NAME,
    NOTIFICATION_OUTBOX_ENABLED: "false",
    SCHEDULER_ENABLED: "false",
    WEB_PUSH_ENABLED: "false",
    ALUMNI_NETWORK_RELEASE_AVAILABLE: "false",
    ...overrides,
  };
}

function harness(databaseName = DATABASE_NAME) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const close = vi.fn(async () => undefined);
  const connect = vi.fn(
    async (_uri: string, _options: ConnectOptions) => ({ databaseName, close }),
  );
  const run = vi.fn(async () => report());
  const createService = vi.fn(() => ({ run }));
  const loadRuntime = vi.fn(async () => ({ createService }));
  const readAccountDeletionManifest = vi.fn(async () => accountDeletionManifest());
  return {
    stdout,
    stderr,
    close,
    connect,
    run,
    createService,
    loadRuntime,
    readAccountDeletionManifest,
    adapters: {
      io: {
        stdout: (line: string) => stdout.push(line),
        stderr: (line: string) => stderr.push(line),
      },
      connect,
      loadRuntime,
      readAccountDeletionManifest,
    },
  };
}

describe("runRestoreRecoveryCli", () => {
  it("fails restore-isolation gates before MongoDB, manifest reads, runtime, or external effects", async () => {
    const test = harness();

    const exitCode = await runRestoreRecoveryCli(
      arguments_(),
      safeEnvironment({ SCHEDULER_ENABLED: "true" }),
      test.adapters,
    );

    expect(exitCode).toBe(3);
    expect(test.connect).not.toHaveBeenCalled();
    expect(test.readAccountDeletionManifest).not.toHaveBeenCalled();
    expect(test.loadRuntime).not.toHaveBeenCalled();
    expect(test.run).not.toHaveBeenCalled();
    expect(test.stdout).toEqual([]);
    expect(JSON.parse(test.stderr[0]!)).toEqual({
      code: "RESTORE_ISOLATION_CONFIGURATION_INVALID",
    });
    expect(test.stderr.join("\n")).not.toContain(SECRET_URI);
    expect(test.stderr.join("\n")).not.toContain(PRIVATE_OPERATOR);
    expect(test.stderr.join("\n")).not.toContain("true");
  });

  it("requires an exact connected database before reading the deletion manifest or loading recovery code", async () => {
    const test = harness("atcloud-production");

    const exitCode = await runRestoreRecoveryCli(
      arguments_(),
      safeEnvironment(),
      test.adapters,
    );

    expect(exitCode).toBe(2);
    expect(test.connect).toHaveBeenCalledOnce();
    expect(test.close).toHaveBeenCalledOnce();
    expect(test.readAccountDeletionManifest).not.toHaveBeenCalled();
    expect(test.loadRuntime).not.toHaveBeenCalled();
    expect(test.run).not.toHaveBeenCalled();
    expect(test.stdout).toEqual([]);
    expect(JSON.parse(test.stderr[0]!)).toMatchObject({
      code: "RESTORE_RECOVERY_CLI_USAGE_ERROR",
    });
    expect(test.stderr.join("\n")).not.toContain(SECRET_URI);
  });

  it("rejects a different restore-named database than the isolated target binding", async () => {
    const test = harness("atcloud-restore-other");
    const argv = arguments_();
    argv[argv.indexOf(DATABASE_NAME)] = "atcloud-restore-other";

    const exitCode = await runRestoreRecoveryCli(
      argv,
      safeEnvironment(),
      test.adapters,
    );

    expect(exitCode).toBe(3);
    expect(test.connect).toHaveBeenCalledOnce();
    expect(test.close).toHaveBeenCalledOnce();
    expect(test.readAccountDeletionManifest).not.toHaveBeenCalled();
    expect(test.loadRuntime).not.toHaveBeenCalled();
    expect(JSON.parse(test.stderr[0]!)).toEqual({
      code: "RESTORE_ISOLATION_DATABASE_INVALID",
    });
  });

  it("uses an isolated non-indexing connection and passes only a hashed operator correlation to recovery", async () => {
    const test = harness();

    const exitCode = await runRestoreRecoveryCli(
      arguments_(),
      safeEnvironment(),
      test.adapters,
    );

    expect(exitCode).toBe(0);
    expect(test.connect).toHaveBeenCalledWith(
      SECRET_URI,
      expect.objectContaining({
        autoCreate: false,
        autoIndex: false,
        bufferCommands: false,
        maxPoolSize: 5,
        minPoolSize: 0,
        appName: "atcloud-restore-recovery-cli",
      }),
    );
    expect(test.readAccountDeletionManifest).toHaveBeenCalledWith(
      "/restricted/account-deletions.json",
    );
    expect(test.loadRuntime).toHaveBeenCalledOnce();
    expect(test.run).toHaveBeenCalledOnce();
    expect(test.run).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: IDEMPOTENCY_KEY,
        accountDeletionManifest: expect.objectContaining({
          kind: "alumni_account_deletion_reconciliation",
          entries: [expect.objectContaining({ userId: PRIVATE_USER_ID })],
        }),
        correlationId: expect.stringMatching(/^restore-[a-f0-9]{48}$/),
      }),
    );
    const recoveryInput = test.run.mock.calls[0]![0] as {
      correlationId: string;
    };
    expect(recoveryInput.correlationId).not.toContain(PRIVATE_OPERATOR);
    expect(test.close).toHaveBeenCalledOnce();
    expect(test.stderr).toEqual([]);
    expect(JSON.parse(test.stdout[0]!)).toMatchObject({
      kind: "restore_recovery",
      status: "completed",
      accountDeletion: { manifestEntries: 1 },
    });
    expect(test.stdout.join("\n")).not.toContain(SECRET_URI);
    expect(test.stdout.join("\n")).not.toContain(PRIVATE_OPERATOR);
    expect(test.stdout.join("\n")).not.toContain(PRIVATE_USER_ID);
  });

  it("validates the manifest before creating the recovery service and reports incomplete recovery as a gate failure", async () => {
    const invalid = harness();
    invalid.readAccountDeletionManifest.mockResolvedValue({ schemaVersion: 1 });

    const invalidExitCode = await runRestoreRecoveryCli(
      arguments_(),
      safeEnvironment(),
      invalid.adapters,
    );

    expect(invalidExitCode).toBe(2);
    expect(invalid.loadRuntime).not.toHaveBeenCalled();
    expect(invalid.run).not.toHaveBeenCalled();
    expect(invalid.close).toHaveBeenCalledOnce();
    expect(JSON.parse(invalid.stderr[0]!)).toMatchObject({
      code: "RESTORE_RECOVERY_CLI_USAGE_ERROR",
    });

    const incomplete = harness();
    incomplete.run.mockResolvedValue(report("incomplete"));
    const incompleteExitCode = await runRestoreRecoveryCli(
      arguments_(),
      safeEnvironment(),
      incomplete.adapters,
    );

    expect(incompleteExitCode).toBe(3);
    expect(incomplete.stderr).toEqual([]);
    expect(JSON.parse(incomplete.stdout[0]!)).toMatchObject({
      status: "incomplete",
    });
  });
});
