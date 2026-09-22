import type { ConnectOptions } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import type { RestoreQualificationReport } from "../../../../src/services/operations/RestoreQualificationService";
import {
  runRestoreQualificationCli,
  type RestoreQualificationCliEnvironment,
} from "../../../../src/scripts/recovery/runRestoreQualification";

const SECRET_URI =
  "mongodb+srv://restore-user:private-password@example.invalid/atcloud-production";
const DATABASE_NAME = "atcloud-restore-test";
const PRIVATE_EMAIL = "restored-person@example.invalid";

function report(
  status: "passed" | "failed" = "passed",
): RestoreQualificationReport {
  return {
    schemaVersion: 1,
    kind: "restore_qualification",
    generatedAt: "2030-09-19T12:00:00.000Z",
    status,
    collections: {
      users: { count: 1, digest: "a".repeat(64) },
    },
    migration: {
      healthy: true,
      recoveryRequired: false,
      applied: 10,
      pending: 0,
      issues: 0,
    },
    transaction: { supported: true, topology: "replica_set" },
    indexes: { expected: 90, missing: 0, mismatched: 0 },
    integrity: {
      chat: {
        orphanMessages: 0,
        messagesBeyondConversationSequence: 0,
        orphanMembers: 0,
        invalidAccessWindows: 0,
        invalidConversationMetadata: 0,
        invalidMessageRetention: 0,
        invalidMemberState: 0,
        messagesOutsideMemberAccess: 0,
        invalidMessagePayload: 0,
      },
      help: {
        orphanOutcomes: 0,
        inconsistentLatestOutcomes: 0,
        invalidOutcomeAncestry: 0,
        invalidLifecycleTimelines: 0,
        invalidRoomLinkage: 0,
      },
      membership: {
      settingsMissingProgram: 0,
      enabledSettingsMissingRoom: 0,
      reconciliationRequired: 0,
      roomsMissingProgram: 0,
      },
      retention: {
        expiredRawImportData: 0,
        expiredInvitationContacts: 0,
        expiredTtlRecords: 0,
        expiredAuditLogs: 0,
      },
      accountDeletion: {
        unscheduledProfiles: 0,
        unscheduledAffiliations: 0,
        unscheduledConsents: 0,
      },
    },
    comparison: { manifestProvided: false, mismatchedCollections: 0 },
    issues: [],
  };
}

function safeEnvironment(
  overrides: Partial<RestoreQualificationCliEnvironment> = {},
): RestoreQualificationCliEnvironment {
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
  const inspect = vi.fn(async () => report());
  const verify = vi.fn(async () => report());
  const createService = vi.fn(() => ({ inspect, verify }));
  const loadRuntime = vi.fn(async () => ({ createService }));
  const readManifest = vi.fn(async () => ({ schemaVersion: 1 }));
  return {
    stdout,
    stderr,
    close,
    connect,
    inspect,
    verify,
    createService,
    loadRuntime,
    readManifest,
    adapters: {
      io: {
        stdout: (line: string) => stdout.push(line),
        stderr: (line: string) => stderr.push(line),
      },
      connect,
      loadRuntime,
      readManifest,
    },
  };
}

describe("runRestoreQualificationCli", () => {
  it("fails isolation configuration before opening MongoDB and never emits secrets", async () => {
    const test = harness();
    const exitCode = await runRestoreQualificationCli(
      ["inspect", "--confirm-db", DATABASE_NAME, "--json"],
      safeEnvironment({ SCHEDULER_ENABLED: "true" }),
      test.adapters,
    );

    expect(exitCode).toBe(3);
    expect(test.connect).not.toHaveBeenCalled();
    expect(test.loadRuntime).not.toHaveBeenCalled();
    expect(test.stdout).toEqual([]);
    expect(JSON.parse(test.stderr[0]!)).toEqual({
      code: "RESTORE_ISOLATION_CONFIGURATION_INVALID",
    });
    expect(test.stderr.join("\n")).not.toContain(SECRET_URI);
    expect(test.stderr.join("\n")).not.toContain("true");
  });

  it("requires an exact connected database confirmation before loading qualification code", async () => {
    const test = harness("atcloud-production");
    const exitCode = await runRestoreQualificationCli(
      ["inspect", "--confirm-db", DATABASE_NAME, "--json"],
      safeEnvironment(),
      test.adapters,
    );

    expect(exitCode).toBe(2);
    expect(test.connect).toHaveBeenCalledOnce();
    expect(test.close).toHaveBeenCalledOnce();
    expect(test.loadRuntime).not.toHaveBeenCalled();
    expect(test.stdout).toEqual([]);
    expect(JSON.parse(test.stderr[0]!)).toMatchObject({
      code: "RESTORE_QUALIFICATION_CLI_USAGE_ERROR",
    });
    expect(test.stderr.join("\n")).not.toContain(SECRET_URI);
  });

  it("uses a non-indexing isolated connection and emits only the qualification report", async () => {
    const test = harness();
    const exitCode = await runRestoreQualificationCli(
      ["inspect", "--confirm-db", DATABASE_NAME, "--json"],
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
        appName: "atcloud-restore-qualification-cli",
      }),
    );
    expect(test.inspect).toHaveBeenCalledOnce();
    expect(test.verify).not.toHaveBeenCalled();
    expect(test.close).toHaveBeenCalledOnce();
    expect(test.stderr).toEqual([]);
    expect(JSON.parse(test.stdout[0]!)).toMatchObject({
      kind: "restore_qualification",
      status: "passed",
      collections: { users: { count: 1 } },
    });
    expect(test.stdout.join("\n")).not.toContain(SECRET_URI);
    expect(test.stdout.join("\n")).not.toContain(PRIVATE_EMAIL);
  });

  it("reads a manifest only after isolation and database confirmation", async () => {
    const test = harness();
    const exitCode = await runRestoreQualificationCli(
      [
        "verify",
        "--confirm-db",
        DATABASE_NAME,
        "--manifest",
        "/restricted/restore-manifest.json",
      ],
      safeEnvironment(),
      test.adapters,
    );

    expect(exitCode).toBe(0);
    expect(test.readManifest).toHaveBeenCalledWith(
      "/restricted/restore-manifest.json",
    );
    expect(test.verify).toHaveBeenCalledWith({ schemaVersion: 1 });
    expect(test.inspect).not.toHaveBeenCalled();
  });
});
