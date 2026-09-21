import mongoose, { type ClientSession, type Model } from "mongoose";
import Conversation, { type IConversation } from "../../models/Conversation";
import ConversationMember, {
  type IConversationMember,
} from "../../models/ConversationMember";
import Program, { type IProgram } from "../../models/Program";
import Purchase, { type IPurchase } from "../../models/Purchase";
import {
  programRoomMembershipSyncService,
  type ProgramMembershipSyncContext,
  type ProgramMembershipSyncResult,
  type ProgramRoomMembershipSyncService,
} from "./ProgramRoomMembershipSyncService";

export interface ProgramMembershipEventSyncResult {
  readonly programIds: readonly string[];
  readonly results: readonly ProgramMembershipSyncResult[];
}

export interface ProgramMembershipEventSyncDataSource {
  findProgramIdsForUser(
    userId: mongoose.Types.ObjectId,
    session?: ClientSession,
  ): Promise<readonly string[]>;
}

interface MongoProgramMembershipEventSyncDataSourceDependencies {
  readonly programModel?: Model<IProgram>;
  readonly purchaseModel?: Model<IPurchase>;
  readonly conversationModel?: Model<IConversation>;
  readonly memberModel?: Model<IConversationMember>;
}

interface ProgramMembershipEventSyncDependencies {
  readonly dataSource?: ProgramMembershipEventSyncDataSource;
  readonly sync?: Pick<ProgramRoomMembershipSyncService, "reconcileProgram">;
}

function querySession<T extends { session(value: ClientSession | null): T }>(
  query: T,
  session?: ClientSession,
): T {
  return session ? query.session(session) : query;
}

function objectId(value: string | mongoose.Types.ObjectId, label: string) {
  const text = String(value);
  if (!mongoose.Types.ObjectId.isValid(text)) {
    throw new TypeError(`${label} requires a valid ObjectId.`);
  }
  return new mongoose.Types.ObjectId(text);
}

function objectIdText(value: unknown): string | null {
  const candidate =
    value && typeof value === "object" && "_id" in value
      ? (value as { readonly _id?: unknown })._id
      : value;
  const text = String(candidate ?? "");
  return mongoose.Types.ObjectId.isValid(text) ? text.toLowerCase() : null;
}

/** Locates every Program that may need a per-user projection refresh. */
export class MongoProgramMembershipEventSyncDataSource
  implements ProgramMembershipEventSyncDataSource
{
  private readonly programs: Model<IProgram>;
  private readonly purchases: Model<IPurchase>;
  private readonly conversations: Model<IConversation>;
  private readonly members: Model<IConversationMember>;

  constructor(
    dependencies: MongoProgramMembershipEventSyncDataSourceDependencies = {},
  ) {
    this.programs = dependencies.programModel ?? Program;
    this.purchases = dependencies.purchaseModel ?? Purchase;
    this.conversations = dependencies.conversationModel ?? Conversation;
    this.members = dependencies.memberModel ?? ConversationMember;
  }

  async findProgramIdsForUser(
    userId: mongoose.Types.ObjectId,
    session?: ClientSession,
  ): Promise<readonly string[]> {
    const programQuery = this.programs
      .find({
        $or: [
          { "mentors.userId": userId },
          { "adminEnrollments.classReps": userId },
          { "adminEnrollments.mentees": userId },
        ],
      })
      .select("_id");
    const purchaseQuery = this.purchases
      .find({ userId, purchaseType: "program" })
      .select("programId");
    const memberQuery = this.members
      .find({ userId })
      .select("conversationId");
    const [programs, purchases, members] = await Promise.all([
      querySession(programQuery, session)
        .lean<Array<{ readonly _id: mongoose.Types.ObjectId }>>()
        .exec(),
      querySession(purchaseQuery, session)
        .lean<Array<{ readonly programId?: unknown }>>()
        .exec(),
      querySession(memberQuery, session)
        .lean<Array<{ readonly conversationId: mongoose.Types.ObjectId }>>()
        .exec(),
    ]);
    const conversationIds = members.map((member) => member.conversationId);
    const roomQuery = this.conversations
      .find({
        _id: { $in: conversationIds },
        kind: "program",
      })
      .select("programId");
    const rooms =
      conversationIds.length === 0
        ? []
        : await querySession(roomQuery, session)
            .lean<Array<{ readonly programId?: unknown }>>()
            .exec();
    const ids = new Set<string>();
    for (const value of [
      ...programs.map((program) => program._id),
      ...purchases.map((purchase) => purchase.programId),
      ...rooms.map((room) => room.programId),
    ]) {
      const id = objectIdText(value);
      if (id) ids.add(id);
    }
    return Object.freeze(Array.from(ids).sort());
  }
}

