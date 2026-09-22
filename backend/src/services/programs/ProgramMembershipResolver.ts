import mongoose, { type ClientSession, type Model } from "mongoose";
import {
  isProgramCommunityOpen,
  type ProgramCommunityMemberRole,
} from "../../contracts/programCommunitySettings";
import Conversation, { type IConversation } from "../../models/Conversation";
import Program, { type IProgram } from "../../models/Program";
import ProgramCommunitySettings, {
  type IProgramCommunitySettings,
} from "../../models/ProgramCommunitySettings";
import Purchase, { type IPurchase } from "../../models/Purchase";
import User, { type IUser } from "../../models/User";
import type { ConversationMemberRole } from "../../contracts/chatRooms";
import {
  normalizeProgramRoles,
  type ProgramRoleSource,
} from "../../utils/programRoles";

export const PROGRAM_MEMBERSHIP_SOURCE_KINDS = [
  "mentor_assignment",
  "admin_class_representative",
  "admin_mentee",
  "program_purchase",
] as const;

export type ProgramMembershipSourceKind =
  (typeof PROGRAM_MEMBERSHIP_SOURCE_KINDS)[number];

export type ProgramConversationMemberRole = Extract<
  ConversationMemberRole,
  "mentor" | "class_representative" | "mentee"
>;

export const PROGRAM_MEMBERSHIP_RESOLUTION_STATES = [
  "open",
  "settings_unavailable",
  "room_unavailable",
  "program_unavailable",
  "role_mapping_invalid",
  "closed",
] as const;

export type ProgramMembershipResolutionState =
  (typeof PROGRAM_MEMBERSHIP_RESOLUTION_STATES)[number];

export const PROGRAM_MEMBERSHIP_LIFECYCLE_ACTIONS = [
  "synchronize",
  "cutoff",
  "archive",
] as const;
export type ProgramMembershipLifecycleAction =
  (typeof PROGRAM_MEMBERSHIP_LIFECYCLE_ACTIONS)[number];

export const PROGRAM_MEMBERSHIP_LIFECYCLE_REASONS = [
  "community_open",
  "room_unavailable",
  "settings_unavailable",
  "program_unavailable",
  "role_mapping_invalid",
  "community_disabled",
  "community_not_yet_open",
  "community_window_invalid",
  "community_closed",
  "community_archived",
] as const;
export type ProgramMembershipLifecycleReason =
  (typeof PROGRAM_MEMBERSHIP_LIFECYCLE_REASONS)[number];

export interface ResolvedProgramMembership {
  readonly userId: string;
  readonly role: ProgramConversationMemberRole;
  readonly sourceKinds: readonly ProgramMembershipSourceKind[];
}

export interface ProgramRoleMappingDiagnostics {
  readonly canonicalRoleCount: number;
  readonly configuredMappingCount: number;
  readonly invalidCanonicalRoleIdCount: number;
  readonly duplicateCanonicalRoleIdCount: number;
  readonly invalidConfiguredMappingCount: number;
  readonly duplicateConfiguredRoleIdCount: number;
  readonly missingMappingCount: number;
  readonly unexpectedMappingCount: number;
}

export interface ProgramMembershipResolution {
  readonly programId: string;
  readonly conversationId: string | null;
  readonly state: ProgramMembershipResolutionState;
  readonly lifecycleAction: ProgramMembershipLifecycleAction;
  readonly lifecycleReason: ProgramMembershipLifecycleReason;
  /** Existing archive clock, or null when the archive transaction must choose now. */
  readonly archiveAt: Date | null;
  readonly memberships: readonly ResolvedProgramMembership[];
  /** Aggregate-only diagnostics: role identifiers are intentionally omitted. */
  readonly roleMappingDiagnostics: ProgramRoleMappingDiagnostics;
  readonly ignoredPurchases: {
    readonly missingStudentRoleId: number;
    readonly unmappedStudentRoleId: number;
  };
}

export interface ProgramMemberResolution {
  readonly programId: string;
  readonly conversationId: string | null;
  readonly state: ProgramMembershipResolutionState;
  readonly membership: ResolvedProgramMembership | null;
}

