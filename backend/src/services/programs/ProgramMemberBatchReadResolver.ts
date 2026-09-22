import mongoose, { type ClientSession, type Model } from "mongoose";
import Conversation, { type IConversation } from "../../models/Conversation";
import Program, { type IProgram } from "../../models/Program";
import ProgramCommunitySettings, {
  type IProgramCommunitySettings,
} from "../../models/ProgramCommunitySettings";
import Purchase, { type IPurchase } from "../../models/Purchase";
import User, { type IUser } from "../../models/User";
import type { ProgramRoleSource } from "../../utils/programRoles";
import {
  ProgramMembershipResolver,
  type ProgramConversationMemberRole,
  type ProgramMembershipResolverDataSource,
} from "./ProgramMembershipResolver";

export interface ProgramMemberBatchReadCandidate {
  readonly programId: string | mongoose.Types.ObjectId;
  readonly conversationId: string | mongoose.Types.ObjectId;
  readonly userId: string | mongoose.Types.ObjectId;
  readonly materializedRole: ProgramConversationMemberRole;
}

export interface EligibleProgramMemberRead {
  readonly programId: string;
  readonly conversationId: string;
  readonly userId: string;
  readonly role: ProgramConversationMemberRole;
}

interface BatchSettingsSnapshot {
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

interface BatchProgramSnapshot extends ProgramRoleSource {
  readonly _id: mongoose.Types.ObjectId;
  readonly mentors?: readonly { readonly userId?: unknown }[];
  readonly adminEnrollments?: {
    readonly mentees?: readonly unknown[];
    readonly classReps?: readonly unknown[];
  };
}

interface BatchConversationSnapshot {
  readonly _id: mongoose.Types.ObjectId;
  readonly programId?: mongoose.Types.ObjectId | null;
}

interface BatchPurchaseSnapshot {
  readonly programId?: mongoose.Types.ObjectId | null;
  readonly userId?: mongoose.Types.ObjectId | null;
  readonly studentRoleId?: string | null;
}

export interface ProgramMemberBatchReadDataSource {
  loadEligibleUsers(
    userIds: readonly mongoose.Types.ObjectId[],
    session?: ClientSession,
  ): Promise<readonly mongoose.Types.ObjectId[]>;
  loadSettings(
    programIds: readonly mongoose.Types.ObjectId[],
    session?: ClientSession,
  ): Promise<readonly BatchSettingsSnapshot[]>;
  loadPrograms(
    programIds: readonly mongoose.Types.ObjectId[],
    session?: ClientSession,
  ): Promise<readonly BatchProgramSnapshot[]>;
  loadPrimaryConversations(
    programIds: readonly mongoose.Types.ObjectId[],
    session?: ClientSession,
  ): Promise<readonly BatchConversationSnapshot[]>;
  loadEffectivePurchases(
    programIds: readonly mongoose.Types.ObjectId[],
    userIds: readonly mongoose.Types.ObjectId[],
    session?: ClientSession,
  ): Promise<readonly BatchPurchaseSnapshot[]>;
}

interface MongoProgramMemberBatchReadDataSourceDependencies {
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

export class MongoProgramMemberBatchReadDataSource
  implements ProgramMemberBatchReadDataSource
{
  private readonly users: Model<IUser>;
  private readonly settings: Model<IProgramCommunitySettings>;
  private readonly programs: Model<IProgram>;
  private readonly conversations: Model<IConversation>;
  private readonly purchases: Model<IPurchase>;

  constructor(
    dependencies: MongoProgramMemberBatchReadDataSourceDependencies = {},
  ) {
    this.users = dependencies.userModel ?? User;
    this.settings = dependencies.settingsModel ?? ProgramCommunitySettings;
    this.programs = dependencies.programModel ?? Program;
    this.conversations = dependencies.conversationModel ?? Conversation;
    this.purchases = dependencies.purchaseModel ?? Purchase;
  }

  async loadEligibleUsers(
    userIds: readonly mongoose.Types.ObjectId[],
    session?: ClientSession,
  ): Promise<readonly mongoose.Types.ObjectId[]> {
    const query = this.users
      .find({ _id: { $in: userIds }, isActive: true, isVerified: true })
      .select("_id");
    const rows = await attachSession(query, session)
      .lean<Array<{ readonly _id: mongoose.Types.ObjectId }>>()
      .exec();
    return Object.freeze(rows.map((row) => row._id));
  }

  async loadSettings(
    programIds: readonly mongoose.Types.ObjectId[],
    session?: ClientSession,
  ): Promise<readonly BatchSettingsSnapshot[]> {
    const query = this.settings
      .find({ programId: { $in: programIds } })
      .select(
        "programId enabled opensAt closesAt archivedAt studentRoleMappings",
      );
    return attachSession(query, session)
      .lean<BatchSettingsSnapshot[]>()
      .exec();
  }

  async loadPrograms(
    programIds: readonly mongoose.Types.ObjectId[],
    session?: ClientSession,
  ): Promise<readonly BatchProgramSnapshot[]> {
    const query = this.programs
      .find({ _id: { $in: programIds } })
      .select(
        "mentors.userId adminEnrollments programRoles.teacherRoleName " +
          "programRoles.studentRoles.id programRoles.studentRoles.name " +
          "programRoles.studentRoles.discountEligible " +
          "programRoles.studentRoles.discountAmount " +
          "programRoles.studentRoles.limit programRoles.studentRoles.count " +
          "classRepDiscount classRepLimit classRepCount",
      );
    return attachSession(query, session)
      .lean<BatchProgramSnapshot[]>()
      .exec();
  }

  async loadPrimaryConversations(
    programIds: readonly mongoose.Types.ObjectId[],
    session?: ClientSession,
  ): Promise<readonly BatchConversationSnapshot[]> {
    const query = this.conversations
      .find({ kind: "program", programId: { $in: programIds } })
      .select("_id programId");
    return attachSession(query, session)
      .lean<BatchConversationSnapshot[]>()
      .exec();
  }

  async loadEffectivePurchases(
    programIds: readonly mongoose.Types.ObjectId[],
    userIds: readonly mongoose.Types.ObjectId[],
    session?: ClientSession,
  ): Promise<readonly BatchPurchaseSnapshot[]> {
    const query = this.purchases
      .find({
        purchaseType: "program",
        programId: { $in: programIds },
        userId: { $in: userIds },
        status: "completed",
        unenrolledAt: { $exists: false },
      })
      .select("programId userId studentRoleId");
    return attachSession(query, session)
      .lean<BatchPurchaseSnapshot[]>()
      .exec();
  }
}

interface ProgramMemberBatchReadResolverDependencies {
  readonly dataSource?: ProgramMemberBatchReadDataSource;
  readonly now?: () => Date;
}

interface NormalizedCandidate {
  readonly programId: mongoose.Types.ObjectId;
  readonly programIdText: string;
  readonly conversationId: mongoose.Types.ObjectId;
  readonly conversationIdText: string;
  readonly userId: mongoose.Types.ObjectId;
  readonly userIdText: string;
  readonly materializedRole: ProgramConversationMemberRole;
}

const PROGRAM_ROLES = new Set<unknown>([
  "mentor",
  "class_representative",
  "mentee",
]);

function objectId(
  value: string | mongoose.Types.ObjectId,
  label: string,
): mongoose.Types.ObjectId {
  const text = String(value);
  if (!mongoose.Types.ObjectId.isValid(text)) {
    throw new TypeError(`${label} must be a valid ObjectId.`);
  }
  return new mongoose.Types.ObjectId(text);
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("Program member batch resolution requires a valid time.");
  }
  return new Date(value);
}

function memberKey(programId: string, userId: string): string {
  return `${programId}\u0000${userId}`;
}

function normalizeCandidates(
  input: readonly ProgramMemberBatchReadCandidate[],
): readonly NormalizedCandidate[] {
  const candidates = new Map<string, NormalizedCandidate>();
  const conflicts = new Set<string>();
  for (const candidate of input) {
    if (!PROGRAM_ROLES.has(candidate.materializedRole)) continue;
    const programId = objectId(candidate.programId, "candidate.programId");
    const conversationId = objectId(
      candidate.conversationId,
      "candidate.conversationId",
    );
    const userId = objectId(candidate.userId, "candidate.userId");
    const normalized = Object.freeze({
      programId,
      programIdText: programId.toString(),
      conversationId,
      conversationIdText: conversationId.toString(),
      userId,
      userIdText: userId.toString(),
      materializedRole: candidate.materializedRole,
    });
    const key = memberKey(normalized.programIdText, normalized.userIdText);
    const existing = candidates.get(key);
    if (
      existing &&
      (existing.conversationIdText !== normalized.conversationIdText ||
        existing.materializedRole !== normalized.materializedRole)
    ) {
      conflicts.add(key);
      candidates.delete(key);
      continue;
    }
    if (!existing && !conflicts.has(key)) candidates.set(key, normalized);
  }
  return Object.freeze(Array.from(candidates.values()));
}

function uniqueObjectIds(
  values: readonly mongoose.Types.ObjectId[],
): readonly mongoose.Types.ObjectId[] {
  return Object.freeze(
    Array.from(
      new Map(values.map((value) => [value.toString(), value])).values(),
    ),
  );
}

function keyedRows<T>(
  rows: readonly T[],
  key: (row: T) => unknown,
): ReadonlyMap<string, T> {
  const result = new Map<string, T>();
  const conflicts = new Set<string>();
  for (const row of rows) {
    const raw = String(key(row) ?? "");
    if (!mongoose.Types.ObjectId.isValid(raw)) continue;
    const normalized = new mongoose.Types.ObjectId(raw).toString();
    if (conflicts.has(normalized)) continue;
    if (result.has(normalized)) {
      result.delete(normalized);
      conflicts.add(normalized);
    } else {
      result.set(normalized, row);
    }
  }
  return result;
}

/**
 * Resolves a multi-Program, multi-recipient authorization snapshot with five
 * batch reads. ProgramMembershipResolver remains the single owner of mapping,
 * source-union, account-status, and role-priority semantics.
 */
export class ProgramMemberBatchReadResolver {
  private readonly dataSource: ProgramMemberBatchReadDataSource;
  private readonly now: () => Date;

