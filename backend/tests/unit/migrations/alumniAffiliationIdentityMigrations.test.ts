import { describe, expect, it, vi } from "vitest";
import { migration as preflightMigration } from "../../../src/migrations/versions/20260919_001_validate-alumni-affiliation-identities";
import { migration as replacementMigration } from "../../../src/migrations/versions/20260919_002_replace-alumni-affiliation-identity-index";
import {
  normalizeMigrationPlan,
  normalizeMigrationVerification,
} from "../../../src/services/migrations/MigrationValidation";

function cursor(value: unknown[]) {
  return { toArray: vi.fn().mockResolvedValue(value) };
}

function identityReadDatabase(
  total = 0,
  counts: readonly number[] = [0, 0, 0],
) {
  const aggregate = vi.fn();
  for (const count of counts) {
    aggregate.mockReturnValueOnce(cursor(count === 0 ? [] : [{ count }]));
  }
  return {
    collection: vi.fn(() => ({
      aggregate,
      countDocuments: vi.fn().mockResolvedValue(total),
    })),
  };
}

describe("Alumni affiliation identity migrations", () => {
  it("keeps overlapping preflight warning counts exact while bounding affected rows", async () => {
    const aggregate = vi
      .fn()
      .mockReturnValueOnce(cursor([{ count: 1 }]))
      .mockReturnValueOnce(cursor([{ count: 2 }]))
      .mockReturnValueOnce(cursor([{ count: 2 }]));
    const collection = {
      countDocuments: vi.fn().mockResolvedValue(3),
      aggregate,
    };

    const raw = await preflightMigration.plan({
      database: { collection: vi.fn(() => collection) },
      batchSize: 100,
    } as never);
    const plan = normalizeMigrationPlan(raw);

    expect(plan.counts).toEqual({
      examined: 3,
      matched: 3,
      modified: 0,
      skipped: 0,
      errors: 0,
    });
    expect(plan.warnings).toEqual([
      {
        code: "ALUMNI_AFFILIATION_IDENTITY_STRUCTURE_INVALID",
        count: 1,
      },
      {
        code: "ALUMNI_AFFILIATION_EXTERNAL_IDENTITY_COLLISION",
        count: 2,
      },
      {
        code: "ALUMNI_AFFILIATION_PROGRAM_IDENTITY_COLLISION",
        count: 2,
      },
    ]);
  });

  it("returns valid fail-closed verification counts when categories overlap", async () => {
    const aggregate = vi
      .fn()
      .mockReturnValueOnce(cursor([{ count: 1 }]))
      .mockReturnValueOnce(cursor([{ count: 2 }]))
      .mockReturnValueOnce(cursor([{ count: 2 }]));
    const collection = {
      countDocuments: vi.fn().mockResolvedValue(3),
      aggregate,
    };

    const raw = await preflightMigration.verify({
      database: { collection: vi.fn(() => collection) },
      direction: "up",
      checkpoint: { validated: true },
      appliedCheckpoint: { validated: true },
      batchSize: 100,
    } as never);
    const verification = normalizeMigrationVerification(raw);

    expect(verification).toMatchObject({
      ok: false,
      counts: {
        examined: 3,
        matched: 3,
        errors: 3,
      },
    });
  });

  it("returns valid fail-closed counts for a missing rollback checkpoint", async () => {
    const raw = await preflightMigration.verify({
      database: { collection: vi.fn() },
      direction: "down",
      checkpoint: null,
      appliedCheckpoint: { validated: true },
      batchSize: 100,
    } as never);

    expect(normalizeMigrationVerification(raw)).toMatchObject({
      ok: false,
      counts: { examined: 1, matched: 0, errors: 1 },
    });
  });

  it("models a fresh replacement plan with valid logical operation counts", async () => {
    const collection = {
      aggregate: vi.fn(() => cursor([])),
      listIndexes: vi.fn(() => ({
        toArray: vi.fn().mockRejectedValue(
          Object.assign(new Error("missing"), { code: 26 }),
        ),
      })),
    };

    const raw = await replacementMigration.plan({
      database: { collection: vi.fn(() => collection) },
      batchSize: 100,
    } as never);

    expect(normalizeMigrationPlan(raw).counts).toEqual({
      examined: 3,
      matched: 3,
      modified: 2,
      skipped: 1,
      errors: 0,
    });
  });

  it("reports stable replacement-plan warnings when data changed after preflight", async () => {
    const aggregate = vi
      .fn()
      .mockReturnValueOnce(cursor([{ count: 1 }]))
      .mockReturnValueOnce(cursor([{ count: 2 }]))
      .mockReturnValueOnce(cursor([{ count: 3 }]));
    const collection = {
      aggregate,
      listIndexes: vi.fn(() => cursor([])),
    };

    const raw = await replacementMigration.plan({
      database: { collection: vi.fn(() => collection) },
      batchSize: 100,
    } as never);

    expect(normalizeMigrationPlan(raw).warnings).toEqual([
      {
        code: "ALUMNI_AFFILIATION_IDENTITY_STRUCTURE_INVALID",
        count: 1,
      },
      {
        code: "ALUMNI_AFFILIATION_EXTERNAL_IDENTITY_COLLISION",
        count: 2,
      },
      {
        code: "ALUMNI_AFFILIATION_PROGRAM_IDENTITY_COLLISION",
        count: 3,
      },
    ]);
  });

  it("creates both targets before dropping legacy and reverses without dropping canonical", async () => {
    const calls: string[] = [];
    const database = {
      reconcileCompoundUniqueIndex: vi.fn(async (input: { indexName: string }) => {
        calls.push(`reconcile:${input.indexName}`);
      }),
      dropCompoundUniqueIndexIfMatches: vi.fn(
        async (input: { indexName: string }) => {
          calls.push(`drop:${input.indexName}`);
        },
      ),
    };

    await replacementMigration.prepare!({
      database,
      readDatabase: identityReadDatabase(),
      direction: "up",
    } as never);
    expect(calls).toEqual([
      "reconcile:uniq_alumni_affiliation_profile_program_key",
      "reconcile:uniq_alumni_affiliation_profile_external_key",
      "drop:uniq_alumni_affiliation_profile_key",
    ]);

    calls.length = 0;
    await replacementMigration.prepare!({
      database,
      readDatabase: identityReadDatabase(),
      direction: "down",
    } as never);
    expect(calls).toEqual([
      "reconcile:uniq_alumni_affiliation_profile_key",
      "drop:uniq_alumni_affiliation_profile_external_key",
    ]);
  });

  it("blocks every DDL operation when the immediate preflight is invalid", async () => {
    const database = {
      reconcileCompoundUniqueIndex: vi.fn(),
      dropCompoundUniqueIndexIfMatches: vi.fn(),
    };

    await expect(
      replacementMigration.prepare!({
        database,
        readDatabase: identityReadDatabase(1, [1, 0, 0]),
        direction: "up",
      } as never),
    ).rejects.toThrow("identity preflight failed");

    expect(database.reconcileCompoundUniqueIndex).not.toHaveBeenCalled();
    expect(database.dropCompoundUniqueIndexIfMatches).not.toHaveBeenCalled();
  });

  it("returns a valid failed verification result for an empty namespace", async () => {
    const collection = {
      aggregate: vi.fn(() => cursor([])),
      countDocuments: vi.fn().mockResolvedValue(0),
      listIndexes: vi.fn(() => ({
        toArray: vi.fn().mockRejectedValue(
          Object.assign(new Error("missing"), {
            codeName: "NamespaceNotFound",
          }),
        ),
      })),
    };

    const raw = await replacementMigration.verify({
      database: { collection: vi.fn(() => collection) },
      direction: "up",
      checkpoint: { replaced: true },
      appliedCheckpoint: { replaced: true },
      batchSize: 100,
    } as never);

    expect(normalizeMigrationVerification(raw)).toEqual({
      ok: false,
      summary: "Verified the alumni affiliation canonical identity indexes.",
      counts: {
        examined: 1,
        matched: 0,
        modified: 0,
        skipped: 1,
        errors: 1,
      },
    });
  });

  it("fails terminal verification when data becomes invalid after DDL", async () => {
    const indexes = [
      { name: "_id_", key: { _id: 1 } },
      {
        name: "uniq_alumni_affiliation_profile_program_key",
        key: { alumniProfileId: 1, programAffiliationKey: 1 },
        unique: true,
        partialFilterExpression: {
          programAffiliationKey: { $type: "string" },
        },
      },
      {
        name: "uniq_alumni_affiliation_profile_external_key",
        key: { alumniProfileId: 1, programId: 1, affiliationKey: 1 },
        unique: true,
      },
    ];
    const readDatabase = identityReadDatabase(1, [1, 0, 0]);
    const collection = readDatabase.collection();
    Object.assign(collection, {
      listIndexes: vi.fn(() => cursor(indexes)),
    });

    const raw = await replacementMigration.verify({
      database: { collection: vi.fn(() => collection) },
      direction: "up",
      checkpoint: { replaced: true },
      appliedCheckpoint: { replaced: true },
      batchSize: 100,
    } as never);

    expect(normalizeMigrationVerification(raw)).toMatchObject({
      ok: false,
      counts: { examined: 3, matched: 2, errors: 1 },
    });
  });

  it("rejects a legacy-equivalent key even when it uses another name", async () => {
    const indexes = [
      { name: "_id_", key: { _id: 1 } },
      {
        name: "uniq_alumni_affiliation_profile_program_key",
        key: { alumniProfileId: 1, programAffiliationKey: 1 },
        unique: true,
        partialFilterExpression: {
          programAffiliationKey: { $type: "string" },
        },
      },
      {
        name: "uniq_alumni_affiliation_profile_external_key",
        key: { alumniProfileId: 1, programId: 1, affiliationKey: 1 },
        unique: true,
      },
      {
        name: "unexpected_legacy_name",
        key: { alumniProfileId: 1, affiliationKey: 1 },
        unique: true,
      },
    ];
    const raw = await replacementMigration.verify({
      database: {
        collection: vi.fn(() => ({
          aggregate: vi.fn(() => cursor([])),
          countDocuments: vi.fn().mockResolvedValue(0),
          listIndexes: vi.fn(() => cursor(indexes)),
        })),
      },
      direction: "up",
      checkpoint: { replaced: true },
      appliedCheckpoint: { replaced: true },
      batchSize: 100,
    } as never);

    expect(normalizeMigrationVerification(raw)).toMatchObject({
      ok: false,
      counts: { examined: 4, matched: 2, errors: 1 },
    });
  });
});