/**
 * Awaitable event adapter used by Program, Purchase, and User mutation paths.
 * The event identifies only the reconciliation scope; the resolver reloads
 * canonical database state and never trusts a caller-supplied membership delta.
 */
export class ProgramMembershipEventSyncService {
  private readonly dataSource: ProgramMembershipEventSyncDataSource;
  private readonly sync: Pick<
    ProgramRoomMembershipSyncService,
    "reconcileProgram"
  >;

  constructor(dependencies: ProgramMembershipEventSyncDependencies = {}) {
    this.dataSource =
      dependencies.dataSource ??
      new MongoProgramMembershipEventSyncDataSource();
    this.sync = dependencies.sync ?? programRoomMembershipSyncService;
  }

  async programAssignmentsChanged(
    programId: string | mongoose.Types.ObjectId,
    context: ProgramMembershipSyncContext = {},
  ): Promise<ProgramMembershipSyncResult> {
    return this.sync.reconcileProgram(
      objectId(programId, "Program assignment sync"),
      context,
    );
  }

  async programPurchaseChanged(
    input: {
      readonly purchaseType: "program" | "event" | "membership";
      readonly programId?: string | mongoose.Types.ObjectId | null;
    },
    context: ProgramMembershipSyncContext = {},
  ): Promise<ProgramMembershipEventSyncResult> {
    if (input.purchaseType !== "program" || input.programId == null) {
      return Object.freeze({
        programIds: Object.freeze([]),
        results: Object.freeze([]),
      });
    }
    const programId = objectId(input.programId, "Program purchase sync");
    const result = await this.sync.reconcileProgram(programId, context);
    return Object.freeze({
      programIds: Object.freeze([programId.toString()]),
      results: Object.freeze([result]),
    });
  }

  async communitySettingsChanged(
    programId: string | mongoose.Types.ObjectId,
    context: ProgramMembershipSyncContext = {},
  ): Promise<ProgramMembershipSyncResult> {
    return this.sync.reconcileProgram(
      objectId(programId, "Program community settings sync"),
      context,
    );
  }

  async userEligibilityChanged(
    userIdInput: string | mongoose.Types.ObjectId,
    context: ProgramMembershipSyncContext = {},
  ): Promise<ProgramMembershipEventSyncResult> {
    const userId = objectId(userIdInput, "User eligibility sync");
    const programIds = await this.dataSource.findProgramIdsForUser(userId);
    const attemptedProgramIds: string[] = [];
    const results: ProgramMembershipSyncResult[] = [];
    // Sequential execution bounds pool usage and gives each Program an
    // independent transaction/retry boundary.
    for (const programId of programIds) {
      const result = await this.sync.reconcileProgram(programId, context);
      attemptedProgramIds.push(programId);
      results.push(result);
      if (result.paused) break;
    }
    return Object.freeze({
      programIds: Object.freeze(attemptedProgramIds),
      results: Object.freeze(results),
    });
  }
}

export const programMembershipEventSyncService =
  new ProgramMembershipEventSyncService();
