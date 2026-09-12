import mongoose, { type ClientSession, type Model } from "mongoose";
import { hasOpenAccessWindow } from "../../contracts/chatRooms";
import ChatMessage, { type IChatMessage } from "../../models/ChatMessage";
import Conversation, { type IConversation } from "../../models/Conversation";
import ConversationMember, {
  type IConversationMember,
} from "../../models/ConversationMember";
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

// Capacity baseline: 5,000 two-member Help Rooms produce 10,000 member
// counters. The hourly bounded worker can therefore complete a full repair
// sweep within 20 hours while keeping Atlas Flex load predictable.
export const CHAT_UNREAD_RECONCILIATION_CAPACITY = Object.freeze({
  baselineActiveMembers: 10_000,
  defaultLimit: 500,
  maximumLimit: 500,
  cadenceMs: 60 * 60_000,
  baselineMaximumSweepHours: 20,
});
const DEFAULT_LIMIT = CHAT_UNREAD_RECONCILIATION_CAPACITY.defaultLimit;
const MAX_LIMIT = CHAT_UNREAD_RECONCILIATION_CAPACITY.maximumLimit;
const DEFAULT_PERIODIC_RECHECK_MS =
  CHAT_UNREAD_RECONCILIATION_CAPACITY.cadenceMs;

export type ChatUnreadReconciliationRunContext = WorkerRunContext<
  typeof WORKER_SERVICE_KEYS.CHAT_UNREAD
>;

export interface ChatUnreadReconciliationResult {
  readonly candidatesScanned: number;
  readonly reconciled: number;
  readonly corrected: number;
  readonly racedOrUnavailable: number;
  readonly hasMore: boolean;
  readonly capacityPerRun: number;
}

interface Candidate {
  readonly _id: mongoose.Types.ObjectId;
}

interface Dependencies {
  readonly now?: () => Date;
  readonly limit?: number;
  readonly periodicRecheckMs?: number;
  readonly memberModel?: Model<IConversationMember>;
  readonly conversationModel?: Model<IConversation>;
  readonly messageModel?: Model<IChatMessage>;
  readonly transactions?: Pick<MongoTransactionService, "run">;
  readonly authorization?: Pick<WorkerAuthorizationService, "assertCapability">;
}

function requirePositiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer from 1 to ${maximum}.`);
  }
  return value;
}

function retainedFilter(now: Date): Readonly<Record<string, unknown>> {
  return {
    $or: [
      { purgeAt: { $exists: false } },
      { purgeAt: null },
      { purgeAt: { $gt: now } },
    ],
  };
}

function sequenceWindowFilter(member: IConversationMember) {
  return {
    $or: member.accessWindows.map((window) => ({
      sequence: {
        $gte: window.visibleFromSequence,
        ...(window.visibleThroughSequence == null
          ? {}
          : { $lte: window.visibleThroughSequence }),
      },
    })),
  };
}

/** Repairs materialized unread counters and rolling-TTL drift in bounded runs. */
export class ChatUnreadReconciliationService {
  private readonly now: () => Date;
  private readonly limit: number;
  private readonly periodicRecheckMs: number;
  private readonly members: Model<IConversationMember>;
  private readonly conversations: Model<IConversation>;
  private readonly messages: Model<IChatMessage>;
  private readonly transactions: Pick<MongoTransactionService, "run">;
  private readonly authorization: Pick<WorkerAuthorizationService, "assertCapability">;
  private inFlight: Promise<ChatUnreadReconciliationResult> | null = null;

  constructor(dependencies: Dependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.limit = requirePositiveInteger(
      dependencies.limit ?? DEFAULT_LIMIT,
      "Chat unread reconciliation limit",
      MAX_LIMIT,
    );
    this.periodicRecheckMs = requirePositiveInteger(
      dependencies.periodicRecheckMs ?? DEFAULT_PERIODIC_RECHECK_MS,
      "Chat unread periodic recheck",
      24 * 60 * 60_000,
    );
    this.members = dependencies.memberModel ?? ConversationMember;
    this.conversations = dependencies.conversationModel ?? Conversation;
    this.messages = dependencies.messageModel ?? ChatMessage;
    this.transactions = dependencies.transactions ?? mongoTransactionService;
    this.authorization = dependencies.authorization ?? workerAuthorizationService;
  }

  async runBounded(
    runContext: ChatUnreadReconciliationRunContext,
  ): Promise<ChatUnreadReconciliationResult> {
    await this.authorization.assertCapability(
      runContext,
      WORKER_CAPABILITIES.CHAT_UNREAD_RECONCILE,
      { resource: { type: "chat_unread", id: "active-members" } },
    );
    if (this.inFlight) return this.inFlight;
    const execution = this.executeBounded();
    this.inFlight = execution;
    void execution.finally(() => {
      if (this.inFlight === execution) this.inFlight = null;
    }).catch(() => undefined);
    return execution;
  }

  async reconcileMember(
    memberId: mongoose.Types.ObjectId,
  ): Promise<{ reconciled: boolean; corrected: boolean }> {
    return this.transactions.run((session) =>
      this.reconcileMemberInTransaction(memberId, session),
    );
  }

  private async executeBounded(): Promise<ChatUnreadReconciliationResult> {
    const now = this.requireNow();
    const staleBefore = new Date(now.getTime() - this.periodicRecheckMs);
    const fetchedCandidates = await this.members.aggregate<Candidate>([
      {
        $match: {
          $and: [
            { status: "active" },
            retainedFilter(now),
            {
              $or: [
                { unreadReconciledAt: { $exists: false } },
                { unreadReconciledAt: null },
                { unreadReconciledAt: { $lte: staleBefore } },
              ],
            },
          ],
        },
      },
      {
        $lookup: {
          from: "conversations",
          localField: "conversationId",
          foreignField: "_id",
          as: "conversation",
        },
      },
      { $unwind: "$conversation" },
      {
        $match: {
          "conversation.status": "current",
          $or: [
            { "conversation.purgeAt": { $exists: false } },
            { "conversation.purgeAt": null },
            { "conversation.purgeAt": { $gt: now } },
          ],
        },
      },
      { $sort: { unreadReconciledAt: 1, _id: 1 } },
      // A single look-ahead row provides a bounded backlog signal without a
      // second count over the collection.
      { $limit: this.limit + 1 },
      { $project: { _id: 1 } },
    ]).exec();
    const hasMore = fetchedCandidates.length > this.limit;
    const candidates = fetchedCandidates.slice(0, this.limit);

    let reconciled = 0;
    let corrected = 0;
    let racedOrUnavailable = 0;
    for (const candidate of candidates) {
      try {
        const result = await this.reconcileMember(candidate._id);
        if (result.reconciled) reconciled += 1;
        if (result.corrected) corrected += 1;
        if (!result.reconciled) racedOrUnavailable += 1;
      } catch {
        racedOrUnavailable += 1;
      }
    }
    return Object.freeze({
      candidatesScanned: candidates.length,
      reconciled,
      corrected,
      racedOrUnavailable,
      hasMore,
      capacityPerRun: this.limit,
    });
  }

  private async reconcileMemberInTransaction(
    memberId: mongoose.Types.ObjectId,
    session: ClientSession,
  ): Promise<{ reconciled: boolean; corrected: boolean }> {
    const now = this.requireNow();
    const member = await this.members.findOne({
      _id: memberId,
      status: "active",
      ...retainedFilter(now),
    }).session(session);
    if (!member || !hasOpenAccessWindow(member.accessWindows)) {
      return { reconciled: false, corrected: false };
    }
    const conversation = await this.conversations.findOne({
      _id: member.conversationId,
      status: "current",
      ...retainedFilter(now),
    }).session(session);
    if (!conversation) return { reconciled: false, corrected: false };

    const unreadCount = await this.messages.countDocuments({
      $and: [
        { conversationId: conversation._id },
        { sequence: { $gt: member.lastReadSequence } },
        { senderId: { $ne: member.userId } },
        { kind: { $in: ["text", "announcement"] } },
        retainedFilter(now),
        sequenceWindowFilter(member),
      ],
    })
      .session(session)
      .exec();
    const corrected = unreadCount !== member.unreadCount;
    const update = await this.members.updateOne(
      {
        _id: member._id,
        revision: member.revision,
        status: "active",
      },
      {
        $set: {
          unreadCount,
          unreadReconciledThroughSequence: conversation.lastSequence,
          unreadReconciledAt: now,
          updatedAt: now,
        },
        $inc: { revision: 1 },
      },
      { session, runValidators: false },
    );
    if (update.modifiedCount !== 1) {
      return { reconciled: false, corrected: false };
    }
    if (corrected) {
      await AuditLogService.recordRequiredInTransaction(
        {
          action: "chat.unread_reconciled",
          actor: {
            type: "worker",
            key: WORKER_SERVICE_KEYS.CHAT_UNREAD,
          },
          source: "worker",
          outcome: "success",
          target: {
            model: "ConversationMember",
            id: member._id.toString(),
          },
          reasonCode: "counter_drift",
          details: {
            conversationId: conversation._id.toString(),
            fromCount: member.unreadCount,
            toCount: unreadCount,
            throughSequence: conversation.lastSequence,
          },
        },
        session,
      );
    }
    return { reconciled: true, corrected };
  }

  private requireNow(): Date {
    const value = this.now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new TypeError("Chat unread reconciliation clock is invalid.");
    }
    return new Date(value);
  }
}

export const chatUnreadReconciliationService =
  new ChatUnreadReconciliationService();
