import { Types, type Model } from "mongoose";
import AlumniHelpOutcomeSubmission, {
  type IAlumniHelpOutcomeSubmission,
} from "../../models/AlumniHelpOutcomeSubmission";
import AlumniHelpRequest, {
  type IAlumniHelpRequest,
} from "../../models/AlumniHelpRequest";
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
import { featureControlService } from "../runtime/FeatureControlService";
import { enqueueAlumniHelpWorkflowNotifications } from "./AlumniHelpWorkflowDeliveryHandler";
import { helpUpdateMarkers } from "./AlumniHelpNotificationCountService";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const WORKER_KEY = WORKER_SERVICE_KEYS.ALUMNI_OUTCOME;

interface OutcomeCandidate {
  readonly _id: Types.ObjectId;
  readonly revision: number;
  readonly dueAt: Date;
}

type TransactionRunner = Pick<MongoTransactionService, "run">;
type OutcomeAuthorizer = Pick<WorkerAuthorizationService, "assertCapability">;
export type AlumniOutcomeRunContext = WorkerRunContext<
  typeof WORKER_SERVICE_KEYS.ALUMNI_OUTCOME
>;

export interface AlumniOutcomeDeadlineResult {
  readonly candidatesScanned: number;
  readonly automaticallyConfirmed: number;
  readonly racedOrUnavailable: number;
  readonly remainingOverdue: number;
  readonly paused: boolean;
}

export interface AlumniOutcomeDeadlineDependencies {
  readonly now?: () => Date;
  readonly maxCandidates?: number;
  readonly transactions?: TransactionRunner;
  readonly authorization?: OutcomeAuthorizer;
  readonly outcomeModel?: Model<IAlumniHelpOutcomeSubmission>;
  readonly requestModel?: Model<IAlumniHelpRequest>;
  readonly runtimeWritable?: () => Promise<boolean>;
}

function requireLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new TypeError(`maxCandidates must be an integer from 1 to ${MAX_LIMIT}.`);
  }
  return value;
}

function requireNow(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("Alumni outcome worker requires a valid clock.");
  }
  return new Date(value);
}

async function defaultRuntimeWritable(): Promise<boolean> {
  const runtime = await featureControlService.getRuntimeConfig();
  return runtime.data.alumniNetwork.mode === "on" &&
    runtime.data.alumniNetwork.writable === true;
}

/** Bounded, restart-safe reconciliation for fixed 480-hour deadlines. */
export class AlumniOutcomeDeadlineService {
  private readonly now: () => Date;
  private readonly maxCandidates: number;
  private readonly transactions: TransactionRunner;
  private readonly authorization: OutcomeAuthorizer;
  private readonly outcomeModel: Model<IAlumniHelpOutcomeSubmission>;
  private readonly requestModel: Model<IAlumniHelpRequest>;
  private readonly runtimeWritable: () => Promise<boolean>;
  private inFlight: Promise<AlumniOutcomeDeadlineResult> | null = null;

  constructor(dependencies: AlumniOutcomeDeadlineDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.maxCandidates = requireLimit(
      dependencies.maxCandidates ?? DEFAULT_LIMIT,
    );
    this.transactions = dependencies.transactions ?? mongoTransactionService;
    this.authorization = dependencies.authorization ?? workerAuthorizationService;
    this.outcomeModel = dependencies.outcomeModel ?? AlumniHelpOutcomeSubmission;
    this.requestModel = dependencies.requestModel ?? AlumniHelpRequest;
    this.runtimeWritable = dependencies.runtimeWritable ?? defaultRuntimeWritable;
  }

