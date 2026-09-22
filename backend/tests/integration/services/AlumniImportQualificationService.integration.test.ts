import mongoose from "mongoose";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  addFixedDays,
  addUtcCalendarMonths,
  deriveAlumniAffiliationKey,
} from "../../../src/contracts/alumniDirectoryData";
import AlumniAffiliation from "../../../src/models/AlumniAffiliation";
import AlumniImportBatch from "../../../src/models/AlumniImportBatch";
import AlumniInvitation from "../../../src/models/AlumniInvitation";
import AlumniProfile from "../../../src/models/AlumniProfile";
import AuditLog from "../../../src/models/AuditLog";
import IdempotencyRecord from "../../../src/models/IdempotencyRecord";
import Program from "../../../src/models/Program";
import User from "../../../src/models/User";
import { AlumniImportService } from "../../../src/services/alumni/AlumniImportService";
import {
  AlumniImportQualificationError,
  AlumniImportQualificationService,
} from "../../../src/services/alumni/AlumniImportQualificationService";
import type { IssueRosterInvitationInput } from "../../../src/services/alumni/AlumniInvitationService";
import { IdempotencyService } from "../../../src/services/reliability/IdempotencyService";
import { MongoTransactionService } from "../../../src/services/reliability/MongoTransactionService";
import { ensureIntegrationDB } from "../setup/connect";

const NOW = new Date("2030-09-19T12:00:00.000Z");
const ACTOR_ID = "507f1f77bcf86cd799439011";
const ACTOR = { id: ACTOR_ID, role: "Administrator" } as const;

const trackedModels = [
  AlumniAffiliation,
  AlumniImportBatch,
  AlumniInvitation,
  AlumniProfile,
  AuditLog,
  IdempotencyRecord,
  Program,
  User,
] as const;

function createImportService() {
  return new AlumniImportService({
    now: () => new Date(NOW),
    idempotency: new IdempotencyService(
      new MongoTransactionService(mongoose.connection),
    ),
    invitations: {
      issueForApprovedRoster: vi.fn(
        async (_input: IssueRosterInvitationInput) => ({
          invitationId: new mongoose.Types.ObjectId().toString(),
          issueCount: 1,
          created: true,
        }),
      ),
    },
  });
}

function createQualificationService() {
  return new AlumniImportQualificationService({
    migrationReadiness: { assertReady: vi.fn(async () => undefined) },
    transactionService: {
      assertTopologyCapability: vi.fn(async () => ({ supported: true })),
    },
  });
}

async function insertUser(input: {
  readonly id?: string;
  readonly email: string;
  readonly suffix: string;
  readonly role?: string;
  readonly active?: boolean;
  readonly verified?: boolean;
}) {
  const id = input.id
    ? new mongoose.Types.ObjectId(input.id)
    : new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    _id: id,
    username: `qualification_${input.suffix}`,
    usernameLower: `qualification_${input.suffix}`,
    email: input.email,
    password: "not-used-by-this-test",
    isAtCloudLeader: false,
    role: input.role ?? "Participant",
    isActive: input.active ?? true,
    isVerified: input.verified ?? true,
    emailNotifications: true,
    loginAttempts: 0,
    hasReceivedWelcomeMessage: false,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return id;
}

function expectationFor(
  qualification: AlumniImportQualificationService,
  csv: Buffer,
) {
  const source = qualification.inspectSource(csv).source;
  return {
    checksum: source.checksum,
    totalRows: source.totalRows,
    uniqueContacts: source.uniqueContacts,
  };
}

