import { describe, expect, it } from "vitest";
import {
  MAX_MIGRATION_CHECKPOINT_STRING_LENGTH,
  SCHEMA_MIGRATION_STATUSES,
  type SchemaMigrationStatus,
} from "../../../src/migrations/types";
import SchemaMigration from "../../../src/models/SchemaMigration";

const MIGRATION_ID = "20260909_001_add-alumni-directory";
const OTHER_MIGRATION_ID = "20260909_002_add-chat-rooms";
const CHECKSUM = "a".repeat(64);
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const STARTED_AT = new Date("2026-09-09T12:00:00.000Z");
const HEARTBEAT_AT = new Date("2026-09-09T12:00:01.000Z");
const FINISHED_AT = new Date("2026-09-09T12:00:02.000Z");

function validMigration(overrides: Record<string, unknown> = {}) {
  return new SchemaMigration({
    _id: MIGRATION_ID,
    migrationId: MIGRATION_ID,
    description: "Add the alumni directory foundation",
    checksum: CHECKSUM,
    status: "applying",
    direction: "up",
    applyCheckpoint: { phase: 1, cursor: "user-42" },
    rollbackCheckpoint: null,
    counts: {
      examined: 4,
      matched: 3,
      modified: 2,
      skipped: 1,
      errors: 0,
    },
    attempt: 1,
    runId: RUN_ID,
    operator: "migration-test-runner",
    appVersion: "1.1.0-m0.04",
    runStartedAt: STARTED_AT,
    runFinishedAt: null,
    lastHeartbeatAt: HEARTBEAT_AT,
    appliedAt: null,
    rolledBackAt: null,
    rollbackReasonCode: null,
    lastError: null,
    revision: 0,
    ...overrides,
  });
}

function migrationForStatus(status: SchemaMigrationStatus) {
  const isDown = ["rolling_back", "rolled_back", "rollback_failed"].includes(
    status,
  );
  const isTerminal = !["applying", "rolling_back"].includes(status);
  const isFailure = ["apply_failed", "rollback_failed"].includes(status);

  return validMigration({
    status,
    direction: isDown ? "down" : "up",
    runFinishedAt: isTerminal ? FINISHED_AT : null,
    appliedAt: status === "applied" ? FINISHED_AT : null,
    rolledBackAt: status === "rolled_back" ? FINISHED_AT : null,
    rollbackReasonCode: isDown ? "OPERATOR_REQUEST" : null,
    lastError: isFailure
      ? {
          code:
            status === "apply_failed"
              ? "MIGRATION_APPLY_FAILED"
              : "MIGRATION_ROLLBACK_FAILED",
          digest: "c".repeat(64),
          recordedAt: FINISHED_AT,
        }
      : null,
  });
}

