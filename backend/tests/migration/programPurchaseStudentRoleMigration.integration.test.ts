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

const MIGRATION_ID =
  "20260912_001_backfill-program-purchase-student-roles";
const BACKUP_COLLECTION =
  "migration_20260912_program_purchase_role_backups";

function database() {
  const value = mongoose.connection.db;
  if (!value) throw new Error("Integration database is not connected.");
  return value;
}

function collection(name: string): Collection<Document> {
  return database().collection(name);
}

function objectId(sequence: number): ObjectId {
  return new ObjectId(sequence.toString(16).padStart(24, "0"));
}

function productionMigration(): MigrationDefinition {
  const definition = MIGRATION_REGISTRY.find(
    (candidate) => candidate.id === MIGRATION_ID,
  );
  if (!definition) throw new Error("Program purchase role migration is missing.");
  return definition;
}

let runnerSequence = 0;
function createRunner(batchSize = 2): MigrationRunner {
  runnerSequence += 1;
  return new MigrationRunner({
    connection: mongoose.connection,
    operator: "program-purchase-role-migration-test",
    appVersion: "m6-06-test",
    leaseOwner: `program-purchase-role-runner-${runnerSequence}`,
    registry: [productionMigration()],
    batchSize,
    leaseDurationMs: 60_000,
  });
}

function program(
  id: ObjectId,
  studentRoles?: readonly {
    id: string;
    name: string;
    discountEligible: boolean;
  }[],
) {
  return {
    _id: id,
    title: "Program role migration fixture",
    ...(studentRoles
      ? { programRoles: { teacherRoleName: "Mentor", studentRoles } }
      : {}),
  };
}

function purchase(
  id: ObjectId,
  programId: ObjectId,
  isClassRep: unknown,
  studentRoleId?: unknown,
) {
  return {
    _id: id,
    orderNumber: `M6-${id.toHexString()}`,
    programId,
    purchaseType: "program",
    status: "completed",
    isClassRep,
    privateEmail: `private-${id.toHexString()}@example.invalid`,
    ...(studentRoleId === undefined ? {} : { studentRoleId }),
  };
}

