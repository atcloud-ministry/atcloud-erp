import mongoose, { type ClientSession, type PipelineStage } from "mongoose";
import type { RuntimeConfigSuccessDTO } from "../../contracts/runtimeConfig";
import {
  CHAT_HTTP_PAYLOAD_MAX_BYTES,
  ChatRoomPayloadTooLargeError,
  type ChatLastMessageDTO,
  type ChatMessageDTO,
  type ChatMessageHistoryDataDTO,
  type ChatMessageHistoryQuery,
  type ChatMessageMutationDataDTO,
  type ChatRoomDataDTO,
  type ChatRoomListDataDTO,
  type ChatRoomListQuery,
  type ChatRoomMuteDataDTO,
  type ChatRoomReadDataDTO,
  type ChatRoomViewerDTO,
  type ChatUnreadTotalDTO,
  type ConversationDTO,
  type MuteChatRoomBody,
  type ReadChatRoomBody,
  type SendChatMessageBody,
} from "../../contracts/chatRoomFlow";
import {
  chatMessagePurgeAt,
  hasOpenAccessWindow,
  isSequenceVisibleInAccessWindows,
  type ChatSafeLink,
} from "../../contracts/chatRooms";
import ChatMessage, { type IChatMessage } from "../../models/ChatMessage";
import Conversation, { type IConversation } from "../../models/Conversation";
import ConversationMember, {
  type ConversationAccessWindow,
  type IConversationMember,
} from "../../models/ConversationMember";
import User from "../../models/User";
import { AuditLogService } from "../AuditLogService";
import { featureControlService } from "../runtime/FeatureControlService";
import {
  idempotencyService,
  type IdempotencyReplayResponseDto,
  type IdempotencyService,
} from "../reliability/IdempotencyService";
import {
  MongoTransactionRetryExhaustedError,
  mongoTransactionService,
  type MongoTransactionService,
} from "../reliability/MongoTransactionService";
import {
  chatMessageIdempotencyConflict,
  chatMessageSequenceConflict,
  chatReadSequenceInvalid,
  chatRoomNotFound,
  chatRoomReadOnly,
  isChatRoomError,
} from "./ChatRoomErrors";
import {
  enqueueChatMessagePersisted,
  type EnqueueChatMessagePersistedInput,
} from "./ChatMessageOutbox";
import {
  chatSendRateLimiter,
  type ChatSendRateLimiter,
} from "./ChatSendRateLimiter";
import {
  enqueueWebPushChatMessage,
  type EnqueueWebPushChatMessageInput,
} from "../push/WebPushChatMessageOutbox";

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const CHAT_LAST_MESSAGE_PREVIEW_CODE_POINTS = 160;
const MAX_LIST_SKIP = 2_147_483_647;
const MEMBER_MUTATION_CAS_MAX_ATTEMPTS = 5;

export interface ChatActor {
  readonly id: string;
  readonly role: string;
}

export interface SendChatMessageInput extends SendChatMessageBody {
  readonly conversationId: string;
  readonly actor: ChatActor;
  readonly idempotencyKey: string;
  readonly correlationId?: string;
}

export interface UpdateChatReadInput extends ReadChatRoomBody {
  readonly conversationId: string;
  readonly actor: ChatActor;
  readonly correlationId?: string;
}

export interface UpdateChatMuteInput extends MuteChatRoomBody {
  readonly conversationId: string;
  readonly actor: ChatActor;
  readonly correlationId?: string;
}

interface ChatMutationReceipt extends IdempotencyReplayResponseDto {
  readonly conversationId: string;
  readonly messageId: string;
  readonly sequence: number;
}

interface RuntimeReader {
  getOperationalRuntimeConfig(options?: {
    readonly signal?: AbortSignal;
  }): Promise<RuntimeConfigSuccessDTO>;
}

interface ChatRoomServiceDependencies {
  readonly now?: () => Date;
  readonly runtime?: RuntimeReader;
  readonly transactions?: Pick<MongoTransactionService, "run">;
  readonly idempotency?: Pick<IdempotencyService, "execute">;
  readonly rateLimiter?: Pick<ChatSendRateLimiter, "assertAllowed">;
  readonly enqueueMessage?: (
    input: EnqueueChatMessagePersistedInput,
  ) => Promise<unknown>;
  readonly enqueuePushMessage?: (
    input: EnqueueWebPushChatMessageInput,
  ) => Promise<unknown>;
}

interface RoomAccess {
  readonly conversation: IConversation;
  readonly member: IConversationMember;
}

interface ConversationListRow {
  readonly member: IConversationMember;
  readonly conversation: IConversation;
}

interface UserSummary {
  readonly _id: mongoose.Types.ObjectId;
  readonly username?: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly avatar?: string | null;
}

interface DeliveryState {
  readonly roomUnreadCount: number;
  readonly lastReadSequence: number;
  readonly chatUnreadTotal: number;
}

