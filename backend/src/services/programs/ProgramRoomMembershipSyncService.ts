import mongoose, { type ClientSession, type Model } from "mongoose";
import type { AuditActor, AuditSource } from "../../contracts/auditLog";
import {
  conversationPurgeAt,
  type ConversationAccessWindowValue,
} from "../../contracts/chatRooms";
import Conversation, { type IConversation } from "../../models/Conversation";
import ConversationMember, {
  type IConversationMember,
} from "../../models/ConversationMember";
import ProgramCommunitySettings, {
  type IProgramCommunitySettings,
  type ProgramMembershipProjectionState,
} from "../../models/ProgramCommunitySettings";
import { AuditLogService } from "../AuditLogService";
import {
  mongoTransactionService,
  type MongoTransactionService,
} from "../reliability/MongoTransactionService";
import {
  programMembershipResolver,
  type ProgramMembershipResolution,
  type ProgramMembershipResolver,
} from "./ProgramMembershipResolver";
import {
  programRoomProvisioner,
  type ProgramRoomProvisioner,
} from "./ProgramRoomProvisioner";
import {
  acquireProgramMembershipRuntimePermit,
  isProgramMembershipRuntimePermit,
  type ProgramMembershipRuntimePermit,
  type ProgramMembershipRuntimeReader,
} from "./ProgramMembershipRuntimeGate";

export interface ProgramMembershipSyncContext {
  readonly actor?: AuditActor;
  readonly source?: AuditSource;
  readonly correlationId?: string;
  /** Internal, runtime-validated proof shared by one bounded sync pass. */
  readonly runtimePermit?: ProgramMembershipRuntimePermit;
}

export interface ProgramMembershipSyncResult {
  readonly programId: string;
  readonly conversationId: string | null;
  readonly resolutionState:
    | ProgramMembershipResolution["state"]
    | "runtime_unavailable";
  readonly paused: boolean;
  readonly roomProvisioned: boolean;
  readonly roomArchived: boolean;
  readonly desiredMemberships: number;
  readonly createdMemberships: number;
  readonly updatedRoles: number;
  readonly closedMemberships: number;
  readonly reactivatedMemberships: number;
  readonly unchangedMemberships: number;
  readonly ignoredPurchasesMissingStudentRoleId: number;
  readonly ignoredPurchasesUnmappedStudentRoleId: number;
  /** Retained as a stable metric name; M6-03 materializes every revocation. */
  readonly deferredRevocations: number;
  /** Retained as a stable metric name; M6-03 materializes every reactivation. */
  readonly deferredReactivations: number;
}

export class ProgramMembershipSyncConflictError extends Error {
  readonly name = "ProgramMembershipSyncConflictError";
  readonly code = "PROGRAM_MEMBERSHIP_SYNC_CONFLICT";

  constructor() {
    super("Program Room membership changed during reconciliation.");
  }
}

interface ProgramMembershipSyncAuditPort {
  recordRequiredInTransaction(
    input: Parameters<typeof AuditLogService.recordRequiredInTransaction>[0],
    session: ClientSession,
  ): Promise<unknown>;
}

interface ProgramMembershipSyncDependencies {
  readonly resolver?: Pick<ProgramMembershipResolver, "resolveProgram">;
  readonly provisioner?: Pick<
    ProgramRoomProvisioner,
    "ensurePrimaryRoomInTransaction"
  >;
  readonly conversationModel?: Model<IConversation>;
  readonly memberModel?: Model<IConversationMember>;
  readonly settingsModel?: Model<IProgramCommunitySettings>;
  readonly transactions?: Pick<MongoTransactionService, "run">;
  readonly audit?: ProgramMembershipSyncAuditPort;
  readonly now?: () => Date;
  readonly maximumConflictAttempts?: number;
  readonly runtimeReader?: ProgramMembershipRuntimeReader;
}

interface ExistingMemberSnapshot {
  readonly _id: mongoose.Types.ObjectId;
  readonly userId: mongoose.Types.ObjectId;
  readonly role: IConversationMember["role"];
  readonly status: IConversationMember["status"];
  readonly joinedAt: Date;
  readonly accessWindows: readonly ConversationAccessWindowValue[];
  readonly lastReadSequence: number;
  readonly unreadCount: number;
  readonly unreadReconciledThroughSequence: number;
  readonly unreadReconciledAt?: Date | null;
  readonly muted: boolean;
  readonly mutedAt?: Date | null;
  readonly purgeAt?: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly revision: number;
}

