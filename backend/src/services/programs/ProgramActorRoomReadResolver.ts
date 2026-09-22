import mongoose, { type ClientSession, type Model } from "mongoose";
import Conversation, { type IConversation } from "../../models/Conversation";
import Program, { type IProgram } from "../../models/Program";
import ProgramCommunitySettings, {
  type IProgramCommunitySettings,
} from "../../models/ProgramCommunitySettings";
import Purchase, { type IPurchase } from "../../models/Purchase";
import User, { type IUser } from "../../models/User";
import {
  ProgramMembershipResolver,
  type ProgramConversationMemberRole,
  type ProgramMembershipResolverDataSource,
} from "./ProgramMembershipResolver";

export interface ProgramActorRoomReadCandidate {
  readonly programId: string | mongoose.Types.ObjectId;
  readonly conversationId: string | mongoose.Types.ObjectId;
  readonly materializedRole: ProgramConversationMemberRole;
}

export interface EligibleProgramActorRoom {
  readonly programId: string;
  readonly conversationId: string;
  readonly role: ProgramConversationMemberRole;
}

interface ProgramActorSettingsSnapshot {
  readonly programId: mongoose.Types.ObjectId;
  readonly enabled: boolean;
  readonly opensAt?: Date | string | null;
  readonly closesAt?: Date | string | null;
  readonly archivedAt?: Date | string | null;
  readonly studentRoleMappings?: readonly {
    readonly studentRoleId: string;
    readonly memberRole: "mentee" | "class_representative";
  }[];
}

interface ProgramActorProgramSnapshot {
  readonly _id: mongoose.Types.ObjectId;
  readonly mentors?: readonly { readonly userId?: unknown }[];
  readonly adminEnrollments?: {
    readonly mentees?: readonly unknown[];
    readonly classReps?: readonly unknown[];
  };
  readonly programRoles?: {
    readonly teacherRoleName?: unknown;
    readonly studentRoles?: readonly {
      readonly id?: unknown;
      readonly name?: unknown;
      readonly discountEligible?: unknown;
      readonly discountAmount?: unknown;
      readonly limit?: unknown;
      readonly count?: unknown;
    }[];
  } | null;
  readonly classRepDiscount?: unknown;
  readonly classRepLimit?: unknown;
  readonly classRepCount?: unknown;
}

interface ProgramActorPurchaseSnapshot {
  readonly programId?: mongoose.Types.ObjectId | null;
  readonly userId?: mongoose.Types.ObjectId | null;
  readonly studentRoleId?: string | null;
}

interface ProgramActorConversationSnapshot {
  readonly _id: mongoose.Types.ObjectId;
  readonly programId?: mongoose.Types.ObjectId | null;
}

export interface ProgramActorRoomReadDataSource {
  loadEligibleActor(
    userId: mongoose.Types.ObjectId,
    session?: ClientSession,
  ): Promise<boolean>;
  loadSettings(
    programIds: readonly mongoose.Types.ObjectId[],
    session?: ClientSession,
  ): Promise<readonly ProgramActorSettingsSnapshot[]>;
  loadProgramsForActor(
    programIds: readonly mongoose.Types.ObjectId[],
    userId: mongoose.Types.ObjectId,
    session?: ClientSession,
  ): Promise<readonly ProgramActorProgramSnapshot[]>;
  loadPrimaryConversations(
    programIds: readonly mongoose.Types.ObjectId[],
    session?: ClientSession,
  ): Promise<readonly ProgramActorConversationSnapshot[]>;
  loadEffectivePurchasesForActor(
    programIds: readonly mongoose.Types.ObjectId[],
    userId: mongoose.Types.ObjectId,
    session?: ClientSession,
  ): Promise<readonly ProgramActorPurchaseSnapshot[]>;
}

interface MongoProgramActorRoomReadDataSourceDependencies {
  readonly userModel?: Model<IUser>;
  readonly settingsModel?: Model<IProgramCommunitySettings>;
  readonly programModel?: Model<IProgram>;
  readonly conversationModel?: Model<IConversation>;
  readonly purchaseModel?: Model<IPurchase>;
}

function attachSession<T extends { session(value: ClientSession): T }>(
  query: T,
  session?: ClientSession,
): T {
  return session ? query.session(session) : query;
}

