import type { Model, Types } from "mongoose";
import {
  ALUMNI_IMPORT_BATCH_TERMINAL_STATUSES,
  IMPORT_RAW_DATA_RETENTION_DAYS,
  INVITATION_CONTACT_RETENTION_MONTHS,
  type AlumniImportBatchStatus,
  type AlumniInvitationStatus,
} from "../../contracts/alumniDirectoryData";
import AlumniImportBatch, {
  type IAlumniImportBatch,
} from "../../models/AlumniImportBatch";
import AlumniInvitation, {
  type IAlumniInvitation,
} from "../../models/AlumniInvitation";
import { AuditLogService } from "../AuditLogService";
import {
  WORKER_CAPABILITIES,
  WORKER_SERVICE_KEYS,
  WorkerAuthorizationService,
  workerAuthorizationService,
  type WorkerRunContext,
} from "../authorization/WorkerAuthorizationService";
import {
  mongoTransactionService,
  type MongoTransactionService,
} from "../reliability/MongoTransactionService";

const DEFAULT_MAX_CANDIDATES_PER_KIND = 100;
const MAX_CONFIGURED_CANDIDATES_PER_KIND = 500;
const CLEANUP_WORKER_KEY = WORKER_SERVICE_KEYS.ALUMNI_RETENTION;

interface ImportCleanupCandidate {
  readonly _id: Types.ObjectId;
  readonly revision: number;
  readonly status: AlumniImportBatchStatus;
}

interface InvitationCleanupCandidate {
  readonly _id: Types.ObjectId;
  readonly revision: number;
  readonly status: Extract<AlumniInvitationStatus, "active" | "invalidated">;
}

type TransactionRunner = Pick<MongoTransactionService, "run">;
type AuditWriter = Pick<typeof AuditLogService, "recordRequiredInTransaction">;
type CleanupAuthorizer = Pick<WorkerAuthorizationService, "assertCapability">;
export type AlumniRetentionRunContext = WorkerRunContext<
  typeof WORKER_SERVICE_KEYS.ALUMNI_RETENTION
>;

export interface AlumniRetentionCleanupResult {
  readonly importCandidatesScanned: number;
  readonly importBatchesPurged: number;
  readonly invitationCandidatesScanned: number;
  readonly invitationsPurged: number;
}

export interface AlumniRetentionCleanupDependencies {
  readonly now?: () => Date;
  readonly maxCandidatesPerKind?: number;
  readonly transactions?: TransactionRunner;
  readonly audit?: AuditWriter;
  readonly authorization?: CleanupAuthorizer;
  readonly importBatchModel?: Model<IAlumniImportBatch>;
  readonly invitationModel?: Model<IAlumniInvitation>;
}

function requireCandidateLimit(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_CONFIGURED_CANDIDATES_PER_KIND
  ) {
    throw new TypeError(
      `maxCandidatesPerKind must be an integer between 1 and ${MAX_CONFIGURED_CANDIDATES_PER_KIND}.`,
    );
  }
  return value;
}

function requireNow(now: Date): Date {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("Alumni retention cleanup requires a valid current time.");
  }
  return new Date(now);
}

/**
 * Executes the approved alumni import/invitation privacy retention policy.
 *
 * Candidate reads are bounded and every destructive write uses revision CAS in
 * the same transaction as its mandatory audit record. A process-wide instance
 * also coalesces overlapping scheduler ticks.
 */
export class AlumniRetentionCleanupService {
  private readonly now: () => Date;
  private readonly maxCandidatesPerKind: number;
  private readonly transactions: TransactionRunner;
  private readonly audit: AuditWriter;
  private readonly authorization: CleanupAuthorizer;
  private readonly importBatchModel: Model<IAlumniImportBatch>;
  private readonly invitationModel: Model<IAlumniInvitation>;
  private inFlight: Promise<AlumniRetentionCleanupResult> | null = null;

  constructor(dependencies: AlumniRetentionCleanupDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.maxCandidatesPerKind = requireCandidateLimit(
      dependencies.maxCandidatesPerKind ?? DEFAULT_MAX_CANDIDATES_PER_KIND,
    );
    this.transactions = dependencies.transactions ?? mongoTransactionService;
    this.audit = dependencies.audit ?? AuditLogService;
    this.authorization = dependencies.authorization ?? workerAuthorizationService;
    this.importBatchModel = dependencies.importBatchModel ?? AlumniImportBatch;
    this.invitationModel = dependencies.invitationModel ?? AlumniInvitation;
  }

  async runBounded(
    runContext: AlumniRetentionRunContext,
  ): Promise<AlumniRetentionCleanupResult> {
    await this.authorization.assertCapability(
      runContext,
      WORKER_CAPABILITIES.ALUMNI_RETENTION_PURGE,
      {
        resource: { type: "alumni_retention", id: "expired-private-data" },
      },
    );
    if (this.inFlight) return this.inFlight;

    const execution = this.executeBounded();
    this.inFlight = execution;
    void execution.then(
      () => {
        if (this.inFlight === execution) this.inFlight = null;
      },
      () => {
        if (this.inFlight === execution) this.inFlight = null;
      },
    );
    return execution;
  }