interface ProgramMembershipSettingsSnapshot {
  readonly enabled: boolean;
  readonly opensAt?: Date | string | null;
  readonly closesAt?: Date | string | null;
  readonly archivedAt?: Date | string | null;
  readonly studentRoleMappings?: readonly {
    readonly studentRoleId: string;
    readonly memberRole: ProgramCommunityMemberRole;
  }[];
}

interface ProgramMembershipProgramSnapshot extends ProgramRoleSource {
  readonly mentors?: readonly { readonly userId?: unknown }[];
  readonly adminEnrollments?: {
    readonly mentees?: readonly unknown[];
    readonly classReps?: readonly unknown[];
  };
}

interface ProgramMembershipPurchaseSnapshot {
  readonly userId?: unknown;
  readonly studentRoleId?: string | null;
}

export interface ProgramMembershipResolverDataSource {
  loadSettings(
    programId: mongoose.Types.ObjectId,
    session?: ClientSession,
  ): Promise<ProgramMembershipSettingsSnapshot | null>;
  loadPrimaryConversationId(
    programId: mongoose.Types.ObjectId,
    session?: ClientSession,
  ): Promise<string | null>;
  loadProgram(
    programId: mongoose.Types.ObjectId,
    session?: ClientSession,
  ): Promise<ProgramMembershipProgramSnapshot | null>;
  loadProgramForUser?(
    programId: mongoose.Types.ObjectId,
    userId: mongoose.Types.ObjectId,
    session?: ClientSession,
  ): Promise<ProgramMembershipProgramSnapshot | null>;
  loadEffectiveProgramPurchases(
    programId: mongoose.Types.ObjectId,
    session?: ClientSession,
  ): Promise<readonly ProgramMembershipPurchaseSnapshot[]>;
  loadEffectiveProgramPurchasesForUser?(
    programId: mongoose.Types.ObjectId,
    userId: mongoose.Types.ObjectId,
    session?: ClientSession,
  ): Promise<readonly ProgramMembershipPurchaseSnapshot[]>;
  loadEligibleUserIds(
    userIds: readonly mongoose.Types.ObjectId[],
    session?: ClientSession,
  ): Promise<readonly string[]>;
}

interface MongoProgramMembershipResolverDataSourceDependencies {
  readonly settingsModel?: Model<IProgramCommunitySettings>;
  readonly conversationModel?: Model<IConversation>;
  readonly programModel?: Model<IProgram>;
  readonly purchaseModel?: Model<IPurchase>;
  readonly userModel?: Model<IUser>;
}

function querySession<T extends { session(value: ClientSession | null): T }>(
  query: T,
  session?: ClientSession,
): T {
  return session ? query.session(session) : query;
}

function objectIdText(value: unknown): string | null {
  const candidate =
    value && typeof value === "object" && "_id" in value
      ? (value as { readonly _id?: unknown })._id
      : value;
  const text = String(candidate ?? "");
  return mongoose.Types.ObjectId.isValid(text) ? text.toLowerCase() : null;
}

function requireProgramId(value: string | mongoose.Types.ObjectId) {
  const text = String(value);
  if (!mongoose.Types.ObjectId.isValid(text)) {
    throw new TypeError("Program membership resolution requires a Program ID.");
  }
  return new mongoose.Types.ObjectId(text);
}

function requireUserId(value: string | mongoose.Types.ObjectId) {
  const text = String(value);
  if (!mongoose.Types.ObjectId.isValid(text)) {
    throw new TypeError("Program member resolution requires a User ID.");
  }
  return new mongoose.Types.ObjectId(text);
}

function requireNow(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("Program membership resolution requires a valid time.");
  }
  return new Date(value);
}

function storedInstant(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : new Date(date);
}

