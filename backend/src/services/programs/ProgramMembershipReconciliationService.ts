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

interface Candidate {
  readonly _id: mongoose.Types.ObjectId;
  readonly programId: mongoose.Types.ObjectId;
}

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
  private inFlight: Promise<ProgramMembershipReconciliationResult> | null =
    null;
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
    if (this.inFlight) return this.inFlight;
    const execution = this.executeBounded(runContext);
    this.inFlight = execution;
    void execution
      .finally(() => {
        if (this.inFlight === execution) this.inFlight = null;
      })
      .catch(() => undefined);
    return execution;
  }

  private async executeBounded(
    runContext: ProgramMembershipReconciliationRunContext,
  ): Promise<ProgramMembershipReconciliationResult> {
    const runtimePermit = await acquireProgramMembershipRuntimePermit(
      this.runtimeReader,
    );
    if (!runtimePermit) {
      return Object.freeze({
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
      });
    }
    const queryNow = requireNow(this.now());
    const anomalyLimit = Math.min(
      PROGRAM_MEMBERSHIP_ANOMALY_CAPACITY,
      this.limit,
    );
    let anomalyPageStartCursor = this.lastAnomalyCandidateId;
    let anomalies = await this.anomalyCandidateLoader(
      anomalyPageStartCursor,
      anomalyLimit + 1,
    );
    if (anomalies.length === 0 && this.lastAnomalyCandidateId) {
      this.lastAnomalyCandidateId = null;
      anomalyPageStartCursor = null;
      anomalies = await this.anomalyCandidateLoader(null, anomalyLimit + 1);
    }
    const anomalyHasMore = anomalies.length > anomalyLimit;
    const selectedAnomalies = anomalies.slice(0, anomalyLimit);
    const settingsLimit = this.limit - selectedAnomalies.length;
    let pageStartCursor = this.lastCandidateId;
    let candidates =
      settingsLimit > 0
        ? await this.loadCandidates(queryNow, pageStartCursor, settingsLimit)
        : [];
    // If every candidate after the prior cursor disappeared or closed, begin a
    // new sweep in this run instead of wasting a full cadence on an empty page.
    if (
      settingsLimit > 0 &&
      candidates.length === 0 &&
      this.lastCandidateId
    ) {
      this.lastCandidateId = null;
      pageStartCursor = null;
      candidates = await this.loadCandidates(queryNow, null, settingsLimit);
    }
    const pageHasMore = candidates.length > settingsLimit;
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

    if (!paused) {
      this.lastCandidateId = pageHasMore
        ? (candidates[Math.max(0, settingsLimit - 1)]?._id ?? pageStartCursor)
        : null;
      this.lastAnomalyCandidateId = anomalyHasMore
        ? (selectedAnomalies[selectedAnomalies.length - 1]?._id ??
          anomalyPageStartCursor)
        : null;
    }

    return Object.freeze({
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
      hasMore: paused || pageHasMore || anomalyHasMore,
      capacityPerRun: this.limit,
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