describe("AlumniImportQualificationService production verification", () => {
  beforeAll(async () => {
    expect(process.env.MONGODB_TEST_URI).toBeTruthy();
    await ensureIntegrationDB();
    await Promise.all(trackedModels.map((model) => model.init()));
    const capability = await new MongoTransactionService(
      mongoose.connection,
    ).assertTopologyCapability(true);
    expect(capability.supported).toBe(true);
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(trackedModels.map((model) => model.deleteMany({})));
    await insertUser({
      id: ACTOR_ID,
      email: "qualification-admin@example.com",
      suffix: "admin",
      role: "Administrator",
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await Promise.all(trackedModels.map((model) => model.deleteMany({})));
  });

  it("qualifies and cancels a 322-row production-sized dry-run", async () => {
    const imports = createImportService();
    const qualification = createQualificationService();
    const csv = Buffer.from(
      [
        "email,firstName,lastName,programName,cohortLabel",
        ...Array.from(
          { length: 322 },
          (_, index) =>
            `alumni${index + 1}@example.com,Alumni,${index + 1},External Program,2030`,
        ),
      ].join("\n"),
      "utf8",
    );
    const expectation = expectationFor(qualification, csv);
    expect(expectation).toMatchObject({ totalRows: 322, uniqueContacts: 322 });
    await expect(
      Promise.all([
        AlumniProfile.countDocuments({}),
        AlumniInvitation.countDocuments({}),
        AlumniAffiliation.countDocuments({}),
      ]),
    ).resolves.toEqual([0, 0, 0]);

    const dryRun = await imports.dryRun({
      csv,
      actor: ACTOR,
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      auditSource: "system",
      operator: "release-20300919",
    });
    await expect(
      Promise.all([
        AlumniProfile.countDocuments({}),
        AlumniInvitation.countDocuments({}),
        AlumniAffiliation.countDocuments({}),
      ]),
    ).resolves.toEqual([0, 0, 0]);
    const report = await qualification.verifyBatch({
      batchId: dryRun.batchId,
      csv,
      expectation,
    });
    expect(report.status).toBe("passed");
    expect(report.issues).toEqual([]);
    expect(report.verification).toEqual(
      expect.objectContaining({
        sourceChecksumMatches: true,
        sourceRowCountMatches: true,
        sourceUniqueContactCountMatches: true,
        accountMatchingMatches: true,
      }),
    );
    expect(JSON.stringify(report)).not.toContain("alumni1@example.com");

    const cancelled = await imports.cancel({
      batchId: dryRun.batchId,
      expectedRevision: 0,
      expectedChecksum: expectation.checksum,
      expectedRowCount: 322,
      expectedUniqueContactCount: 322,
      reasonCode: "operator_request",
      actor: ACTOR,
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
      auditSource: "system",
      operator: "release-20300919",
    });
    expect(cancelled).toMatchObject({
      replayed: false,
      status: "cancelled",
      revision: 1,
      terminalAt: NOW.toISOString(),
      rawDataPurgeAt: addFixedDays(NOW, 30).toISOString(),
      purgeAt: addUtcCalendarMonths(NOW, 6).toISOString(),
    });
    await expect(
      imports.cancel({
        batchId: dryRun.batchId,
        expectedRevision: 0,
        expectedChecksum: expectation.checksum,
        expectedRowCount: 322,
        expectedUniqueContactCount: 322,
        reasonCode: "operator_request",
        actor: ACTOR,
        idempotencyKey: "22222222-2222-4222-8222-222222222222",
        auditSource: "system",
        operator: "release-20300919",
      }),
    ).resolves.toMatchObject({ replayed: true, status: "cancelled" });
    expect(
      await AuditLog.findOne({ action: "alumni_import.cancelled" }).lean(),
    ).toMatchObject({
      source: "system",
      reasonCode: "operator_request",
      details: {
        totalRows: 322,
        uniqueContacts: 322,
        operator: "release-20300919",
      },
    });
  });

  it("can terminate an all-invalid zero-contact batch with exact expectations", async () => {
    const imports = createImportService();
    const qualification = createQualificationService();
    const csv = Buffer.from("email,programName\nnot-an-email,\n", "utf8");
    const expectation = expectationFor(qualification, csv);
    expect(expectation).toMatchObject({ totalRows: 1, uniqueContacts: 0 });
    const dryRun = await imports.dryRun({
      csv,
      actor: ACTOR,
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
    });

    await expect(
      imports.cancel({
        batchId: dryRun.batchId,
        expectedRevision: 0,
        expectedChecksum: expectation.checksum,
        expectedRowCount: 1,
        expectedUniqueContactCount: 1,
        reasonCode: "data_validation_failed",
        actor: ACTOR,
        idempotencyKey: "44444444-4444-4444-8444-444444444444",
      }),
    ).rejects.toMatchObject({ code: "ALUMNI_IMPORT_EXPECTATION_CONFLICT" });
    expect(await AlumniImportBatch.findById(dryRun.batchId).lean()).toMatchObject({
      status: "review_ready",
      revision: 0,
    });

    await expect(
      imports.cancel({
        batchId: dryRun.batchId,
        expectedRevision: 0,
        expectedChecksum: expectation.checksum,
        expectedRowCount: 1,
        expectedUniqueContactCount: 0,
        reasonCode: "data_validation_failed",
        actor: ACTOR,
        idempotencyKey: "55555555-5555-4555-8555-555555555555",
      }),
    ).resolves.toMatchObject({ status: "cancelled", revision: 1 });
  });

  it("detects exact row-error tuple, account-match, enum, and checksum tampering", async () => {
    const matchedUserId = await insertUser({
      email: "matched@example.com",
      suffix: "matched",
    });
    const imports = createImportService();
    const qualification = createQualificationService();
    const validCsv = Buffer.from(
      "email,programName\nmatched@example.com,External Program\n",
      "utf8",
    );
    const validExpectation = expectationFor(qualification, validCsv);
    const validBatch = await imports.dryRun({
      csv: validCsv,
      actor: ACTOR,
      idempotencyKey: "66666666-6666-4666-8666-666666666666",
    });
    expect(
      await qualification.verifyBatch({
        batchId: validBatch.batchId,
        csv: validCsv,
        expectation: validExpectation,
      }),
    ).toMatchObject({ status: "passed" });

    await AlumniImportBatch.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(validBatch.batchId) },
      {
        $set: {
          "rowResults.0.matchedUserId": new mongoose.Types.ObjectId(),
        },
      },
    );
    const matchTamper = await qualification.verifyBatch({
      batchId: validBatch.batchId,
      csv: validCsv,
      expectation: validExpectation,
    });
    expect(matchTamper.issues).toContainEqual({
      code: "ACCOUNT_MATCH_MISMATCH",
      count: 1,
    });
    expect(matchTamper.verification.accountMatchingMatches).toBe(false);

    await AlumniImportBatch.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(validBatch.batchId) },
      {
        $set: {
          "rowResults.0.matchedUserId": matchedUserId,
          "rowResults.0.matchStatus": "unknown",
          checksum: "malformed",
        },
      },
    );
    const structuralTamper = await qualification.verifyBatch({
      batchId: validBatch.batchId,
      csv: validCsv,
      expectation: validExpectation,
    });
    expect(structuralTamper.batch.checksum).toBe("invalid");
    expect(structuralTamper.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "BATCH_CHECKSUM_MISMATCH" }),
        expect.objectContaining({ code: "ROW_RESULTS_INVALID" }),
        expect.objectContaining({ code: "COUNT_INVARIANT_FAILED" }),
      ]),
    );

    const invalidCsv = Buffer.from(
      "email,programName\nnot-an-email,\n",
      "utf8",
    );
    const invalidExpectation = expectationFor(qualification, invalidCsv);
    const invalidBatch = await imports.dryRun({
      csv: invalidCsv,
      actor: ACTOR,
      idempotencyKey: "77777777-7777-4777-8777-777777777777",
    });
    await AlumniImportBatch.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(invalidBatch.batchId) },
      {
        $set: {
          "rowErrors.0.rowNumber": 99,
          "rowErrors.0.code": "private_email_example_com",
        },
      },
    );
    const rowErrorTamper = await qualification.verifyBatch({
      batchId: invalidBatch.batchId,
      csv: invalidCsv,
      expectation: invalidExpectation,
    });
    expect(rowErrorTamper.issues).toContainEqual({
      code: "ROW_ERROR_DISTRIBUTION_MISMATCH",
      count: 1,
    });
    expect(rowErrorTamper.rowIssues).toContainEqual({
      code: "invalid_error_code",
      count: 1,
    });
    expect(JSON.stringify(rowErrorTamper)).not.toContain(
      "private_email_example_com",
    );
  });

  it("accepts a valid manual match only while its referenced user exists", async () => {
    const manualUserId = await insertUser({
      email: "manual-target@example.com",
      suffix: "manual",
    });
    const imports = createImportService();
    const qualification = createQualificationService();
    const csv = Buffer.from(
      "email,programName\nroster@example.com,External Program\n",
      "utf8",
    );
    const expectation = expectationFor(qualification, csv);
    const dryRun = await imports.dryRun({
      csv,
      actor: ACTOR,
      idempotencyKey: "88888888-8888-4888-8888-888888888888",
    });
    const rows = await imports.listRows({
      batchId: dryRun.batchId,
      page: 1,
      limit: 20,
    });
    await imports.review({
      batchId: dryRun.batchId,
      expectedRevision: 0,
      decisions: [
        {
          rowNumber: rows.rows[0]!.rowNumber,
          rowKey: rows.rows[0]!.rowKey,
          eligibilityStatus: "approved",
          resolution: {
            matchStatus: "matched",
            matchedUserId: manualUserId.toString(),
          },
        },
      ],
      actor: ACTOR,
      idempotencyKey: "99999999-9999-4999-8999-999999999999",
    });

    const validManual = await qualification.verifyBatch({
      batchId: dryRun.batchId,
      csv,
      expectation,
    });
    expect(validManual.verification.accountMatchingMatches).toBe(true);
    expect(validManual.issues).not.toContainEqual(
      expect.objectContaining({ code: "ACCOUNT_MATCH_MISMATCH" }),
    );

    await User.deleteOne({ _id: manualUserId });
    const missingManual = await qualification.verifyBatch({
      batchId: dryRun.batchId,
      csv,
      expectation,
    });
    expect(missingManual.issues).toContainEqual({
      code: "ACCOUNT_MATCH_MISMATCH",
      count: 1,
    });
  });

  it("accepts an ambiguous row after a durable rejection decision", async () => {
    // Simulate legacy duplicate accounts. The current User schema prevents new
    // duplicates, but qualification must still safely handle historical data.
    await User.collection.dropIndex("email_1");
    try {
      await insertUser({
        email: "ambiguous@example.com",
        suffix: "ambiguous_one",
      });
      await insertUser({
        email: "ambiguous@example.com",
        suffix: "ambiguous_two",
      });
      const imports = createImportService();
      const qualification = createQualificationService();
      const csv = Buffer.from(
        "email,programName\nambiguous@example.com,External Program\n",
        "utf8",
      );
      const expectation = expectationFor(qualification, csv);
      const dryRun = await imports.dryRun({
        csv,
        actor: ACTOR,
        idempotencyKey: "abababab-abab-4bab-8bab-abababababab",
      });
      const rows = await imports.listRows({
        batchId: dryRun.batchId,
        page: 1,
        limit: 20,
      });
      expect(rows.rows[0]).toMatchObject({
        matchStatus: "ambiguous",
        eligibilityStatus: "pending_review",
      });
      await imports.review({
        batchId: dryRun.batchId,
        expectedRevision: 0,
        decisions: [
          {
            rowNumber: rows.rows[0]!.rowNumber,
            rowKey: rows.rows[0]!.rowKey,
            eligibilityStatus: "rejected",
          },
        ],
        actor: ACTOR,
        idempotencyKey: "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc",
      });

      const report = await qualification.verifyBatch({
        batchId: dryRun.batchId,
        csv,
        expectation,
      });
      expect(report.status).toBe("passed");
      expect(report.issues).not.toContainEqual(
        expect.objectContaining({ code: "AMBIGUOUS_MATCH_REQUIRES_REVIEW" }),
      );
    } finally {
      await User.deleteMany({ email: "ambiguous@example.com" });
      await User.collection.createIndex(
        { email: 1 },
        { name: "email_1", unique: true },
      );
    }
  });

  it("rejects missing schema version and malformed revision metadata", async () => {
    const imports = createImportService();
    const qualification = createQualificationService();
    const csv = Buffer.from(
      "email,programName\nmetadata@example.com,External Program\n",
      "utf8",
    );
    const expectation = expectationFor(qualification, csv);
    const dryRun = await imports.dryRun({
      csv,
      actor: ACTOR,
      idempotencyKey: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
    });
    await AlumniImportBatch.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(dryRun.batchId) },
      { $unset: { schemaVersion: "" }, $set: { revision: -1 } },
    );

    const report = await qualification.verifyBatch({
      batchId: dryRun.batchId,
      csv,
      expectation,
    });
    expect(report.status).toBe("failed");
    expect(report.batch.revision).toBe(0);
    expect(report.issues).toContainEqual({
      code: "BATCH_METADATA_INVALID",
      count: 2,
    });
  });

  it("rejects impossible review-ready phases, provenance, and side-effect counts", async () => {
    const imports = createImportService();
    const qualification = createQualificationService();
    const csv = Buffer.from(
      "email,programName\nphase@example.com,External Program\n",
      "utf8",
    );
    const expectation = expectationFor(qualification, csv);

    const createBatch = async (key: string) =>
      imports.dryRun({ csv, actor: ACTOR, idempotencyKey: key });

    const countTamper = await createBatch(
      "10101010-1010-4010-8010-101010101010",
    );
    await AlumniImportBatch.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(countTamper.batchId) },
      { $set: { "counts.invitationsCreated": 1 } },
    );
    await expect(
      qualification.verifyBatch({
        batchId: countTamper.batchId,
        csv,
        expectation,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "COUNT_INVARIANT_FAILED" }),
      ]),
    });

    await AlumniImportBatch.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(countTamper.batchId) },
      { $set: { "counts.invitationsCreated": 0 } },
    );
    await imports.cancel({
      batchId: countTamper.batchId,
      expectedRevision: 0,
      expectedChecksum: expectation.checksum,
      expectedRowCount: 1,
      expectedUniqueContactCount: 1,
      reasonCode: "operator_request",
      actor: ACTOR,
      idempotencyKey: "20202020-2020-4020-8020-202020202020",
    });
    const phaseTamper = await createBatch(
      "30303030-3030-4030-8030-303030303030",
    );
    await AlumniImportBatch.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(phaseTamper.batchId) },
      {
        $set: {
          "rowResults.0.eligibilityStatus": "approved",
          "rowResults.0.reviewedAt": NOW,
          "rowResults.0.reviewedBy": new mongoose.Types.ObjectId(ACTOR_ID),
          "rowResults.0.applicationStatus": "skipped",
          "rowResults.0.applicationUpdatedAt": NOW,
          "counts.approvedRows": 1,
        },
      },
    );
    await expect(
      qualification.verifyBatch({
        batchId: phaseTamper.batchId,
        csv,
        expectation,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "ROW_RESULTS_INVALID" }),
      ]),
    });

    await AlumniImportBatch.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(phaseTamper.batchId) },
      {
        $set: {
          "rowResults.0.eligibilityStatus": "pending_review",
          "rowResults.0.matchMethod": "manual",
          "rowResults.0.applicationStatus": "pending",
          "rowResults.0.applicationUpdatedAt": null,
          "counts.approvedRows": 0,
        },
        $unset: {
          "rowResults.0.reviewedAt": "",
          "rowResults.0.reviewedBy": "",
        },
      },
    );
    await expect(
      qualification.verifyBatch({
        batchId: phaseTamper.batchId,
        csv,
        expectation,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "ROW_RESULTS_INVALID" }),
      ]),
    });

    const invalidCsv = Buffer.from(
      "email,programName\nnot-an-email,External Program\n",
      "utf8",
    );
    const invalidExpectation = expectationFor(qualification, invalidCsv);
    const invalidPhase = await imports.dryRun({
      csv: invalidCsv,
      actor: ACTOR,
      idempotencyKey: "40404040-4040-4040-8040-404040404040",
    });
    await AlumniImportBatch.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(invalidPhase.batchId) },
      {
        $set: {
          "rowResults.0.applicationStatus": "pending",
          "rowResults.0.applicationUpdatedAt": null,
        },
      },
    );
    await expect(
      qualification.verifyBatch({
        batchId: invalidPhase.batchId,
        csv: invalidCsv,
        expectation: invalidExpectation,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "ROW_RESULTS_INVALID" }),
      ]),
    });
  });

  it("reports affiliation null, normalization, identity, duplicate, and missing-batch issues", async () => {
    const imports = createImportService();
    const qualification = createQualificationService();
    const csv = Buffer.from(
      "email,programName\nverify@example.com,External Program\n",
      "utf8",
    );
    const expectation = expectationFor(qualification, csv);
    const dryRun = await imports.dryRun({
      csv,
      actor: ACTOR,
      idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const profileOne = new mongoose.Types.ObjectId();
    const profileTwo = new mongoose.Types.ObjectId();
    const duplicateProfile = new mongoose.Types.ObjectId();
    await AlumniAffiliation.collection.insertMany([
      {
        alumniProfileId: profileOne,
        programId: null,
        programName: "Program One",
        cohortLabel: null,
        affiliationKey: deriveAlumniAffiliationKey({
          programName: "Program One",
          cohortLabel: null,
        }),
        programAffiliationKey: null,
        verificationStatus: "pending_review",
        revision: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        alumniProfileId: profileTwo,
        programName: " Program  Two ",
        cohortLabel: " 2030 ",
        affiliationKey: deriveAlumniAffiliationKey({
          programName: " Program  Two ",
          cohortLabel: " 2030 ",
        }),
        verificationStatus: "pending_review",
        revision: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        alumniProfileId: duplicateProfile,
        programName: "Duplicate Program",
        cohortLabel: null,
        affiliationKey: "a".repeat(64),
        verificationStatus: "pending_review",
        revision: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        alumniProfileId: duplicateProfile,
        programName: "Duplicate Program",
        cohortLabel: null,
        affiliationKey: "b".repeat(64),
        verificationStatus: "pending_review",
        revision: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);

    const report = await qualification.verifyBatch({
      batchId: dryRun.batchId,
      csv,
      expectation,
    });
    expect(report.affiliations).toMatchObject({
      totalRecords: 4,
      formatErrorRecords: 2,
      affiliationKeyMismatchRecords: 2,
      duplicateIdentityGroups: 1,
      duplicateIdentityRecords: 1,
    });
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "AFFILIATION_FORMAT_ERROR", count: 2 }),
        expect.objectContaining({
          code: "AFFILIATION_NAME_IDENTITY_MISMATCH",
          count: 2,
        }),
        expect.objectContaining({
          code: "AFFILIATION_DUPLICATE_IDENTITY",
          count: 1,
        }),
      ]),
    );

    const missing = await qualification.verifyBatch({
      batchId: new mongoose.Types.ObjectId().toString(),
      csv,
      expectation,
    });
    expect(missing.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "BATCH_NOT_FOUND" }),
        expect.objectContaining({ code: "AFFILIATION_FORMAT_ERROR" }),
      ]),
    );
  });

  it("validates actor authorization and exact operational index subsets", async () => {
    const qualification = createQualificationService();
    await expect(qualification.assertOperatorActor(ACTOR_ID)).resolves.toEqual({
      id: ACTOR_ID,
      role: "Administrator",
    });
    const participantId = await insertUser({
      email: "participant@example.com",
      suffix: "participant",
    });
    await expect(
      qualification.assertOperatorActor(participantId.toString()),
    ).rejects.toMatchObject({ code: "ALUMNI_IMPORT_ACTOR_UNAUTHORIZED" });
    await expect(qualification.assertOperationalGates()).resolves.toBeUndefined();
    await expect(qualification.assertCancellationGates()).resolves.toBeUndefined();

    const affiliationIndexes = vi
      .spyOn(AlumniAffiliation.collection, "listIndexes")
      .mockReturnValue({ toArray: async () => [] } as never);
    await expect(qualification.assertOperationalGates()).rejects.toBeInstanceOf(
      AlumniImportQualificationError,
    );
    await expect(qualification.assertCancellationGates()).resolves.toBeUndefined();
    affiliationIndexes.mockRestore();

    const idempotencyIndexes = vi
      .spyOn(IdempotencyRecord.collection, "listIndexes")
      .mockReturnValue({
        toArray: async () => [
          {
            name: "uniq_idempotency_scope_actor_key",
            key: {
              hashVersion: 1,
              scope: 1,
              actorKeyHash: 1,
              keyHash: 1,
            },
            unique: false,
          },
        ],
      } as never);
    await expect(qualification.assertCancellationGates()).rejects.toMatchObject({
      code: "ALUMNI_IMPORT_REQUIRED_INDEX_MISSING",
    });
    idempotencyIndexes.mockRestore();

    const actualImportIndexes = await AlumniImportBatch.collection
      .listIndexes()
      .toArray();
    const explicitFalseImportIndexes = vi
      .spyOn(AlumniImportBatch.collection, "listIndexes")
      .mockReturnValue({
        toArray: async () =>
          actualImportIndexes.map((index) =>
            [
              "ttl_alumni_import_batch_purge_at",
              "idx_alumni_import_batch_raw_cleanup",
            ].includes(index.name ?? "")
              ? { ...index, unique: false }
              : index,
          ),
      } as never);
    await expect(qualification.assertOperationalGates()).resolves.toBeUndefined();
    await expect(qualification.assertCancellationGates()).resolves.toBeUndefined();
    explicitFalseImportIndexes.mockRestore();

    const importIndexes = vi
      .spyOn(AlumniImportBatch.collection, "listIndexes")
      .mockReturnValue({ toArray: async () => [] } as never);
    await expect(qualification.assertCancellationGates()).rejects.toMatchObject({
      code: "ALUMNI_IMPORT_REQUIRED_INDEX_MISSING",
    });
    importIndexes.mockRestore();

    const actualAffiliationIndexes = await AlumniAffiliation.collection
      .listIndexes()
      .toArray();
    const legacyAffiliation = vi
      .spyOn(AlumniAffiliation.collection, "listIndexes")
      .mockReturnValue({
        toArray: async () => [
          ...actualAffiliationIndexes,
          {
            name: "unexpected_legacy_name",
            key: { alumniProfileId: 1, affiliationKey: 1 },
            unique: true,
          },
        ],
      } as never);
    await expect(qualification.assertOperationalGates()).rejects.toMatchObject({
      code: "ALUMNI_IMPORT_REQUIRED_INDEX_MISSING",
    });
    legacyAffiliation.mockRestore();

    const duplicateRequiredKey = vi
      .spyOn(AlumniImportBatch.collection, "listIndexes")
      .mockReturnValue({
        toArray: async () => [
          ...actualImportIndexes,
          { name: "unexpected_purge", key: { purgeAt: 1 } },
        ],
      } as never);
    await expect(qualification.assertOperationalGates()).rejects.toMatchObject({
      code: "ALUMNI_IMPORT_REQUIRED_INDEX_MISSING",
    });
    duplicateRequiredKey.mockRestore();
  });
});