export class MongoProgramActorRoomReadDataSource
  implements ProgramActorRoomReadDataSource
{
  private readonly users: Model<IUser>;
  private readonly settings: Model<IProgramCommunitySettings>;
  private readonly programs: Model<IProgram>;
  private readonly conversations: Model<IConversation>;
  private readonly purchases: Model<IPurchase>;

  constructor(
    dependencies: MongoProgramActorRoomReadDataSourceDependencies = {},
  ) {
    this.users = dependencies.userModel ?? User;
    this.settings = dependencies.settingsModel ?? ProgramCommunitySettings;
    this.programs = dependencies.programModel ?? Program;
    this.conversations = dependencies.conversationModel ?? Conversation;
    this.purchases = dependencies.purchaseModel ?? Purchase;
  }

  async loadEligibleActor(
    userId: mongoose.Types.ObjectId,
    session?: ClientSession,
  ): Promise<boolean> {
    const query = this.users
      .findOne({ _id: userId, isActive: true, isVerified: true })
      .select("_id");
    const actor = await attachSession(query, session)
      .lean<{ readonly _id: mongoose.Types.ObjectId }>()
      .exec();
    return actor !== null;
  }

  async loadSettings(
    programIds: readonly mongoose.Types.ObjectId[],
    session?: ClientSession,
  ): Promise<readonly ProgramActorSettingsSnapshot[]> {
    const query = this.settings
      .find({ programId: { $in: programIds } })
      .select(
        "programId enabled opensAt closesAt archivedAt studentRoleMappings",
      );
    return attachSession(query, session)
      .lean<ProgramActorSettingsSnapshot[]>()
      .exec();
  }

  async loadProgramsForActor(
    programIds: readonly mongoose.Types.ObjectId[],
    userId: mongoose.Types.ObjectId,
    session?: ClientSession,
  ): Promise<readonly ProgramActorProgramSnapshot[]> {
    const aggregate = this.programs.aggregate<ProgramActorProgramSnapshot>([
      { $match: { _id: { $in: programIds } } },
      {
        $project: {
          _id: 1,
          mentors: {
            $filter: {
              input: { $ifNull: ["$mentors", []] },
              as: "mentor",
              cond: { $eq: ["$$mentor.userId", userId] },
            },
          },
          adminEnrollments: {
            mentees: {
              $filter: {
                input: { $ifNull: ["$adminEnrollments.mentees", []] },
                as: "memberUserId",
                cond: { $eq: ["$$memberUserId", userId] },
              },
            },
            classReps: {
              $filter: {
                input: { $ifNull: ["$adminEnrollments.classReps", []] },
                as: "memberUserId",
                cond: { $eq: ["$$memberUserId", userId] },
              },
            },
          },
          programRoles: 1,
          classRepDiscount: 1,
          classRepLimit: 1,
          classRepCount: 1,
        },
      },
    ]);
    if (session) aggregate.session(session);
    return aggregate.exec();
  }

  async loadPrimaryConversations(
    programIds: readonly mongoose.Types.ObjectId[],
    session?: ClientSession,
  ): Promise<readonly ProgramActorConversationSnapshot[]> {
    const query = this.conversations
      .find({ kind: "program", programId: { $in: programIds } })
      .select("_id programId");
    return attachSession(query, session)
      .lean<ProgramActorConversationSnapshot[]>()
      .exec();
  }

  async loadEffectivePurchasesForActor(
    programIds: readonly mongoose.Types.ObjectId[],
    userId: mongoose.Types.ObjectId,
    session?: ClientSession,
  ): Promise<readonly ProgramActorPurchaseSnapshot[]> {
    const query = this.purchases
      .find({
        purchaseType: "program",
        programId: { $in: programIds },
        userId,
        status: "completed",
        unenrolledAt: { $exists: false },
      })
      .select("programId userId studentRoleId");
    return attachSession(query, session)
      .lean<ProgramActorPurchaseSnapshot[]>()
      .exec();
  }
}

interface ProgramActorRoomReadResolverDependencies {
  readonly dataSource?: ProgramActorRoomReadDataSource;
  readonly now?: () => Date;
}

interface NormalizedCandidate {
  readonly programId: mongoose.Types.ObjectId;
  readonly programIdText: string;
  readonly conversationId: mongoose.Types.ObjectId;
  readonly conversationIdText: string;
  readonly materializedRole: ProgramConversationMemberRole;
}

const PROGRAM_ROLES = new Set<unknown>([
  "mentor",
  "class_representative",
  "mentee",
]);

function objectId(value: string | mongoose.Types.ObjectId, label: string) {
  const text = String(value);
  if (!mongoose.Types.ObjectId.isValid(text)) {
    throw new TypeError(`${label} must be a valid ObjectId.`);
  }
  return new mongoose.Types.ObjectId(text);
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("Program Room read resolution requires a valid time.");
  }
  return new Date(value);
}

function normalizeCandidates(
  candidates: readonly ProgramActorRoomReadCandidate[],
): readonly NormalizedCandidate[] {
  const byProgram = new Map<string, NormalizedCandidate>();
  const conflictedPrograms = new Set<string>();
  for (const candidate of candidates) {
    if (!PROGRAM_ROLES.has(candidate.materializedRole)) continue;
    const programId = objectId(candidate.programId, "candidate.programId");
    const conversationId = objectId(
      candidate.conversationId,
      "candidate.conversationId",
    );
    const normalized = Object.freeze({
      programId,
      programIdText: programId.toString(),
      conversationId,
      conversationIdText: conversationId.toString(),
      materializedRole: candidate.materializedRole,
    });
    const existing = byProgram.get(normalized.programIdText);
    if (
      existing &&
      (existing.conversationIdText !== normalized.conversationIdText ||
        existing.materializedRole !== normalized.materializedRole)
    ) {
      conflictedPrograms.add(normalized.programIdText);
      byProgram.delete(normalized.programIdText);
      continue;
    }
    if (!existing && !conflictedPrograms.has(normalized.programIdText)) {
      byProgram.set(normalized.programIdText, normalized);
    }
  }
  return Object.freeze(Array.from(byProgram.values()));
}

