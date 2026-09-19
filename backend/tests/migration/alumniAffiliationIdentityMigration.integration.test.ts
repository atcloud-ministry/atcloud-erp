import mongoose from "mongoose";
import { ObjectId, type Collection, type Document } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATION_REGISTRY } from "../../src/migrations/registry";
import type { MigrationDefinition } from "../../src/migrations/types";
import {
  MigrationRunner,
  SCHEMA_MIGRATION_COLLECTION,
} from "../../src/services/migrations/MigrationRunner";
import { SCHEMA_MIGRATION_LOCK_COLLECTION } from "../../src/services/migrations/MigrationLeaseService";
import { ensureIntegrationDB } from "../integration/setup/connect";

const PREFLIGHT_ID =
  "20260919_001_validate-alumni-affiliation-identities";
const REPLACEMENT_ID =
  "20260919_002_replace-alumni-affiliation-identity-index";
const COLLECTION = "alumni_affiliations";
const LEGACY_INDEX = "uniq_alumni_affiliation_profile_key";
const EXTERNAL_INDEX = "uniq_alumni_affiliation_profile_external_key";
const PROGRAM_INDEX = "uniq_alumni_affiliation_profile_program_key";

function database() {
  const value = mongoose.connection.db;
  if (!value) throw new Error("Integration database is not connected.");
  return value;
}

function affiliations(): Collection<Document> {
  return database().collection(COLLECTION);
}

function collection(name: string): Collection<Document> {
  return database().collection(name);
}

function productionMigrations(): readonly MigrationDefinition[] {
  const definitions = [PREFLIGHT_ID, REPLACEMENT_ID].map((id) =>
    MIGRATION_REGISTRY.find((candidate) => candidate.id === id),
  );
  if (definitions.some((definition) => definition === undefined)) {
    throw new Error("Alumni affiliation identity migrations are missing.");
  }
  return definitions as readonly MigrationDefinition[];
}

let runnerSequence = 0;
function createRunner(): MigrationRunner {
  runnerSequence += 1;
  return new MigrationRunner({
    connection: mongoose.connection,
    operator: "alumni-affiliation-migration-test",
    appVersion: "g1-02-test",
    leaseOwner: `alumni-affiliation-runner-${runnerSequence}`,
    registry: productionMigrations(),
    batchSize: 100,
    leaseDurationMs: 60_000,
  });
}

async function dropIdentityIndexes(): Promise<void> {
  let indexes: { readonly name?: string }[];
  try {
    indexes = await affiliations().listIndexes().toArray();
  } catch (error) {
    const candidate = error as {
      readonly code?: unknown;
      readonly codeName?: unknown;
    };
    if (candidate.code === 26 || candidate.codeName === "NamespaceNotFound") {
      await database().createCollection(COLLECTION);
      indexes = await affiliations().listIndexes().toArray();
    } else {
      throw error;
    }
  }
  const identityNames = new Set([LEGACY_INDEX, EXTERNAL_INDEX, PROGRAM_INDEX]);
  for (const index of indexes) {
    if (index.name && identityNames.has(index.name)) {
      await affiliations().dropIndex(index.name);
    }
  }
}

async function createLegacyIndex(): Promise<void> {
  await affiliations().createIndex(
    { alumniProfileId: 1, affiliationKey: 1 },
    { name: LEGACY_INDEX, unique: true },
  );
}

async function createProgramIndex(): Promise<void> {
  await affiliations().createIndex(
    { alumniProfileId: 1, programAffiliationKey: 1 },
    {
      name: PROGRAM_INDEX,
      unique: true,
      partialFilterExpression: {
        programAffiliationKey: { $type: "string" },
      },
    },
  );
}

function externalAffiliation(
  profile: ObjectId,
  affiliationKey: string,
  sequence: number,
) {
  return {
    _id: new ObjectId(sequence.toString(16).padStart(24, "0")),
    alumniProfileId: profile,
    programName: "Shared Program",
    cohortLabel: "2030",
    affiliationKey,
    verificationStatus: "verified",
    revision: 0,
  };
}

function programAffiliation(
  profile: ObjectId,
  programId: ObjectId,
  affiliationKey: string,
  programAffiliationKey: string,
  sequence: number,
) {
  return {
    ...externalAffiliation(profile, affiliationKey, sequence),
    programId,
    programAffiliationKey,
  };
}

async function identityIndexMap() {
  const indexes = await affiliations().listIndexes().toArray();
  return new Map(indexes.map((index) => [index.name, index]));
}

async function restoreCurrentIndexes(): Promise<void> {
  await affiliations().deleteMany({});
  await dropIdentityIndexes();
  await createProgramIndex();
  await affiliations().createIndex(
    { alumniProfileId: 1, programId: 1, affiliationKey: 1 },
    { name: EXTERNAL_INDEX, unique: true },
  );
}

