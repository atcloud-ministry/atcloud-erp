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
} from "../../../src/contracts/alumniDirectoryData";
import AlumniImportBatch from "../../../src/models/AlumniImportBatch";
import AuditLog from "../../../src/models/AuditLog";
import IdempotencyRecord from "../../../src/models/IdempotencyRecord";
import Program from "../../../src/models/Program";
import User from "../../../src/models/User";
import {
  AlumniImportService,
} from "../../../src/services/alumni/AlumniImportService";
import type { IssueRosterInvitationInput } from "../../../src/services/alumni/AlumniInvitationService";
import { parseAlumniRosterCsv } from "../../../src/services/alumni/AlumniRosterCsvParser";
import { IdempotencyService } from "../../../src/services/reliability/IdempotencyService";
import { MongoTransactionService } from "../../../src/services/reliability/MongoTransactionService";
import { ensureIntegrationDB } from "../setup/connect";

const NOW = new Date("2030-09-12T12:00:00.000Z");
const ACTOR = {
  id: "507f1f77bcf86cd799439011",
  role: "Administrator",
} as const;

const trackedModels = [
  AlumniImportBatch,
  AuditLog,
  IdempotencyRecord,
  Program,
  User,
] as const;

function createService(
  options: {
    readonly issueError?: unknown;
    readonly now?: () => Date;
  } = {},
) {
  const issueForApprovedRoster = vi.fn(
    async (input: IssueRosterInvitationInput) => {
      expect(input.session.inTransaction()).toBe(true);
      if (options.issueError) throw options.issueError;
      return {
        invitationId: new mongoose.Types.ObjectId().toString(),
        issueCount: 1,
        created: true,
      };
    },
  );
  const service = new AlumniImportService({
    now: options.now ?? (() => new Date(NOW)),
    idempotency: new IdempotencyService(
      new MongoTransactionService(mongoose.connection),
    ),
    invitations: { issueForApprovedRoster },
  });
  return { service, issueForApprovedRoster };
}

async function insertUser(email: string, suffix: string, active = true) {
  const now = new Date(NOW);
  const result = await User.collection.insertOne({
    username: `alumni_${suffix}`,
    usernameLower: `alumni_${suffix}`,
    email,
    password: "not-used-by-this-test",
    isAtCloudLeader: false,
    role: "Participant",
    isActive: active,
    isVerified: active,
    emailNotifications: true,
    loginAttempts: 0,
    hasReceivedWelcomeMessage: false,
    createdAt: now,
    updatedAt: now,
  });
  return result.insertedId;
}

async function insertProgram(title: string) {
  const now = new Date(NOW);
  const result = await Program.collection.insertOne({
    title,
    programType: "EMBA Mentor Circles",
    isFree: true,
    fullPriceTicket: 0,
    createdBy: new mongoose.Types.ObjectId(ACTOR.id),
    createdAt: now,
    updatedAt: now,
  });
  return result.insertedId;
}

