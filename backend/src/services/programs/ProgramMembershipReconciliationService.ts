import mongoose, { type Model } from "mongoose";
import ProgramCommunitySettings, {
  type IProgramCommunitySettings,
} from "../../models/ProgramCommunitySettings";
import Conversation from "../../models/Conversation";
import ConversationMember from "../../models/ConversationMember";
import Program from "../../models/Program";
import {
  WORKER_CAPABILITIES,
  WORKER_SERVICE_KEYS,
  WorkerAuthorizationService,
  workerAuthorizationService,
  type WorkerRunContext,
} from "../authorization/WorkerAuthorizationService";
import {
  programRoomMembershipSyncService,
  type ProgramMembershipSyncResult,
  type ProgramRoomMembershipSyncService,
} from "./ProgramRoomMembershipSyncService";
import {
  acquireProgramMembershipRuntimePermit,
  type ProgramMembershipRuntimeReader,
} from "./ProgramMembershipRuntimeGate";

// The approved baseline contains 500 Programs with at most 50 simultaneously
// open. A stable cursor repairs every open Program in at most two one-minute
// runs while keeping sequential database work inside the approved Flex pool.
export const PROGRAM_MEMBERSHIP_RECONCILIATION_CAPACITY = Object.freeze({
  baselinePrograms: 500,
  baselineSimultaneouslyOpenPrograms: 50,
  defaultLimit: 25,
  maximumLimit: 100,
  cadenceMs: 60_000,
  baselineMaximumSweepMinutes: 2,
});

export type ProgramMembershipReconciliationRunContext = WorkerRunContext<
  typeof WORKER_SERVICE_KEYS.PROGRAM_MEMBERSHIP_RECONCILER
>;

export interface ProgramMembershipReconciliationResult {
  readonly paused: boolean;
  readonly candidatesScanned: number;
  readonly reconciledPrograms: number;
  readonly createdMemberships: number;
  readonly updatedRoles: number;
  readonly closedMemberships: number;
  readonly reactivatedMemberships: number;
  readonly archivedRooms: number;
  readonly ignoredPurchasesMissingStudentRoleId: number;
  readonly ignoredPurchasesUnmappedStudentRoleId: number;
  readonly deferredRevocations: number;
  readonly deferredReactivations: number;
  readonly racedOrUnavailable: number;
  readonly hasMore: boolean;
  readonly capacityPerRun: number;
}

/**
 * A JSON-safe continuation point for an isolated, resumable reconciliation
 * run.  It deliberately contains only collection cursor values, so it can be
 * persisted by an operations tool without adding restore-specific fields to
 * the normal reconciliation result.
 */
export interface ProgramMembershipReconciliationCheckpoint {
  readonly settingsAfterId: string | null;
  readonly anomalyAfterId: string | null;
}

export interface ProgramMembershipReconciliationCheckpointRun {
  readonly result: ProgramMembershipReconciliationResult;
  readonly checkpoint: ProgramMembershipReconciliationCheckpoint;
}

export const EMPTY_PROGRAM_MEMBERSHIP_RECONCILIATION_CHECKPOINT =
  Object.freeze({
    settingsAfterId: null,
    anomalyAfterId: null,
  } satisfies ProgramMembershipReconciliationCheckpoint);

interface Candidate {
  readonly _id: mongoose.Types.ObjectId;
  readonly programId: mongoose.Types.ObjectId;
}

interface InternalReconciliationCheckpoint {
  readonly settingsAfterId: mongoose.Types.ObjectId | null;
  readonly anomalyAfterId: mongoose.Types.ObjectId | null;
}

interface BoundedReconciliationExecution {
  readonly result: ProgramMembershipReconciliationResult;
  readonly checkpoint: InternalReconciliationCheckpoint;
}

type InFlightReconciliationExecution =
  | {
      readonly kind: "stateful";
      readonly execution: Promise<ProgramMembershipReconciliationResult>;
    }
  | {
      readonly kind: "checkpoint";
      readonly checkpointKey: string;
      readonly execution: Promise<ProgramMembershipReconciliationCheckpointRun>;
    };

type AnomalyCandidateLoader = (
  afterId: mongoose.Types.ObjectId | null,
  limit: number,
) => Promise<readonly Candidate[]>;