function objectId(value: string): mongoose.Types.ObjectId {
  if (typeof value !== "string" || !OBJECT_ID_PATTERN.test(value)) {
    throw chatRoomNotFound();
  }
  return new mongoose.Types.ObjectId(value);
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("Chat room clock is invalid.");
  }
  return new Date(value);
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

function memberHasCurrentAccess(member: IConversationMember): boolean {
  return (
    member.status === "active" &&
    hasOpenAccessWindow(member.accessWindows ?? [])
  );
}

function safeLink(value: ChatSafeLink | null | undefined): ChatSafeLink | null {
  return value
    ? Object.freeze({ url: String(value.url), label: String(value.label) })
    : null;
}

function participant(
  id: string,
  displayName: string,
  avatar: string | null | undefined,
) {
  return Object.freeze({
    id,
    displayName,
    avatar: avatar ? String(avatar) : null,
  });
}

function displayName(user: UserSummary | null | undefined): string {
  if (!user) return "Community Member";
  const fullName = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim();
  return fullName || user.username?.trim() || "Community Member";
}

function messageDto(message: IChatMessage): ChatMessageDTO {
  return Object.freeze({
    id: String(message._id),
    conversationId: String(message.conversationId),
    sequence: message.sequence,
    sender: participant(
      String(message.senderId),
      message.senderSnapshot.displayName,
      message.senderSnapshot.avatar,
    ),
    clientMessageId: message.clientMessageId,
    kind: message.kind,
    content: message.content ?? null,
    safeLink: safeLink(message.safeLink),
    createdAt: new Date(message.createdAt).toISOString(),
  });
}

function previewContent(value: string | null | undefined): string | null {
  if (!value) return null;
  const codePoints = Array.from(value);
  return codePoints.length <= CHAT_LAST_MESSAGE_PREVIEW_CODE_POINTS
    ? value
    : `${codePoints.slice(0, CHAT_LAST_MESSAGE_PREVIEW_CODE_POINTS).join("")}…`;
}

function lastMessageDto(message: IChatMessage): ChatLastMessageDTO {
  return Object.freeze({
    id: String(message._id),
    sequence: message.sequence,
    kind: message.kind,
    sender: participant(
      String(message.senderId),
      message.senderSnapshot.displayName,
      message.senderSnapshot.avatar,
    ),
    contentPreview: previewContent(message.content),
    safeLink: safeLink(message.safeLink),
    createdAt: new Date(message.createdAt).toISOString(),
  });
}

function payloadsEqual(
  message: IChatMessage,
  input: Pick<SendChatMessageInput, "content" | "safeLink">,
): boolean {
  const existingLink = safeLink(message.safeLink);
  const requestedLink = safeLink(input.safeLink);
  return (
    (message.content ?? null) === input.content &&
    existingLink?.url === requestedLink?.url &&
    existingLink?.label === requestedLink?.label
  );
}

function accessSequenceFilter(
  windows: readonly ConversationAccessWindow[],
): Readonly<Record<string, unknown>> {
  return {
    $or: windows.map((window) => ({
      sequence: {
        $gte: window.visibleFromSequence,
        ...(window.visibleThroughSequence == null
          ? {}
          : { $lte: window.visibleThroughSequence }),
      },
    })),
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === 11000,
  );
}

function assertMessageEnvelopeFits(dto: ChatMessageDTO): void {
  const maximumEnvelope = {
    eventId: "00000000-0000-4000-8000-000000000000",
    conversationId: dto.conversationId,
    message: dto,
    roomUnreadCount: Number.MAX_SAFE_INTEGER,
    chatUnreadTotal: Number.MAX_SAFE_INTEGER,
    timestamp: "2026-09-12T12:00:00.000Z",
  };
  if (
    Buffer.byteLength(JSON.stringify(maximumEnvelope), "utf8") >
    CHAT_HTTP_PAYLOAD_MAX_BYTES
  ) {
    throw new ChatRoomPayloadTooLargeError();
  }
}

export class ChatRoomService {
  private readonly now: () => Date;
  private readonly runtime: RuntimeReader;
  private readonly transactions: Pick<MongoTransactionService, "run">;
  private readonly idempotency: Pick<IdempotencyService, "execute">;
  private readonly rateLimiter: Pick<ChatSendRateLimiter, "assertAllowed">;
  private readonly enqueueMessage: (
    input: EnqueueChatMessagePersistedInput,
  ) => Promise<unknown>;
  private readonly enqueuePushMessage: (
    input: EnqueueWebPushChatMessageInput,
  ) => Promise<unknown>;

  constructor(dependencies: ChatRoomServiceDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.runtime = dependencies.runtime ?? featureControlService;
    this.transactions = dependencies.transactions ?? mongoTransactionService;
    this.idempotency = dependencies.idempotency ?? idempotencyService;
    this.rateLimiter = dependencies.rateLimiter ?? chatSendRateLimiter;
    this.enqueueMessage = dependencies.enqueueMessage ?? enqueueChatMessagePersisted;
    this.enqueuePushMessage =
      dependencies.enqueuePushMessage ?? enqueueWebPushChatMessage;
  }

