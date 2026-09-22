import { describe, expect, it, vi } from "vitest";
import type { MigrationDefinition } from "../../../../src/migrations/types";
import { MigrationReadinessService } from "../../../../src/services/migrations/MigrationReadinessService";

const ZERO_COUNTS = {
  examined: 0,
  matched: 0,
  modified: 0,
  skipped: 0,
  errors: 0,
};

function definition(id: string, digit: string): MigrationDefinition {
  return {
    id,
    description: id,
    checksum: digit.repeat(64),
    plan: async () => ({
      summary: id,
      counts: ZERO_COUNTS,
      estimatedBatches: 0,
      warnings: [],
    }),
    up: async () => ({ done: true, checkpoint: null, counts: ZERO_COUNTS }),
    down: async () => ({ done: true, checkpoint: null, counts: ZERO_COUNTS }),
    verify: async () => ({ ok: true, summary: id, counts: ZERO_COUNTS }),
  };
}

const registry = [
  definition("20260916_001_first", "a"),
  definition("20260917_001_second", "b"),
  definition("20260918_001_third", "c"),
] as const;

const applied = (index: number) => ({
  _id: registry[index].id,
  migrationId: registry[index].id,
  checksum: registry[index].checksum,
  status: "applied",
});

describe("MigrationReadinessService", () => {
  it("accepts the exact fully-applied ledger", async () => {
    const service = new MigrationReadinessService({
      registry,
      readLedger: vi.fn().mockResolvedValue([applied(0), applied(1), applied(2)]),
    });
    await expect(service.getSnapshot()).resolves.toEqual({
      ready: true,
      appliedCount: 3,
      requiredCount: 3,
      issues: [],
    });
  });

  it("detects missing versions, checksum drift, and an applied-version gap", async () => {
    const service = new MigrationReadinessService({
      registry,
      readLedger: vi.fn().mockResolvedValue([
        applied(0),
        { ...applied(2), checksum: "d".repeat(64) },
      ]),
    });
    const snapshot = await service.getSnapshot();
    expect(snapshot.ready).toBe(false);
    expect(snapshot.issues).toEqual(
      expect.arrayContaining(["PENDING_MIGRATION", "CHECKSUM_DRIFT"]),
    );

    const gap = new MigrationReadinessService({
      registry,
      readLedger: vi.fn().mockResolvedValue([applied(0), applied(2)]),
    });
    expect((await gap.getSnapshot()).issues).toContain("VERSION_GAP");
  });

  it("detects recovery states and fails closed when the ledger cannot be read", async () => {
    const recovery = new MigrationReadinessService({
      registry,
      readLedger: vi.fn().mockResolvedValue([
        applied(0),
        { ...applied(1), status: "apply_failed" },
      ]),
    });
    expect((await recovery.getSnapshot()).issues).toEqual(
      expect.arrayContaining(["RECOVERY_REQUIRED", "PENDING_MIGRATION"]),
    );

    const unavailable = new MigrationReadinessService({
      registry,
      readLedger: vi.fn().mockRejectedValue(new Error("private database failure")),
    });
    await expect(unavailable.getSnapshot()).resolves.toMatchObject({
      ready: false,
      issues: ["LEDGER_READ_FAILED"],
    });
    await expect(unavailable.assertReady()).rejects.toMatchObject({
      code: "ALUMNI_NETWORK_MIGRATIONS_NOT_READY",
    });
  });
});