function keyedRows<T>(
  rows: readonly T[],
  key: (row: T) => unknown,
): ReadonlyMap<string, T> {
  const result = new Map<string, T>();
  const conflicts = new Set<string>();
  for (const row of rows) {
    const text = String(key(row) ?? "");
    if (!mongoose.Types.ObjectId.isValid(text) || conflicts.has(text)) continue;
    const canonical = new mongoose.Types.ObjectId(text).toString();
    if (result.has(canonical)) {
      result.delete(canonical);
      conflicts.add(canonical);
    } else {
      result.set(canonical, row);
    }
  }
  return result;
}

export class ProgramActorRoomReadResolver {
  private readonly dataSource: ProgramActorRoomReadDataSource;
  private readonly now: () => Date;

  constructor(dependencies: ProgramActorRoomReadResolverDependencies = {}) {
    this.dataSource =
      dependencies.dataSource ?? new MongoProgramActorRoomReadDataSource();
    this.now = dependencies.now ?? (() => new Date());
  }

  /**
   * Resolves all candidate Rooms with a fixed number of actor-scoped database
   * reads. Canonical role/mapping policy is delegated to the single-user
   * ProgramMembershipResolver over the already-loaded immutable snapshot.
   */
  async resolveEligibleRooms(
    userIdInput: string | mongoose.Types.ObjectId,
    candidatesInput: readonly ProgramActorRoomReadCandidate[],
    options: { readonly now?: Date; readonly session?: ClientSession } = {},
  ): Promise<readonly EligibleProgramActorRoom[]> {
    const userId = objectId(userIdInput, "userId");
    const candidates = normalizeCandidates(candidatesInput);
    if (candidates.length === 0) return Object.freeze([]);
    const now = validNow(options.now ?? this.now());
    if (!(await this.dataSource.loadEligibleActor(userId, options.session))) {
      return Object.freeze([]);
    }

    const programIds = Object.freeze(
      candidates.map((candidate) => candidate.programId),
    );
    const [settingsRows, programRows, conversationRows, purchaseRows] =
      await Promise.all([
        this.dataSource.loadSettings(programIds, options.session),
        this.dataSource.loadProgramsForActor(
          programIds,
          userId,
          options.session,
        ),
        this.dataSource.loadPrimaryConversations(programIds, options.session),
        this.dataSource.loadEffectivePurchasesForActor(
          programIds,
          userId,
          options.session,
        ),
      ]);

    const settingsByProgram = keyedRows(
      settingsRows,
      (settings) => settings.programId,
    );
    const programsById = keyedRows(programRows, (program) => program._id);
    const conversationsByProgram = keyedRows(
      conversationRows,
      (conversation) => conversation.programId,
    );
    const purchasesByProgram = new Map<
      string,
      ProgramActorPurchaseSnapshot[]
    >();
    for (const purchase of purchaseRows) {
      const text = String(purchase.programId ?? "");
      if (!mongoose.Types.ObjectId.isValid(text)) continue;
      const programId = new mongoose.Types.ObjectId(text).toString();
      const rows = purchasesByProgram.get(programId) ?? [];
      rows.push(purchase);
      purchasesByProgram.set(programId, rows);
    }

    const snapshotDataSource: ProgramMembershipResolverDataSource = {
      loadSettings: async (programId) =>
        settingsByProgram.get(programId.toString()) ?? null,
      loadPrimaryConversationId: async (programId) =>
        conversationsByProgram.get(programId.toString())?._id.toString() ??
        null,
      loadProgram: async (programId) =>
        programsById.get(programId.toString()) ?? null,
      loadProgramForUser: async (programId) =>
        programsById.get(programId.toString()) ?? null,
      loadEffectiveProgramPurchases: async (programId) =>
        purchasesByProgram.get(programId.toString()) ?? Object.freeze([]),
      loadEffectiveProgramPurchasesForUser: async (programId) =>
        purchasesByProgram.get(programId.toString()) ?? Object.freeze([]),
      loadEligibleUserIds: async (requestedUserIds) =>
        requestedUserIds.some((candidateId) => candidateId.equals(userId))
          ? Object.freeze([userId.toString()])
          : Object.freeze([]),
    };
    const resolver = new ProgramMembershipResolver({
      dataSource: snapshotDataSource,
      now: () => now,
    });

    const eligible: EligibleProgramActorRoom[] = [];
    for (const candidate of candidates) {
      const resolution = await resolver.resolveProgramMember(
        candidate.programId,
        userId,
        { now },
      );
      if (
        resolution.state !== "open" ||
        resolution.conversationId !== candidate.conversationIdText ||
        resolution.membership?.role !== candidate.materializedRole
      ) {
        continue;
      }
      eligible.push(
        Object.freeze({
          programId: candidate.programIdText,
          conversationId: candidate.conversationIdText,
          role: resolution.membership.role,
        }),
      );
    }
    return Object.freeze(eligible);
  }
}

export const programActorRoomReadResolver =
  new ProgramActorRoomReadResolver();
