import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addFixedDays,
  addUtcCalendarMonths,
  deriveAlumniAffiliationKey,
} from "../../../src/contracts/alumniDirectoryData";
import AlumniImportBatch from "../../../src/models/AlumniImportBatch";
import AlumniInvitation from "../../../src/models/AlumniInvitation";
import AuditLog from "../../../src/models/AuditLog";
import {
  AlumniRetentionCleanupService,
} from "../../../src/services/alumni/AlumniRetentionCleanupService";
import {
  WORKER_RUN_TRIGGERS,
  WORKER_SERVICE_KEYS,
  workerAuthorizationService,
} from "../../../src/services/authorization/WorkerAuthorizationService";
import { MongoTransactionService } from "../../../src/services/reliability/MongoTransactionService";
import { ensureIntegrationDB } from "../setup/connect";

const NOW = new Date("2032-03-12T12:00:00.000Z");
const HASH = (value: string) => value.repeat(64);
const models = [AlumniImportBatch, AlumniInvitation, AuditLog] as const;

function cleanupContext(trigger = WORKER_RUN_TRIGGERS.SCHEDULED) {
  return workerAuthorizationService.createRunContext(
    WORKER_SERVICE_KEYS.ALUMNI_RETENTION,
    trigger,
  );
}

function terminalBatchInput(options: {
  readonly terminalAt: Date;
  readonly status?: "completed" | "failed" | "cancelled";
  readonly checksumCharacter?: string;
}) {
  const terminalAt = new Date(options.terminalAt);
  return {
    checksum: HASH(options.checksumCharacter ?? "a"),
    status: options.status ?? "failed",
    counts: {
      totalRows: 1,
      validRows: 0,
      invalidRows: 1,
      matchedRows: 0,
      unmatchedRows: 0,
      ambiguousRows: 0,
      approvedRows: 0,
      rejectedRows: 0,
      appliedRows: 0,
      invitationsCreated: 0,
      affiliationsCreated: 0,
    },
    rawHeaders: ["email"],
    rawRows: [{ rowNumber: 2, values: ["private@example.org"] }],
    rowErrors: [
      {
        rowNumber: 2,
        field: "email",
        code: "invalid_email",
        message: "Email is invalid.",
      },
    ],
    rowResults: [
      {
        rowNumber: 2,
        rowKey: HASH("b"),
        matchStatus: "invalid",
        matchMethod: "none",
        candidateUserIds: [],
        eligibilityStatus: "not_applicable",
        reviewedAt: null,
        applicationStatus: "skipped",
        applicationUpdatedAt: terminalAt,
      },
    ],
    createdBy: new mongoose.Types.ObjectId(),
    terminalAt,
    rawDataPurgeAt: addFixedDays(terminalAt, 30),
    purgeAt: addUtcCalendarMonths(terminalAt, 6),
  };
}

function invitationInput(options: {
  readonly sentAt: Date;
  readonly hashCharacter: string;
  readonly status?: "active" | "invalidated";
}) {
  const sentAt = new Date(options.sentAt);
  const sourceBatchId = new mongoose.Types.ObjectId();
  const lookupHash = HASH(options.hashCharacter);
  const status = options.status ?? "active";
  return {
    sourceImportBatchIds: [sourceBatchId],
    contactEmail: `${options.hashCharacter}@example.org`,
    contactFirstName: "Private",
    contactLastName: "Contact",
    contactLookupHash: lookupHash,
    ...(status === "active"
      ? {
          activeContactLookupHash: lookupHash,
          tokenHash: HASH(options.hashCharacter.toUpperCase()),
        }
      : {}),
    matchedUserId: new mongoose.Types.ObjectId(),
    affiliations: [
      {
        programName: "EMBA",
        cohortLabel: "2031",
        affiliationKey: deriveAlumniAffiliationKey({
          programName: "EMBA",
          cohortLabel: "2031",
        }),
        sourceImportBatchId: sourceBatchId,
        sourceRowNumber: 2,
        reviewedAt: addFixedDays(sentAt, -1),
        reviewedBy: new mongoose.Types.ObjectId(),
      },
    ],
    status,
    issuedAt: sentAt,
    tokenExpiresAt: addFixedDays(sentAt, 14),
    lastInvitationSentAt: sentAt,
    ...(status === "invalidated" ? { invalidatedAt: sentAt } : {}),
    contactPurgeAt: addUtcCalendarMonths(sentAt, 6),
  };
}

