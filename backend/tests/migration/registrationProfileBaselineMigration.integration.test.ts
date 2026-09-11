import mongoose from "mongoose";
import { validateRegistrationProfile } from "@atcloud/shared-time/registration-profile";
import {
  Double,
  Int32,
  ObjectId,
  type Collection,
  type Document,
} from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATION_REGISTRY } from "../../src/migrations/registry";
import type {
  MigrationBatchContext,
  MigrationDefinition,
} from "../../src/migrations/types";
import {
  MigrationRunner,
  SCHEMA_MIGRATION_COLLECTION,
} from "../../src/services/migrations/MigrationRunner";
import { SCHEMA_MIGRATION_LOCK_COLLECTION } from "../../src/services/migrations/MigrationLeaseService";
import { ensureIntegrationDB } from "../integration/setup/connect";

const MIGRATION_ID = "20260911_001_inventory-registration-profile";
const USER_COLLECTION = "users";

function database() {
  const value = mongoose.connection.db;
  if (!value) throw new Error("Integration database is not connected.");
  return value;
}

function users(): Collection<Document> {
  return database().collection(USER_COLLECTION);
}

function ledger(): Collection<Document> {
  return database().collection(SCHEMA_MIGRATION_COLLECTION);
}

function locks(): Collection<Document> {
  return database().collection(SCHEMA_MIGRATION_LOCK_COLLECTION);
}

function objectId(sequence: number): ObjectId {
  return new ObjectId(sequence.toString(16).padStart(24, "0"));
}

function canonicalProfile() {
  return {
    phone: "+12065550199",
    birthYear: new Int32(1990),
    residenceCity: "Seattle",
    residenceRegion: "US-WA",
    residenceCountryCode: "US",
    employmentStatus: "employed",
    company: "Example Company",
    occupation: null,
  };
}

function legacyUser(sequence: number, suffix = String(sequence)) {
  const username = `legacy-${suffix}`;
  return {
    _id: objectId(sequence),
    username,
    usernameLower: username.toLowerCase(),
    email: `private-${suffix}@example.invalid`,
    phone: `206-555-01${suffix.padStart(2, "0")}`,
    homeAddress: `${suffix} Private Legacy Address`,
  };
}

function productionMigration(): MigrationDefinition {
  const definition = MIGRATION_REGISTRY.find(
    (candidate) => candidate.id === MIGRATION_ID,
  );
  if (!definition) throw new Error("Registration-profile migration is missing.");
  return definition;
}

let runnerSequence = 0;

function createRunner(
  registry: readonly MigrationDefinition[] = [productionMigration()],
  batchSize = 2,
): MigrationRunner {
  runnerSequence += 1;
  return new MigrationRunner({
    connection: mongoose.connection,
    operator: "registration-profile-migration-test",
    appVersion: "m1-03-test",
    leaseOwner: `registration-profile-runner-${runnerSequence}`,
    registry,
    batchSize,
    leaseDurationMs: 60_000,
  });
}

