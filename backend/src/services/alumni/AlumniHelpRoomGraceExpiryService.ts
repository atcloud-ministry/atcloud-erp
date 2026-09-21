import { Types, type Model } from "mongoose";
import Conversation, { type IConversation } from "../../models/Conversation";
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
import {
  AlumniHelpRoomProvisioner,
  alumniHelpRoomProvisioner,
} from "./AlumniHelpRoomProvisioner";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const WORKER_KEY = WORKER_SERVICE_KEYS.ALUMNI_HELP_ROOM_GRACE;

interface GraceExpiryCandidate {
  readonly _id: Types.ObjectId;
  readonly revision: number;
  readonly helpRequestId: Types.ObjectId;
  readonly writeAccessEndsAt: Date;
}

type TransactionRunner = Pick<MongoTransactionService, "run">;
type GraceExpiryAuthorizer = Pick<
  WorkerAuthorizationService,
  "assertCapability"
>;
type AuditWriter = Pick<typeof AuditLogService, "recordRequiredInTransaction">;

export type AlumniHelpRoomGraceExpiryRunContext = WorkerRunContext<
  typeof WORKER_SERVICE_KEYS.ALUMNI_HELP_ROOM_GRACE
>;

export interface AlumniHelpRoomGraceExpiryResult {
  readonly candidatesScanned: number;
  readonly archived: number;
  readonly racedOrUnavailable: number;
  readonly remainingOverdue: number;
}

export interface AlumniHelpRoomGraceExpiryDependencies {
  readonly now?: () => Date;
  readonly maxCandidates?: number;
  readonly transactions?: TransactionRunner;
  readonly authorization?: GraceExpiryAuthorizer;
  readonly audit?: AuditWriter;
  readonly conversationModel?: Model<IConversation>;
  readonly roomProvisioner?: Pick<
    AlumniHelpRoomProvisioner,
    "archiveInTransaction"
  >;
}

function requireLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new TypeError(`maxCandidates must be an integer from 1 to ${MAX_LIMIT}.`);
  }
  return value;
}

function requireNow(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("Alumni Help Room grace worker requires a valid clock.");
  }
  return new Date(value);
}

/**
 * Bounded, restart-safe archival of closed Help Rooms after their fixed
 * write-access grace period. The archive clock is the deadline itself (rather
 * than a delayed scheduler tick), so the chat retention window remains exact.
 */
export class AlumniHelpRoomGraceExpiryService {
  private readonly now: () => Date;
  private readonly maxCandidates: number;
  private readonly transactions: TransactionRunner;
  private readonly authorization: GraceExpiryAuthorizer;
  private readonly audit: AuditWriter;
  private readonly conversationModel: Model<IConversation>;
  private readonly roomProvisioner: Pick<
    AlumniHelpRoomProvisioner,
    "archiveInTransaction"
  >;
  private inFlight: Promise<AlumniHelpRoomGraceExpiryResult> | null = null;

  constructor(dependencies: AlumniHelpRoomGraceExpiryDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.maxCandidates = requireLimit(
      dependencies.maxCandidates ?? DEFAULT_LIMIT,
    );
    this.transactions = dependencies.transactions ?? mongoTransactionService;
    this.authorization = dependencies.authorization ?? workerAuthorizationService;
    this.audit = dependencies.audit ?? AuditLogService;
    this.conversationModel = dependencies.conversationModel ?? Conversation;
    this.roomProvisioner =
      dependencies.roomProvisioner ?? alumniHelpRoomProvisioner;
  }

  async runBounded(
    runContext: AlumniHelpRoomGraceExpiryRunContext,
  ): Promise<AlumniHelpRoomGraceExpiryResult> {
    await this.authorization.assertCapability(
      runContext,
      WORKER_CAPABILITIES.ALUMNI_HELP_ROOM_GRACE_ARCHIVE,
      { resource: { type: "alumni_help_room", id: "expired-grace-periods" } },
    );
    if (this.inFlight) return this.inFlight;

    const execution = this.executeBounded(runContext);
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

  private async executeBounded(
    runContext: AlumniHelpRoomGraceExpiryRunContext,
  ): Promise<AlumniHelpRoomGraceExpiryResult> {
    const now = requireNow(this.now());
    const candidates = await this.conversationModel
      .find({
        kind: "alumni_help",
        status: "current",
        writeAccessEndsAt: { $lte: now },
      })
      .select({ _id: 1, revision: 1, helpRequestId: 1, writeAccessEndsAt: 1 })
      .sort({ writeAccessEndsAt: 1, _id: 1 })
      .limit(this.maxCandidates)
      .lean<GraceExpiryCandidate[]>()
      .exec();

    let archived = 0;
    let racedOrUnavailable = 0;
    for (const candidate of candidates) {
      try {
        if (await this.archiveCandidate(candidate, now, runContext)) {
          archived += 1;
        } else {
          racedOrUnavailable += 1;
        }
      } catch {
        // A concurrent message or membership change can invalidate the
        // provisioner's revision CAS. Treat it as a retryable candidate; the
        // next bounded tick re-reads the room before making any archival write.
        racedOrUnavailable += 1;
      }
    }

    const remainingOverdue = await this.conversationModel.countDocuments({
      kind: "alumni_help",
      status: "current",
      writeAccessEndsAt: { $lte: now },
    });
    return {
      candidatesScanned: candidates.length,
      archived,
      racedOrUnavailable,
      remainingOverdue,
    };
  }

  private archiveCandidate(
    candidate: GraceExpiryCandidate,
    now: Date,
    runContext: AlumniHelpRoomGraceExpiryRunContext,
  ): Promise<boolean> {
    return this.transactions.run(async (session) => {
      const room = await this.conversationModel
        .findOne({
          _id: candidate._id,
          revision: candidate.revision,
          kind: "alumni_help",
          status: "current",
          helpRequestId: candidate.helpRequestId,
          writeAccessEndsAt: { $lte: now },
        })
        .session(session)
        .exec();
      if (
        !room ||
        !(room.helpRequestId instanceof Types.ObjectId) ||
        !(room.writeAccessEndsAt instanceof Date) ||
        Number.isNaN(room.writeAccessEndsAt.getTime())
      ) {
        return false;
      }

      const archivedAt = new Date(room.writeAccessEndsAt);
      await this.roomProvisioner.archiveInTransaction({
        conversationId: room._id,
        helpRequestId: room.helpRequestId,
        archivedAt,
        session,
      });
      await this.audit.recordRequiredInTransaction(
        {
          action: "alumni_help.room_grace_expired",
          actor: { type: "worker", key: WORKER_KEY },
          source: "worker",
          outcome: "success",
          target: { model: "Conversation", id: room._id.toString() },
          reasonCode: "grace_period_elapsed",
          details: {
            helpRequestId: room.helpRequestId.toString(),
            writeAccessEndedAt: archivedAt.toISOString(),
            resultingConversationRevision: room.revision + 1,
            workerRunId: runContext.runId,
          },
        },
        session,
      );
      return true;
    });
  }
}

export const alumniHelpRoomGraceExpiryService =
  new AlumniHelpRoomGraceExpiryService();