interface ProgramMembershipReconciliationDependencies {
  readonly now?: () => Date;
  readonly limit?: number;
  readonly settingsModel?: Model<IProgramCommunitySettings>;
  readonly sync?: Pick<ProgramRoomMembershipSyncService, "reconcileProgram">;
  readonly authorization?: Pick<
    WorkerAuthorizationService,
    "assertCapability"
  >;
  readonly runtimeReader?: ProgramMembershipRuntimeReader;
  readonly anomalyCandidateLoader?: AnomalyCandidateLoader;
}

const PROGRAM_MEMBERSHIP_ANOMALY_CAPACITY = 5;

function requireLimit(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > PROGRAM_MEMBERSHIP_RECONCILIATION_CAPACITY.maximumLimit
  ) {
    throw new TypeError(
      `Program membership reconciliation limit must be an integer from 1 to ${PROGRAM_MEMBERSHIP_RECONCILIATION_CAPACITY.maximumLimit}.`,
    );
  }
  return value;
}

function requireNow(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(
      "Program membership reconciliation requires a valid time.",
    );
  }
  return new Date(value);
}

function requireCheckpointId(
  value: unknown,
  label: string,
): mongoose.Types.ObjectId | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[a-f0-9]{24}$/iu.test(value)) {
    throw new TypeError(
      `Program membership reconciliation ${label} checkpoint must be a 24-character ObjectId or null.`,
    );
  }
  return new mongoose.Types.ObjectId(value);
}

function parseCheckpoint(
  value: unknown,
): InternalReconciliationCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(
      "Program membership reconciliation checkpoint must be an object.",
    );
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record);
  if (
    keys.length !== 2 ||
    !keys.includes("settingsAfterId") ||
    !keys.includes("anomalyAfterId")
  ) {
    throw new TypeError(
      "Program membership reconciliation checkpoint has invalid fields.",
    );
  }
  return Object.freeze({
    settingsAfterId: requireCheckpointId(record.settingsAfterId, "settings"),
    anomalyAfterId: requireCheckpointId(record.anomalyAfterId, "anomaly"),
  });
}

function serializeCheckpoint(
  checkpoint: InternalReconciliationCheckpoint,
): ProgramMembershipReconciliationCheckpoint {
  return Object.freeze({
    settingsAfterId: checkpoint.settingsAfterId?.toHexString() ?? null,
    anomalyAfterId: checkpoint.anomalyAfterId?.toHexString() ?? null,
  });
}

function checkpointKey(checkpoint: InternalReconciliationCheckpoint): string {
  return [
    checkpoint.settingsAfterId?.toHexString() ?? "",
    checkpoint.anomalyAfterId?.toHexString() ?? "",
  ].join(":");
}

/** Performs a bounded repair pass over Programs whose community is open now. */
export class ProgramMembershipReconciliationService {
  private readonly now: () => Date;
  private readonly limit: number;
  private readonly settings: Model<IProgramCommunitySettings>;
  private readonly sync: Pick<
    ProgramRoomMembershipSyncService,
    "reconcileProgram"
  >;
  private readonly authorization: Pick<
    WorkerAuthorizationService,
    "assertCapability"
  >;
  private readonly runtimeReader?: ProgramMembershipRuntimeReader;
  private readonly anomalyCandidateLoader: AnomalyCandidateLoader;
  private inFlight: InFlightReconciliationExecution | null = null;
  private lastCandidateId: mongoose.Types.ObjectId | null = null;
  private lastAnomalyCandidateId: mongoose.Types.ObjectId | null = null;

  constructor(
    dependencies: ProgramMembershipReconciliationDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.limit = requireLimit(
      dependencies.limit ??
        PROGRAM_MEMBERSHIP_RECONCILIATION_CAPACITY.defaultLimit,
    );
    this.settings = dependencies.settingsModel ?? ProgramCommunitySettings;
    this.sync = dependencies.sync ?? programRoomMembershipSyncService;
    this.authorization =
      dependencies.authorization ?? workerAuthorizationService;
    this.runtimeReader = dependencies.runtimeReader;
    this.anomalyCandidateLoader =
      dependencies.anomalyCandidateLoader ??
      ((afterId, limit) => this.loadAnomalyCandidates(afterId, limit));
  }

