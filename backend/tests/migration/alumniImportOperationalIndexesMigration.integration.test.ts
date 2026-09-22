import mongoose from "mongoose";
import { type Collection, type Document } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATION_REGISTRY } from "../../src/migrations/registry";
import type { MigrationDefinition } from "../../src/migrations/types";
import AlumniImportBatch from "../../src/models/AlumniImportBatch";
import IdempotencyRecord from "../../src/models/IdempotencyRecord";
import {
  MigrationRunner,
  SCHEMA_MIGRATION_COLLECTION,
} from "../../src/services/migrations/MigrationRunner";
import { SCHEMA_MIGRATION_LOCK_COLLECTION } from "../../src/services/migrations/MigrationLeaseService";
import { ensureIntegrationDB } from "../integration/setup/connect";

const MIGRATION_ID =
  "20260919_003_reconcile-alumni-import-retention-indexes";
const IMPORT_COLLECTION = "alumni_import_batches";
const IDEMPOTENCY_COLLECTION = "idempotencyrecords";
const INDEX_NAMES = new Set([
  "ttl_alumni_import_batch_purge_at",
  "idx_alumni_import_batch_raw_cleanup",
  "uniq_alumni_import_batch_active_checksum",
  "uniq_idempotency_scope_actor_key",
]);

function database() {
  const value = mongoose.connection.db;
  if (!value) throw new Error("Integration database is not connected.");
  return value;
}

function collection(name: string): Collection<Document> {
  return database().collection(name);
}

function definition(): MigrationDefinition {
  const value = MIGRATION_REGISTRY.find((entry) => entry.id === MIGRATION_ID);
  if (!value) throw new Error("Alumni import operational migration is missing.");
  return value;
}

let runnerSequence = 0;
function createRunner(): MigrationRunner {
  runnerSequence += 1;
  return new MigrationRunner({
    connection: mongoose.connection,
    operator: "alumni-import-operational-index-test",
    appVersion: "g1-02-test",
    leaseOwner: `alumni-import-index-runner-${runnerSequence}`,
    registry: [definition()],
    batchSize: 100,
    leaseDurationMs: 60_000,
  });
}

async function dropOperationalIndexes(): Promise<void> {
  for (const name of [IMPORT_COLLECTION, IDEMPOTENCY_COLLECTION]) {
    let indexes: { readonly name?: string }[];
    try {
      indexes = await collection(name).listIndexes().toArray();
    } catch (error) {
      const candidate = error as {
        readonly code?: unknown;
        readonly codeName?: unknown;
      };
      if (candidate.code === 26 || candidate.codeName === "NamespaceNotFound") {
        await database().createCollection(name);
        indexes = await collection(name).listIndexes().toArray();
      } else {
        throw error;
      }
    }
    for (const index of indexes) {
      if (index.name && INDEX_NAMES.has(index.name)) {
        await collection(name).dropIndex(index.name);
      }
    }
  }
}

async function indexNames(name: string): Promise<Set<string | undefined>> {
  return new Set(
    (await collection(name).listIndexes().toArray()).map((index) => index.name),
  );
}

async function indexMap(name: string) {
  const indexes = await collection(name).listIndexes().toArray();
  return new Map(indexes.map((index) => [index.name, index]));
}