describe("registration-profile baseline migration", () => {
  beforeAll(async () => {
    await ensureIntegrationDB();
    await users().createIndex({ usernameLower: 1 }, { unique: true });
  });

  beforeEach(async () => {
    await Promise.all([
      users().deleteMany({}),
      ledger().deleteMany({}),
      locks().deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await Promise.all([
      users().deleteMany({}),
      ledger().deleteMany({}),
      locks().deleteMany({}),
    ]);
  });

  it("dry-runs aggregate warnings without returning profile PII", async () => {
    const seeded = [
      legacyUser(1, "alice"),
      {
        _id: objectId(2),
        username: "complete-user",
        usernameLower: "complete-user",
        email: "complete-private@example.invalid",
        homeAddress: "Do Not Return This Address",
        ...canonicalProfile(),
      },
      {
        _id: objectId(3),
        username: "noncanonical-user",
        usernameLower: "noncanonical-user",
        email: "noncanonical-private@example.invalid",
        phone: " +12065550188 ",
        birthYear: new Double(2027),
        residenceCity: " Seattle ",
        residenceRegion: "us-wa",
        residenceCountryCode: "us",
        employmentStatus: " EMPLOYED ",
        company: " Example Company ",
        occupation: "Engineer\nManager",
      },
      {
        _id: objectId(4),
        username: "unknown-iso-user",
        usernameLower: "unknown-iso-user",
        email: "unknown-iso-private@example.invalid",
        ...canonicalProfile(),
        residenceCountryCode: "ZZ",
        residenceRegion: "ZZ-ZZZ",
      },
    ];
    await users().insertMany(seeded);
    const before = await users().find({}).sort({ _id: 1 }).toArray();

    const unknownIsoProfile = validateRegistrationProfile(
      {
        ...canonicalProfile(),
        birthYear: 1990,
        residenceCountryCode: "ZZ",
        residenceRegion: "ZZ-ZZZ",
      },
      new Date("2026-09-11T00:00:00.000Z"),
    );
    expect(unknownIsoProfile.success).toBe(false);
    if (!unknownIsoProfile.success) {
      expect(unknownIsoProfile.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "residenceCountryCode" }),
          expect.objectContaining({ field: "residenceRegion" }),
        ]),
      );
    }

    const result = await createRunner().dryRun(MIGRATION_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.plan.counts).toEqual({
      examined: 4,
      matched: 4,
      modified: 0,
      skipped: 0,
      errors: 0,
    });
    const warnings = Object.fromEntries(
      result.entries[0]!.plan.warnings.map((warning) => [
        warning.code,
        warning.count,
      ]),
    );
    expect(warnings).toMatchObject({
      PROFILE_WITH_OBSERVED_ISSUES: 2,
      PHONE_NOT_CANONICAL_E164: 2,
      BIRTH_YEAR_MISSING: 1,
      BIRTH_YEAR_INVALID: 1,
      BIRTH_YEAR_NOT_BSON_INT: 1,
      RESIDENCE_CITY_MISSING: 1,
      RESIDENCE_CITY_NOT_CANONICAL: 1,
      RESIDENCE_REGION_ABSENT: 1,
      RESIDENCE_REGION_NOT_CANONICAL: 1,
      RESIDENCE_COUNTRY_MISSING: 1,
      RESIDENCE_COUNTRY_NOT_CANONICAL: 1,
      EMPLOYMENT_STATUS_MISSING: 1,
      EMPLOYMENT_STATUS_NOT_CANONICAL: 1,
      COMPANY_REQUIRED_NOT_CANONICAL: 1,
      OPTIONAL_OCCUPATION_ABSENT: 3,
      OCCUPATION_NOT_CANONICAL: 1,
      LEGACY_HOME_ADDRESS_PRESENT: 2,
    });
    expect(
      Object.keys(warnings).some((code) => /COMPLETE|READINESS/u.test(code)),
    ).toBe(false);

    const output = JSON.stringify(result);
    for (const privateValue of [
      "private-alice@example.invalid",
      "206-555-01alice",
      "alice Private Legacy Address",
      "Do Not Return This Address",
      "complete-private@example.invalid",
      "unknown-iso-private@example.invalid",
    ]) {
      expect(output).not.toContain(privateValue);
    }
    expect(await users().find({}).sort({ _id: 1 }).toArray()).toEqual(before);
  });

  it("uses bounded keyset batches and excludes users beyond the fixed high-watermark", async () => {
    const initialUsers = [
      legacyUser(11),
      legacyUser(12),
      legacyUser(13),
      legacyUser(14),
      legacyUser(15),
    ];
    await users().insertMany(initialUsers);
    const before = await users()
      .find({ _id: { $in: initialUsers.slice(0, 4).map((user) => user._id) } })
      .sort({ _id: 1 })
      .toArray();

    const base = productionMigration();
    let upCalls = 0;
    const wrapped: MigrationDefinition = {
      ...base,
      up: async (context: MigrationBatchContext) => {
        const result = await base.up(context);
        upCalls += 1;
        if (upCalls === 1) {
          await users().insertOne(legacyUser(99, "created-during-run"));
          await users().updateOne(
            { _id: objectId(15) },
            {
              $set: canonicalProfile(),
              $unset: { homeAddress: "" },
            },
          );
        }
        return result;
      },
    };

    const result = await createRunner([wrapped]).apply(MIGRATION_ID);
    expect(upCalls).toBe(3);
    expect(result.entries[0]).toMatchObject({
      id: MIGRATION_ID,
      status: "applied",
      counts: {
        examined: 5,
        matched: 5,
        modified: 0,
        skipped: 0,
        errors: 0,
      },
    });

    const after = await users()
      .find({ _id: { $in: initialUsers.slice(0, 4).map((user) => user._id) } })
      .sort({ _id: 1 })
      .toArray();
    expect(after).toEqual(before);
    expect(await users().findOne({ _id: objectId(15) })).toMatchObject({
      ...canonicalProfile(),
      birthYear: 1990,
    });
    expect(
      await users().findOne({ _id: objectId(99) }),
    ).toMatchObject({ username: "legacy-created-during-run" });

    const record = await ledger().findOne({ _id: MIGRATION_ID });
    expect(record?.applyCheckpoint).toMatchObject({
      highWatermark: objectId(15).toHexString(),
      lastId: objectId(15).toHexString(),
      inventory: {
        usersScanned: 5,
        profilesWithObservedIssues: 4,
      },
    });
    const persisted = JSON.stringify(record?.applyCheckpoint);
    expect(persisted).not.toContain("Private Legacy Address");
    expect(persisted).not.toContain("206-555");
  });

  it("resumes after a committed checkpoint, reruns safely, and rolls back only the ledger", async () => {
    const seeded = [
      legacyUser(21),
      legacyUser(22),
      legacyUser(23),
      legacyUser(24),
      legacyUser(25),
    ];
    await users().insertMany(seeded);
    const before = await users().find({}).sort({ _id: 1 }).toArray();

    const base = productionMigration();
    let upCalls = 0;
    const interrupted: MigrationDefinition = {
      ...base,
      up: async (context: MigrationBatchContext) => {
        upCalls += 1;
        if (upCalls === 2) throw new Error("Injected baseline scan interruption.");
        return base.up(context);
      },
    };
    await expect(
      createRunner([interrupted]).apply(MIGRATION_ID),
    ).rejects.toThrow(/failed with code MIGRATION_APPLY_FAILED/);
    expect(await ledger().findOne({ _id: MIGRATION_ID })).toMatchObject({
      status: "apply_failed",
      applyCheckpoint: {
        lastId: objectId(22).toHexString(),
        inventory: { usersScanned: 2 },
      },
    });

    const resumed = await createRunner().resume(MIGRATION_ID);
    expect(resumed.entries[0]).toMatchObject({
      status: "applied",
      counts: { examined: 5, matched: 5, modified: 0, errors: 0 },
    });
    expect((await createRunner().apply(MIGRATION_ID)).entries).toEqual([]);

    await users().updateOne(
      { _id: objectId(25) },
      {
        $set: canonicalProfile(),
        $unset: { homeAddress: "" },
      },
    );
    const afterUserCompletion = await users().find({}).sort({ _id: 1 }).toArray();

    const rolledBack = await createRunner().rollback(
      MIGRATION_ID,
      "OPERATOR_REQUEST",
    );
    expect(rolledBack.entries[0]).toMatchObject({
      status: "rolled_back",
      counts: { examined: 0, matched: 0, modified: 0, errors: 0 },
    });
    expect(await users().find({}).sort({ _id: 1 }).toArray()).toEqual(
      afterUserCompletion,
    );
    expect(afterUserCompletion).not.toEqual(before);

    const reapplied = await createRunner().apply(MIGRATION_ID);
    expect(reapplied.entries[0]).toMatchObject({
      status: "applied",
      counts: { examined: 5, matched: 5, modified: 0, errors: 0 },
    });
    expect(await users().find({}).sort({ _id: 1 }).toArray()).toEqual(
      afterUserCompletion,
    );
  });
});