  async runBounded(
    runContext: ProgramMembershipReconciliationRunContext,
  ): Promise<ProgramMembershipReconciliationResult> {
    await this.assertAuthorization(runContext);
    for (;;) {
      const active = this.inFlight;
      if (!active) return this.startStatefulRun(runContext);
      if (active.kind === "stateful") return active.execution;
      await active.execution;
    }
  }

  /**
   * Performs one bounded reconciliation pass from caller-owned cursors.
   * Unlike `runBounded`, this method never changes the scheduler's in-memory
   * sweep position; callers persist the returned checkpoint themselves.
   */
  async runBoundedFromCheckpoint(
    runContext: ProgramMembershipReconciliationRunContext,
    checkpoint: ProgramMembershipReconciliationCheckpoint,
  ): Promise<ProgramMembershipReconciliationCheckpointRun> {
    const parsedCheckpoint = parseCheckpoint(checkpoint);
    const requestedCheckpointKey = checkpointKey(parsedCheckpoint);
    await this.assertAuthorization(runContext);
    for (;;) {
      const active = this.inFlight;
      if (!active) {
        return this.startCheckpointRun(runContext, parsedCheckpoint);
      }
      if (
        active.kind === "checkpoint" &&
        active.checkpointKey === requestedCheckpointKey
      ) {
        return active.execution;
      }
      await active.execution;
    }
  }

  private async assertAuthorization(
    runContext: ProgramMembershipReconciliationRunContext,
  ): Promise<void> {
    await this.authorization.assertCapability(
      runContext,
      WORKER_CAPABILITIES.PROGRAM_MEMBERSHIP_RECONCILE,
      {
        resource: {
          type: "program_membership",
          id: "open-programs",
        },
      },
    );
  }

  private startStatefulRun(
    runContext: ProgramMembershipReconciliationRunContext,
  ): Promise<ProgramMembershipReconciliationResult> {
    const initialCheckpoint: InternalReconciliationCheckpoint = Object.freeze({
      settingsAfterId: this.lastCandidateId,
      anomalyAfterId: this.lastAnomalyCandidateId,
    });
    const execution = this.executeBounded(
      runContext,
      initialCheckpoint,
      true,
    ).then(
      ({ result, checkpoint }) => {
        if (!result.paused) {
          this.lastCandidateId = checkpoint.settingsAfterId;
          this.lastAnomalyCandidateId = checkpoint.anomalyAfterId;
        }
        return result;
      },
    );
    const active: InFlightReconciliationExecution = {
      kind: "stateful",
      execution,
    };
    this.inFlight = active;
    void execution
      .finally(() => {
        if (this.inFlight === active) this.inFlight = null;
      })
      .catch(() => undefined);
    return execution;
  }

  private startCheckpointRun(
    runContext: ProgramMembershipReconciliationRunContext,
    initialCheckpoint: InternalReconciliationCheckpoint,
  ): Promise<ProgramMembershipReconciliationCheckpointRun> {
    const execution = this.executeBounded(
      runContext,
      initialCheckpoint,
      false,
    ).then(
      ({ result, checkpoint }) =>
        Object.freeze({
          result,
          checkpoint: serializeCheckpoint(checkpoint),
        }),
    );
    const active: InFlightReconciliationExecution = {
      kind: "checkpoint",
      checkpointKey: checkpointKey(initialCheckpoint),
      execution,
    };
    this.inFlight = active;
    void execution
      .finally(() => {
        if (this.inFlight === active) this.inFlight = null;
      })
      .catch(() => undefined);
    return execution;
  }