describe("AlumniImportService", () => {
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
    await Promise.all(trackedModels.map((model) => model.deleteMany({})));
  });

  afterAll(async () => {
    await Promise.all(trackedModels.map((model) => model.deleteMany({})));
  });

  it("runs, reviews, applies, reads, replays, and reruns a retained roster", async () => {
    const matchedUserId = await insertUser(
      "existing@example.com",
      "existing",
      false,
    );
    const programId = await insertProgram("EMBA Mentor Circles");
    const { service, issueForApprovedRoster } = createService();
    const csv = Buffer.from(
      [
        "email,firstName,lastName,programName,cohortLabel,programId",
        `EXISTING@EXAMPLE.COM,Amy,Chen,EMBA Mentor Circles,2022,${programId}`,
        "new@example.com,New,Alum,External Fellowship,2024,",
        `existing@example.com,Amy,Chen,EMBA Mentor Circles,2022,${programId}`,
        "not-an-email,Bad,Contact,External Fellowship,2025,",
      ].join("\n"),
      "utf8",
    );

    const dryRun = await service.dryRun({
      csv,
      actor: ACTOR,
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      correlationId: "alumni-import-dry-run",
    });
    expect(dryRun).toMatchObject({
      replayed: false,
      status: "review_ready",
      revision: 0,
      totalRows: 4,
      validRows: 2,
      invalidRows: 2,
      matchedRows: 1,
      unmatchedRows: 1,
    });
    const replay = await service.dryRun({
      csv,
      actor: ACTOR,
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      correlationId: "ignored-on-replay",
    });
    expect(replay).toEqual({ ...dryRun, replayed: true });
    expect(await AlumniImportBatch.countDocuments({})).toBe(1);

    const rows = await service.listRows({
      batchId: dryRun.batchId,
      page: 1,
      limit: 20,
    });
    expect(rows.rows).toHaveLength(4);
    expect(rows.rows[0]).toMatchObject({
      rowNumber: 2,
      contactEmail: "existing@example.com",
      matchStatus: "matched",
      matchMethod: "exact_email",
      matchedUser: { id: matchedUserId.toString() },
      eligibilityStatus: "pending_review",
    });
    expect(rows.rows[2]).toMatchObject({
      rowNumber: 4,
      matchStatus: "invalid",
      matchMethod: "none",
      errors: [expect.objectContaining({ code: "duplicate_affiliation" })],
    });

    const review = await service.review({
      batchId: dryRun.batchId,
      expectedRevision: 0,
      decisions: [
        {
          rowNumber: rows.rows[0]!.rowNumber,
          rowKey: rows.rows[0]!.rowKey,
          eligibilityStatus: "approved",
        },
        {
          rowNumber: rows.rows[1]!.rowNumber,
          rowKey: rows.rows[1]!.rowKey,
          eligibilityStatus: "rejected",
          reviewReasonCode: "not_confirmed",
        },
      ],
      actor: ACTOR,
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
    });
    expect(review).toMatchObject({
      replayed: false,
      revision: 1,
      approvedRows: 1,
      rejectedRows: 1,
      pendingReviewRows: 0,
    });

    const applied = await service.apply({
      batchId: dryRun.batchId,
      expectedRevision: 1,
      actor: ACTOR,
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
    });
    expect(applied).toEqual({
      replayed: false,
      batchId: dryRun.batchId,
      status: "completed",
      revision: 2,
      appliedRows: 1,
      invitationsCreated: 1,
      remainingRows: 0,
    });
    expect(issueForApprovedRoster).toHaveBeenCalledTimes(1);
    expect(issueForApprovedRoster.mock.calls[0]![0]).toMatchObject({
      contactEmail: "existing@example.com",
      matchedUserId,
      affiliations: [
        expect.objectContaining({
          programId,
          programName: "EMBA Mentor Circles",
          cohortLabel: "2022",
          sourceRowNumber: 2,
        }),
      ],
    });

    const stored = await AlumniImportBatch.findById(dryRun.batchId).select(
      "+rawHeaders +rawRows +rowErrors +rowResults",
    );
    expect(stored).toMatchObject({
      status: "completed",
      revision: 2,
      terminalAt: NOW,
      rawDataPurgeAt: addFixedDays(NOW, 30),
      purgeAt: addUtcCalendarMonths(NOW, 6),
    });
    expect(
      await AuditLog.countDocuments({
        targetModel: "AlumniImportBatch",
        targetId: dryRun.batchId,
      }),
    ).toBe(3);

    const rerun = await service.rerun({
      batchId: dryRun.batchId,
      expectedRevision: 2,
      actor: ACTOR,
      idempotencyKey: "44444444-4444-4444-8444-444444444444",
    });
    expect(rerun).toMatchObject({
      replayed: false,
      sourceBatchId: dryRun.batchId,
      sourceRevision: 3,
      status: "review_ready",
      revision: 0,
      totalRows: 4,
      validRows: 2,
      invalidRows: 2,
    });
    const rerunBatch = await AlumniImportBatch.findById(rerun.batchId).select(
      "+rowResults",
    );
    expect(rerunBatch?.rerunOfBatchId?.toString()).toBe(dryRun.batchId);
    expect(rerunBatch?.counts).toMatchObject({
      approvedRows: 0,
      rejectedRows: 0,
      appliedRows: 0,
      invitationsCreated: 0,
      affiliationsCreated: 0,
    });
    expect(
      rerunBatch?.rowResults?.filter(
        (row) => row.eligibilityStatus === "pending_review",
      ),
    ).toHaveLength(2);
  });

  it("allows only one active dry-run per checksum across actors and keys", async () => {
    const { service } = createService();
    const csv = Buffer.from(
      "email,programName\nconcurrent@example.com,External Fellowship\n",
      "utf8",
    );
    const secondActor = {
      id: "507f1f77bcf86cd799439012",
      role: "Administrator",
    } as const;
    const results = await Promise.allSettled([
      service.dryRun({
        csv,
        actor: ACTOR,
        idempotencyKey: "10101010-1010-4010-8010-101010101010",
      }),
      service.dryRun({
        csv,
        actor: secondActor,
        idempotencyKey: "20202020-2020-4020-8020-202020202020",
      }),
    ]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof service.dryRun>>
      > => result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      code: "ALUMNI_IMPORT_STATE_CONFLICT",
      httpStatus: 409,
    });
    expect(
      await AlumniImportBatch.countDocuments({ status: "review_ready" }),
    ).toBe(1);

    const parsed = parseAlumniRosterCsv(csv);
    await service.cancel({
      batchId: fulfilled[0]!.value.batchId,
      expectedRevision: 0,
      expectedChecksum: parsed.checksum,
      expectedRowCount: 1,
      expectedUniqueContactCount: 1,
      reasonCode: "operator_request",
      actor: ACTOR,
      idempotencyKey: "30303030-3030-4030-8030-303030303030",
    });
    await expect(
      service.dryRun({
        csv,
        actor: secondActor,
        idempotencyKey: "40404040-4040-4040-8040-404040404040",
      }),
    ).resolves.toMatchObject({ status: "review_ready", replayed: false });
  });

  it("binds dry-run and cancellation idempotency to audit attribution", async () => {
    const { service } = createService();
    const csv = Buffer.from(
      "email,programName\nattribution@example.com,External Fellowship\n",
      "utf8",
    );
    const dryRunKey = "50505050-5050-4050-8050-505050505050";
    const dryRun = await service.dryRun({
      csv,
      actor: ACTOR,
      idempotencyKey: dryRunKey,
      auditSource: "system",
      operator: "release-a",
    });
    await expect(
      service.dryRun({
        csv,
        actor: ACTOR,
        idempotencyKey: dryRunKey,
        auditSource: "system",
        operator: "release-b",
      }),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST",
    });

    const parsed = parseAlumniRosterCsv(csv);
    const cancelKey = "60606060-6060-4060-8060-606060606060";
    await service.cancel({
      batchId: dryRun.batchId,
      expectedRevision: 0,
      expectedChecksum: parsed.checksum,
      expectedRowCount: 1,
      expectedUniqueContactCount: 1,
      reasonCode: "operator_request",
      actor: ACTOR,
      idempotencyKey: cancelKey,
      auditSource: "system",
      operator: "release-a",
    });
    await expect(
      service.cancel({
        batchId: dryRun.batchId,
        expectedRevision: 0,
        expectedChecksum: parsed.checksum,
        expectedRowCount: 1,
        expectedUniqueContactCount: 1,
        reasonCode: "operator_request",
        actor: ACTOR,
        idempotencyKey: cancelKey,
        auditSource: "http",
      }),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST",
    });
    expect(
      await AuditLog.findOne({ action: "alumni_import.cancelled" }).lean(),
    ).toMatchObject({ source: "system", details: { operator: "release-a" } });
  });

  it("rejects a header-only roster without creating a batch or receipt", async () => {
    const { service } = createService();
    await expect(
      service.dryRun({
        csv: Buffer.from("email,programName\n", "utf8"),
        actor: ACTOR,
        idempotencyKey: "55555555-5555-4555-8555-555555555555",
      }),
    ).rejects.toMatchObject({
      code: "ALUMNI_INPUT_INVALID",
      httpStatus: 400,
    });
    expect(await AlumniImportBatch.countDocuments({})).toBe(0);
    expect(await IdempotencyRecord.countDocuments({})).toBe(0);
  });

  it("returns a controlled client error when row results exceed the retained envelope", async () => {
    const { service } = createService();
    const oversizedName = "x".repeat(1_500);
    const csv = Buffer.from(
      [
        "email,firstName,programName",
        ...Array.from(
          { length: 5_000 },
          (_, index) =>
            `oversized${index + 1}@example.com,${oversizedName},Program`,
        ),
      ].join("\n"),
      "utf8",
    );
    expect(csv.length).toBeLessThan(8 * 1024 * 1024);
    expect(parseAlumniRosterCsv(csv).rows).toHaveLength(5_000);

    await expect(
      service.dryRun({
        csv,
        actor: ACTOR,
        idempotencyKey: "18181818-1818-4818-8818-181818181818",
      }),
    ).rejects.toMatchObject({
      code: "ALUMNI_INPUT_INVALID",
      httpStatus: 400,
    });
    expect(await AlumniImportBatch.countDocuments({})).toBe(0);
    expect(await IdempotencyRecord.countDocuments({})).toBe(0);
  });

  it("honors an admin's explicit unmatched resolution even when the email has an account", async () => {
    await insertUser("override@example.com", "override");
    const { service, issueForApprovedRoster } = createService();
    const dryRun = await service.dryRun({
      csv: Buffer.from(
        "email,programName\noverride@example.com,External Fellowship\n",
        "utf8",
      ),
      actor: ACTOR,
      idempotencyKey: "66666666-6666-4666-8666-666666666666",
    });
    const rows = await service.listRows({
      batchId: dryRun.batchId,
      page: 1,
      limit: 20,
    });
    await service.review({
      batchId: dryRun.batchId,
      expectedRevision: 0,
      decisions: [
        {
          rowNumber: rows.rows[0]!.rowNumber,
          rowKey: rows.rows[0]!.rowKey,
          eligibilityStatus: "approved",
          resolution: { matchStatus: "unmatched" },
        },
      ],
      actor: ACTOR,
      idempotencyKey: "77777777-7777-4777-8777-777777777777",
    });
    await expect(
      service.apply({
        batchId: dryRun.batchId,
        expectedRevision: 1,
        actor: ACTOR,
        idempotencyKey: "88888888-8888-4888-8888-888888888888",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      appliedRows: 1,
    });
    expect(issueForApprovedRoster).toHaveBeenCalledWith(
      expect.not.objectContaining({ matchedUserId: expect.anything() }),
    );
  });

  it("rolls back apply when a reviewed matched account no longer exists", async () => {
    const matchedUserId = await insertUser("removed@example.com", "removed");
    const { service, issueForApprovedRoster } = createService();
    const dryRun = await service.dryRun({
      csv: Buffer.from(
        "email,programName\nremoved@example.com,External Fellowship\n",
        "utf8",
      ),
      actor: ACTOR,
      idempotencyKey: "99999999-9999-4999-8999-999999999999",
    });
    const rows = await service.listRows({
      batchId: dryRun.batchId,
      page: 1,
      limit: 20,
    });
    await service.review({
      batchId: dryRun.batchId,
      expectedRevision: 0,
      decisions: [
        {
          rowNumber: rows.rows[0]!.rowNumber,
          rowKey: rows.rows[0]!.rowKey,
          eligibilityStatus: "approved",
        },
      ],
      actor: ACTOR,
      idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    await User.deleteOne({ _id: matchedUserId });

    await expect(
      service.apply({
        batchId: dryRun.batchId,
        expectedRevision: 1,
        actor: ACTOR,
        idempotencyKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    ).rejects.toMatchObject({
      code: "ALUMNI_IMPORT_APPLICATION_CONFLICT",
      httpStatus: 409,
    });
    expect(issueForApprovedRoster).not.toHaveBeenCalled();
    expect(await AlumniImportBatch.findById(dryRun.batchId).lean()).toMatchObject({
      status: "review_ready",
      revision: 1,
    });
  });

  it("rejects an exact-email match when the account email changes after review", async () => {
    const matchedUserId = await insertUser("drift@example.com", "drift");
    const { service, issueForApprovedRoster } = createService();
    const dryRun = await service.dryRun({
      csv: Buffer.from(
        "email,programName\ndrift@example.com,External Fellowship\n",
        "utf8",
      ),
      actor: ACTOR,
      idempotencyKey: "23232323-2323-4323-8323-232323232323",
    });
    const rows = await service.listRows({
      batchId: dryRun.batchId,
      page: 1,
      limit: 20,
    });
    expect(rows.rows[0]).toMatchObject({
      matchStatus: "matched",
      matchMethod: "exact_email",
    });
    await service.review({
      batchId: dryRun.batchId,
      expectedRevision: 0,
      decisions: [
        {
          rowNumber: rows.rows[0]!.rowNumber,
          rowKey: rows.rows[0]!.rowKey,
          eligibilityStatus: "approved",
        },
      ],
      actor: ACTOR,
      idempotencyKey: "24242424-2424-4424-8424-242424242424",
    });
    await User.updateOne(
      { _id: matchedUserId },
      { $set: { email: "changed@example.com" } },
    );

    await expect(
      service.apply({
        batchId: dryRun.batchId,
        expectedRevision: 1,
        actor: ACTOR,
        idempotencyKey: "25252525-2525-4525-8525-252525252525",
      }),
    ).rejects.toMatchObject({
      code: "ALUMNI_IMPORT_APPLICATION_CONFLICT",
      httpStatus: 409,
    });
    expect(issueForApprovedRoster).not.toHaveBeenCalled();
    expect(await AlumniImportBatch.findById(dryRun.batchId).lean()).toMatchObject({
      status: "review_ready",
      revision: 1,
    });
  });

  it("retains manual match provenance and permits a different account email", async () => {
    const matchedUserId = await insertUser("selected@example.com", "selected");
    const { service, issueForApprovedRoster } = createService();
    const dryRun = await service.dryRun({
      csv: Buffer.from(
        "email,programName\nroster@example.com,External Fellowship\n",
        "utf8",
      ),
      actor: ACTOR,
      idempotencyKey: "26262626-2626-4626-8626-262626262626",
    });
    const before = await service.listRows({
      batchId: dryRun.batchId,
      page: 1,
      limit: 20,
    });
    expect(before.rows[0]).toMatchObject({
      matchStatus: "unmatched",
      matchMethod: "none",
    });
    await service.review({
      batchId: dryRun.batchId,
      expectedRevision: 0,
      decisions: [
        {
          rowNumber: before.rows[0]!.rowNumber,
          rowKey: before.rows[0]!.rowKey,
          eligibilityStatus: "approved",
          resolution: {
            matchStatus: "matched",
            matchedUserId: matchedUserId.toString(),
          },
        },
      ],
      actor: ACTOR,
      idempotencyKey: "27272727-2727-4727-8727-272727272727",
    });
    const after = await service.listRows({
      batchId: dryRun.batchId,
      page: 1,
      limit: 20,
    });
    expect(after.rows[0]).toMatchObject({
      matchStatus: "matched",
      matchMethod: "manual",
      matchedUser: { id: matchedUserId.toString() },
    });

    await expect(
      service.apply({
        batchId: dryRun.batchId,
        expectedRevision: 1,
        actor: ACTOR,
        idempotencyKey: "28282828-2828-4828-8828-282828282828",
      }),
    ).resolves.toMatchObject({ status: "completed", appliedRows: 1 });
    expect(issueForApprovedRoster).toHaveBeenCalledWith(
      expect.objectContaining({ matchedUserId }),
    );
  });

  it("keeps same-title rows for distinct canonical Programs", async () => {
    const firstProgramId = await insertProgram("Shared Program Title");
    const secondProgramId = await insertProgram("Shared Program Title");
    const { service, issueForApprovedRoster } = createService();
    const dryRun = await service.dryRun({
      csv: Buffer.from(
        [
          "email,programName,cohortLabel,programId",
          `same@example.com,Shared Program Title,2030,${firstProgramId}`,
          `same@example.com,Shared Program Title,2030,${secondProgramId}`,
          "same@example.com,Shared Program Title,2030,",
        ].join("\n"),
        "utf8",
      ),
      actor: ACTOR,
      idempotencyKey: "29292929-2929-4929-8929-292929292929",
    });
    expect(dryRun).toMatchObject({
      totalRows: 3,
      validRows: 3,
      invalidRows: 0,
    });
    const rows = await service.listRows({
      batchId: dryRun.batchId,
      page: 1,
      limit: 20,
    });
    await service.review({
      batchId: dryRun.batchId,
      expectedRevision: 0,
      decisions: rows.rows.map((row) => ({
        rowNumber: row.rowNumber,
        rowKey: row.rowKey,
        eligibilityStatus: "approved" as const,
      })),
      actor: ACTOR,
      idempotencyKey: "30303030-3030-4030-8030-303030303030",
    });
    await service.apply({
      batchId: dryRun.batchId,
      expectedRevision: 1,
      actor: ACTOR,
      idempotencyKey: "31313131-3131-4131-8131-313131313131",
    });

    expect(issueForApprovedRoster).toHaveBeenCalledTimes(1);
    expect(issueForApprovedRoster.mock.calls[0]![0].affiliations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ programId: firstProgramId }),
        expect.objectContaining({ programId: secondProgramId }),
        expect.not.objectContaining({ programId: expect.anything() }),
      ]),
    );
  });

  it("rejects an oversized contact group before issuing any invitation", async () => {
    const { service, issueForApprovedRoster } = createService();
    const rosterRows = Array.from(
      { length: 51 },
      (_, index) => `large@example.com,Program ${index + 1}`,
    );
    const dryRun = await service.dryRun({
      csv: Buffer.from(
        ["email,programName", ...rosterRows].join("\n"),
        "utf8",
      ),
      actor: ACTOR,
      idempotencyKey: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    const rows = await service.listRows({
      batchId: dryRun.batchId,
      page: 1,
      limit: 100,
    });
    await service.review({
      batchId: dryRun.batchId,
      expectedRevision: 0,
      decisions: rows.rows.map((row) => ({
        rowNumber: row.rowNumber,
        rowKey: row.rowKey,
        eligibilityStatus: "approved" as const,
      })),
      actor: ACTOR,
      idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });

    await expect(
      service.apply({
        batchId: dryRun.batchId,
        expectedRevision: 1,
        actor: ACTOR,
        idempotencyKey: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      }),
    ).rejects.toMatchObject({
      code: "ALUMNI_IMPORT_APPLICATION_CONFLICT",
      httpStatus: 409,
    });
    expect(issueForApprovedRoster).not.toHaveBeenCalled();
    expect(await AlumniImportBatch.findById(dryRun.batchId).lean()).toMatchObject({
      status: "review_ready",
      revision: 1,
      counts: { appliedRows: 0, invitationsCreated: 0 },
    });
  });

  it("maps a cross-batch invitation unique-key race to a controlled conflict", async () => {
    const duplicateKeyError = Object.assign(new Error("duplicate key"), {
      code: 11000,
    });
    const { service, issueForApprovedRoster } = createService({
      issueError: duplicateKeyError,
    });
    const dryRun = await service.dryRun({
      csv: Buffer.from(
        "email,programName\nrace@example.com,External Fellowship\n",
        "utf8",
      ),
      actor: ACTOR,
      idempotencyKey: "19191919-1919-4919-8919-191919191919",
    });
    const rows = await service.listRows({
      batchId: dryRun.batchId,
      page: 1,
      limit: 20,
    });
    await service.review({
      batchId: dryRun.batchId,
      expectedRevision: 0,
      decisions: [
        {
          rowNumber: rows.rows[0]!.rowNumber,
          rowKey: rows.rows[0]!.rowKey,
          eligibilityStatus: "approved",
        },
      ],
      actor: ACTOR,
      idempotencyKey: "20202020-2020-4020-8020-202020202020",
    });

    await expect(
      service.apply({
        batchId: dryRun.batchId,
        expectedRevision: 1,
        actor: ACTOR,
        idempotencyKey: "21212121-2121-4121-8121-212121212121",
      }),
    ).rejects.toMatchObject({
      code: "ALUMNI_IMPORT_APPLICATION_CONFLICT",
      httpStatus: 409,
    });
    expect(issueForApprovedRoster).toHaveBeenCalledTimes(1);
    expect(await AlumniImportBatch.findById(dryRun.batchId).lean()).toMatchObject({
      status: "review_ready",
      revision: 1,
      counts: { appliedRows: 0, invitationsCreated: 0 },
    });
    expect(
      await IdempotencyRecord.countDocuments({ scope: "alumni.import.apply" }),
    ).toBe(0);
  });

  it("rejects inconsistent matched-user resolutions for one contact", async () => {
    await insertUser("shared@example.com", "shared");
    const otherUserId = await insertUser("other@example.com", "other");
    const { service, issueForApprovedRoster } = createService();
    const dryRun = await service.dryRun({
      csv: Buffer.from(
        [
          "email,programName",
          "shared@example.com,Program One",
          "shared@example.com,Program Two",
        ].join("\n"),
        "utf8",
      ),
      actor: ACTOR,
      idempotencyKey: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    });
    const rows = await service.listRows({
      batchId: dryRun.batchId,
      page: 1,
      limit: 20,
    });
    await service.review({
      batchId: dryRun.batchId,
      expectedRevision: 0,
      decisions: [
        {
          rowNumber: rows.rows[0]!.rowNumber,
          rowKey: rows.rows[0]!.rowKey,
          eligibilityStatus: "approved",
        },
        {
          rowNumber: rows.rows[1]!.rowNumber,
          rowKey: rows.rows[1]!.rowKey,
          eligibilityStatus: "approved",
          resolution: {
            matchStatus: "matched",
            matchedUserId: otherUserId.toString(),
          },
        },
      ],
      actor: ACTOR,
      idempotencyKey: "12121212-1212-4212-8212-121212121212",
    });

    await expect(
      service.apply({
        batchId: dryRun.batchId,
        expectedRevision: 1,
        actor: ACTOR,
        idempotencyKey: "13131313-1313-4313-8313-131313131313",
      }),
    ).rejects.toMatchObject({
      code: "ALUMNI_IMPORT_APPLICATION_CONFLICT",
      httpStatus: 409,
    });
    expect(issueForApprovedRoster).not.toHaveBeenCalled();
  });

  it("applies at most 100 rows per resumable chunk", async () => {
    const { service, issueForApprovedRoster } = createService();
    const rosterRows = Array.from(
      { length: 101 },
      (_, index) => `person${index + 1}@example.com,Program ${index + 1}`,
    );
    const dryRun = await service.dryRun({
      csv: Buffer.from(
        ["email,programName", ...rosterRows].join("\n"),
        "utf8",
      ),
      actor: ACTOR,
      idempotencyKey: "14141414-1414-4414-8414-141414141414",
    });
    const firstPage = await service.listRows({
      batchId: dryRun.batchId,
      page: 1,
      limit: 100,
    });
    const secondPage = await service.listRows({
      batchId: dryRun.batchId,
      page: 2,
      limit: 100,
    });
    await service.review({
      batchId: dryRun.batchId,
      expectedRevision: 0,
      decisions: [...firstPage.rows, ...secondPage.rows].map((row) => ({
        rowNumber: row.rowNumber,
        rowKey: row.rowKey,
        eligibilityStatus: "approved" as const,
      })),
      actor: ACTOR,
      idempotencyKey: "15151515-1515-4515-8515-151515151515",
    });

    await expect(
      service.apply({
        batchId: dryRun.batchId,
        expectedRevision: 1,
        actor: ACTOR,
        idempotencyKey: "16161616-1616-4616-8616-161616161616",
      }),
    ).resolves.toMatchObject({
      status: "applying",
      revision: 2,
      appliedRows: 100,
      invitationsCreated: 100,
      remainingRows: 1,
    });
    expect(issueForApprovedRoster).toHaveBeenCalledTimes(100);

    await expect(
      service.apply({
        batchId: dryRun.batchId,
        expectedRevision: 2,
        actor: ACTOR,
        idempotencyKey: "17171717-1717-4717-8717-171717171717",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      revision: 3,
      appliedRows: 101,
      invitationsCreated: 101,
      remainingRows: 0,
    });
    expect(issueForApprovedRoster).toHaveBeenCalledTimes(101);
  });

  it("reruns a partially applied batch without undoing its completed chunk", async () => {
    const { service, issueForApprovedRoster } = createService();
    const rosterRows = Array.from(
      { length: 101 },
      (_, index) => `recovery${index + 1}@example.com,Program ${index + 1}`,
    );
    const dryRun = await service.dryRun({
      csv: Buffer.from(
        ["email,programName", ...rosterRows].join("\n"),
        "utf8",
      ),
      actor: ACTOR,
      idempotencyKey: "32323232-3232-4232-8232-323232323232",
    });
    const firstPage = await service.listRows({
      batchId: dryRun.batchId,
      page: 1,
      limit: 100,
    });
    const secondPage = await service.listRows({
      batchId: dryRun.batchId,
      page: 2,
      limit: 100,
    });
    await service.review({
      batchId: dryRun.batchId,
      expectedRevision: 0,
      decisions: [...firstPage.rows, ...secondPage.rows].map((row) => ({
        rowNumber: row.rowNumber,
        rowKey: row.rowKey,
        eligibilityStatus: "approved" as const,
      })),
      actor: ACTOR,
      idempotencyKey: "33333333-3333-4333-8333-333333333334",
    });
    const partial = await service.apply({
      batchId: dryRun.batchId,
      expectedRevision: 1,
      actor: ACTOR,
      idempotencyKey: "34343434-3434-4434-8434-343434343434",
    });
    expect(partial).toMatchObject({
      status: "applying",
      revision: 2,
      appliedRows: 100,
      remainingRows: 1,
    });
    expect(issueForApprovedRoster).toHaveBeenCalledTimes(100);

    const rerun = await service.rerun({
      batchId: dryRun.batchId,
      expectedRevision: 2,
      actor: ACTOR,
      idempotencyKey: "35353535-3535-4535-8535-353535353535",
    });
    expect(rerun).toMatchObject({
      sourceBatchId: dryRun.batchId,
      sourceRevision: 3,
      status: "review_ready",
      revision: 0,
      totalRows: 101,
    });
    expect(issueForApprovedRoster).toHaveBeenCalledTimes(100);

    const source = await AlumniImportBatch.findById(dryRun.batchId).select(
      "+rowResults",
    );
    expect(source).toMatchObject({
      status: "cancelled",
      revision: 3,
      terminalAt: NOW,
      rawDataPurgeAt: addFixedDays(NOW, 30),
      purgeAt: addUtcCalendarMonths(NOW, 6),
      counts: { appliedRows: 100, invitationsCreated: 100 },
    });
    const replacement = await AlumniImportBatch.findById(rerun.batchId).select(
      "+rowResults",
    );
    expect(replacement).toMatchObject({
      status: "review_ready",
      revision: 0,
      counts: {
        approvedRows: 0,
        rejectedRows: 0,
        appliedRows: 0,
        invitationsCreated: 0,
        affiliationsCreated: 0,
      },
    });
    expect(
      replacement?.rowResults?.every(
        (row) =>
          row.eligibilityStatus === "pending_review" &&
          row.applicationStatus === "pending",
      ),
    ).toBe(true);
  });

  it("fails closed at the logical raw-data retention boundary", async () => {
    let currentNow = new Date(NOW);
    const { service } = createService({ now: () => new Date(currentNow) });
    const dryRun = await service.dryRun({
      csv: Buffer.from(
        "email,programName\nretention@example.com,External Fellowship\n",
        "utf8",
      ),
      actor: ACTOR,
      idempotencyKey: "36363636-3636-4636-8636-363636363636",
    });
    const rows = await service.listRows({
      batchId: dryRun.batchId,
      page: 1,
      limit: 20,
    });
    await service.review({
      batchId: dryRun.batchId,
      expectedRevision: 0,
      decisions: [
        {
          rowNumber: rows.rows[0]!.rowNumber,
          rowKey: rows.rows[0]!.rowKey,
          eligibilityStatus: "approved",
        },
      ],
      actor: ACTOR,
      idempotencyKey: "37373737-3737-4737-8737-373737373737",
    });
    await service.apply({
      batchId: dryRun.batchId,
      expectedRevision: 1,
      actor: ACTOR,
      idempotencyKey: "38383838-3838-4838-8838-383838383838",
    });
    currentNow = addFixedDays(NOW, 30);

    await expect(service.getBatch(dryRun.batchId)).resolves.toMatchObject({
      rawDataAvailable: false,
    });
    const batches = await service.listBatches({ page: 1, limit: 20 });
    expect(batches.batches[0]).toMatchObject({ rawDataAvailable: false });
    await expect(
      service.listRows({ batchId: dryRun.batchId, page: 1, limit: 20 }),
    ).rejects.toMatchObject({
      code: "ALUMNI_IMPORT_RAW_DATA_UNAVAILABLE",
      httpStatus: 410,
    });
    await expect(
      service.rerun({
        batchId: dryRun.batchId,
        expectedRevision: 2,
        actor: ACTOR,
        idempotencyKey: "39393939-3939-4939-8939-393939393939",
      }),
    ).rejects.toMatchObject({
      code: "ALUMNI_IMPORT_RAW_DATA_UNAVAILABLE",
      httpStatus: 410,
    });
    expect(await AlumniImportBatch.countDocuments({})).toBe(1);
    expect(
      await IdempotencyRecord.countDocuments({ scope: "alumni.import.rerun" }),
    ).toBe(0);
  });
});