  async list(userId: string, query: ChatRoomListQuery): Promise<ChatRoomListDataDTO> {
    const actorId = objectId(userId);
    const now = this.requireNow();
    const writable = await this.runtimeWritable();
    const commonPipeline = this.listPipeline(actorId, query.view, now);
    const countResult = await ConversationMember.aggregate<{ total: number }>([
      ...commonPipeline,
      { $count: "total" },
    ]).exec();
    const totalCount = countResult[0]?.total ?? 0;
    const requestedSkip = (query.page - 1) * query.limit;
    const skip = Number.isSafeInteger(requestedSkip) ? requestedSkip : MAX_LIST_SKIP + 1;
    const rows =
      skip >= totalCount || skip > MAX_LIST_SKIP
        ? []
        : await ConversationMember.aggregate<ConversationListRow>([
            ...commonPipeline,
            { $sort: { "member.updatedAt": -1, _id: -1 } },
            { $skip: skip },
            { $limit: query.limit },
          ]).exec();
    const conversations = await this.buildConversationDtos(
      actorId,
      rows,
      writable,
      now,
    );
    return Object.freeze({
      conversations,
      pagination: Object.freeze({
        currentPage: query.page,
        totalPages: totalCount === 0 ? 0 : Math.ceil(totalCount / query.limit),
        totalCount,
        hasNext: skip + rows.length < totalCount,
        hasPrev: query.page > 1 && totalCount > 0,
      }),
      chatUnreadTotal: await this.countUnreadForUser(actorId, now),
    });
  }

  async get(userId: string, conversationId: string): Promise<ChatRoomDataDTO> {
    const actorId = objectId(userId);
    const now = this.requireNow();
    const access = await this.loadAccess(actorId, objectId(conversationId), now);
    const [conversation] = await this.buildConversationDtos(
      actorId,
      [{ conversation: access.conversation, member: access.member }],
      await this.runtimeWritable(),
      now,
    );
    if (!conversation) throw chatRoomNotFound();
    return Object.freeze({
      conversation,
      chatUnreadTotal: await this.countUnreadForUser(actorId, now),
    });
  }

  async history(
    userId: string,
    conversationId: string,
    query: ChatMessageHistoryQuery,
  ): Promise<ChatMessageHistoryDataDTO> {
    const actorId = objectId(userId);
    const roomId = objectId(conversationId);
    const now = this.requireNow();
    const { member } = await this.loadAccess(actorId, roomId, now);
    const clauses: Readonly<Record<string, unknown>>[] = [
      { conversationId: roomId },
      retainedFilter(now),
      accessSequenceFilter(member.accessWindows),
    ];
    const forward = query.afterSequence !== undefined;
    if (query.beforeSequence !== undefined) {
      clauses.push({ sequence: { $lt: query.beforeSequence } });
    } else if (query.afterSequence !== undefined) {
      clauses.push({ sequence: { $gt: query.afterSequence } });
    }
    const fetched = await ChatMessage.find({ $and: clauses })
      .sort({ sequence: forward ? 1 : -1, _id: forward ? 1 : -1 })
      .limit(query.limit + 1)
      .lean<IChatMessage[]>()
      .exec();
    const hasMore = fetched.length > query.limit;
    const selected = fetched.slice(0, query.limit);
    if (!forward) selected.reverse();
    const messages = Object.freeze(selected.map(messageDto));
    const first = messages[0];
    const last = messages[messages.length - 1];
    return Object.freeze({
      conversationId: roomId.toString(),
      messages,
      pagination: Object.freeze({
        limit: query.limit,
        hasMore,
        beforeSequence: query.beforeSequence ?? null,
        afterSequence: query.afterSequence ?? null,
        nextBeforeSequence: !forward && hasMore && first ? first.sequence : null,
        nextAfterSequence: forward && hasMore && last ? last.sequence : null,
      }),
      roomUnreadCount: member.status === "active" ? member.unreadCount : 0,
      chatUnreadTotal: await this.countUnreadForUser(actorId, now),
    });
  }