interface ProgramRoomFenceSnapshot {
  readonly _id: mongoose.Types.ObjectId;
  readonly status: IConversation["status"];
  readonly lastSequence: number;
  readonly lastMessageId?: mongoose.Types.ObjectId | null;
  readonly latestMessagePurgeAt?: Date | null;
  readonly archivedAt?: Date | null;
  readonly purgeAt?: Date | null;
  readonly revision: number;
}

interface ProgramSettingsFenceSnapshot {
  readonly _id: mongoose.Types.ObjectId;
  readonly enabled?: boolean;
  readonly archivedAt?: Date | null;
  readonly membershipFenceRevision?: number;
  readonly membershipProjectionRevision?: number;
  readonly membershipProjectionState?: ProgramMembershipProjectionState;
  readonly revision?: number;
}

interface ArchivedSettingsMutation {
  readonly changed: boolean;
  readonly settingsId: mongoose.Types.ObjectId | null;
  readonly archivedAt: Date | null;
}

const DEFAULT_MAXIMUM_CONFLICT_ATTEMPTS = 3;
export const PROGRAM_MEMBERSHIP_BULK_WRITE_BATCH_SIZE = 100;

function requireProgramId(value: string | mongoose.Types.ObjectId) {
  const text = String(value);
  if (!mongoose.Types.ObjectId.isValid(text)) {
    throw new TypeError("Program membership sync requires a Program ID.");
  }
  return new mongoose.Types.ObjectId(text);
}

function requireNow(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("Program membership sync requires a valid time.");
  }
  return new Date(value);
}

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === 11000,
  );
}

function sameInstant(
  first: Date | null | undefined,
  second: Date | null | undefined,
): boolean {
  if (first == null || second == null) return first == null && second == null;
  return first instanceof Date && second instanceof Date
    ? first.getTime() === second.getTime()
    : false;
}

function cloneWindows(
  windows: readonly ConversationAccessWindowValue[],
): Array<{
  visibleFromSequence: number;
  visibleThroughSequence: number | null;
  openedAt: Date;
  closedAt: Date | null;
}> {
  return windows.map((window) => ({
    visibleFromSequence: window.visibleFromSequence,
    visibleThroughSequence: window.visibleThroughSequence ?? null,
    openedAt: new Date(window.openedAt),
    closedAt: window.closedAt ? new Date(window.closedAt) : null,
  }));
}

function closeOpenWindows(
  windows: readonly ConversationAccessWindowValue[],
  throughSequence: number,
  closedAt: Date,
): ReturnType<typeof cloneWindows> {
  return cloneWindows(windows).map((window) =>
    window.visibleThroughSequence == null
      ? {
          ...window,
          visibleThroughSequence: throughSequence,
          closedAt: new Date(closedAt),
        }
      : window,
  );
}

function chunks<T>(values: readonly T[], size: number): readonly T[][] {
  const pages: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    pages.push(values.slice(index, index + size));
  }
  return pages;
}

