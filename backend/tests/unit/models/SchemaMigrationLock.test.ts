import { describe, expect, it } from "vitest";
import SchemaMigrationLock, {
  SCHEMA_MIGRATION_GLOBAL_LOCK_ID,
} from "../../../src/models/SchemaMigrationLock";

const MIGRATION_ID = "20260909_001_add-alumni-directory";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";
const ACQUIRED_AT = new Date("2026-09-09T12:00:00.000Z");
const HEARTBEAT_AT = new Date("2026-09-09T12:00:01.000Z");
const EXPIRES_AT = new Date("2026-09-09T12:01:01.000Z");

function activeLock(overrides: Record<string, unknown> = {}) {
  return new SchemaMigrationLock({
    _id: SCHEMA_MIGRATION_GLOBAL_LOCK_ID,
    runId: RUN_ID,
    token: TOKEN,
    owner: "migration-test-runner",
    currentMigrationId: MIGRATION_ID,
    acquiredAt: ACQUIRED_AT,
    heartbeatAt: HEARTBEAT_AT,
    expiresAt: EXPIRES_AT,
    releasedAt: null,
    fence: 1,
    revision: 1,
    ...overrides,
  });
}

function releasedLock(overrides: Record<string, unknown> = {}) {
  return new SchemaMigrationLock({
    _id: SCHEMA_MIGRATION_GLOBAL_LOCK_ID,
    runId: null,
    token: null,
    owner: null,
    currentMigrationId: null,
    acquiredAt: ACQUIRED_AT,
    heartbeatAt: HEARTBEAT_AT,
    expiresAt: HEARTBEAT_AT,
    releasedAt: new Date("2026-09-09T12:00:02.000Z"),
    fence: 2,
    revision: 4,
    ...overrides,
  });
}

describe("SchemaMigrationLock model", () => {
  it("accepts active and released global lock states", async () => {
    await expect(activeLock().validate()).resolves.toBeUndefined();
    await expect(releasedLock().validate()).resolves.toBeUndefined();
  });

  it("defaults to the fixed global string _id and rejects any other id", async () => {
    const defaultId = activeLock({ _id: undefined });
    expect(defaultId._id).toBe(SCHEMA_MIGRATION_GLOBAL_LOCK_ID);
    expect(typeof defaultId._id).toBe("string");
    await expect(defaultId.validate()).resolves.toBeUndefined();

    await expect(activeLock({ _id: "another-lock" }).validate()).rejects.toThrow(
      "Schema migration lock _id must be global",
    );
    expect(SchemaMigrationLock.schema.path("_id").options.immutable).toBe(true);
  });

  it("rejects unknown fields in strict throw mode", () => {
    expect(() => activeLock({ unexpected: true })).toThrow();
  });

  it.each(["runId", "token", "owner"])(
    "requires %s as part of a complete active lease identity",
    async (field) => {
      await expect(activeLock({ [field]: null }).validate()).rejects.toThrow(
        "active migration lock requires owner, runId, and token",
      );
    },
  );

  it("validates active identity formats and the current migration id", async () => {
    for (const overrides of [
      { runId: "not-a-uuid" },
      { token: "not-a-uuid" },
      { owner: "unsafe\nowner" },
      { currentMigrationId: "not-a-migration-id" },
    ]) {
      await expect(activeLock(overrides).validate()).rejects.toThrow();
    }
  });

  it("requires an active lease to expire after its heartbeat", async () => {
    await expect(
      activeLock({ expiresAt: HEARTBEAT_AT }).validate(),
    ).rejects.toThrow("expiresAt must follow heartbeatAt");
  });

  it("requires heartbeat and release timestamps to follow acquisition", async () => {
    const beforeAcquisition = new Date("2026-09-09T11:59:59.000Z");

    await expect(
      activeLock({ heartbeatAt: beforeAcquisition }).validate(),
    ).rejects.toThrow("heartbeatAt cannot precede acquiredAt");

    await expect(
      releasedLock({ releasedAt: beforeAcquisition }).validate(),
    ).rejects.toThrow("releasedAt cannot precede acquiredAt");

    await expect(
      activeLock({ expiresAt: beforeAcquisition }).validate(),
    ).rejects.toThrow("expiresAt cannot precede acquiredAt");
  });

  it("requires release to follow the final heartbeat", async () => {
    await expect(
      releasedLock({
        heartbeatAt: new Date("2026-09-09T12:00:03.000Z"),
      }).validate(),
    ).rejects.toThrow("releasedAt cannot precede heartbeatAt");
  });

  it("requires released locks to clear identity and current migration fields", async () => {
    for (const overrides of [
      { runId: RUN_ID },
      { token: TOKEN },
      { owner: "migration-test-runner" },
      { currentMigrationId: MIGRATION_ID },
    ]) {
      await expect(releasedLock(overrides).validate()).rejects.toThrow(
        "released migration lock cannot retain lease identity fields",
      );
    }
  });

  it("requires released locks to be expired no later than release", async () => {
    await expect(
      releasedLock({ expiresAt: EXPIRES_AT }).validate(),
    ).rejects.toThrow("released migration lock cannot remain unexpired");
  });

  it("requires positive safe-integer fencing and revision counters", async () => {
    for (const overrides of [
      { fence: 0 },
      { fence: 1.5 },
      { revision: 0 },
      { revision: 1.5 },
    ]) {
      await expect(activeLock(overrides).validate()).rejects.toThrow();
    }
  });

  it("declares the stable lock collection and expiry index", () => {
    expect(SchemaMigrationLock.modelName).toBe("SchemaMigrationLock");
    expect(SchemaMigrationLock.collection.name).toBe("schema_migration_locks");
    expect(SchemaMigrationLock.schema.get("strict")).toBe("throw");
    expect(SchemaMigrationLock.schema.get("versionKey")).toBe(false);
    expect(SchemaMigrationLock.schema.indexes()).toEqual(
      expect.arrayContaining([[{ expiresAt: 1 }, expect.any(Object)]]),
    );
  });
});