describe("SchemaMigration model", () => {
  it("accepts every valid status with its required direction and lifecycle fields", async () => {
    for (const status of SCHEMA_MIGRATION_STATUSES) {
      await expect(migrationForStatus(status).validate()).resolves.toBeUndefined();
    }
  });

  it("uses a string migration id and requires migrationId to equal _id", async () => {
    const migration = validMigration();

    expect(typeof migration._id).toBe("string");
    expect(migration._id).toBe(MIGRATION_ID);

    const mismatch = validMigration({ migrationId: OTHER_MIGRATION_ID });
    await expect(mismatch.validate()).rejects.toThrow(
      "migrationId must equal the document _id",
    );
  });

  it("rejects unknown root and nested fields in strict throw mode", async () => {
    expect(() => validMigration({ unexpected: true })).toThrow();
    const invalidCounts = validMigration({
      counts: {
        examined: 0,
        matched: 0,
        modified: 0,
        skipped: 0,
        errors: 0,
        unexpected: 1,
      },
    });
    await expect(invalidCounts.validate()).rejects.toThrow("StrictModeError");
    expect(() =>
      migrationForStatus("apply_failed").set("lastError.unexpected", true),
    ).toThrow();
  });

  it("marks identity and definition fields immutable", () => {
    for (const path of ["_id", "migrationId", "description", "checksum"]) {
      expect(SchemaMigration.schema.path(path).options.immutable).toBe(true);
    }
  });

  it("normalizes valid checksums and rejects malformed digests", async () => {
    const normalized = validMigration({ checksum: "A".repeat(64) });
    expect(normalized.checksum).toBe(CHECKSUM);
    await expect(normalized.validate()).resolves.toBeUndefined();

    await expect(
      validMigration({ checksum: "not-a-sha-256-digest" }).validate(),
    ).rejects.toThrow("checksum");
  });

  it.each(SCHEMA_MIGRATION_STATUSES)(
    "rejects a direction inconsistent with %s",
    async (status) => {
      const migration = migrationForStatus(status);
      migration.direction = migration.direction === "up" ? "down" : "up";

      await expect(migration.validate()).rejects.toThrow("invalid direction");
    },
  );

  it("requires terminal timestamps and forbids them on active runs", async () => {
    await expect(
      validMigration({ runFinishedAt: FINISHED_AT }).validate(),
    ).rejects.toThrow("active migration cannot have runFinishedAt");

    const unfinishedTerminal = migrationForStatus("applied");
    unfinishedTerminal.runFinishedAt = null;
    await expect(unfinishedTerminal.validate()).rejects.toThrow(
      "terminal migration requires runFinishedAt",
    );

    const finishedBeforeStart = migrationForStatus("applied");
    finishedBeforeStart.runFinishedAt = new Date("2026-09-09T11:59:59.000Z");
    await expect(finishedBeforeStart.validate()).rejects.toThrow(
      "runFinishedAt cannot precede runStartedAt",
    );
  });

  it("requires failure details only on failure statuses", async () => {
    const failureWithoutError = migrationForStatus("apply_failed");
    failureWithoutError.lastError = null;
    await expect(failureWithoutError.validate()).rejects.toThrow(
      "failed migration requires lastError",
    );

    const activeWithError = validMigration({
      lastError: {
        code: "UNEXPECTED_ERROR",
        digest: "d".repeat(64),
        recordedAt: HEARTBEAT_AT,
      },
    });
    await expect(activeWithError.validate()).rejects.toThrow(
      "Only a failed migration may retain lastError",
    );

    const invalidError = migrationForStatus("apply_failed");
    invalidError.lastError = {
      code: "unsafe error code",
      digest: "short",
      recordedAt: FINISHED_AT,
    };
    await expect(invalidError.validate()).rejects.toThrow();

    const customCode = migrationForStatus("apply_failed");
    customCode.lastError!.code = "TOKEN_SUPER_SECRET_123" as never;
    customCode.lastError!.digest = "d".repeat(64);
    await expect(customCode.validate()).rejects.toThrow("lastError.code");
  });

  it("requires completion timestamps for applied and rolled-back records", async () => {
    const applied = migrationForStatus("applied");
    applied.appliedAt = null;
    await expect(applied.validate()).rejects.toThrow(
      "applied migration requires appliedAt",
    );

    const rolledBack = migrationForStatus("rolled_back");
    rolledBack.rolledBackAt = null;
    await expect(rolledBack.validate()).rejects.toThrow(
      "rolled-back migration requires rolledBackAt",
    );
  });

  it("requires an allowlisted rollback reason code only for the down direction", async () => {
    await expect(
      validMigration({ rollbackReasonCode: "OPERATOR_REQUEST" }).validate(),
    ).rejects.toThrow("cannot retain a rollback reason code");

    const missingReason = migrationForStatus("rolling_back");
    missingReason.rollbackReasonCode = null;
    await expect(missingReason.validate()).rejects.toThrow(
      "rollback migration requires a reason code",
    );

    const invalidReason = migrationForStatus("rolling_back");
    invalidReason.rollbackReasonCode = "PRIVATE_FREE_TEXT" as never;
    await expect(invalidReason.validate()).rejects.toThrow(
      "rollbackReasonCode",
    );
  });

  it("accepts bounded JSON checkpoints and rejects unbounded metadata", async () => {
    await expect(validMigration().validate()).resolves.toBeUndefined();

    await expect(
      validMigration({ applyCheckpoint: "cursor-only" }).validate(),
    ).rejects.toThrow("bounded JSON resumability metadata");

    await expect(
      validMigration({
        applyCheckpoint: {
          cursor: "x".repeat(MAX_MIGRATION_CHECKPOINT_STRING_LENGTH + 1),
        },
      }).validate(),
    ).rejects.toThrow("bounded JSON resumability metadata");

    await expect(
      validMigration({ applyCheckpoint: { $where: "unsafe" } }).validate(),
    ).rejects.toThrow("bounded JSON resumability metadata");

    await expect(
      migrationForStatus("rolling_back")
        .set("rollbackCheckpoint", "cursor-only")
        .validate(),
    ).rejects.toThrow("bounded JSON resumability metadata");
  });

  it("stores an isolated clone of each valid checkpoint", async () => {
    const applyCheckpoint = {
      cursor: "user-42",
      nested: { phase: 1 },
    };
    const migration = validMigration({ applyCheckpoint });

    applyCheckpoint.cursor = "mutated";
    applyCheckpoint.nested.phase = 2;

    expect(migration.applyCheckpoint).toEqual({
      cursor: "user-42",
      nested: { phase: 1 },
    });
    await expect(migration.validate()).resolves.toBeUndefined();
  });

  it("does not allow forward execution to retain rollback progress", async () => {
    await expect(
      validMigration({ rollbackCheckpoint: { lastId: 42 } }).validate(),
    ).rejects.toThrow("cannot retain rollback progress");
  });

  it("enforces bounded safe-integer counters, attempts, revisions, and run metadata", async () => {
    for (const counts of [
      {
        examined: -1,
        matched: 0,
        modified: 0,
        skipped: 0,
        errors: 0,
      },
      {
        examined: 1.5,
        matched: 0,
        modified: 0,
        skipped: 0,
        errors: 0,
      },
      {
        examined: 1,
        matched: 2,
        modified: 0,
        skipped: 0,
        errors: 0,
      },
      {
        examined: 1,
        matched: 1,
        modified: 2,
        skipped: 0,
        errors: 0,
      },
      {
        examined: 1,
        matched: 1,
        modified: 1,
        skipped: 2,
        errors: 0,
      },
      {
        examined: 1,
        matched: 1,
        modified: 1,
        skipped: 0,
        errors: 1,
      },
    ]) {
      await expect(validMigration({ counts }).validate()).rejects.toThrow();
    }

    for (const overrides of [
      { attempt: 0 },
      { attempt: 1.5 },
      { revision: -1 },
      { revision: 1.5 },
      { runId: "not-a-uuid" },
      { operator: "unsafe\noperator" },
      { appVersion: "invalid version" },
    ]) {
      await expect(validMigration(overrides).validate()).rejects.toThrow();
    }
  });

  it("requires chronological run and heartbeat timestamps", async () => {
    await expect(
      validMigration({
        lastHeartbeatAt: new Date("2026-09-09T11:59:59.000Z"),
      }).validate(),
    ).rejects.toThrow("lastHeartbeatAt cannot precede runStartedAt");
  });

  it("rejects lifecycle timestamps that contradict the current status", async () => {
    await expect(
      migrationForStatus("applied")
        .set("rolledBackAt", FINISHED_AT)
        .validate(),
    ).rejects.toThrow("Only a rolled-back migration may retain rolledBackAt");

    await expect(
      migrationForStatus("apply_failed")
        .set("appliedAt", FINISHED_AT)
        .validate(),
    ).rejects.toThrow("Only an applied forward migration may retain appliedAt");
  });

  it("requires completion and error timestamps to fall within their run", async () => {
    const heartbeatAfterFinish = migrationForStatus("applied");
    heartbeatAfterFinish.lastHeartbeatAt = new Date(
      "2026-09-09T12:00:03.000Z",
    );
    await expect(heartbeatAfterFinish.validate()).rejects.toThrow(
      "runFinishedAt cannot precede lastHeartbeatAt",
    );

    const appliedBeforeStart = migrationForStatus("applied");
    appliedBeforeStart.appliedAt = new Date("2026-09-09T11:59:59.000Z");
    await expect(appliedBeforeStart.validate()).rejects.toThrow(
      "appliedAt must fall within the completed apply run",
    );

    const rollbackAfterFinish = migrationForStatus("rolled_back");
    rollbackAfterFinish.rolledBackAt = new Date(
      "2026-09-09T12:00:03.000Z",
    );
    await expect(rollbackAfterFinish.validate()).rejects.toThrow(
      "rolledBackAt must fall within the completed rollback run",
    );

    const errorBeforeStart = migrationForStatus("apply_failed");
    errorBeforeStart.lastError!.recordedAt = new Date(
      "2026-09-09T11:59:59.000Z",
    );
    await expect(errorBeforeStart.validate()).rejects.toThrow(
      "lastError.recordedAt must fall within the failed run",
    );
  });

  it("requires rollback history to precede the rollback run", async () => {
    const rollback = migrationForStatus("rolling_back");
    rollback.appliedAt = new Date("2026-09-09T12:00:01.000Z");

    await expect(rollback.validate()).rejects.toThrow(
      "rollback cannot precede the retained appliedAt timestamp",
    );
  });

  it("declares stable collection and migration lookup index names", () => {
    expect(SchemaMigration.modelName).toBe("SchemaMigration");
    expect(SchemaMigration.collection.name).toBe("schema_migrations");
    expect(SchemaMigration.schema.get("strict")).toBe("throw");
    expect(SchemaMigration.schema.get("versionKey")).toBe(false);
    expect(SchemaMigration.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { migrationId: 1 },
          expect.objectContaining({
            unique: true,
            name: "uniq_schema_migration_id",
          }),
        ],
        [{ status: 1, migrationId: 1 }, expect.any(Object)],
        [{ runId: 1, migrationId: 1 }, expect.any(Object)],
        [{ status: 1, lastHeartbeatAt: 1 }, expect.any(Object)],
      ]),
    );
  });
});