  private async executeBounded(
    runContext: ProgramMembershipReconciliationRunContext,
    initialCheckpoint: InternalReconciliationCheckpoint,
    cycleWhenExhausted: boolean,
  ): Promise<BoundedReconciliationExecution> {
    const runtimePermit = await acquireProgramMembershipRuntimePermit(
      this.runtimeReader,
    );
    if (!runtimePermit) {
      return Object.freeze({
        result: Object.freeze({
          paused: true,
          candidatesScanned: 0,
          reconciledPrograms: 0,
          createdMemberships: 0,
          updatedRoles: 0,
          closedMemberships: 0,
          reactivatedMemberships: 0,
          archivedRooms: 0,
          ignoredPurchasesMissingStudentRoleId: 0,
          ignoredPurchasesUnmappedStudentRoleId: 0,
          deferredRevocations: 0,
          deferredReactivations: 0,
          racedOrUnavailable: 0,
          hasMore: false,
          capacityPerRun: this.limit,
        }),
        checkpoint: initialCheckpoint,
      });
    }
    const queryNow = requireNow(this.now());
    const anomalyLimit = Math.min(
      PROGRAM_MEMBERSHIP_ANOMALY_CAPACITY,
      this.limit,
    );
    let anomalyPageStartCursor = initialCheckpoint.anomalyAfterId;
    let anomalies = await this.anomalyCandidateLoader(
      anomalyPageStartCursor,
      anomalyLimit + 1,
    );
    if (
      cycleWhenExhausted &&
      anomalies.length === 0 &&
      initialCheckpoint.anomalyAfterId
    ) {
      anomalyPageStartCursor = null;
      anomalies = await this.anomalyCandidateLoader(null, anomalyLimit + 1);
    }
    const anomalyHasMore = anomalies.length > anomalyLimit;
    const selectedAnomalies = anomalies.slice(0, anomalyLimit);
    const settingsLimit = this.limit - selectedAnomalies.length;
    let pageStartCursor = initialCheckpoint.settingsAfterId;
    let candidates =
      settingsLimit > 0
        ? await this.loadCandidates(queryNow, pageStartCursor, settingsLimit)
        : [];
    // The scheduler continuously sweeps, so it may restart after every
    // candidate after its cursor disappeared or closed. A caller-owned restore
    // checkpoint instead remains terminal at that point.
    if (
      settingsLimit > 0 &&
      candidates.length === 0 &&
      initialCheckpoint.settingsAfterId &&
      cycleWhenExhausted
    ) {
      pageStartCursor = null;
      candidates = await this.loadCandidates(queryNow, null, settingsLimit);
    }
    const pageHasMore = candidates.length > settingsLimit;
    let settingsHasMore = pageHasMore;
    let nextSettingsAfterId = pageHasMore
      ? (candidates[Math.max(0, settingsLimit - 1)]?._id ?? pageStartCursor)
      : null;
    // An anomaly page can consume all mutation capacity. In checkpoint mode,
    // perform a one-record settings probe so an unvisited settings sweep is
    // never incorrectly reported as complete or reset to its first page.
    if (!cycleWhenExhausted && settingsLimit === 0) {
      const settingsProbe = await this.loadCandidates(
        queryNow,
        initialCheckpoint.settingsAfterId,
        0,
      );
      settingsHasMore = settingsProbe.length > 0;
      nextSettingsAfterId = settingsHasMore
        ? initialCheckpoint.settingsAfterId
        : null;
    }
    const anomalyProgramIds = new Set(
      selectedAnomalies.map((candidate) => candidate.programId.toString()),
    );
    const selectedSettings = candidates
      .slice(0, settingsLimit)
      .filter(
        (candidate) => !anomalyProgramIds.has(candidate.programId.toString()),
      );
    const selected = [...selectedAnomalies, ...selectedSettings];

    let paused = false;
    let candidatesScanned = 0;
    let reconciledPrograms = 0;
    let createdMemberships = 0;
    let updatedRoles = 0;
    let closedMemberships = 0;
    let reactivatedMemberships = 0;
    let archivedRooms = 0;
    let ignoredPurchasesMissingStudentRoleId = 0;
    let ignoredPurchasesUnmappedStudentRoleId = 0;
    let deferredRevocations = 0;
    let deferredReactivations = 0;
    let racedOrUnavailable = 0;
    for (const candidate of selected) {
      candidatesScanned += 1;
      let result: ProgramMembershipSyncResult;
      try {
        result = await this.sync.reconcileProgram(candidate.programId, {
          actor: {
            type: "worker",
            key: WORKER_SERVICE_KEYS.PROGRAM_MEMBERSHIP_RECONCILER,
          },
          source: "worker",
          correlationId: runContext.runId,
          runtimePermit,
        });
      } catch {
        racedOrUnavailable += 1;
        continue;
      }
      if (result.paused) {
        paused = true;
        break;
      }
      reconciledPrograms += 1;
      createdMemberships += result.createdMemberships;
      updatedRoles += result.updatedRoles;
      closedMemberships += result.closedMemberships;
      reactivatedMemberships += result.reactivatedMemberships;
      archivedRooms += result.roomArchived ? 1 : 0;
      ignoredPurchasesMissingStudentRoleId +=
        result.ignoredPurchasesMissingStudentRoleId;
      ignoredPurchasesUnmappedStudentRoleId +=
        result.ignoredPurchasesUnmappedStudentRoleId;
      deferredRevocations += result.deferredRevocations;
      deferredReactivations += result.deferredReactivations;
    }

    // A normal scheduler sweep eventually wraps and retries a raced candidate.
    // An externally persisted checkpoint must instead retain the entire prior
    // page so a later clean recovery pass cannot falsely terminate after
    // advancing beyond that candidate.
    const retryCheckpoint =
      !cycleWhenExhausted && racedOrUnavailable > 0;
    const checkpoint = paused || retryCheckpoint
      ? initialCheckpoint
      : Object.freeze({
          settingsAfterId: nextSettingsAfterId,
          anomalyAfterId: anomalyHasMore
            ? (selectedAnomalies[selectedAnomalies.length - 1]?._id ??
              anomalyPageStartCursor)
            : null,
        });

    return Object.freeze({
      result: Object.freeze({
        paused,
        candidatesScanned,
        reconciledPrograms,
        createdMemberships,
        updatedRoles,
        closedMemberships,
        reactivatedMemberships,
        archivedRooms,
        ignoredPurchasesMissingStudentRoleId,
        ignoredPurchasesUnmappedStudentRoleId,
        deferredRevocations,
        deferredReactivations,
        racedOrUnavailable,
        hasMore:
          paused ||
          retryCheckpoint ||
          settingsHasMore ||
          anomalyHasMore,
        capacityPerRun: this.limit,
      }),
      checkpoint,
    });
  }