  async send(input: SendChatMessageInput): Promise<ChatMessageMutationDataDTO> {
    const actorId = objectId(input.actor.id);
    const roomId = objectId(input.conversationId);
    const now = this.requireNow();
    const access = await this.loadAccess(actorId, roomId, now);

    const existing = await this.findClientMessage(
      actorId,
      roomId,
      input.clientMessageId,
      now,
    );
    if (existing) {
      return this.replayMessage(actorId, access.member, existing, input, now);
    }
    const writable = await this.runtimeWritable();

    let execution;
    try {
      execution = await this.idempotency.execute<ChatMutationReceipt>({
        scope: `chat.message.send:${roomId.toString()}`,
        actorKey: actorId.toString(),
        key: input.idempotencyKey,
        requestPayload: {
          conversationId: roomId.toString(),
          clientMessageId: input.clientMessageId,
          content: input.content,
          safeLink: input.safeLink,
        },
        execute: async (session) => {
          const occurredAt = this.requireNow();
          const transactionAccess = await this.loadAccess(
            actorId,
            roomId,
            occurredAt,
            session,
          );

          const retry = await ChatMessage.findOne({
            conversationId: roomId,
            senderId: actorId,
            clientMessageId: input.clientMessageId,
          }).session(session);
          if (retry) {
            this.assertReplayAllowed(transactionAccess.member, retry, input);
            return {
              httpStatus: 201,
              response: {
                conversationId: roomId.toString(),
                messageId: retry._id.toString(),
                sequence: retry.sequence,
              },
              resource: { type: "ChatMessage", id: retry._id.toString() },
            };
          }
          if (
            !writable ||
            !(await this.runtimeWritable()) ||
            !this.canSend(transactionAccess)
          ) {
            throw chatRoomReadOnly();
          }
          this.rateLimiter.assertAllowed({
            userId: actorId.toString(),
            conversationId: roomId.toString(),
            clientMessageId: input.clientMessageId,
          });

          const sender = await User.findOne({
            _id: actorId,
            isActive: true,
            isVerified: true,
          })
            .select("_id username firstName lastName avatar")
            .session(session)
            .lean<UserSummary>();
          if (!sender) throw chatRoomNotFound();
          const messageId = new mongoose.Types.ObjectId();
          const purgeAt = chatMessagePurgeAt(occurredAt);
          const conversation = await Conversation.findOneAndUpdate(
            {
              _id: roomId,
              status: "current",
              lastSequence: { $lt: Number.MAX_SAFE_INTEGER },
              ...retainedFilter(occurredAt),
            },
            {
              $inc: { lastSequence: 1, revision: 1 },
              $set: {
                lastMessageId: messageId,
                latestMessagePurgeAt: purgeAt,
                updatedAt: occurredAt,
              },
            },
            {
              new: true,
              session,
              runValidators: true,
              timestamps: false,
            },
          );
          if (!conversation) throw chatMessageSequenceConflict();

          const message = new ChatMessage({
            _id: messageId,
            conversationId: roomId,
            sequence: conversation.lastSequence,
            senderId: actorId,
            senderSnapshot: {
              displayName: displayName(sender),
              avatar: sender.avatar ?? null,
            },
            clientMessageId: input.clientMessageId,
            kind: "text",
            content: input.content,
            safeLink: input.safeLink,
            createdAt: occurredAt,
            purgeAt,
          });
          await message.validate();
          assertMessageEnvelopeFits(messageDto(message));
          await message.save({ session, validateBeforeSave: false });

          const openWindowFilter = {
            accessWindows: {
              $elemMatch: {
                visibleFromSequence: { $lte: conversation.lastSequence },
                visibleThroughSequence: null,
              },
            },
          };
          const senderUpdate = await ConversationMember.updateOne(
            {
              conversationId: roomId,
              userId: actorId,
              status: "active",
              ...openWindowFilter,
              ...retainedFilter(occurredAt),
            },
            {
              $set: {
                unreadReconciledThroughSequence: conversation.lastSequence,
                updatedAt: occurredAt,
              },
              $inc: { revision: 1 },
            },
            { session, runValidators: false },
          );
          if (senderUpdate.modifiedCount !== 1) throw chatRoomReadOnly();
          await ConversationMember.updateMany(
            {
              conversationId: roomId,
              userId: { $ne: actorId },
              status: "active",
              ...openWindowFilter,
              ...retainedFilter(occurredAt),
            },
            {
              $inc: { unreadCount: 1, revision: 1 },
              $set: {
                unreadReconciledThroughSequence: conversation.lastSequence,
                updatedAt: occurredAt,
              },
            },
            { session, runValidators: false },
          );

          await AuditLogService.recordRequiredInTransaction(
            {
              action: "chat.message_sent",
              actor: {
                type: "user",
                id: actorId.toString(),
                role: input.actor.role,
              },
              source: "http",
              outcome: "success",
              target: { model: "ChatMessage", id: messageId.toString() },
              correlationId: input.correlationId,
              details: {
                conversationId: roomId.toString(),
                sequence: conversation.lastSequence,
                kind: "text",
              },
            },
            session,
          );
          await this.enqueueMessage({
            conversationId: roomId.toString(),
            messageId: messageId.toString(),
            sequence: conversation.lastSequence,
            occurredAt: occurredAt.toISOString(),
            session,
            correlationId: input.correlationId,
          });
          // External delivery is recipient-scoped so one transient endpoint
          // cannot replay an email already sent to another room member.
          const pushRecipients = await ConversationMember.find({
            conversationId: roomId,
            userId: { $ne: actorId },
            status: "active",
            ...openWindowFilter,
            ...retainedFilter(occurredAt),
          })
            .select({ userId: 1, _id: 0 })
            .session(session)
            .lean<Array<{ userId: mongoose.Types.ObjectId }>>();
          for (const recipient of pushRecipients) {
            await this.enqueuePushMessage({
              conversationId: roomId.toString(),
              messageId: messageId.toString(),
              recipientUserId: recipient.userId.toString(),
              sequence: conversation.lastSequence,
              occurredAt: occurredAt.toISOString(),
              session,
              correlationId: input.correlationId,
            });
          }
          return {
            httpStatus: 201,
            response: {
              conversationId: roomId.toString(),
              messageId: messageId.toString(),
              sequence: conversation.lastSequence,
            },
            resource: { type: "ChatMessage", id: messageId.toString() },
          };
        },
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const raced = await this.findClientMessage(
        actorId,
        roomId,
        input.clientMessageId,
        this.requireNow(),
      );
      if (!raced) throw chatMessageSequenceConflict();
      const currentAccess = await this.loadAccess(
        actorId,
        roomId,
        this.requireNow(),
      );
      return this.replayMessage(
        actorId,
        currentAccess.member,
        raced,
        input,
        this.requireNow(),
      );
    }
    const message = await this.loadRetainedMessageDocument({
      conversationId: execution.response!.conversationId as string,
      messageId: execution.response!.messageId as string,
      sequence: execution.response!.sequence as number,
    });
    if (!message) throw chatMessageSequenceConflict();
    this.assertReplayAllowed(access.member, message, input);
    return this.messageMutationResult(actorId, message, this.requireNow());
  }

  async markRead(input: UpdateChatReadInput): Promise<ChatRoomReadDataDTO> {
    const actorId = objectId(input.actor.id);
    const roomId = objectId(input.conversationId);
    if (!(await this.runtimeWritable())) throw chatRoomReadOnly();
    const state = await this.runMemberCasMutation(async (session) => {
      const now = this.requireNow();
      const access = await this.loadAccess(actorId, roomId, now, session);
      if (!this.canSend(access)) throw chatRoomReadOnly();
      if (
        input.throughSequence > access.conversation.lastSequence ||
        (input.throughSequence > access.member.lastReadSequence &&
          !isSequenceVisibleInAccessWindows(
            input.throughSequence,
            access.member.accessWindows,
          ))
      ) {
        throw chatReadSequenceInvalid();
      }
      const lastReadSequence = Math.max(
        access.member.lastReadSequence,
        input.throughSequence,
      );
      const unreadCount = await this.countUnreadForMember(
        access.member,
        access.conversation,
        now,
        lastReadSequence,
        session,
      );
      const updated = await ConversationMember.updateOne(
        {
          _id: access.member._id,
          revision: access.member.revision,
          status: "active",
        },
        {
          $set: {
            lastReadSequence,
            unreadCount,
            unreadReconciledThroughSequence: access.conversation.lastSequence,
            unreadReconciledAt: now,
            updatedAt: now,
          },
          $inc: { revision: 1 },
        },
        { session, runValidators: false },
      );
      if (updated.modifiedCount !== 1) throw chatMessageSequenceConflict();
      if (lastReadSequence !== access.member.lastReadSequence) {
        await AuditLogService.recordRequiredInTransaction(
          {
            action: "chat.room_read",
            actor: {
              type: "user",
              id: actorId.toString(),
              role: input.actor.role,
            },
            source: "http",
            outcome: "success",
            target: { model: "Conversation", id: roomId.toString() },
            correlationId: input.correlationId,
            details: {
              fromSequence: access.member.lastReadSequence,
              toSequence: lastReadSequence,
            },
          },
          session,
        );
      }
      return { lastReadSequence, unreadCount };
    });
    return Object.freeze({
      conversationId: roomId.toString(),
      ...state,
      chatUnreadTotal: await this.countUnreadForUser(
        actorId,
        this.requireNow(),
      ),
    });
  }

  async setMuted(input: UpdateChatMuteInput): Promise<ChatRoomMuteDataDTO> {
    const actorId = objectId(input.actor.id);
    const roomId = objectId(input.conversationId);
    if (!(await this.runtimeWritable())) throw chatRoomReadOnly();
    await this.runMemberCasMutation(async (session) => {
      const now = this.requireNow();
      const access = await this.loadAccess(actorId, roomId, now, session);
      if (!this.canSend(access)) throw chatRoomReadOnly();
      if (access.member.muted === input.muted) return;
      const updated = await ConversationMember.updateOne(
        {
          _id: access.member._id,
          revision: access.member.revision,
          status: "active",
        },
        {
          $set: {
            muted: input.muted,
            mutedAt: input.muted ? now : null,
            updatedAt: now,
          },
          $inc: { revision: 1 },
        },
        { session, runValidators: false },
      );
      if (updated.modifiedCount !== 1) throw chatMessageSequenceConflict();
      await AuditLogService.recordRequiredInTransaction(
        {
          action: input.muted ? "chat.room_muted" : "chat.room_unmuted",
          actor: {
            type: "user",
            id: actorId.toString(),
            role: input.actor.role,
          },
          source: "http",
          outcome: "success",
          target: { model: "Conversation", id: roomId.toString() },
          correlationId: input.correlationId,
        },
        session,
      );
    });
    return Object.freeze({
      conversationId: roomId.toString(),
      muted: input.muted,
      chatUnreadTotal: await this.countUnreadForUser(
        actorId,
        this.requireNow(),
      ),
    });
  }

  async unreadTotal(userId: string): Promise<ChatUnreadTotalDTO> {
    return Object.freeze({
      chatUnreadTotal: await this.countUnreadForUser(
        objectId(userId),
        this.requireNow(),
      ),
    });
  }

  /** Strict retained DTO loader used by the durable Socket delivery handler. */
  async loadRetainedMessageForDelivery(input: {
    readonly conversationId: string;
    readonly messageId: string;
    readonly sequence: number;
  }): Promise<ChatMessageDTO | null> {
    const message = await this.loadRetainedMessageDocument(input);
    return message ? messageDto(message) : null;
  }

  async listActiveRetainedMemberUserIds(
    conversationId: string,
    sequence: number,
  ): Promise<readonly string[]> {
    const roomId = objectId(conversationId);
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      return Object.freeze([]);
    }
    const now = this.requireNow();
    const conversation = await Conversation.findOne({
      _id: roomId,
      status: "current",
      ...retainedFilter(now),
    })
      .select("_id")
      .lean()
      .exec();
    if (!conversation) return Object.freeze([]);
    const members = await ConversationMember.find({
      conversationId: roomId,
      status: "active",
      accessWindows: {
        $elemMatch: {
          visibleFromSequence: { $lte: sequence },
          $or: [
            { visibleThroughSequence: null },
            { visibleThroughSequence: { $gte: sequence } },
          ],
        },
      },
      ...retainedFilter(now),
    })
      .select("userId")
      .lean<Array<{ userId: mongoose.Types.ObjectId }>>()
      .exec();
    const activeUsers = await User.find({
      _id: { $in: members.map((member) => member.userId) },
      isActive: true,
      isVerified: true,
    })
      .select("_id")
      .lean<Array<{ _id: mongoose.Types.ObjectId }>>()
      .exec();
    return Object.freeze(activeUsers.map((user) => user._id.toString()));
  }

  async getMemberDeliveryState(
    conversationId: string,
    userId: string,
    sequence: number,
  ): Promise<DeliveryState | null> {
    if (!Number.isSafeInteger(sequence) || sequence < 1) return null;
    const roomId = objectId(conversationId);
    const actorId = objectId(userId);
    // The total may require a comparatively long aggregate. Calculate it
    // before the final authorization read so a close/deactivation committed
    // during that wait is observed by the last database operation.
    const chatUnreadTotal = await this.getChatUnreadTotal(actorId.toString());
    const now = this.requireNow();
    const states = await ConversationMember.aggregate<{
      roomUnreadCount: number;
      lastReadSequence: number;
    }>([
      {
        $match: {
          conversationId: roomId,
          userId: actorId,
          status: "active",
          accessWindows: {
            $elemMatch: {
              visibleFromSequence: { $lte: sequence },
              $or: [
                { visibleThroughSequence: null },
                { visibleThroughSequence: { $gte: sequence } },
              ],
            },
          },
          ...retainedFilter(now),
        },
      },
      {
        $lookup: {
          from: Conversation.collection.name,
          let: { roomId: "$conversationId" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$_id", "$$roomId"] },
                status: "current",
                ...retainedFilter(now),
              },
            },
            { $project: { _id: 1 } },
          ],
          as: "currentConversation",
        },
      },
      { $match: { "currentConversation.0": { $exists: true } } },
      {
        $lookup: {
          from: User.collection.name,
          let: { memberUserId: "$userId" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$_id", "$$memberUserId"] },
                isActive: true,
                isVerified: true,
              },
            },
            { $project: { _id: 1 } },
          ],
          as: "activeUser",
        },
      },
      { $match: { "activeUser.0": { $exists: true } } },
      {
        $project: {
          _id: 0,
          roomUnreadCount: "$unreadCount",
          lastReadSequence: "$lastReadSequence",
        },
      },
      { $limit: 1 },
    ]).exec();
    const state = states[0];
    if (!state) return null;
    return Object.freeze({
      roomUnreadCount: state.roomUnreadCount,
      lastReadSequence: state.lastReadSequence,
      chatUnreadTotal,
    });
  }

  async getChatUnreadTotal(userId: string): Promise<number> {
    return this.countUnreadForUser(objectId(userId), this.requireNow());
  }

  private requireNow(): Date {
    return validNow(this.now());
  }

  private async runMemberCasMutation<T>(
    operation: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    for (
      let attempt = 1;
      attempt <= MEMBER_MUTATION_CAS_MAX_ATTEMPTS;
      attempt += 1
    ) {
      try {
        return await this.transactions.run((session) => operation(session));
      } catch (error) {
        if (
          attempt === MEMBER_MUTATION_CAS_MAX_ATTEMPTS ||
          (!(error instanceof MongoTransactionRetryExhaustedError) &&
            (!isChatRoomError(error) ||
              error.code !== "CHAT_MESSAGE_SEQUENCE_CONFLICT"))
        ) {
          throw error;
        }
      }
    }
    throw chatMessageSequenceConflict();
  }

  private async runtimeWritable(): Promise<boolean> {
    try {
      const config = await this.runtime.getOperationalRuntimeConfig();
      const feature = config.data.alumniNetwork;
      return feature.mode === "on" && feature.writable === true;
    } catch {
      return false;
    }
  }

  private canSend(access: RoomAccess): boolean {
    return (
      access.conversation.status === "current" &&
      memberHasCurrentAccess(access.member)
    );
  }

  private async loadAccess(
    actorId: mongoose.Types.ObjectId,
    conversationId: mongoose.Types.ObjectId,
    now: Date,
    session?: ClientSession,
  ): Promise<RoomAccess> {
    const [conversation, member] = await Promise.all([
      Conversation.findOne({
        _id: conversationId,
        ...retainedFilter(now),
      }).session(session ?? null),
      ConversationMember.findOne({
        conversationId,
        userId: actorId,
        ...retainedFilter(now),
      }).session(session ?? null),
    ]);
    if (!conversation || !member) throw chatRoomNotFound();
    return { conversation, member };
  }

  private listPipeline(
    actorId: mongoose.Types.ObjectId,
    view: ChatRoomListQuery["view"],
    now: Date,
  ): PipelineStage[] {
    const viewMatch =
      view === "current"
        ? {
            "member.status": "active",
            "conversation.status": "current",
          }
        : {
            $or: [
              { "member.status": "history_only" },
              { "conversation.status": "archived" },
            ],
          };
    return [
      {
        $match: {
          userId: actorId,
          ...retainedFilter(now),
        },
      },
      { $set: { member: "$$ROOT" } },
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
          $and: [
            viewMatch,
            {
              $or: [
                { "conversation.purgeAt": { $exists: false } },
                { "conversation.purgeAt": null },
                { "conversation.purgeAt": { $gt: now } },
              ],
            },
          ],
        },
      },
      { $project: { member: 1, conversation: 1 } },
    ];
  }

  private async buildConversationDtos(
    actorId: mongoose.Types.ObjectId,
    rows: readonly ConversationListRow[],
    writable: boolean,
    now: Date,
  ): Promise<readonly ConversationDTO[]> {
    if (rows.length === 0) return Object.freeze([]);
    const roomIds = rows.map((row) => row.conversation._id);
    const otherMembers = await ConversationMember.find({
      conversationId: { $in: roomIds },
      userId: { $ne: actorId },
      ...retainedFilter(now),
    })
      .select("conversationId userId")
      .lean<Array<{
        conversationId: mongoose.Types.ObjectId;
        userId: mongoose.Types.ObjectId;
      }>>()
      .exec();
    const users = await User.find({
      _id: { $in: otherMembers.map((member) => member.userId) },
    })
      .select("_id username firstName lastName avatar")
      .lean<UserSummary[]>()
      .exec();
    const usersById = new Map(users.map((user) => [String(user._id), user]));
    const otherByRoom = new Map(
      otherMembers.map((member) => [String(member.conversationId), member]),
    );
    const visibilityClauses = rows.map(({ conversation, member }) => ({
      conversationId: conversation._id,
      ...accessSequenceFilter(member.accessWindows),
    }));
    const lastMessages = await ChatMessage.aggregate<{
      _id: mongoose.Types.ObjectId;
      message: IChatMessage;
    }>([
      {
        $match: {
          $and: [retainedFilter(now), { $or: visibilityClauses }],
        },
      },
      { $sort: { conversationId: 1, sequence: -1, _id: -1 } },
      { $group: { _id: "$conversationId", message: { $first: "$$ROOT" } } },
    ]).exec();
    const lastByRoomId = new Map(
      lastMessages.map(({ _id, message }) => [String(_id), message]),
    );

    return Object.freeze(
      rows.map((row) => {
        const room = row.conversation;
        const member = row.member;
        const other =
          room.kind === "alumni_help"
            ? otherByRoom.get(String(room._id))
            : undefined;
        const otherUser = other ? usersById.get(String(other.userId)) : undefined;
        const counterpart = other
          ? participant(
              String(other.userId),
              displayName(otherUser),
              otherUser?.avatar,
            )
          : null;
        const canSend = writable && this.canSend({ conversation: room, member });
        const viewer: ChatRoomViewerDTO = Object.freeze({
          role: member.role,
          status: member.status,
          lastReadSequence: member.lastReadSequence,
          unreadCount: member.status === "active" ? member.unreadCount : 0,
          muted: member.muted,
          accessMode: canSend ? "read_write" : "read_only",
          canSend,
        });
        const lastMessage = lastByRoomId.get(String(room._id));
        return Object.freeze({
          id: String(room._id),
          kind: room.kind,
          status: room.status,
          section:
            room.status === "current" && member.status === "active"
              ? "current"
              : "past",
          title:
            room.kind === "alumni_help"
              ? counterpart?.displayName ?? "Alumni Help Room"
              : "Program Room",
          helpRequestId: room.helpRequestId ? String(room.helpRequestId) : null,
          programId: room.programId ? String(room.programId) : null,
          counterpart,
          lastSequence: lastMessage?.sequence ?? 0,
          lastMessage: lastMessage ? lastMessageDto(lastMessage) : null,
          viewer,
          createdAt: new Date(room.createdAt).toISOString(),
          updatedAt: new Date(member.updatedAt).toISOString(),
          archivedAt: room.archivedAt
            ? new Date(room.archivedAt).toISOString()
            : null,
        });
      }),
    );
  }

  private async findClientMessage(
    actorId: mongoose.Types.ObjectId,
    roomId: mongoose.Types.ObjectId,
    clientMessageId: string,
    now: Date,
  ): Promise<IChatMessage | null> {
    return ChatMessage.findOne({
      conversationId: roomId,
      senderId: actorId,
      clientMessageId,
      ...retainedFilter(now),
    }).exec();
  }

  private async messageMutationResult(
    actorId: mongoose.Types.ObjectId,
    message: IChatMessage,
    now: Date,
  ): Promise<ChatMessageMutationDataDTO> {
    const member = await ConversationMember.findOne({
      conversationId: message.conversationId,
      userId: actorId,
      ...retainedFilter(now),
    })
      .select("status unreadCount")
      .lean<{ status: string; unreadCount: number }>()
      .exec();
    if (!member) throw chatRoomNotFound();
    return Object.freeze({
      message: messageDto(message),
      roomUnreadCount: member.status === "active" ? member.unreadCount : 0,
      chatUnreadTotal: await this.countUnreadForUser(actorId, now),
    });
  }

  private assertReplayAllowed(
    member: IConversationMember,
    message: IChatMessage,
    input: Pick<SendChatMessageInput, "content" | "safeLink">,
  ): void {
    if (
      !isSequenceVisibleInAccessWindows(message.sequence, member.accessWindows)
    ) {
      throw chatRoomNotFound();
    }
    if (!payloadsEqual(message, input)) {
      throw chatMessageIdempotencyConflict();
    }
  }

  private async replayMessage(
    actorId: mongoose.Types.ObjectId,
    member: IConversationMember,
    message: IChatMessage,
    input: Pick<SendChatMessageInput, "content" | "safeLink">,
    now: Date,
  ): Promise<ChatMessageMutationDataDTO> {
    this.assertReplayAllowed(member, message, input);
    return this.messageMutationResult(actorId, message, now);
  }

  private async loadRetainedMessageDocument(input: {
    readonly conversationId: string;
    readonly messageId: string;
    readonly sequence: number;
  }): Promise<IChatMessage | null> {
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) return null;
    let roomId: mongoose.Types.ObjectId;
    let messageId: mongoose.Types.ObjectId;
    try {
      roomId = objectId(input.conversationId);
      messageId = objectId(input.messageId);
    } catch {
      return null;
    }
    const now = this.requireNow();
    return ChatMessage.findOne({
      _id: messageId,
      conversationId: roomId,
      sequence: input.sequence,
      ...retainedFilter(now),
    }).exec();
  }

  private async countUnreadForUser(
    actorId: mongoose.Types.ObjectId,
    now: Date,
  ): Promise<number> {
    const result = await ConversationMember.aggregate<{ total: number }>([
      {
        $match: {
          userId: actorId,
          status: "active",
          unreadCount: { $gt: 0 },
          ...retainedFilter(now),
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
      { $group: { _id: null, total: { $sum: "$unreadCount" } } },
    ]).exec();
    const total = result[0]?.total ?? 0;
    return Number.isSafeInteger(total) && total >= 0 ? total : 0;
  }

  private async countUnreadForMember(
    member: IConversationMember,
    conversation: IConversation,
    now: Date,
    lastReadSequence = member.lastReadSequence,
    session?: ClientSession,
  ): Promise<number> {
    if (member.status !== "active" || conversation.status !== "current") return 0;
    return ChatMessage.countDocuments({
      $and: [
        { conversationId: conversation._id },
        { sequence: { $gt: lastReadSequence } },
        { senderId: { $ne: member.userId } },
        { kind: { $in: ["text", "announcement"] } },
        retainedFilter(now),
        accessSequenceFilter(member.accessWindows),
      ],
    })
      .session(session ?? null)
      .exec();
  }
}

export const chatRoomService = new ChatRoomService();