describe("Alumni import operational index migration", () => {
  beforeAll(async () => {
    await ensureIntegrationDB();
    await Promise.all([AlumniImportBatch.init(), IdempotencyRecord.init()]);
  });

  beforeEach(async () => {
    await Promise.all([
      collection(IMPORT_COLLECTION).deleteMany({}),
      collection(IDEMPOTENCY_COLLECTION).deleteMany({}),
      collection(SCHEMA_MIGRATION_COLLECTION).deleteMany({}),
      collection(SCHEMA_MIGRATION_LOCK_COLLECTION).deleteMany({}),
    ]);
    await dropOperationalIndexes();
  });

  afterAll(async () => {
    await Promise.all([
      collection(IMPORT_COLLECTION).deleteMany({}),
      collection(IDEMPOTENCY_COLLECTION).deleteMany({}),
      collection(SCHEMA_MIGRATION_COLLECTION).deleteMany({}),
      collection(SCHEMA_MIGRATION_LOCK_COLLECTION).deleteMany({}),
    ]);
    await Promise.all([
      AlumniImportBatch.syncIndexes(),
      IdempotencyRecord.syncIndexes(),
    ]);
  });

  it("creates exact safety indexes and preserves them on rollback", async () => {
    await expect(createRunner().apply(MIGRATION_ID)).resolves.toMatchObject({
      entries: [expect.objectContaining({ id: MIGRATION_ID, status: "applied" })],
    });
    const importIndexes = await indexMap(IMPORT_COLLECTION);
    expect(importIndexes.get("ttl_alumni_import_batch_purge_at")).toMatchObject({
      key: { purgeAt: 1 },
      expireAfterSeconds: 0,
    });
    expect(importIndexes.get("idx_alumni_import_batch_raw_cleanup")).toMatchObject({
      key: { rawDataPurgedAt: 1, rawDataPurgeAt: 1 },
    });
    expect(importIndexes.get("uniq_alumni_import_batch_active_checksum")).toMatchObject({
      key: { checksum: 1 },
      unique: true,
      partialFilterExpression: {
        status: {
          $in: ["pending", "dry_running", "review_ready", "applying"],
        },
      },
    });
    expect(
      (await indexMap(IDEMPOTENCY_COLLECTION)).get(
        "uniq_idempotency_scope_actor_key",
      ),
    ).toMatchObject({
      key: { hashVersion: 1, scope: 1, actorKeyHash: 1, keyHash: 1 },
      unique: true,
    });

    await expect(
      createRunner().rollback(MIGRATION_ID, "OPERATOR_REQUEST"),
    ).resolves.toMatchObject({
      entries: [
        expect.objectContaining({ id: MIGRATION_ID, status: "rolled_back" }),
      ],
    });
    expect(
      (await indexNames(IMPORT_COLLECTION)).has(
        "uniq_alumni_import_batch_active_checksum",
      ),
    ).toBe(true);
    expect(
      (await indexNames(IDEMPOTENCY_COLLECTION)).has(
        "uniq_idempotency_scope_actor_key",
      ),
    ).toBe(true);

    await expect(createRunner().apply(MIGRATION_ID)).resolves.toMatchObject({
      entries: [expect.objectContaining({ id: MIGRATION_ID, status: "applied" })],
    });
    expect(
      (await indexMap(IMPORT_COLLECTION)).get(
        "uniq_alumni_import_batch_active_checksum",
      ),
    ).toMatchObject({
      key: { checksum: 1 },
      unique: true,
    });
  });

  it("blocks all DDL when duplicate active checksums exist", async () => {
    const now = new Date("2030-09-19T00:00:00.000Z");
    await collection(IMPORT_COLLECTION).insertMany([
      {
        checksum: "a".repeat(64),
        status: "review_ready",
        createdBy: new mongoose.Types.ObjectId(),
        counts: {},
        revision: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        checksum: "a".repeat(64),
        status: "applying",
        createdBy: new mongoose.Types.ObjectId(),
        counts: {},
        revision: 0,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    await expect(createRunner().apply(MIGRATION_ID)).rejects.toThrow(
      /MIGRATION_APPLY_FAILED/u,
    );
    const names = await indexNames(IMPORT_COLLECTION);
    expect(names.has("ttl_alumni_import_batch_purge_at")).toBe(false);
    expect(names.has("idx_alumni_import_batch_raw_cleanup")).toBe(false);
    expect(names.has("uniq_alumni_import_batch_active_checksum")).toBe(false);
    expect(
      (await indexNames(IDEMPOTENCY_COLLECTION)).has(
        "uniq_idempotency_scope_actor_key",
      ),
    ).toBe(false);
  });
});