describe("Program purchase student-role versioned migration", () => {
  beforeAll(async () => {
    await ensureIntegrationDB();
  });

  beforeEach(async () => {
    await Promise.all([
      collection("programs").deleteMany({}),
      collection("purchases").deleteMany({}),
      collection(BACKUP_COLLECTION).deleteMany({}),
      collection(SCHEMA_MIGRATION_COLLECTION).deleteMany({}),
      collection(SCHEMA_MIGRATION_LOCK_COLLECTION).deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await Promise.all([
      collection("programs").deleteMany({}),
      collection("purchases").deleteMany({}),
      collection(BACKUP_COLLECTION).deleteMany({}),
      collection(SCHEMA_MIGRATION_COLLECTION).deleteMany({}),
      collection(SCHEMA_MIGRATION_LOCK_COLLECTION).deleteMany({}),
    ]);
  });

  it("dry-runs aggregate-safe diagnostics without changing data", async () => {
    const legacyProgramId = objectId(101);
    const ambiguousProgramId = objectId(102);
    await collection("programs").insertMany([
      program(legacyProgramId),
      program(ambiguousProgramId, [
        { id: "participant", name: "Participant", discountEligible: false },
        { id: "observer", name: "Observer", discountEligible: false },
      ]),
    ]);
    const seeded = [
      purchase(objectId(201), legacyProgramId, false),
      purchase(objectId(202), legacyProgramId, true, "removed-role"),
      purchase(objectId(203), legacyProgramId, false, "mentee"),
      purchase(objectId(204), ambiguousProgramId, false),
      purchase(objectId(205), objectId(999), false),
    ];
    await collection("purchases").insertMany(seeded);
    const before = await collection("purchases").find({}).sort({ _id: 1 }).toArray();

    const result = await createRunner().dryRun(MIGRATION_ID);

    expect(result.entries[0]?.plan.counts).toEqual({
      examined: 5,
      matched: 4,
      modified: 0,
      skipped: 1,
      errors: 0,
    });
    expect(
      Object.fromEntries(
        result.entries[0]!.plan.warnings.map((warning) => [
          warning.code,
          warning.count,
        ]),
      ),
    ).toEqual({
      PROGRAM_PURCHASE_ROLE_MISSING: 3,
      PROGRAM_PURCHASE_ROLE_INVALID: 1,
      PROGRAM_PURCHASE_ROLE_AUTO_RESOLVABLE: 2,
      PROGRAM_PURCHASE_ROLE_AMBIGUOUS: 1,
      PROGRAM_PURCHASE_ROLE_UNAVAILABLE: 1,
    });
    const serialized = JSON.stringify(result);
    for (const document of seeded) {
      expect(serialized).not.toContain(document.privateEmail);
      expect(serialized).not.toContain(document._id.toHexString());
    }
    expect(await collection("purchases").find({}).sort({ _id: 1 }).toArray()).toEqual(
      before,
    );
    expect(await collection(BACKUP_COLLECTION).countDocuments({})).toBe(0);
    expect(await collection(SCHEMA_MIGRATION_COLLECTION).countDocuments({})).toBe(
      0,
    );
  });

  it("applies deterministic candidates in bounded batches and rolls them back", async () => {
    const legacyProgramId = objectId(111);
    const customProgramId = objectId(112);
    await collection("programs").insertMany([
      program(legacyProgramId),
      program(customProgramId, [
        { id: "participant", name: "Participant", discountEligible: false },
        {
          id: "representative",
          name: "Representative",
          discountEligible: true,
        },
      ]),
    ]);
    await collection("purchases").insertMany([
      purchase(objectId(211), legacyProgramId, false),
      purchase(objectId(212), legacyProgramId, true, "removed-role"),
      purchase(objectId(213), customProgramId, false),
      purchase(objectId(214), customProgramId, true),
      purchase(objectId(215), customProgramId, false, "participant"),
    ]);

    const applied = await createRunner(2).apply(MIGRATION_ID);

    expect(applied.entries[0]).toMatchObject({
      id: MIGRATION_ID,
      status: "applied",
      counts: {
        examined: 5,
        matched: 4,
        modified: 4,
        skipped: 1,
        errors: 0,
      },
    });
    const migrated = await collection("purchases")
      .find({}, { projection: { studentRoleId: 1 } })
      .sort({ _id: 1 })
      .toArray();
    expect(migrated.map((entry) => entry.studentRoleId)).toEqual([
      "mentee",
      "classRep",
      "participant",
      "representative",
      "participant",
    ]);
    expect(await collection(BACKUP_COLLECTION).countDocuments({})).toBe(4);

    const rolledBack = await createRunner(2).rollback(
      MIGRATION_ID,
      "OPERATOR_REQUEST",
    );
    expect(rolledBack.entries[0]).toMatchObject({
      status: "rolled_back",
      counts: { examined: 4, matched: 4, modified: 4, errors: 0 },
    });
    const restored = await collection("purchases")
      .find({}, { projection: { studentRoleId: 1 } })
      .sort({ _id: 1 })
      .toArray();
    expect(restored[0]).not.toHaveProperty("studentRoleId");
    expect(restored[1]?.studentRoleId).toBe("removed-role");
    expect(restored[2]).not.toHaveProperty("studentRoleId");
    expect(restored[3]).not.toHaveProperty("studentRoleId");
    expect(restored[4]?.studentRoleId).toBe("participant");
    expect(await collection(BACKUP_COLLECTION).countDocuments({})).toBe(0);
  });

  it("fails closed before writing a batch containing ambiguous evidence", async () => {
    const programId = objectId(121);
    const purchaseId = objectId(221);
    await collection("programs").insertOne(
      program(programId, [
        { id: "participant", name: "Participant", discountEligible: false },
        { id: "observer", name: "Observer", discountEligible: false },
      ]),
    );
    await collection("purchases").insertOne(
      purchase(purchaseId, programId, false),
    );

    await expect(createRunner().apply(MIGRATION_ID)).rejects.toThrow(
      /MIGRATION_APPLY_FAILED/u,
    );

    expect(await collection("purchases").findOne({ _id: purchaseId })).not.toHaveProperty(
      "studentRoleId",
    );
    expect(await collection(BACKUP_COLLECTION).countDocuments({})).toBe(0);
    expect(
      await collection(SCHEMA_MIGRATION_COLLECTION).findOne({
        _id: MIGRATION_ID,
      }),
    ).toMatchObject({
      status: "apply_failed",
      counts: { examined: 0, matched: 0, modified: 0 },
    });
  });
});