export class MongoProgramMembershipResolverDataSource
  implements ProgramMembershipResolverDataSource
{
  private readonly settings: Model<IProgramCommunitySettings>;
  private readonly conversations: Model<IConversation>;
  private readonly programs: Model<IProgram>;
  private readonly purchases: Model<IPurchase>;
  private readonly users: Model<IUser>;

  constructor(
    dependencies: MongoProgramMembershipResolverDataSourceDependencies = {},
  ) {
    this.settings = dependencies.settingsModel ?? ProgramCommunitySettings;
    this.conversations = dependencies.conversationModel ?? Conversation;
    this.programs = dependencies.programModel ?? Program;
    this.purchases = dependencies.purchaseModel ?? Purchase;
    this.users = dependencies.userModel ?? User;
  }

  async loadSettings(
    programId: mongoose.Types.ObjectId,
    session?: ClientSession,
  ): Promise<ProgramMembershipSettingsSnapshot | null> {
    const query = this.settings
      .findOne({ programId })
      .select("enabled opensAt closesAt archivedAt studentRoleMappings");
    return querySession(query, session)
      .lean<ProgramMembershipSettingsSnapshot>()
      .exec();
  }

  async loadPrimaryConversationId(
    programId: mongoose.Types.ObjectId,
    session?: ClientSession,
  ): Promise<string | null> {
    const query = this.conversations
      .findOne({ kind: "program", programId })
      .select("_id");
    const room = await querySession(query, session)
      .lean<{ readonly _id: mongoose.Types.ObjectId }>()
      .exec();
    return room?._id.toString() ?? null;
  }

  async loadProgram(
    programId: mongoose.Types.ObjectId,
    session?: ClientSession,
  ): Promise<ProgramMembershipProgramSnapshot | null> {
    const query = this.programs
      .findById(programId)
      .select(
        "mentors.userId adminEnrollments programRoles.teacherRoleName " +
          "programRoles.studentRoles.id programRoles.studentRoles.name " +
          "programRoles.studentRoles.discountEligible " +
          "programRoles.studentRoles.discountAmount " +
          "programRoles.studentRoles.limit programRoles.studentRoles.count " +
          "classRepDiscount classRepLimit classRepCount",
      );
    return querySession(query, session)
      .lean<ProgramMembershipProgramSnapshot>()
      .exec();
  }

  async loadProgramForUser(
    programId: mongoose.Types.ObjectId,
    userId: mongoose.Types.ObjectId,
    session?: ClientSession,
  ): Promise<ProgramMembershipProgramSnapshot | null> {
    const aggregate = this.programs.aggregate<ProgramMembershipProgramSnapshot>([
      { $match: { _id: programId } },
      {
        $project: {
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
      { $limit: 1 },
    ]);
    if (session) aggregate.session(session);
    const rows = await aggregate.exec();
    return rows[0] ?? null;
  }

  async loadEffectiveProgramPurchases(
    programId: mongoose.Types.ObjectId,
    session?: ClientSession,
  ): Promise<readonly ProgramMembershipPurchaseSnapshot[]> {
    const query = this.purchases
      .find({
        purchaseType: "program",
        programId,
        status: "completed",
        unenrolledAt: { $exists: false },
      })
      .select("userId studentRoleId");
    return querySession(query, session)
      .lean<ProgramMembershipPurchaseSnapshot[]>()
      .exec();
  }

  async loadEffectiveProgramPurchasesForUser(
    programId: mongoose.Types.ObjectId,
    userId: mongoose.Types.ObjectId,
    session?: ClientSession,
  ): Promise<readonly ProgramMembershipPurchaseSnapshot[]> {
    const query = this.purchases
      .find({
        purchaseType: "program",
        programId,
        userId,
        status: "completed",
        unenrolledAt: { $exists: false },
      })
      .select("userId studentRoleId");
    return querySession(query, session)
      .lean<ProgramMembershipPurchaseSnapshot[]>()
      .exec();
  }

  async loadEligibleUserIds(
    userIds: readonly mongoose.Types.ObjectId[],
    session?: ClientSession,
  ): Promise<readonly string[]> {
    if (userIds.length === 0) return Object.freeze([]);
    const query = this.users
      .find({
        _id: { $in: userIds },
        isActive: true,
        isVerified: true,
      })
      .select("_id");
    const rows = await querySession(query, session)
      .lean<Array<{ readonly _id: mongoose.Types.ObjectId }>>()
      .exec();
    return Object.freeze(rows.map((row) => row._id.toString()));
  }
}

interface ProgramMembershipResolverDependencies {
  readonly dataSource?: ProgramMembershipResolverDataSource;
  readonly now?: () => Date;
}

interface MutableMembership {
  readonly roles: Set<ProgramConversationMemberRole>;
  readonly sources: Set<ProgramMembershipSourceKind>;
}

const ROLE_PRIORITY: Readonly<Record<ProgramConversationMemberRole, number>> =
  Object.freeze({
    mentee: 1,
    class_representative: 2,
    mentor: 3,
  });

const STUDENT_ROLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const VALID_MAPPED_ROLES = new Set<unknown>([
  "mentee",
  "class_representative",
]);

const EMPTY_ROLE_MAPPING_DIAGNOSTICS: ProgramRoleMappingDiagnostics =
  Object.freeze({
    canonicalRoleCount: 0,
    configuredMappingCount: 0,
    invalidCanonicalRoleIdCount: 0,
    duplicateCanonicalRoleIdCount: 0,
    invalidConfiguredMappingCount: 0,
    duplicateConfiguredRoleIdCount: 0,
    missingMappingCount: 0,
    unexpectedMappingCount: 0,
  });

function canonicalRoleId(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !STUDENT_ROLE_ID_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
}

function inspectRoleMappingIntegrity(
  program: ProgramMembershipProgramSnapshot,
  rawMappings: ProgramMembershipSettingsSnapshot["studentRoleMappings"],
): {
  readonly valid: boolean;
  readonly mappings: ReadonlyMap<string, ProgramCommunityMemberRole>;
  readonly diagnostics: ProgramRoleMappingDiagnostics;
} {
  const normalizedRoles = normalizeProgramRoles(program);
  const rawCanonicalIds = normalizedRoles.studentRoles.map((role) => role.id);
  const canonicalIds = new Set<string>();
  let invalidCanonicalRoleIdCount = 0;
  let duplicateCanonicalRoleIdCount = 0;
  for (const rawId of rawCanonicalIds) {
    const id = canonicalRoleId(rawId);
    if (!id) {
      invalidCanonicalRoleIdCount += 1;
      continue;
    }
    if (canonicalIds.has(id)) {
      duplicateCanonicalRoleIdCount += 1;
      continue;
    }
    canonicalIds.add(id);
  }

  const configured = Array.isArray(rawMappings) ? rawMappings : [];
  const mappings = new Map<string, ProgramCommunityMemberRole>();
  let invalidConfiguredMappingCount = 0;
  let duplicateConfiguredRoleIdCount = 0;
  for (const mapping of configured) {
    const id = canonicalRoleId(mapping?.studentRoleId);
    if (!id || !VALID_MAPPED_ROLES.has(mapping?.memberRole)) {
      invalidConfiguredMappingCount += 1;
      continue;
    }
    if (mappings.has(id)) {
      duplicateConfiguredRoleIdCount += 1;
      continue;
    }
    mappings.set(id, mapping.memberRole);
  }

  const missingMappingCount = Array.from(canonicalIds).filter(
    (id) => !mappings.has(id),
  ).length;
  const unexpectedMappingCount = Array.from(mappings).filter(
    ([id]) => !canonicalIds.has(id),
  ).length;
  const diagnostics = Object.freeze({
    canonicalRoleCount: rawCanonicalIds.length,
    configuredMappingCount: configured.length,
    invalidCanonicalRoleIdCount,
    duplicateCanonicalRoleIdCount,
    invalidConfiguredMappingCount,
    duplicateConfiguredRoleIdCount,
    missingMappingCount,
    unexpectedMappingCount,
  });
  return Object.freeze({
    valid:
      invalidCanonicalRoleIdCount === 0 &&
      duplicateCanonicalRoleIdCount === 0 &&
      invalidConfiguredMappingCount === 0 &&
      duplicateConfiguredRoleIdCount === 0 &&
      missingMappingCount === 0 &&
      unexpectedMappingCount === 0 &&
      canonicalIds.size > 0,
    mappings,
    diagnostics,
  });
}

function preferredRole(
  roles: ReadonlySet<ProgramConversationMemberRole>,
): ProgramConversationMemberRole {
  let result: ProgramConversationMemberRole = "mentee";
  for (const role of roles) {
    if (ROLE_PRIORITY[role] > ROLE_PRIORITY[result]) result = role;
  }
  return result;
}

function emptyResolution(
  programId: mongoose.Types.ObjectId,
  state: Exclude<ProgramMembershipResolutionState, "open">,
  lifecycleAction: ProgramMembershipLifecycleAction,
  lifecycleReason: ProgramMembershipLifecycleReason,
  conversationId: string | null = null,
  roleMappingDiagnostics: ProgramRoleMappingDiagnostics =
    EMPTY_ROLE_MAPPING_DIAGNOSTICS,
  archiveAt: Date | null = null,
): ProgramMembershipResolution {
  return Object.freeze({
    programId: programId.toString(),
    conversationId,
    state,
    lifecycleAction,
    lifecycleReason,
    archiveAt: archiveAt ? new Date(archiveAt) : null,
    memberships: Object.freeze([]),
    roleMappingDiagnostics,
    ignoredPurchases: Object.freeze({
      missingStudentRoleId: 0,
      unmappedStudentRoleId: 0,
    }),
  });
}

function programMemberResolution(
  programId: mongoose.Types.ObjectId,
  state: ProgramMembershipResolutionState,
  conversationId: string | null = null,
  membership: ResolvedProgramMembership | null = null,
): ProgramMemberResolution {
  return Object.freeze({
    programId: programId.toString(),
    conversationId,
    state,
    membership,
  });
}

/**
 * Resolves the complete current Program Room membership from canonical source
 * records. Event notifications are hints only; no caller-provided delta is
 * trusted as membership state.
 */
export class ProgramMembershipResolver {
  private readonly dataSource: ProgramMembershipResolverDataSource;
  private readonly now: () => Date;

  constructor(dependencies: ProgramMembershipResolverDependencies = {}) {
    this.dataSource =
      dependencies.dataSource ?? new MongoProgramMembershipResolverDataSource();
    this.now = dependencies.now ?? (() => new Date());
  }

  async resolveProgram(
    programIdInput: string | mongoose.Types.ObjectId,
    options: { readonly now?: Date; readonly session?: ClientSession } = {},
  ): Promise<ProgramMembershipResolution> {
    const programId = requireProgramId(programIdInput);
    const now = requireNow(options.now ?? this.now());
    const settings = await this.dataSource.loadSettings(
      programId,
      options.session,
    );
    if (!settings) {
      const program = await this.dataSource.loadProgram(
        programId,
        options.session,
      );
      return program
        ? emptyResolution(
            programId,
            "settings_unavailable",
            "cutoff",
            "settings_unavailable",
          )
        : emptyResolution(
            programId,
            "program_unavailable",
            "archive",
            "program_unavailable",
          );
    }

    const archivedAt = storedInstant(settings.archivedAt);
    if (settings.archivedAt != null && archivedAt) {
      return emptyResolution(
        programId,
        "closed",
        "archive",
        "community_archived",
        null,
        EMPTY_ROLE_MAPPING_DIAGNOSTICS,
        archivedAt,
      );
    }
    const closesAt = storedInstant(settings.closesAt);
    if (settings.closesAt != null && closesAt && now >= closesAt) {
      return emptyResolution(
        programId,
        "closed",
        "archive",
        "community_closed",
      );
    }
    const program = await this.dataSource.loadProgram(programId, options.session);
    if (!program) {
      return emptyResolution(
        programId,
        "program_unavailable",
        "archive",
        "program_unavailable",
      );
    }
    if (!isProgramCommunityOpen(settings, now)) {
      const opensAt = storedInstant(settings.opensAt);
      const lifecycleReason =
        settings.enabled !== true
          ? "community_disabled"
          : !opensAt || (settings.closesAt != null && !closesAt)
            ? "community_window_invalid"
            : now < opensAt
              ? "community_not_yet_open"
              : "community_closed";
      return emptyResolution(
        programId,
        "closed",
        "cutoff",
        lifecycleReason,
      );
    }
    const mappingIntegrity = inspectRoleMappingIntegrity(
      program,
      settings.studentRoleMappings,
    );
    if (!mappingIntegrity.valid) {
      return emptyResolution(
        programId,
        "role_mapping_invalid",
        "cutoff",
        "role_mapping_invalid",
        null,
        mappingIntegrity.diagnostics,
      );
    }
    const conversationId = objectIdText(
      await this.dataSource.loadPrimaryConversationId(
        programId,
        options.session,
      ),
    );
    if (!conversationId) {
      return emptyResolution(
        programId,
        "room_unavailable",
        "synchronize",
        "room_unavailable",
      );
    }
    const purchases = await this.dataSource.loadEffectiveProgramPurchases(
      programId,
      options.session,
    );

    const mappings = mappingIntegrity.mappings;
    const candidates = new Map<string, MutableMembership>();
    const add = (
      rawUserId: unknown,
      role: ProgramConversationMemberRole,
      source: ProgramMembershipSourceKind,
    ) => {
      const userId = objectIdText(rawUserId);
      if (!userId) return;
      const membership = candidates.get(userId) ?? {
        roles: new Set<ProgramConversationMemberRole>(),
        sources: new Set<ProgramMembershipSourceKind>(),
      };
      membership.roles.add(role);
      membership.sources.add(source);
      candidates.set(userId, membership);
    };

    for (const mentor of program.mentors ?? []) {
      add(mentor.userId, "mentor", "mentor_assignment");
    }
    for (const userId of program.adminEnrollments?.classReps ?? []) {
      add(userId, "class_representative", "admin_class_representative");
    }
    for (const userId of program.adminEnrollments?.mentees ?? []) {
      add(userId, "mentee", "admin_mentee");
    }
    let missingStudentRoleId = 0;
    let unmappedStudentRoleId = 0;
    for (const purchase of purchases) {
      const studentRoleId = purchase.studentRoleId?.trim();
      if (!studentRoleId) {
        missingStudentRoleId += 1;
        continue;
      }
      const role = mappings.get(studentRoleId);
      if (!role) {
        unmappedStudentRoleId += 1;
        continue;
      }
      add(purchase.userId, role, "program_purchase");
    }

    const candidateIds = Array.from(candidates.keys()).map(
      (userId) => new mongoose.Types.ObjectId(userId),
    );
    const eligibleUserIds = new Set(
      await this.dataSource.loadEligibleUserIds(candidateIds, options.session),
    );
    const memberships = Array.from(candidates.entries())
      .filter(([userId]) => eligibleUserIds.has(userId))
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([userId, membership]) =>
        Object.freeze({
          userId,
          role: preferredRole(membership.roles),
          sourceKinds: Object.freeze(
            PROGRAM_MEMBERSHIP_SOURCE_KINDS.filter((source) =>
              membership.sources.has(source),
            ),
          ),
        }),
      );

    return Object.freeze({
      programId: programId.toString(),
      conversationId,
      state: "open",
      lifecycleAction: "synchronize",
      lifecycleReason: "community_open",
      archiveAt: null,
      memberships: Object.freeze(memberships),
      roleMappingDiagnostics: mappingIntegrity.diagnostics,
      ignoredPurchases: Object.freeze({
        missingStudentRoleId,
        unmappedStudentRoleId,
      }),
    });
  }

  /**
   * Resolves one user's current canonical Program membership without loading
   * every Program purchase or every eligible account. This is the final
   * delivery-time check for recipient-scoped notification events.
   */
  async resolveProgramMember(
    programIdInput: string | mongoose.Types.ObjectId,
    userIdInput: string | mongoose.Types.ObjectId,
    options: { readonly now?: Date; readonly session?: ClientSession } = {},
  ): Promise<ProgramMemberResolution> {
    const programId = requireProgramId(programIdInput);
    const userId = requireUserId(userIdInput);
    const userIdText = userId.toString();
    const now = requireNow(options.now ?? this.now());
    const settings = await this.dataSource.loadSettings(
      programId,
      options.session,
    );
    const loadProgram = () =>
      this.dataSource.loadProgramForUser
        ? this.dataSource.loadProgramForUser(
            programId,
            userId,
            options.session,
          )
        : this.dataSource.loadProgram(programId, options.session);
    if (!settings) {
      return programMemberResolution(
        programId,
        (await loadProgram())
          ? "settings_unavailable"
          : "program_unavailable",
      );
    }
    const archivedAt = storedInstant(settings.archivedAt);
    if (settings.archivedAt != null && archivedAt) {
      return programMemberResolution(programId, "closed");
    }
    const closesAt = storedInstant(settings.closesAt);
    if (settings.closesAt != null && closesAt && now >= closesAt) {
      return programMemberResolution(programId, "closed");
    }
    const program = await loadProgram();
    if (!program) {
      return programMemberResolution(programId, "program_unavailable");
    }
    if (!isProgramCommunityOpen(settings, now)) {
      return programMemberResolution(programId, "closed");
    }
    const mappingIntegrity = inspectRoleMappingIntegrity(
      program,
      settings.studentRoleMappings,
    );
    if (!mappingIntegrity.valid) {
      return programMemberResolution(programId, "role_mapping_invalid");
    }
    const conversationId = objectIdText(
      await this.dataSource.loadPrimaryConversationId(
        programId,
        options.session,
      ),
    );
    if (!conversationId) {
      return programMemberResolution(programId, "room_unavailable");
    }

    const candidate: MutableMembership = {
      roles: new Set<ProgramConversationMemberRole>(),
      sources: new Set<ProgramMembershipSourceKind>(),
    };
    const add = (
      rawUserId: unknown,
      role: ProgramConversationMemberRole,
      source: ProgramMembershipSourceKind,
    ) => {
      if (objectIdText(rawUserId) !== userIdText) return;
      candidate.roles.add(role);
      candidate.sources.add(source);
    };
    for (const mentor of program.mentors ?? []) {
      add(mentor.userId, "mentor", "mentor_assignment");
    }
    for (const candidateUserId of program.adminEnrollments?.classReps ?? []) {
      add(
        candidateUserId,
        "class_representative",
        "admin_class_representative",
      );
    }
    for (const candidateUserId of program.adminEnrollments?.mentees ?? []) {
      add(candidateUserId, "mentee", "admin_mentee");
    }
    const purchases = this.dataSource.loadEffectiveProgramPurchasesForUser
      ? await this.dataSource.loadEffectiveProgramPurchasesForUser(
          programId,
          userId,
          options.session,
        )
      : (
          await this.dataSource.loadEffectiveProgramPurchases(
            programId,
            options.session,
          )
        ).filter((purchase) => objectIdText(purchase.userId) === userIdText);
    for (const purchase of purchases) {
      const studentRoleId = purchase.studentRoleId?.trim();
      if (!studentRoleId) continue;
      const role = mappingIntegrity.mappings.get(studentRoleId);
      if (role) add(purchase.userId, role, "program_purchase");
    }
    if (candidate.roles.size === 0) {
      return programMemberResolution(programId, "open", conversationId);
    }
    const eligible = await this.dataSource.loadEligibleUserIds(
      [userId],
      options.session,
    );
    if (!eligible.includes(userIdText)) {
      return programMemberResolution(programId, "open", conversationId);
    }
    return programMemberResolution(
      programId,
      "open",
      conversationId,
      Object.freeze({
        userId: userIdText,
        role: preferredRole(candidate.roles),
        sourceKinds: Object.freeze(
          PROGRAM_MEMBERSHIP_SOURCE_KINDS.filter((source) =>
            candidate.sources.has(source),
          ),
        ),
      }),
    );
  }
}

export const programMembershipResolver = new ProgramMembershipResolver();