function storedNonNegativeRevision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Stored ${label} revision is invalid.`);
  }
  return Number(value);
}

function emptyResult(
  resolution: ProgramMembershipResolution,
  overrides: Partial<ProgramMembershipSyncResult> = {},
): ProgramMembershipSyncResult {
  return Object.freeze({
    programId: resolution.programId,
    conversationId: resolution.conversationId,
    resolutionState: resolution.state,
    paused: false,
    roomProvisioned: false,
    roomArchived: false,
    desiredMemberships: resolution.memberships.length,
    createdMemberships: 0,
    updatedRoles: 0,
    closedMemberships: 0,
    reactivatedMemberships: 0,
    unchangedMemberships: 0,
    ignoredPurchasesMissingStudentRoleId:
      resolution.ignoredPurchases.missingStudentRoleId,
    ignoredPurchasesUnmappedStudentRoleId:
      resolution.ignoredPurchases.unmappedStudentRoleId,
    deferredRevocations: 0,
    deferredReactivations: 0,
    ...overrides,
  });
}

function runtimePausedResult(
  programId: mongoose.Types.ObjectId,
): ProgramMembershipSyncResult {
  return Object.freeze({
    programId: programId.toString(),
    conversationId: null,
    resolutionState: "runtime_unavailable",
    paused: true,
    roomProvisioned: false,
    roomArchived: false,
    desiredMemberships: 0,
    createdMemberships: 0,
    updatedRoles: 0,
    closedMemberships: 0,
    reactivatedMemberships: 0,
    unchangedMemberships: 0,
    ignoredPurchasesMissingStudentRoleId: 0,
    ignoredPurchasesUnmappedStudentRoleId: 0,
    deferredRevocations: 0,
    deferredReactivations: 0,
  });
}

/**
 * Materializes the complete canonical Program membership and access-window
 * lifecycle. Every projection is transactionally fenced against Room message
 * sequence changes and settings changes.
 */
export class ProgramRoomMembershipSyncService {
  private readonly resolver: Pick<ProgramMembershipResolver, "resolveProgram">;
  private readonly provisioner: Pick<
    ProgramRoomProvisioner,
    "ensurePrimaryRoomInTransaction"
  >;
  private readonly conversations: Model<IConversation>;
  private readonly members: Model<IConversationMember>;
  private readonly settings: Model<IProgramCommunitySettings>;
  private readonly transactions: Pick<MongoTransactionService, "run">;
  private readonly audit: ProgramMembershipSyncAuditPort;
  private readonly now: () => Date;
  private readonly maximumConflictAttempts: number;
  private readonly runtimeReader?: ProgramMembershipRuntimeReader;

  constructor(dependencies: ProgramMembershipSyncDependencies = {}) {
    this.resolver = dependencies.resolver ?? programMembershipResolver;
    this.provisioner = dependencies.provisioner ?? programRoomProvisioner;
    this.conversations = dependencies.conversationModel ?? Conversation;
    this.members = dependencies.memberModel ?? ConversationMember;
    this.settings = dependencies.settingsModel ?? ProgramCommunitySettings;
    this.transactions = dependencies.transactions ?? mongoTransactionService;
    this.audit = dependencies.audit ?? AuditLogService;
    this.now = dependencies.now ?? (() => new Date());
    this.runtimeReader = dependencies.runtimeReader;
    const maximumConflictAttempts =
      dependencies.maximumConflictAttempts ?? DEFAULT_MAXIMUM_CONFLICT_ATTEMPTS;
    if (
      !Number.isSafeInteger(maximumConflictAttempts) ||
      maximumConflictAttempts < 1 ||
      maximumConflictAttempts > 10
    ) {
      throw new TypeError(
        "Program membership sync conflict attempts must be an integer from 1 to 10.",
      );
    }
    this.maximumConflictAttempts = maximumConflictAttempts;
  }

  async reconcileProgram(
    programIdInput: string | mongoose.Types.ObjectId,
    context: ProgramMembershipSyncContext = {},
  ): Promise<ProgramMembershipSyncResult> {
    const programId = requireProgramId(programIdInput);
    const outerPermitIsValid =
      context.runtimePermit === undefined ||
      isProgramMembershipRuntimePermit(context.runtimePermit);
    const freshRuntimePermit = await acquireProgramMembershipRuntimePermit(
      this.runtimeReader,
    );
    if (!outerPermitIsValid || !freshRuntimePermit) {
      return runtimePausedResult(programId);
    }
    for (
      let attempt = 1;
      attempt <= this.maximumConflictAttempts;
      attempt += 1
    ) {
      try {
        return await this.transactions.run((session) => {
          // Read inside the callback so both transaction-driver retries and
          // logical fence retries re-evaluate opensAt/closesAt boundaries.
          const transactionNow = requireNow(this.now());
          return this.reconcileInTransaction(
            programId,
            transactionNow,
            context,
            session,
          );
        });
      } catch (error) {
        if (
          attempt === this.maximumConflictAttempts ||
          (!(error instanceof ProgramMembershipSyncConflictError) &&
            !isDuplicateKeyError(error))
        ) {
          throw error;
        }
      }
    }
    throw new ProgramMembershipSyncConflictError();
  }

  private async advanceRoomFence(
    programId: mongoose.Types.ObjectId,
    conversation: ProgramRoomFenceSnapshot,
    session: ClientSession,
  ): Promise<void> {
    const fenced = await this.conversations.updateOne(
      {
        _id: conversation._id,
        kind: "program",
        programId,
        status: "current",
        lastSequence: conversation.lastSequence,
        revision: conversation.revision,
      },
      {
        $inc: { revision: 1 },
      },
      { session, runValidators: false, timestamps: false },
    );
    if (fenced.modifiedCount !== 1) {
      throw new ProgramMembershipSyncConflictError();
    }
  }

  private async advanceSettingsFenceWithoutRoom(
    programId: mongoose.Types.ObjectId,
    session: ClientSession,
  ): Promise<boolean> {
    const settings = await this.settings
      .findOne({ programId })
      .select("_id membershipFenceRevision")
      .session(session)
      .lean<ProgramSettingsFenceSnapshot>()
      .exec();
    if (!settings) return false;

    const rawRevision = settings.membershipFenceRevision;
    const fenceRevision = rawRevision ?? 0;
    if (
      !Number.isSafeInteger(fenceRevision) ||
      fenceRevision < 0 ||
      fenceRevision >= Number.MAX_SAFE_INTEGER
    ) {
      throw new Error("Stored Program membership fence revision is invalid.");
    }
    const revisionFilter =
      rawRevision === undefined
        ? {
            $or: [
              { membershipFenceRevision: { $exists: false } },
              { membershipFenceRevision: 0 },
            ],
          }
        : { membershipFenceRevision: fenceRevision };
    const fenced = await this.settings.updateOne(
      {
        _id: settings._id,
        programId,
        ...revisionFilter,
      },
      { $inc: { membershipFenceRevision: 1 } },
      { session, runValidators: false, timestamps: false },
    );
    if (fenced.modifiedCount !== 1) {
      throw new ProgramMembershipSyncConflictError();
    }
    return true;
  }

  private async loadProgramRoom(
    programId: mongoose.Types.ObjectId,
    session: ClientSession,
  ): Promise<ProgramRoomFenceSnapshot | null> {
    return this.conversations
      .findOne({ kind: "program", programId })
      .select(
        "_id status lastSequence lastMessageId latestMessagePurgeAt " +
          "archivedAt purgeAt revision",
      )
      .session(session)
      .lean<ProgramRoomFenceSnapshot>()
      .exec();
  }

  private async loadMembers(
    conversationId: mongoose.Types.ObjectId,
    session: ClientSession,
  ): Promise<readonly ExistingMemberSnapshot[]> {
    return this.members
      .find({ conversationId })
      .sort({ _id: 1 })
      .session(session)
      .lean<ExistingMemberSnapshot[]>()
      .exec();
  }

  private async markSettingsProjection(
    programId: mongoose.Types.ObjectId,
    state: Exclude<ProgramMembershipProjectionState, "pending" | "archived">,
    session: ClientSession,
  ): Promise<void> {
    const settings = await this.settings
      .findOne({ programId })
      .select(
        "_id revision membershipProjectionRevision membershipProjectionState",
      )
      .session(session)
      .lean<ProgramSettingsFenceSnapshot>()
      .exec();
    if (!settings) return;
    const revision = storedNonNegativeRevision(
      settings.revision,
      "Program community settings",
    );
    const projectedRevision = settings.membershipProjectionRevision ?? 0;
    if (
      settings.membershipProjectionState === state &&
      projectedRevision === revision
    ) {
      return;
    }
    const marked = await this.settings.updateOne(
      { _id: settings._id, programId, revision },
      {
        $set: {
          membershipProjectionState: state,
          membershipProjectionRevision: revision,
        },
      },
      { session, runValidators: false, timestamps: false },
    );
    if (marked.modifiedCount !== 1) {
      throw new ProgramMembershipSyncConflictError();
    }
  }

  private async archiveSettings(
    programId: mongoose.Types.ObjectId,
    archiveAt: Date,
    now: Date,
    session: ClientSession,
  ): Promise<ArchivedSettingsMutation> {
    const settings = await this.settings
      .findOne({ programId })
      .select(
        "_id enabled archivedAt revision membershipProjectionRevision " +
          "membershipProjectionState",
      )
      .session(session)
      .lean<ProgramSettingsFenceSnapshot>()
      .exec();
    if (!settings) {
      return Object.freeze({ changed: false, settingsId: null, archivedAt: null });
    }
    const revision = storedNonNegativeRevision(
      settings.revision,
      "Program community settings",
    );
    if (settings.archivedAt) {
      const storedArchivedAt = new Date(settings.archivedAt);
      const domainChanged = settings.enabled !== false;
      if (domainChanged && revision >= Number.MAX_SAFE_INTEGER) {
        throw new Error(
          "Stored Program community settings revision is exhausted.",
        );
      }
      const projectedRevision = revision + (domainChanged ? 1 : 0);
      if (
        !domainChanged &&
        settings.membershipProjectionState === "archived" &&
        settings.membershipProjectionRevision === projectedRevision
      ) {
        return Object.freeze({
          changed: false,
          settingsId: settings._id,
          archivedAt: storedArchivedAt,
        });
      }
      const marked = await this.settings.updateOne(
        {
          _id: settings._id,
          programId,
          revision,
          archivedAt: settings.archivedAt,
        },
        {
          $set: {
            enabled: false,
            membershipProjectionState: "archived",
            membershipProjectionRevision: projectedRevision,
            ...(domainChanged ? { updatedAt: now } : {}),
          },
          ...(domainChanged ? { $inc: { revision: 1 } } : {}),
        },
        { session, runValidators: false, timestamps: false },
      );
      if (marked.modifiedCount !== 1) {
        throw new ProgramMembershipSyncConflictError();
      }
      return Object.freeze({
        changed: true,
        settingsId: settings._id,
        archivedAt: storedArchivedAt,
      });
    }

    if (revision >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Stored Program community settings revision is exhausted.");
    }
    const archived = await this.settings.updateOne(
      {
        _id: settings._id,
        programId,
        revision,
        $or: [{ archivedAt: null }, { archivedAt: { $exists: false } }],
      },
      {
        $set: {
          enabled: false,
          archivedAt: archiveAt,
          membershipProjectionState: "archived",
          membershipProjectionRevision: revision + 1,
          updatedAt: now,
        },
        $inc: { revision: 1 },
      },
      { session, runValidators: false, timestamps: false },
    );
    if (archived.modifiedCount !== 1) {
      throw new ProgramMembershipSyncConflictError();
    }
    return Object.freeze({
      changed: true,
      settingsId: settings._id,
      archivedAt: new Date(archiveAt),
    });
  }

  private async createMembers(
    conversation: ProgramRoomFenceSnapshot,
    memberships: readonly ProgramMembershipResolution["memberships"][number][],
    now: Date,
    session: ClientSession,
  ): Promise<void> {
    const operations: mongoose.AnyBulkWriteOperation<IConversationMember>[] =
      memberships.map((membership) => ({
        updateOne: {
          filter: {
            conversationId: conversation._id,
            userId: new mongoose.Types.ObjectId(membership.userId),
          },
          update: {
            $setOnInsert: {
              conversationId: conversation._id,
              userId: new mongoose.Types.ObjectId(membership.userId),
              role: membership.role,
              status: "active",
              joinedAt: now,
              accessWindows: [
                {
                  visibleFromSequence: conversation.lastSequence + 1,
                  visibleThroughSequence: null,
                  openedAt: now,
                  closedAt: null,
                },
              ],
              lastReadSequence: conversation.lastSequence,
              unreadCount: 0,
              unreadReconciledThroughSequence: conversation.lastSequence,
              unreadReconciledAt: now,
              muted: false,
              mutedAt: null,
              purgeAt: null,
              revision: 0,
              createdAt: now,
              updatedAt: now,
            },
          },
          upsert: true,
          timestamps: false,
        },
      }));
    for (const batch of chunks(operations, PROGRAM_MEMBERSHIP_BULK_WRITE_BATCH_SIZE)) {
      const result = await this.members.bulkWrite(batch, {
        session,
        ordered: true,
      });
      if (result.upsertedCount !== batch.length) {
        throw new ProgramMembershipSyncConflictError();
      }
    }
  }

  private async updateMembers(
    operations: readonly mongoose.AnyBulkWriteOperation<IConversationMember>[],
    session: ClientSession,
  ): Promise<void> {
    for (const batch of chunks(operations, PROGRAM_MEMBERSHIP_BULK_WRITE_BATCH_SIZE)) {
      const result = await this.members.bulkWrite(batch, {
        session,
        ordered: true,
      });
      if (result.modifiedCount !== batch.length) {
        throw new ProgramMembershipSyncConflictError();
      }
    }
  }

  private memberLifecycleOperations(
    resolution: ProgramMembershipResolution,
    conversation: ProgramRoomFenceSnapshot,
    existing: readonly ExistingMemberSnapshot[],
    now: Date,
  ): {
    readonly operations: readonly mongoose.AnyBulkWriteOperation<IConversationMember>[];
    readonly created: readonly ProgramMembershipResolution["memberships"][number][];
    readonly updatedRoles: number;
    readonly closed: number;
    readonly reactivated: number;
    readonly unchanged: number;
  } {
    const synchronize = resolution.lifecycleAction === "synchronize";
    const desiredByUserId = new Map(
      (synchronize ? resolution.memberships : []).map((membership) => [
        membership.userId,
        membership,
      ]),
    );
    const existingByUserId = new Map(
      existing.map((member) => [member.userId.toString(), member]),
    );
    const created = synchronize
      ? resolution.memberships.filter(
          (membership) => !existingByUserId.has(membership.userId),
        )
      : [];
    const operations: mongoose.AnyBulkWriteOperation<IConversationMember>[] = [];
    let updatedRoles = 0;
    let closed = 0;
    let reactivated = 0;
    let unchanged = 0;

    for (const member of existing) {
      const desired = desiredByUserId.get(member.userId.toString());
      if (desired && member.status === "active") {
        if (member.role === desired.role) {
          unchanged += 1;
          continue;
        }
        updatedRoles += 1;
        operations.push({
          updateOne: {
            filter: { _id: member._id, status: "active", revision: member.revision },
            update: {
              $set: { role: desired.role, updatedAt: now },
              $inc: { revision: 1 },
            },
            timestamps: false,
          },
        });
        continue;
      }

      if (desired && member.status === "history_only") {
        const windows = cloneWindows(member.accessWindows);
        const lastWindow = windows[windows.length - 1];
        if (
          !lastWindow ||
          lastWindow.visibleThroughSequence == null ||
          !lastWindow.closedAt ||
          lastWindow.closedAt > now
        ) {
          throw new ProgramMembershipSyncConflictError();
        }
        windows.push({
          visibleFromSequence: conversation.lastSequence + 1,
          visibleThroughSequence: null,
          openedAt: now,
          closedAt: null,
        });
        reactivated += 1;
        operations.push({
          updateOne: {
            filter: {
              _id: member._id,
              status: "history_only",
              revision: member.revision,
            },
            update: {
              $set: {
                role: desired.role,
                status: "active",
                accessWindows: windows,
                lastReadSequence: conversation.lastSequence,
                unreadCount: 0,
                unreadReconciledThroughSequence: conversation.lastSequence,
                unreadReconciledAt: now,
                purgeAt: null,
                updatedAt: now,
              },
              $inc: { revision: 1 },
            },
            timestamps: false,
          },
        });
        continue;
      }

      if (!desired && member.status === "active") {
        if (
          !member.accessWindows.some(
            (window) => window.visibleThroughSequence == null,
          )
        ) {
          throw new ProgramMembershipSyncConflictError();
        }
        if (member.accessWindows.some((window) => window.openedAt > now)) {
          throw new ProgramMembershipSyncConflictError();
        }
        closed += 1;
        operations.push({
          updateOne: {
            filter: { _id: member._id, status: "active", revision: member.revision },
            update: {
              $set: {
                status: "history_only",
                accessWindows: closeOpenWindows(
                  member.accessWindows,
                  conversation.lastSequence,
                  now,
                ),
                lastReadSequence: conversation.lastSequence,
                unreadCount: 0,
                unreadReconciledThroughSequence: conversation.lastSequence,
                unreadReconciledAt: now,
                purgeAt: null,
                updatedAt: now,
              },
              $inc: { revision: 1 },
            },
            timestamps: false,
          },
        });
      }
    }
    return Object.freeze({
      operations: Object.freeze(operations),
      created: Object.freeze(created),
      updatedRoles,
      closed,
      reactivated,
      unchanged,
    });
  }

  private async archiveProgramRoom(
    programId: mongoose.Types.ObjectId,
    resolution: ProgramMembershipResolution,
    now: Date,
    context: ProgramMembershipSyncContext,
    session: ClientSession,
  ): Promise<ProgramMembershipSyncResult> {
    const room = await this.loadProgramRoom(programId, session);
    // Once a Room is archived, its committed cutoff is authoritative for all
    // retries. Before that transition, the canonical Program/settings clock
    // (for example closesAt) determines the cutoff.
    const archiveAt =
      (room?.status === "archived" && room.archivedAt
        ? new Date(room.archivedAt)
        : resolution.archiveAt) ?? now;
    const purgeAt = conversationPurgeAt(
      archiveAt,
      room?.latestMessagePurgeAt,
    );
    let roomArchived = false;
    let roomRepaired = false;
    let closedMemberships = 0;
    let memberUpdates = 0;

    if (room) {
      if (room.status === "current") {
        const archived = await this.conversations.updateOne(
          {
            _id: room._id,
            kind: "program",
            programId,
            status: "current",
            lastSequence: room.lastSequence,
            revision: room.revision,
          },
          {
            $set: {
              status: "archived",
              archivedAt: archiveAt,
              purgeAt,
              updatedAt: now,
            },
            $inc: { revision: 1 },
          },
          { session, runValidators: false, timestamps: false },
        );
        if (archived.modifiedCount !== 1) {
          throw new ProgramMembershipSyncConflictError();
        }
        roomArchived = true;
      } else if (
        !sameInstant(room.archivedAt, archiveAt) ||
        !sameInstant(room.purgeAt, purgeAt)
      ) {
        const repaired = await this.conversations.updateOne(
          {
            _id: room._id,
            kind: "program",
            programId,
            status: "archived",
            revision: room.revision,
          },
          {
            $set: {
              archivedAt: archiveAt,
              purgeAt,
              updatedAt: now,
            },
            $inc: { revision: 1 },
          },
          { session, runValidators: false, timestamps: false },
        );
        if (repaired.modifiedCount !== 1) {
          throw new ProgramMembershipSyncConflictError();
        }
        roomRepaired = true;
      }

      const members = await this.loadMembers(room._id, session);
      const operations: mongoose.AnyBulkWriteOperation<IConversationMember>[] = [];
      for (const member of members) {
        const active = member.status === "active";
        const hasOpenWindow = member.accessWindows.some(
          (window) => window.visibleThroughSequence == null,
        );
        if (active && !hasOpenWindow) {
          throw new ProgramMembershipSyncConflictError();
        }
        const windows = hasOpenWindow
          ? closeOpenWindows(member.accessWindows, room.lastSequence, archiveAt)
          : cloneWindows(member.accessWindows);
        if (
          hasOpenWindow &&
          member.accessWindows.some((window) => window.openedAt > archiveAt)
        ) {
          throw new ProgramMembershipSyncConflictError();
        }
        const changed =
          active ||
          hasOpenWindow ||
          member.unreadCount !== 0 ||
          member.lastReadSequence !== room.lastSequence ||
          member.unreadReconciledThroughSequence !== room.lastSequence ||
          !sameInstant(member.purgeAt, purgeAt);
        if (!changed) continue;
        if (active) closedMemberships += 1;
        memberUpdates += 1;
        operations.push({
          updateOne: {
            filter: { _id: member._id, revision: member.revision },
            update: {
              $set: {
                status: "history_only",
                accessWindows: windows,
                lastReadSequence: room.lastSequence,
                unreadCount: 0,
                unreadReconciledThroughSequence: room.lastSequence,
                unreadReconciledAt: archiveAt,
                purgeAt,
                updatedAt: now,
              },
              $inc: { revision: 1 },
            },
            timestamps: false,
          },
        });
      }
      await this.updateMembers(operations, session);
    }

    const settingsMutation = await this.archiveSettings(
      programId,
      archiveAt,
      now,
      session,
    );
    if (
      roomArchived ||
      roomRepaired ||
      memberUpdates > 0 ||
      settingsMutation.changed
    ) {
      await this.audit.recordRequiredInTransaction(
        {
          action: "program.room_archived",
          actor:
            context.actor ??
            ({ type: "system", key: "program-membership-event-sync" } as const),
          source: context.source ?? "system",
          outcome: "success",
          target: {
            model: room ? "Conversation" : "ProgramCommunitySettings",
            id:
              room?._id.toString() ??
              settingsMutation.settingsId?.toString() ??
              programId.toString(),
          },
          correlationId: context.correlationId,
          details: {
            programId: programId.toString(),
            lifecycleReason: resolution.lifecycleReason,
            roomArchived,
            roomRepaired,
            closedMemberships,
            updatedMemberships: memberUpdates,
            archiveAt: archiveAt.toISOString(),
            settingsArchivedAt: settingsMutation.archivedAt?.toISOString(),
            purgeAt: purgeAt.toISOString(),
          },
        },
        session,
      );
    }

    return emptyResult(resolution, {
      conversationId: room?._id.toString() ?? null,
      roomArchived,
      closedMemberships,
    });
  }

  private async reconcileInTransaction(
    programId: mongoose.Types.ObjectId,
    now: Date,
    context: ProgramMembershipSyncContext,
    session: ClientSession,
  ): Promise<ProgramMembershipSyncResult> {
    let resolution = await this.resolver.resolveProgram(programId, {
      now,
      session,
    });
    let roomProvisioned = false;
    if (resolution.state === "room_unavailable") {
      const settingsFenced = await this.advanceSettingsFenceWithoutRoom(
        programId,
        session,
      );
      if (!settingsFenced) throw new ProgramMembershipSyncConflictError();
      await this.provisioner.ensurePrimaryRoomInTransaction({
        programId,
        provisionedAt: now,
        session,
      });
      roomProvisioned = true;
      resolution = await this.resolver.resolveProgram(programId, {
        now,
        session,
      });
    }
    if (resolution.lifecycleAction === "archive") {
      return this.archiveProgramRoom(
        programId,
        resolution,
        now,
        context,
        session,
      );
    }

    const conversation = await this.loadProgramRoom(programId, session);
    if (!conversation) {
      await this.markSettingsProjection(programId, "cutoff", session);
      return emptyResult(resolution, { roomProvisioned });
    }
    if (conversation.status !== "current") {
      throw new ProgramMembershipSyncConflictError();
    }
    if (
      resolution.lifecycleAction === "synchronize" &&
      resolution.conversationId !== conversation._id.toString()
    ) {
      throw new ProgramMembershipSyncConflictError();
    }

    const conversationId = conversation._id;
    const existing = await this.loadMembers(conversationId, session);
    const lifecycle = this.memberLifecycleOperations(
      resolution,
      conversation,
      existing,
      now,
    );
    const mutationCount =
      lifecycle.created.length + lifecycle.operations.length;
    // Every canonical projection advances the same Room fence. This keeps
    // access-window cutoffs/re-entry baselines on the exact committed message
    // sequence and forces competing projections to retry from a fresh snapshot.
    await this.advanceRoomFence(programId, conversation, session);
    await this.createMembers(
      conversation,
      lifecycle.created,
      now,
      session,
    );
    await this.updateMembers(lifecycle.operations, session);
    await this.markSettingsProjection(
      programId,
      resolution.lifecycleAction === "synchronize" ? "open" : "cutoff",
      session,
    );

    if (roomProvisioned || mutationCount > 0) {
      await this.audit.recordRequiredInTransaction(
        {
          action: "program.membership_synchronized",
          actor:
            context.actor ??
            ({ type: "system", key: "program-membership-event-sync" } as const),
          source: context.source ?? "system",
          outcome: "success",
          target: {
            model: "Conversation",
            id: conversationId.toString(),
          },
          correlationId: context.correlationId,
          details: {
            programId: programId.toString(),
            lifecycleReason: resolution.lifecycleReason,
            roomProvisioned,
            desiredMemberships: resolution.memberships.length,
            createdMemberships: lifecycle.created.length,
            updatedRoles: lifecycle.updatedRoles,
            closedMemberships: lifecycle.closed,
            reactivatedMemberships: lifecycle.reactivated,
            ignoredPurchasesMissingStudentRoleId:
              resolution.ignoredPurchases.missingStudentRoleId,
            ignoredPurchasesUnmappedStudentRoleId:
              resolution.ignoredPurchases.unmappedStudentRoleId,
          },
        },
        session,
      );
    }

    return Object.freeze({
      programId: programId.toString(),
      conversationId: conversationId.toString(),
      resolutionState: resolution.state,
      paused: false,
      roomProvisioned,
      roomArchived: false,
      desiredMemberships: resolution.memberships.length,
      createdMemberships: lifecycle.created.length,
      updatedRoles: lifecycle.updatedRoles,
      closedMemberships: lifecycle.closed,
      reactivatedMemberships: lifecycle.reactivated,
      unchangedMemberships: lifecycle.unchanged,
      ignoredPurchasesMissingStudentRoleId:
        resolution.ignoredPurchases.missingStudentRoleId,
      ignoredPurchasesUnmappedStudentRoleId:
        resolution.ignoredPurchases.unmappedStudentRoleId,
      deferredRevocations: 0,
      deferredReactivations: 0,
    });
  }
}

export const programRoomMembershipSyncService =
  new ProgramRoomMembershipSyncService();