  constructor(dependencies: ProgramMemberBatchReadResolverDependencies = {}) {
    this.dataSource =
      dependencies.dataSource ?? new MongoProgramMemberBatchReadDataSource();
    this.now = dependencies.now ?? (() => new Date());
  }

  async resolveEligibleMemberships(
    candidatesInput: readonly ProgramMemberBatchReadCandidate[],
    options: { readonly now?: Date; readonly session?: ClientSession } = {},
  ): Promise<readonly EligibleProgramMemberRead[]> {
    const candidates = normalizeCandidates(candidatesInput);
    if (candidates.length === 0) return Object.freeze([]);
    const now = validNow(options.now ?? this.now());
    const programIds = uniqueObjectIds(
      candidates.map((candidate) => candidate.programId),
    );
    const userIds = uniqueObjectIds(
      candidates.map((candidate) => candidate.userId),
    );
    const [eligibleUserRows, settingsRows, programRows, conversationRows, purchases] =
      await Promise.all([
        this.dataSource.loadEligibleUsers(userIds, options.session),
        this.dataSource.loadSettings(programIds, options.session),
        this.dataSource.loadPrograms(programIds, options.session),
        this.dataSource.loadPrimaryConversations(programIds, options.session),
        this.dataSource.loadEffectivePurchases(
          programIds,
          userIds,
          options.session,
        ),
      ]);

    const eligibleUserIds = new Set(
      eligibleUserRows.map((userId) => userId.toString()),
    );
    const settingsByProgram = keyedRows(
      settingsRows,
      (settings) => settings.programId,
    );
    const programsById = keyedRows(programRows, (program) => program._id);
    const conversationsByProgram = keyedRows(
      conversationRows,
      (conversation) => conversation.programId,
    );
    const purchasesByProgram = new Map<string, BatchPurchaseSnapshot[]>();
    for (const purchase of purchases) {
      const rawProgramId = String(purchase.programId ?? "");
      const rawUserId = String(purchase.userId ?? "");
      if (
        !mongoose.Types.ObjectId.isValid(rawProgramId) ||
        !mongoose.Types.ObjectId.isValid(rawUserId)
      ) {
        continue;
      }
      const programId = new mongoose.Types.ObjectId(rawProgramId).toString();
      const userId = new mongoose.Types.ObjectId(rawUserId).toString();
      if (!eligibleUserIds.has(userId)) continue;
      const rows = purchasesByProgram.get(programId) ?? [];
      rows.push(purchase);
      purchasesByProgram.set(programId, rows);
    }

    const snapshotDataSource: ProgramMembershipResolverDataSource = {
      loadSettings: async (programId) =>
        settingsByProgram.get(programId.toString()) ?? null,
      loadPrimaryConversationId: async (programId) =>
        conversationsByProgram.get(programId.toString())?._id.toString() ?? null,
      loadProgram: async (programId) =>
        programsById.get(programId.toString()) ?? null,
      loadEffectiveProgramPurchases: async (programId) =>
        purchasesByProgram.get(programId.toString()) ?? Object.freeze([]),
      loadEligibleUserIds: async (requestedUserIds) =>
        Object.freeze(
          requestedUserIds
            .map((userId) => userId.toString())
            .filter((userId) => eligibleUserIds.has(userId)),
        ),
    };
    const resolver = new ProgramMembershipResolver({
      dataSource: snapshotDataSource,
      now: () => now,
    });
    const resolutions = await Promise.all(
      programIds.map((programId) =>
        resolver.resolveProgram(programId, { now }),
      ),
    );
    const canonicalRoles = new Map<string, ProgramConversationMemberRole>();
    for (const resolution of resolutions) {
      if (resolution.state !== "open" || !resolution.conversationId) continue;
      for (const membership of resolution.memberships) {
        canonicalRoles.set(
          memberKey(resolution.programId, membership.userId),
          membership.role,
        );
      }
    }

    return Object.freeze(
      candidates.flatMap((candidate) => {
        const primaryConversation = conversationsByProgram.get(
          candidate.programIdText,
        );
        const role = canonicalRoles.get(
          memberKey(candidate.programIdText, candidate.userIdText),
        );
        if (
          primaryConversation?._id.toString() !== candidate.conversationIdText ||
          role !== candidate.materializedRole
        ) {
          return [];
        }
        return [
          Object.freeze({
            programId: candidate.programIdText,
            conversationId: candidate.conversationIdText,
            userId: candidate.userIdText,
            role,
          }),
        ];
      }),
    );
  }
}

export const programMemberBatchReadResolver =
  new ProgramMemberBatchReadResolver();