  private loadCandidates(
    now: Date,
    afterId: mongoose.Types.ObjectId | null,
    limit: number,
  ): Promise<Candidate[]> {
    return this.settings
      .find({
        ...(afterId ? { _id: { $gt: afterId } } : {}),
        $or: [
          {
            enabled: true,
            archivedAt: null,
            opensAt: { $lte: now },
            $or: [
              { closesAt: null },
              { closesAt: { $exists: false } },
              { closesAt: { $gt: now } },
            ],
          },
          { membershipProjectionState: "pending" },
          { membershipProjectionState: { $exists: false } },
          {
            $expr: {
              $ne: [
                { $ifNull: ["$membershipProjectionRevision", -1] },
                "$revision",
              ],
            },
          },
          {
            enabled: true,
            archivedAt: null,
            closesAt: { $lte: now },
            membershipProjectionState: { $ne: "archived" },
          },
          {
            archivedAt: { $ne: null },
            membershipProjectionState: { $ne: "archived" },
          },
        ],
      })
      .select("programId")
      .sort({ _id: 1 })
      .limit(limit + 1)
      .lean<Candidate[]>()
      .exec();
  }

  private async loadAnomalyCandidates(
    afterId: mongoose.Types.ObjectId | null,
    limit: number,
  ): Promise<readonly Candidate[]> {
    return Conversation.aggregate<Candidate>([
      {
        $match: {
          kind: "program",
          status: "current",
          programId: { $type: "objectId" },
          ...(afterId ? { _id: { $gt: afterId } } : {}),
        },
      },
      { $sort: { _id: 1 } },
      {
        $lookup: {
          from: ProgramCommunitySettings.collection.name,
          localField: "programId",
          foreignField: "programId",
          pipeline: [{ $project: { _id: 1 } }, { $limit: 1 }],
          as: "communitySettings",
        },
      },
      {
        $lookup: {
          from: Program.collection.name,
          localField: "programId",
          foreignField: "_id",
          pipeline: [{ $project: { _id: 1 } }, { $limit: 1 }],
          as: "program",
        },
      },
      {
        $lookup: {
          from: ConversationMember.collection.name,
          let: { roomId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$conversationId", "$$roomId"] },
                status: "active",
              },
            },
            { $project: { _id: 1 } },
            { $limit: 1 },
          ],
          as: "activeMember",
        },
      },
      {
        $match: {
          $or: [
            { "program.0": { $exists: false } },
            {
              "communitySettings.0": { $exists: false },
              "activeMember.0": { $exists: true },
            },
          ],
        },
      },
      { $project: { _id: 1, programId: 1 } },
      { $limit: limit },
    ]).exec();
  }
}

export const programMembershipReconciliationService =
  new ProgramMembershipReconciliationService();