describe("M2-02 alumni retention cleanup", () => {
  beforeAll(async () => {
    await ensureIntegrationDB();
    await Promise.all(models.map((model) => model.init()));
    const capability = await new MongoTransactionService(
      mongoose.connection,
    ).assertTopologyCapability(true);
    expect(capability.supported).toBe(true);
  });

  beforeEach(async () => {
    await Promise.all(models.map((model) => model.deleteMany({})));
  });

  afterAll(async () => {
    await Promise.all(models.map((model) => model.deleteMany({})));
  });

  it("purges due private data at the exact cutoff while retaining summaries and provenance", async () => {
    const dueBatch = await AlumniImportBatch.create(
      terminalBatchInput({ terminalAt: addFixedDays(NOW, -30) }),
    );
    const futureBatch = await AlumniImportBatch.create(
      terminalBatchInput({
        terminalAt: addFixedDays(NOW, -29),
        checksumCharacter: "c",
      }),
    );
    const dueActive = await AlumniInvitation.create(
      invitationInput({
        sentAt: addUtcCalendarMonths(NOW, -6),
        hashCharacter: "d",
      }),
    );
    const dueInvalidated = await AlumniInvitation.create(
      invitationInput({
        sentAt: addUtcCalendarMonths(NOW, -6),
        hashCharacter: "e",
        status: "invalidated",
      }),
    );
    const futureInvitation = await AlumniInvitation.create(
      invitationInput({
        sentAt: addFixedDays(addUtcCalendarMonths(NOW, -6), 1),
        hashCharacter: "f",
      }),
    );
    const service = new AlumniRetentionCleanupService({
      now: () => new Date(NOW),
      transactions: new MongoTransactionService(mongoose.connection),
    });

    await expect(
      service.runBounded(cleanupContext()),
    ).resolves.toEqual({
      importCandidatesScanned: 1,
      importBatchesPurged: 1,
      invitationCandidatesScanned: 2,
      invitationsPurged: 2,
    });

    const retainedBatch = await AlumniImportBatch.findById(dueBatch._id).select(
      "+rawHeaders +rawRows +rowErrors +rowResults",
    );
    expect(retainedBatch).toMatchObject({
      status: "failed",
      revision: 1,
      rawDataPurgedAt: NOW,
      counts: { totalRows: 1, invalidRows: 1 },
    });
    expect(retainedBatch?.rawHeaders).toBeUndefined();
    expect(retainedBatch?.rawRows).toBeUndefined();
    expect(retainedBatch?.rowErrors).toBeUndefined();
    expect(retainedBatch?.rowResults).toBeUndefined();
    await expect(retainedBatch?.validate()).resolves.toBeUndefined();
    expect(await AlumniImportBatch.findById(futureBatch._id)).toMatchObject({
      revision: 0,
      rawDataPurgedAt: null,
    });

    const privateSelection = [
      "+contactEmail",
      "+contactFirstName",
      "+contactLastName",
      "+contactLookupHash",
      "+activeContactLookupHash",
      "+matchedUserId",
      "+tokenHash",
    ].join(" ");
    const [activeAfter, invalidatedAfter, futureAfter] = await Promise.all([
      AlumniInvitation.findById(dueActive._id).select(privateSelection),
      AlumniInvitation.findById(dueInvalidated._id).select(privateSelection),
      AlumniInvitation.findById(futureInvitation._id).select(privateSelection),
    ]);
    expect(activeAfter).toMatchObject({
      status: "invalidated",
      invalidatedAt: NOW,
      contactPurgedAt: NOW,
      revision: 1,
    });
    expect(invalidatedAfter).toMatchObject({
      status: "invalidated",
      contactPurgedAt: NOW,
      revision: 1,
    });
    for (const purged of [activeAfter, invalidatedAfter]) {
      expect(purged?.contactEmail).toBeUndefined();
      expect(purged?.contactFirstName).toBeUndefined();
      expect(purged?.contactLastName).toBeUndefined();
      expect(purged?.contactLookupHash).toBeUndefined();
      expect(purged?.activeContactLookupHash).toBeUndefined();
      expect(purged?.matchedUserId).toBeUndefined();
      expect(purged?.tokenHash).toBeUndefined();
      expect(purged?.affiliations).toHaveLength(1);
      await expect(purged?.validate()).resolves.toBeUndefined();
    }
    expect(futureAfter).toMatchObject({ status: "active", revision: 0 });
    expect(futureAfter?.contactEmail).toBe("f@example.org");

    const audits = await AuditLog.find({
      action: {
        $in: [
          "alumni_import.raw_data_purged",
          "alumni_invitation.contact_purged",
        ],
      },
    })
      .sort({ action: 1, targetId: 1 })
      .lean();
    expect(audits).toHaveLength(3);
    expect(audits.every((audit) => audit.actorKey === "alumni-retention")).toBe(
      true,
    );
    expect(audits.every((audit) => audit.reasonCode === "retention_expired")).toBe(
      true,
    );
    const serializedAudits = JSON.stringify(audits);
    expect(serializedAudits).not.toContain("private@example.org");
    expect(serializedAudits).not.toContain("@example.org");
  });

  it("rolls the purge back when its mandatory audit write fails", async () => {
    const batch = await AlumniImportBatch.create(
      terminalBatchInput({ terminalAt: addFixedDays(NOW, -30) }),
    );
    const service = new AlumniRetentionCleanupService({
      now: () => new Date(NOW),
      transactions: new MongoTransactionService(mongoose.connection),
      audit: {
        recordRequiredInTransaction: async () => {
          throw new Error("audit unavailable");
        },
      },
    });

    await expect(service.runBounded(cleanupContext())).rejects.toThrow(
      "audit unavailable",
    );

    const unchanged = await AlumniImportBatch.findById(batch._id).select(
      "+rawHeaders +rawRows +rowErrors +rowResults",
    );
    expect(unchanged).toMatchObject({ revision: 0, rawDataPurgedAt: null });
    expect(unchanged?.rawRows).toHaveLength(1);
    expect(await AuditLog.countDocuments({})).toBe(0);
  });

  it("honors the configured per-kind bound across repeated runs", async () => {
    await AlumniImportBatch.create([
      terminalBatchInput({
        terminalAt: addFixedDays(NOW, -32),
        checksumCharacter: "1",
      }),
      terminalBatchInput({
        terminalAt: addFixedDays(NOW, -31),
        checksumCharacter: "2",
      }),
    ]);
    const service = new AlumniRetentionCleanupService({
      now: () => new Date(NOW),
      maxCandidatesPerKind: 1,
      transactions: new MongoTransactionService(mongoose.connection),
    });

    const first = await service.runBounded(cleanupContext());
    expect(first).toMatchObject({
      importCandidatesScanned: 1,
      importBatchesPurged: 1,
    });
    expect(
      await AlumniImportBatch.countDocuments({ rawDataPurgedAt: null }),
    ).toBe(1);

    const second = await service.runBounded(cleanupContext());
    expect(second).toMatchObject({
      importCandidatesScanned: 1,
      importBatchesPurged: 1,
    });
    expect(
      await AlumniImportBatch.countDocuments({ rawDataPurgedAt: null }),
    ).toBe(0);
  });
});