describe("Alumni affiliation canonical identity migrations", () => {
  beforeAll(async () => {
    await ensureIntegrationDB();
  });

  beforeEach(async () => {
    await affiliations().deleteMany({});
    await Promise.all([
      collection(SCHEMA_MIGRATION_COLLECTION).deleteMany({}),
      collection(SCHEMA_MIGRATION_LOCK_COLLECTION).deleteMany({}),
    ]);
    await dropIdentityIndexes();
  });

  afterAll(async () => {
    await Promise.all([
      collection(SCHEMA_MIGRATION_COLLECTION).deleteMany({}),
      collection(SCHEMA_MIGRATION_LOCK_COLLECTION).deleteMany({}),
    ]);
    await restoreCurrentIndexes();
  });

  it("dry-runs exact structural and collision counts without changing data", async () => {
    const externalProfile = new ObjectId();
    const linkedProfile = new ObjectId();
    await affiliations().insertMany([
      externalAffiliation(externalProfile, "a".repeat(64), 1),
      externalAffiliation(externalProfile, "a".repeat(64), 2),
      programAffiliation(
        linkedProfile,
        new ObjectId(),
        "b".repeat(64),
        "c".repeat(64),
        3,
      ),
      programAffiliation(
        linkedProfile,
        new ObjectId(),
        "d".repeat(64),
        "c".repeat(64),
        4,
      ),
      {
        ...externalAffiliation(new ObjectId(), "e".repeat(64), 5),
        programId: null,
      },
    ]);
    const before = await affiliations().find({}).sort({ _id: 1 }).toArray();

    const result = await createRunner().dryRun(REPLACEMENT_ID);

    const preflight = result.entries.find((entry) => entry.id === PREFLIGHT_ID);
    expect(preflight?.plan.counts).toEqual({
      examined: 5,
      matched: 5,
      modified: 0,
      skipped: 0,
      errors: 0,
    });
    expect(
      Object.fromEntries(
        preflight!.plan.warnings.map((warning) => [warning.code, warning.count]),
      ),
    ).toEqual({
      ALUMNI_AFFILIATION_IDENTITY_STRUCTURE_INVALID: 1,
      ALUMNI_AFFILIATION_EXTERNAL_IDENTITY_COLLISION: 2,
      ALUMNI_AFFILIATION_PROGRAM_IDENTITY_COLLISION: 2,
    });
    expect(await affiliations().find({}).sort({ _id: 1 }).toArray()).toEqual(before);
    expect((await identityIndexMap()).has(EXTERNAL_INDEX)).toBe(false);
    expect(
      await collection(SCHEMA_MIGRATION_COLLECTION).countDocuments({}),
    ).toBe(0);
  });

  it("blocks DDL replacement when preflight finds a collision", async () => {
    const profile = new ObjectId();
    await affiliations().insertMany([
      externalAffiliation(profile, "a".repeat(64), 11),
      externalAffiliation(profile, "a".repeat(64), 12),
    ]);

    await expect(createRunner().apply(REPLACEMENT_ID)).rejects.toThrow(
      /MIGRATION_APPLY_FAILED/u,
    );

    const indexes = await identityIndexMap();
    expect(indexes.has(EXTERNAL_INDEX)).toBe(false);
    expect(indexes.has(PROGRAM_INDEX)).toBe(false);
    expect(
      await collection(SCHEMA_MIGRATION_COLLECTION).findOne({
        _id: PREFLIGHT_ID,
      }),
    ).toMatchObject({ status: "apply_failed" });
    expect(
      await collection(SCHEMA_MIGRATION_COLLECTION).findOne({
        _id: REPLACEMENT_ID,
      }),
    ).toBeNull();
  });

  it("revalidates data after preflight was applied and before any replacement DDL", async () => {
    await createProgramIndex();
    await createLegacyIndex();
    await expect(createRunner().apply(PREFLIGHT_ID)).resolves.toMatchObject({
      entries: [
        expect.objectContaining({ id: PREFLIGHT_ID, status: "applied" }),
      ],
    });
    await affiliations().insertOne({
      ...externalAffiliation(new ObjectId(), "f".repeat(64), 15),
      programId: null,
    });

    const dryRun = await createRunner().dryRun(REPLACEMENT_ID);
    expect(dryRun.entries).toHaveLength(1);
    expect(dryRun.entries[0]?.id).toBe(REPLACEMENT_ID);
    expect(dryRun.entries[0]?.plan.warnings).toEqual([
      {
        code: "ALUMNI_AFFILIATION_IDENTITY_STRUCTURE_INVALID",
        count: 1,
      },
    ]);
    let indexes = await identityIndexMap();
    expect(indexes.has(LEGACY_INDEX)).toBe(true);
    expect(indexes.has(PROGRAM_INDEX)).toBe(true);
    expect(indexes.has(EXTERNAL_INDEX)).toBe(false);
    expect(
      await collection(SCHEMA_MIGRATION_COLLECTION).findOne({
        _id: REPLACEMENT_ID,
      }),
    ).toBeNull();

    await expect(createRunner().apply(REPLACEMENT_ID)).rejects.toThrow(
      /MIGRATION_APPLY_FAILED/u,
    );

    indexes = await identityIndexMap();
    expect(indexes.has(LEGACY_INDEX)).toBe(true);
    expect(indexes.has(PROGRAM_INDEX)).toBe(true);
    expect(indexes.has(EXTERNAL_INDEX)).toBe(false);
    expect(
      await collection(SCHEMA_MIGRATION_COLLECTION).findOne({
        _id: REPLACEMENT_ID,
      }),
    ).toMatchObject({ status: "apply_failed" });
  });

  it("upgrades the legacy index and immediately rolls it back in safe order", async () => {
    await affiliations().insertOne(
      externalAffiliation(new ObjectId(), "a".repeat(64), 21),
    );
    await createProgramIndex();
    await createLegacyIndex();

    const applied = await createRunner().apply(REPLACEMENT_ID);
    expect(applied.entries.at(-1)).toMatchObject({
      id: REPLACEMENT_ID,
      status: "applied",
    });
    let indexes = await identityIndexMap();
    expect(indexes.get(EXTERNAL_INDEX)).toMatchObject({
      key: { alumniProfileId: 1, programId: 1, affiliationKey: 1 },
      unique: true,
    });
    expect(indexes.get(PROGRAM_INDEX)).toMatchObject({
      key: { alumniProfileId: 1, programAffiliationKey: 1 },
      unique: true,
      partialFilterExpression: {
        programAffiliationKey: { $type: "string" },
      },
    });
    expect(indexes.has(LEGACY_INDEX)).toBe(false);

    const rolledBack = await createRunner().rollback(
      REPLACEMENT_ID,
      "OPERATOR_REQUEST",
    );
    expect(rolledBack.entries[0]).toMatchObject({
      id: REPLACEMENT_ID,
      status: "rolled_back",
    });
    indexes = await identityIndexMap();
    expect(indexes.has(LEGACY_INDEX)).toBe(true);
    expect(indexes.has(EXTERNAL_INDEX)).toBe(false);
    expect(indexes.has(PROGRAM_INDEX)).toBe(true);
  });

  it("resumes safely when both targets were created before the legacy drop", async () => {
    await createLegacyIndex();
    await createProgramIndex();
    await affiliations().createIndex(
      { alumniProfileId: 1, programId: 1, affiliationKey: 1 },
      { name: EXTERNAL_INDEX, unique: true },
    );

    await expect(createRunner().apply(REPLACEMENT_ID)).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ id: REPLACEMENT_ID, status: "applied" }),
      ]),
    });
    const indexes = await identityIndexMap();
    expect(indexes.has(LEGACY_INDEX)).toBe(false);
    expect(indexes.has(EXTERNAL_INDEX)).toBe(true);
    expect(indexes.has(PROGRAM_INDEX)).toBe(true);
  });

  it("enforces both target identities after replacement", async () => {
    await createLegacyIndex();
    await createProgramIndex();
    await createRunner().apply(REPLACEMENT_ID);

    const profile = new ObjectId();
    const firstProgram = new ObjectId();
    const secondProgram = new ObjectId();
    await affiliations().insertMany([
      externalAffiliation(profile, "a".repeat(64), 31),
      programAffiliation(
        profile,
        firstProgram,
        "a".repeat(64),
        "b".repeat(64),
        32,
      ),
      programAffiliation(
        profile,
        secondProgram,
        "a".repeat(64),
        "c".repeat(64),
        33,
      ),
    ]);

    await expect(
      affiliations().insertOne(
        externalAffiliation(profile, "a".repeat(64), 34),
      ),
    ).rejects.toMatchObject({ code: 11000 });
    await expect(
      affiliations().insertOne(
        programAffiliation(
          profile,
          firstProgram,
          "d".repeat(64),
          "b".repeat(64),
          35,
        ),
      ),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("keeps target indexes when rollback cannot restore the stricter legacy index", async () => {
    await createLegacyIndex();
    await createProgramIndex();
    await createRunner().apply(REPLACEMENT_ID);
    const profile = new ObjectId();
    await affiliations().insertMany([
      programAffiliation(
        profile,
        new ObjectId(),
        "a".repeat(64),
        "b".repeat(64),
        41,
      ),
      programAffiliation(
        profile,
        new ObjectId(),
        "a".repeat(64),
        "c".repeat(64),
        42,
      ),
    ]);

    await expect(
      createRunner().rollback(REPLACEMENT_ID, "OPERATOR_REQUEST"),
    ).rejects.toThrow(/MIGRATION_ROLLBACK_FAILED/u);

    const indexes = await identityIndexMap();
    expect(indexes.has(LEGACY_INDEX)).toBe(false);
    expect(indexes.has(EXTERNAL_INDEX)).toBe(true);
    expect(indexes.has(PROGRAM_INDEX)).toBe(true);
    expect(
      await collection(SCHEMA_MIGRATION_COLLECTION).findOne({
        _id: REPLACEMENT_ID,
      }),
    ).toMatchObject({ status: "rollback_failed" });
  });
});