  async runBounded(
    runContext: AlumniOutcomeRunContext,
  ): Promise<AlumniOutcomeDeadlineResult> {
    await this.authorization.assertCapability(
      runContext,
      WORKER_CAPABILITIES.ALUMNI_OUTCOME_AUTO_CONFIRM,
      { resource: { type: "alumni_outcome", id: "pending-deadlines" } },
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
    runContext: AlumniOutcomeRunContext,
  ): Promise<AlumniOutcomeDeadlineResult> {
    if (!(await this.runtimeWritable())) {
      return {
        candidatesScanned: 0,
        automaticallyConfirmed: 0,
        racedOrUnavailable: 0,
        remainingOverdue: 0,
        paused: true,
      };
    }
    const now = requireNow(this.now());
    const candidates = await this.outcomeModel
      .find({ status: "pending", dueAt: { $lte: now } })
      .select({ _id: 1, revision: 1, dueAt: 1 })
      .sort({ dueAt: 1, _id: 1 })
      .limit(this.maxCandidates)
      .lean<OutcomeCandidate[]>()
      .exec();

    let automaticallyConfirmed = 0;
    for (const candidate of candidates) {
      if (await this.confirmCandidate(candidate, now, runContext)) {
        automaticallyConfirmed += 1;
      }
    }
    const remainingOverdue = await this.outcomeModel.countDocuments({
      status: "pending",
      dueAt: { $lte: now },
    });
    return {
      candidatesScanned: candidates.length,
      automaticallyConfirmed,
      racedOrUnavailable: candidates.length - automaticallyConfirmed,
      remainingOverdue,
      paused: false,
    };
  }

  private confirmCandidate(
    candidate: OutcomeCandidate,
    now: Date,
    runContext: AlumniOutcomeRunContext,
  ): Promise<boolean> {
    return this.transactions.run(async (session) => {
      const outcome = await this.outcomeModel
        .findOne({
          _id: candidate._id,
          revision: candidate.revision,
          status: "pending",
          dueAt: { $lte: now },
        })
        .session(session);
      if (!outcome) return false;
      const request = await this.requestModel
        .findOne({
          _id: outcome.helpRequestId,
          latestOutcomeSubmissionId: outcome._id,
          latestOutcomeStatus: "pending",
        })
        .session(session);
      if (!request) return false;

      const outcomeUpdate = await this.outcomeModel.updateOne(
        {
          _id: outcome._id,
          revision: outcome.revision,
          status: "pending",
          dueAt: { $lte: now },
        },
        {
          $set: {
            status: "confirmed",
            decidedAt: now,
            decidedBy: null,
            confirmationMethod: "automatic_20_day",
            revision: outcome.revision + 1,
          },
        },
        { session, runValidators: false },
      );
      if (outcomeUpdate.modifiedCount !== 1) return false;

      const requestUpdate = await this.requestModel.updateOne(
        {
          _id: request._id,
          revision: request.revision,
          latestOutcomeSubmissionId: outcome._id,
          latestOutcomeStatus: "pending",
        },
        {
          $set: {
            latestOutcomeStatus: "confirmed",
            revision: request.revision + 1,
          },
          $max: helpUpdateMarkers(request.revision + 1, null),
        },
        { session, runValidators: false },
      );
      if (requestUpdate.modifiedCount !== 1) {
        throw new Error("Alumni Help request outcome summary changed concurrently.");
      }

      await AuditLogService.recordRequiredInTransaction(
        {
          action: "alumni_help.outcome_auto_confirm",
          actor: { type: "worker", key: WORKER_KEY },
          source: "worker",
          outcome: "success",
          target: {
            model: "AlumniHelpOutcomeSubmission",
            id: outcome._id.toString(),
          },
          reasonCode: "automatic_20_day",
          details: {
            outcomeRevisionNumber: outcome.revisionNumber,
            dueAt: outcome.dueAt.toISOString(),
            resultingOutcomeRevision: outcome.revision + 1,
            resultingRequestRevision: request.revision + 1,
            workerRunId: runContext.runId,
          },
        },
        session,
      );
      await enqueueAlumniHelpWorkflowNotifications({
        requestId: request._id.toString(),
        requestRevision: request.revision + 1,
        timelineEventId: new Types.ObjectId().toString(),
        eventType: "outcome_auto_confirm",
        actorUserId: null,
        requesterId: request.requesterId.toString(),
        providerId: request.providerId.toString(),
        outcomeSubmissionId: outcome._id.toString(),
        outcomeRevision: outcome.revisionNumber,
        occurredAt: now,
        session,
      });
      return true;
    });
  }
}

export const alumniOutcomeDeadlineService = new AlumniOutcomeDeadlineService();