  private async executeBounded(): Promise<AlumniRetentionCleanupResult> {
    const now = requireNow(this.now());
    const importCandidates = await this.importBatchModel
      .find({
        status: { $in: ALUMNI_IMPORT_BATCH_TERMINAL_STATUSES },
        rawDataPurgedAt: null,
        rawDataPurgeAt: { $lte: now },
      })
      .select({ _id: 1, revision: 1, status: 1 })
      .sort({ rawDataPurgeAt: 1, _id: 1 })
      .limit(this.maxCandidatesPerKind)
      .lean<ImportCleanupCandidate[]>()
      .exec();

    let importBatchesPurged = 0;
    for (const candidate of importCandidates) {
      if (await this.purgeImportRawData(candidate, now)) {
        importBatchesPurged += 1;
      }
    }

    const invitationCandidates = await this.invitationModel
      .find({
        status: { $in: ["active", "invalidated"] },
        contactPurgedAt: null,
        contactPurgeAt: { $lte: now },
      })
      .select({ _id: 1, revision: 1, status: 1 })
      .sort({ contactPurgeAt: 1, _id: 1 })
      .limit(this.maxCandidatesPerKind)
      .lean<InvitationCleanupCandidate[]>()
      .exec();

    let invitationsPurged = 0;
    for (const candidate of invitationCandidates) {
      if (await this.purgeInvitationContact(candidate, now)) {
        invitationsPurged += 1;
      }
    }

    return {
      importCandidatesScanned: importCandidates.length,
      importBatchesPurged,
      invitationCandidatesScanned: invitationCandidates.length,
      invitationsPurged,
    };
  }

  private purgeImportRawData(
    candidate: ImportCleanupCandidate,
    now: Date,
  ): Promise<boolean> {
    return this.transactions.run(async (session) => {
      const result = await this.importBatchModel.updateOne(
        {
          _id: candidate._id,
          revision: candidate.revision,
          status: candidate.status,
          rawDataPurgedAt: null,
          rawDataPurgeAt: { $lte: now },
        },
        {
          $unset: {
            rawHeaders: 1,
            rawRows: 1,
            rowErrors: 1,
            rowResults: 1,
          },
          $set: {
            rawDataPurgedAt: now,
            revision: candidate.revision + 1,
          },
        },
        { session, runValidators: false },
      );
      if (result.modifiedCount !== 1) return false;

      await this.audit.recordRequiredInTransaction(
        {
          action: "alumni_import.raw_data_purged",
          actor: { type: "worker", key: CLEANUP_WORKER_KEY },
          source: "worker",
          outcome: "success",
          target: {
            model: "AlumniImportBatch",
            id: candidate._id.toString(),
          },
          reasonCode: "retention_expired",
          details: {
            batchStatus: candidate.status,
            retentionDays: IMPORT_RAW_DATA_RETENTION_DAYS,
            resultingRevision: candidate.revision + 1,
          },
        },
        session,
      );
      return true;
    });
  }

  private purgeInvitationContact(
    candidate: InvitationCleanupCandidate,
    now: Date,
  ): Promise<boolean> {
    return this.transactions.run(async (session) => {
      const lifecycleUpdate =
        candidate.status === "active"
          ? { status: "invalidated" as const, invalidatedAt: now }
          : {};
      const result = await this.invitationModel.updateOne(
        {
          _id: candidate._id,
          revision: candidate.revision,
          status: candidate.status,
          contactPurgedAt: null,
          contactPurgeAt: { $lte: now },
        },
        {
          $unset: {
            contactEmail: 1,
            contactFirstName: 1,
            contactLastName: 1,
            contactLookupHash: 1,
            activeContactLookupHash: 1,
            matchedUserId: 1,
            tokenHash: 1,
          },
          $set: {
            ...lifecycleUpdate,
            contactPurgedAt: now,
            revision: candidate.revision + 1,
          },
        },
        { session, runValidators: false },
      );
      if (result.modifiedCount !== 1) return false;

      await this.audit.recordRequiredInTransaction(
        {
          action: "alumni_invitation.contact_purged",
          actor: { type: "worker", key: CLEANUP_WORKER_KEY },
          source: "worker",
          outcome: "success",
          target: {
            model: "AlumniInvitation",
            id: candidate._id.toString(),
          },
          reasonCode: "retention_expired",
          details: {
            previousStatus: candidate.status,
            resultingStatus: "invalidated",
            retentionMonths: INVITATION_CONTACT_RETENTION_MONTHS,
            resultingRevision: candidate.revision + 1,
          },
        },
        session,
      );
      return true;
    });
  }
}

export const alumniRetentionCleanupService =
  new AlumniRetentionCleanupService();
