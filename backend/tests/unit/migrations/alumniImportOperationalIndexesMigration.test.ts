import { describe, expect, it, vi } from "vitest";
import { migration } from "../../../src/migrations/versions/20260919_003_reconcile-alumni-import-retention-indexes";
import {
  normalizeMigrationPlan,
  normalizeMigrationVerification,
} from "../../../src/services/migrations/MigrationValidation";

const activeStatuses = [
  "pending",
  "dry_running",
  "review_ready",
  "applying",
];

function cursor<T>(values: T[]) {
  return { toArray: vi.fn().mockResolvedValue(values) };
}

function exactImportIndexes() {
  return [
    {
      name: "idx_alumni_import_batch_raw_cleanup",
      key: { rawDataPurgedAt: 1, rawDataPurgeAt: 1 },
      unique: false,
    },
    {
      name: "ttl_alumni_import_batch_purge_at",
      key: { purgeAt: 1 },
      unique: false,
      expireAfterSeconds: 0,
    },
    {
      name: "uniq_alumni_import_batch_active_checksum",
      key: { checksum: 1 },
      unique: true,
      partialFilterExpression: { status: { $in: activeStatuses } },
    },
  ];
}

function exactIdempotencyIndexes() {
  return [
    {
      name: "uniq_idempotency_scope_actor_key",
      key: { hashVersion: 1, scope: 1, actorKeyHash: 1, keyHash: 1 },
      unique: true,
    },
  ];
}

function readDatabase(input: {
  readonly importIndexes?: unknown[];
  readonly idempotencyIndexes?: unknown[];
  readonly importCounts?: readonly number[];
  readonly idempotencyCount?: number;
} = {}) {
  let importAggregateCall = 0;
  return {
    collection: vi.fn((name: string) => ({
      listIndexes: vi.fn(() =>
        cursor(
          name === "alumni_import_batches"
            ? (input.importIndexes ?? exactImportIndexes())
            : (input.idempotencyIndexes ?? exactIdempotencyIndexes()),
        ),
      ),
      aggregate: vi.fn(() => {
        const count =
          name === "alumni_import_batches"
            ? (input.importCounts?.[importAggregateCall++] ?? 0)
            : (input.idempotencyCount ?? 0);
        return cursor(count === 0 ? [] : [{ count }]);
      }),
    })),
  };
}

describe("alumni import operational indexes migration", () => {
  it("reconciles all safety indexes and preserves them during rollback", async () => {
    const calls: string[] = [];
    const database = {
      reconcileCompoundUniqueIndex: vi.fn(
        async (input: { indexName: string }) => {
          calls.push(`unique:${input.indexName}`);
        },
      ),
      reconcilePartialUniqueIndex: vi.fn(
        async (input: { indexName: string }) => {
          calls.push(`partial:${input.indexName}`);
        },
      ),
      reconcileCompoundIndex: vi.fn(
        async (input: { indexName: string }) => {
          calls.push(`compound:${input.indexName}`);
        },
      ),
      reconcileExactTtlIndex: vi.fn(
        async (input: { indexName: string }) => {
          calls.push(`ttl:${input.indexName}`);
        },
      ),
    };

    for (const direction of ["up", "down"] as const) {
      calls.length = 0;
      await migration.prepare!({
        database,
        readDatabase: readDatabase(),
        direction,
      } as never);
      expect(calls).toEqual([
        "unique:uniq_idempotency_scope_actor_key",
        "partial:uniq_alumni_import_batch_active_checksum",
        "compound:idx_alumni_import_batch_raw_cleanup",
        "ttl:ttl_alumni_import_batch_purge_at",
      ]);
    }
  });

  it("blocks every DDL operation when active checksums conflict", async () => {
    const database = {
      reconcileCompoundUniqueIndex: vi.fn(),
      reconcilePartialUniqueIndex: vi.fn(),
      reconcileCompoundIndex: vi.fn(),
      reconcileExactTtlIndex: vi.fn(),
    };
    await expect(
      migration.prepare!({
        database,
        readDatabase: readDatabase({ importCounts: [0, 2] }),
        direction: "up",
      } as never),
    ).rejects.toThrow("operational index preflight failed");
    expect(database.reconcileCompoundUniqueIndex).not.toHaveBeenCalled();
    expect(database.reconcilePartialUniqueIndex).not.toHaveBeenCalled();
    expect(database.reconcileCompoundIndex).not.toHaveBeenCalled();
    expect(database.reconcileExactTtlIndex).not.toHaveBeenCalled();
  });

  it("reports data and exact-definition conflicts without exposing keys", async () => {
    const raw = await migration.plan({
      database: readDatabase({
        importIndexes: [
          {
            name: "ttl_alumni_import_batch_purge_at",
            key: { purgeAt: 1 },
            expireAfterSeconds: 60,
          },
        ],
        idempotencyIndexes: [],
        importCounts: [1, 2],
        idempotencyCount: 2,
      }),
      batchSize: 100,
    } as never);
    const plan = normalizeMigrationPlan(raw);
    expect(plan.counts).toEqual({
      examined: 4,
      matched: 4,
      modified: 4,
      skipped: 0,
      errors: 0,
    });
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        { code: "ALUMNI_IMPORT_BATCH_TTL_INDEX_CONFLICT", count: 1 },
        { code: "ALUMNI_IMPORT_ACTIVE_CHECKSUM_INVALID", count: 1 },
        { code: "ALUMNI_IMPORT_ACTIVE_CHECKSUM_DUPLICATE", count: 2 },
        { code: "ALUMNI_IMPORT_IDEMPOTENCY_DUPLICATE", count: 2 },
      ]),
    );
  });

  it("verifies the exact safety baseline in both directions", async () => {
    for (const direction of ["up", "down"] as const) {
      const raw = await migration.verify({
        database: readDatabase(),
        direction,
        checkpoint: { operationalIndexesReady: true },
        appliedCheckpoint: { operationalIndexesReady: true },
        batchSize: 100,
      } as never);
      expect(normalizeMigrationVerification(raw)).toMatchObject({
        ok: true,
        counts: { examined: 7, matched: 7, errors: 0 },
      });
    }
  });

  it("rejects an extra index on a required key", async () => {
    const raw = await migration.verify({
      database: readDatabase({
        importIndexes: [
          ...exactImportIndexes(),
          { name: "unexpected_checksum", key: { checksum: 1 } },
        ],
      }),
      direction: "up",
      checkpoint: { operationalIndexesReady: true },
      appliedCheckpoint: { operationalIndexesReady: true },
      batchSize: 100,
    } as never);
    expect(normalizeMigrationVerification(raw)).toMatchObject({
      ok: false,
      counts: { examined: 7, matched: 6, errors: 1 },
    });
  });
});
