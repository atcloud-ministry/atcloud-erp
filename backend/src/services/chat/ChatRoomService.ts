import mongoose, { type ClientSession, type PipelineStage } from "mongoose";
import type { RuntimeConfigSuccessDTO } from "../../contracts/runtimeConfig";
import type { PublishProgramAnnouncementBody } from "../../contracts/programAnnouncements";
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
  type ProgramChatRoomLinkDataDTO,
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
import Program from "../../models/Program";
import User from "../../models/User";
import {
  programMembershipResolver,
  type ProgramMembershipResolution,
  type ProgramMembershipResolver,
} from "../programs/ProgramMembershipResolver";
import {
  programActorRoomReadResolver,
  type ProgramActorRoomReadResolver,
  type ProgramActorRoomReadCandidate,
} from "../programs/ProgramActorRoomReadResolver";
import {
  programMemberBatchReadResolver,
  type ProgramMemberBatchReadCandidate,
  type ProgramMemberBatchReadResolver,
} from "../programs/ProgramMemberBatchReadResolver";
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
  chatAnnouncementForbidden,
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
  enqueueWebPushChatMessagesBatch,
  enqueueWebPushChatMessage,
  type EnqueueWebPushChatMessageInput,
} from "../push/WebPushChatMessageOutbox";
import { NOTIFICATION_OUTBOX_ENQUEUE_BATCH_MAXIMUM } from "../reliability/NotificationOutboxService";
import {
  programAnnouncementRateLimiter,
  type ProgramAnnouncementRateLimiter,
} from "./ProgramAnnouncementRateLimiter";
import { RoleUtils } from "../../utils/roleUtils";

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

export interface PublishProgramAnnouncementInput
  extends PublishProgramAnnouncementBody {
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
  readonly announcementRateLimiter?: Pick<
    ProgramAnnouncementRateLimiter,
    "assertAllowed"
  >;
  readonly programMembershipResolver?: Pick<
    ProgramMembershipResolver,
    "resolveProgram" | "resolveProgramMember"
  >;
  readonly programActorRoomReadResolver?: Pick<
    ProgramActorRoomReadResolver,
    "resolveEligibleRooms"
  >;
  readonly programMemberBatchReadResolver?: Pick<
    ProgramMemberBatchReadResolver,
    "resolveEligibleMemberships"
  >;
  readonly enqueueMessage?: (
    input: EnqueueChatMessagePersistedInput,
  ) => Promise<unknown>;
  readonly enqueuePushMessage?: (
    input: EnqueueWebPushChatMessageInput,
  ) => Promise<unknown>;
  readonly enqueuePushMessagesBatch?: (
    input: readonly EnqueueWebPushChatMessageInput[],
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
  readonly role?: string;
}

interface ProgramSummary {
  readonly _id: mongoose.Types.ObjectId;
  readonly title?: string;
}

interface DeliveryState {
  readonly roomUnreadCount: number;
  readonly lastReadSequence: number;
  readonly chatUnreadTotal: number;
}

interface BatchDeliveryState extends DeliveryState {
  readonly userId: string;
}

interface DeliveryUnreadRow {
  readonly userId: mongoose.Types.ObjectId;
  readonly conversationId: mongoose.Types.ObjectId;
  readonly role: IConversationMember["role"];
  readonly unreadCount: number;
  readonly kind: IConversation["kind"];
  readonly programId?: mongoose.Types.ObjectId | null;
}

interface DeliveryMemberRow {
  readonly userId: mongoose.Types.ObjectId;
  readonly role: IConversationMember["role"];
  readonly roomUnreadCount: number;
  readonly lastReadSequence: number;
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
  private readonly announcementRateLimiter: Pick<
    ProgramAnnouncementRateLimiter,
    "assertAllowed"
  >;
  private readonly programMembershipResolver: Pick<
    ProgramMembershipResolver,
    "resolveProgram" | "resolveProgramMember"
  >;
  private readonly programActorRoomReadResolver: Pick<
    ProgramActorRoomReadResolver,
    "resolveEligibleRooms"
  >;
  private readonly programMemberBatchReadResolver: Pick<
    ProgramMemberBatchReadResolver,
    "resolveEligibleMemberships"
  >;
  private readonly enqueueMessage: (
    input: EnqueueChatMessagePersistedInput,
  ) => Promise<unknown>;
  private readonly enqueuePushMessage: (
    input: EnqueueWebPushChatMessageInput,
  ) => Promise<unknown>;
  private readonly enqueuePushMessagesBatch: (
    input: readonly EnqueueWebPushChatMessageInput[],
  ) => Promise<unknown>;

  constructor(dependencies: ChatRoomServiceDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.runtime = dependencies.runtime ?? featureControlService;
    this.transactions = dependencies.transactions ?? mongoTransactionService;
    this.idempotency = dependencies.idempotency ?? idempotencyService;
    this.rateLimiter = dependencies.rateLimiter ?? chatSendRateLimiter;
    this.announcementRateLimiter =
      dependencies.announcementRateLimiter ?? programAnnouncementRateLimiter;
    this.programMembershipResolver =
      dependencies.programMembershipResolver ?? programMembershipResolver;
    this.programActorRoomReadResolver =
      dependencies.programActorRoomReadResolver ?? programActorRoomReadResolver;
    this.programMemberBatchReadResolver =
      dependencies.programMemberBatchReadResolver ?? programMemberBatchReadResolver;
    this.enqueueMessage = dependencies.enqueueMessage ?? enqueueChatMessagePersisted;
    this.enqueuePushMessage =
      dependencies.enqueuePushMessage ?? enqueueWebPushChatMessage;
    this.enqueuePushMessagesBatch =
      dependencies.enqueuePushMessagesBatch ?? enqueueWebPushChatMessagesBatch;
  }

  async list(userId: string, query: ChatRoomListQuery): Promise<ChatRoomListDataDTO> {
    const actorId = objectId(userId);
    const now = this.requireNow();
    const writable = await this.runtimeWritable();
    const ineligibleCurrentProgramRoomIds =
      await this.listIneligibleCurrentProgramRoomIds(actorId, now);
    const excludedProgramRoomIds =
      query.view === "current"
        ? ineligibleCurrentProgramRoomIds
        : Object.freeze([]);
    const commonPipeline = this.listPipeline(
      actorId,
      query.view,
      now,
      excludedProgramRoomIds,
    );
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
      chatUnreadTotal: await this.countUnreadForUser(
        actorId,
        now,
        ineligibleCurrentProgramRoomIds,
      ),
    });
  }

  async get(userId: string, conversationId: string): Promise<ChatRoomDataDTO> {
    const actorId = objectId(userId);
    const now = this.requireNow();
    const access = await this.loadAccess(actorId, objectId(conversationId), now);
    await this.assertCanonicalProgramReadAccess(access, actorId, now);
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

  async getProgramRoomLink(
    userId: string,
    programId: string,
  ): Promise<ProgramChatRoomLinkDataDTO> {
    const actorId = objectId(userId);
    const targetProgramId = objectId(programId);
    const now = this.requireNow();
    const conversation = await Conversation.findOne({
      kind: "program",
      programId: targetProgramId,
      ...retainedFilter(now),
    }).exec();
    if (!conversation) throw chatRoomNotFound();
    const member = await ConversationMember.findOne({
      conversationId: conversation._id,
      userId: actorId,
      ...retainedFilter(now),
    }).exec();
    if (!member) throw chatRoomNotFound();
    await this.assertCanonicalProgramReadAccess(
      { conversation, member },
      actorId,
      now,
    );

    const canSend =
      (await this.runtimeWritable()) && this.canSend({ conversation, member });
    return Object.freeze({
      room: Object.freeze({
        id: String(conversation._id),
        programId: String(targetProgramId),
        status: conversation.status,
        section:
          conversation.status === "current" && member.status === "active"
            ? "current"
            : "past",
        viewer: Object.freeze({
          status: member.status,
          accessMode: canSend ? "read_write" : "read_only",
        }),
      }),
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
    const access = await this.loadAccess(actorId, roomId, now);
    await this.assertCanonicalProgramReadAccess(access, actorId, now);
    const { member } = access;
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
          const programResolution =
            await this.requireCanonicalProgramMembership(
              transactionAccess,
              actorId,
              occurredAt,
              session,
            );
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
          const canonicalRecipientIds = programResolution
            ? programResolution.memberships
                .filter((membership) => membership.userId !== actorId.toString())
                .map((membership) => new mongoose.Types.ObjectId(membership.userId))
            : null;
          const recipientUserFilter = canonicalRecipientIds
            ? { $in: canonicalRecipientIds }
            : { $ne: actorId };
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
              userId: recipientUserFilter,
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
            userId: recipientUserFilter,
            status: "active",
            ...openWindowFilter,
            ...retainedFilter(occurredAt),
          })
            .select({ userId: 1, _id: 0 })
            .session(session)
            .lean<Array<{ userId: mongoose.Types.ObjectId }>>();
          const pushInputs = pushRecipients.map((recipient) => ({
              conversationId: roomId.toString(),
              messageId: messageId.toString(),
              recipientUserId: recipient.userId.toString(),
              sequence: conversation.lastSequence,
              occurredAt: occurredAt.toISOString(),
              session,
              correlationId: input.correlationId,
            }));
          if (programResolution) {
            for (
              let offset = 0;
              offset < pushInputs.length;
              offset += NOTIFICATION_OUTBOX_ENQUEUE_BATCH_MAXIMUM
            ) {
              await this.enqueuePushMessagesBatch(
                pushInputs.slice(
                  offset,
                  offset + NOTIFICATION_OUTBOX_ENQUEUE_BATCH_MAXIMUM,
                ),
              );
            }
          } else {
            for (const pushInput of pushInputs) {
              await this.enqueuePushMessage(pushInput);
            }
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

  async publishAnnouncement(
    input: PublishProgramAnnouncementInput,
  ): Promise<ChatMessageMutationDataDTO> {
    const actorId = objectId(input.actor.id);
    const roomId = objectId(input.conversationId);
    const now = this.requireNow();
    const access = await this.loadAccess(actorId, roomId, now);
    const announcementPayload = Object.freeze({
      content: input.content,
      safeLink: null,
    });

    const existing = await this.findClientMessage(
      actorId,
      roomId,
      input.clientMessageId,
      now,
    );
    if (existing) {
      return this.replayMessage(
        actorId,
        access.member,
        existing,
        announcementPayload,
        now,
        "announcement",
      );
    }
    const writable = await this.runtimeWritable();

    let execution;
    try {
      execution = await this.idempotency.execute<ChatMutationReceipt>({
        scope: `chat.program.announcement.publish:${roomId.toString()}`,
        actorKey: actorId.toString(),
        key: input.idempotencyKey,
        requestPayload: {
          conversationId: roomId.toString(),
          clientMessageId: input.clientMessageId,
          content: input.content,
        },
        transactionOptions: {
          maxAttempts: 12,
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
            this.assertReplayAllowed(
              transactionAccess.member,
              retry,
              announcementPayload,
              "announcement",
            );
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
            !this.canSend(transactionAccess) ||
            transactionAccess.conversation.kind !== "program"
          ) {
            throw chatRoomReadOnly();
          }
          const resolution = await this.requireCanonicalProgramMembership(
            transactionAccess,
            actorId,
            occurredAt,
            session,
          );
          if (!resolution) throw chatRoomReadOnly();
          const canonicalActor = resolution.memberships.find(
            (membership) => membership.userId === actorId.toString(),
          );
          if (!canonicalActor) throw chatAnnouncementForbidden();

          const sender = await User.findOne({
            _id: actorId,
            isActive: true,
            isVerified: true,
          })
            .select("_id username firstName lastName avatar role")
            .session(session)
            .lean<UserSummary>();
          if (!sender) throw chatRoomNotFound();
          const canPublish =
            canonicalActor.role === "mentor" ||
            canonicalActor.role === "class_representative" ||
            (canonicalActor.role === "mentee" &&
              RoleUtils.isLeaderOrHigher(sender.role ?? ""));
          if (!canPublish) throw chatAnnouncementForbidden();
          await this.announcementRateLimiter.assertAllowed({
            conversationId: roomId.toString(),
            occurredAt,
            session,
          });

          const messageId = new mongoose.Types.ObjectId();
          const purgeAt = chatMessagePurgeAt(occurredAt);
          const conversation = await Conversation.findOneAndUpdate(
            {
              _id: roomId,
              kind: "program",
              programId: new mongoose.Types.ObjectId(resolution.programId),
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
            kind: "announcement",
            content: input.content,
            safeLink: null,
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
          const canonicalRecipientIds = resolution.memberships
            .filter((membership) => membership.userId !== actorId.toString())
            .map((membership) => new mongoose.Types.ObjectId(membership.userId));
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
              userId: { $in: canonicalRecipientIds },
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
              action: "chat.program_announcement_published",
              actor: {
                type: "user",
                id: actorId.toString(),
                role: sender.role ?? input.actor.role,
              },
              source: "http",
              outcome: "success",
              target: { model: "ChatMessage", id: messageId.toString() },
              correlationId: input.correlationId,
              details: {
                conversationId: roomId.toString(),
                programId: resolution.programId,
                sequence: conversation.lastSequence,
                kind: "announcement",
                recipientCount: canonicalRecipientIds.length,
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

          const externalRecipients = await ConversationMember.find({
            conversationId: roomId,
            userId: { $in: canonicalRecipientIds },
            status: "active",
            ...openWindowFilter,
            ...retainedFilter(occurredAt),
          })
            .select({ userId: 1, _id: 0 })
            .session(session)
            .lean<Array<{ userId: mongoose.Types.ObjectId }>>();
          for (
            let offset = 0;
            offset < externalRecipients.length;
            offset += NOTIFICATION_OUTBOX_ENQUEUE_BATCH_MAXIMUM
          ) {
            await this.enqueuePushMessagesBatch(
              externalRecipients
                .slice(
                  offset,
                  offset + NOTIFICATION_OUTBOX_ENQUEUE_BATCH_MAXIMUM,
                )
                .map((recipient) => ({
                  conversationId: roomId.toString(),
                  messageId: messageId.toString(),
                  recipientUserId: recipient.userId.toString(),
                  sequence: conversation.lastSequence,
                  occurredAt: occurredAt.toISOString(),
                  session,
                  correlationId: input.correlationId,
                })),
            );
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
        announcementPayload,
        this.requireNow(),
        "announcement",
      );
    }
    const message = await this.loadRetainedMessageDocument({
      conversationId: execution.response!.conversationId as string,
      messageId: execution.response!.messageId as string,
      sequence: execution.response!.sequence as number,
    });
    if (!message) throw chatMessageSequenceConflict();
    this.assertReplayAllowed(
      access.member,
      message,
      announcementPayload,
      "announcement",
    );
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
      await this.requireCanonicalProgramActorCurrentAccess(
        access,
        actorId,
        now,
        session,
      );
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
      if (
        access.member.status !== "active" &&
        access.member.status !== "history_only"
      ) {
        throw chatRoomReadOnly();
      }
      if (this.canSend(access)) {
        await this.requireCanonicalProgramActorCurrentAccess(
          access,
          actorId,
          now,
          session,
        );
      }
      if (access.member.muted === input.muted) return;
      const updated = await ConversationMember.updateOne(
        {
          _id: access.member._id,
          revision: access.member.revision,
          status: access.member.status,
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
      .select("_id kind programId")
      .lean<{
        _id: mongoose.Types.ObjectId;
        kind: IConversation["kind"];
        programId?: mongoose.Types.ObjectId | null;
      }>()
      .exec();
    if (!conversation) return Object.freeze([]);
    let canonicalProgramUserIds: readonly mongoose.Types.ObjectId[] | null =
      null;
    if (conversation.kind === "program") {
      if (!conversation.programId) return Object.freeze([]);
      const resolution = await this.programMembershipResolver.resolveProgram(
        conversation.programId,
        { now },
      );
      if (
        resolution.state !== "open" ||
        resolution.conversationId !== roomId.toString()
      ) {
        return Object.freeze([]);
      }
      canonicalProgramUserIds = Object.freeze(
        resolution.memberships.map(
          (membership) => new mongoose.Types.ObjectId(membership.userId),
        ),
      );
    }
    const members = await ConversationMember.find({
      conversationId: roomId,
      ...(canonicalProgramUserIds
        ? { userId: { $in: canonicalProgramUserIds } }
        : {}),
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

  /**
   * Resolves Socket recipients and absolute counters in a fixed number of
   * aggregates. Program membership and role are checked again after the
   * counter snapshot; callers can synchronously emit the returned batch with
   * no authorization await between a state decision and its account-room emit.
   */
  async getMemberDeliveryStates(
    conversationId: string,
    userIds: readonly string[],
    sequence: number,
  ): Promise<readonly BatchDeliveryState[]> {
    if (!Number.isSafeInteger(sequence) || sequence < 1 || userIds.length === 0) {
      return Object.freeze([]);
    }
    const roomId = objectId(conversationId);
    const actorIdsByText = new Map<string, mongoose.Types.ObjectId>();
    for (const userId of userIds) {
      const actorId = objectId(userId);
      actorIdsByText.set(actorId.toString(), actorId);
    }
    const actorIds = Array.from(actorIdsByText.values());
    const now = this.requireNow();
    const conversation = await Conversation.findOne({
      _id: roomId,
      status: "current",
      ...retainedFilter(now),
    })
      .select("_id kind programId")
      .lean<{
        readonly _id: mongoose.Types.ObjectId;
        readonly kind: IConversation["kind"];
        readonly programId?: mongoose.Types.ObjectId | null;
      }>()
      .exec();
    if (!conversation) return Object.freeze([]);
    if (conversation.kind === "program" && !conversation.programId) {
      return Object.freeze([]);
    }

    const unreadRows = await ConversationMember.aggregate<DeliveryUnreadRow>([
      {
        $match: {
          userId: { $in: actorIds },
          status: "active",
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
            { $project: { _id: 1, kind: 1, programId: 1 } },
          ],
          as: "currentConversation",
        },
      },
      { $unwind: "$currentConversation" },
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
          userId: 1,
          conversationId: 1,
          role: 1,
          unreadCount: 1,
          kind: "$currentConversation.kind",
          programId: "$currentConversation.programId",
        },
      },
    ]).exec();

    const targetMembersQuery = () =>
      ConversationMember.aggregate<DeliveryMemberRow>([
      {
        $match: {
          conversationId: roomId,
          userId: { $in: actorIds },
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
          userId: 1,
          role: 1,
          roomUnreadCount: "$unreadCount",
          lastReadSequence: 1,
        },
      },
      ]).exec();

    const programCandidates: ProgramMemberBatchReadCandidate[] = [];
    for (const row of unreadRows) {
      if (
        row.kind !== "program" ||
        !row.programId ||
        (row.role !== "mentor" &&
          row.role !== "class_representative" &&
          row.role !== "mentee")
      ) {
        continue;
      }
      programCandidates.push({
        programId: row.programId,
        conversationId: row.conversationId,
        userId: row.userId,
        materializedRole: row.role,
      });
    }
    let targetMembers: readonly DeliveryMemberRow[];
    let eligibleProgramMembers;
    if (conversation.kind === "program") {
      targetMembers = await targetMembersQuery();
      for (const member of targetMembers) {
        if (
          member.role !== "mentor" &&
          member.role !== "class_representative" &&
          member.role !== "mentee"
        ) {
          continue;
        }
        programCandidates.push({
          programId: conversation.programId!,
          conversationId: roomId,
          userId: member.userId,
          materializedRole: member.role,
        });
      }
      // This is deliberately the final awaited authorization operation for a
      // Program delivery. It performs five batch reads regardless of how many
      // Program Rooms or recipients are represented in the unread snapshot.
      eligibleProgramMembers =
        await this.programMemberBatchReadResolver.resolveEligibleMemberships(
          programCandidates,
          { now },
        );
    } else {
      // Resolve other Program Rooms before the target-room membership read.
      // For Alumni Help delivery the target aggregate must remain the final
      // await before the synchronous account-room emit loop.
      eligibleProgramMembers =
        programCandidates.length === 0
          ? Object.freeze([])
          : await this.programMemberBatchReadResolver.resolveEligibleMemberships(
              programCandidates,
              { now },
            );
      targetMembers = await targetMembersQuery();
    }
    const eligibleProgramMemberKeys = new Set(
      eligibleProgramMembers.map(
        (member) =>
          `${member.programId}\u0000${member.conversationId}\u0000${member.userId}\u0000${member.role}`,
      ),
    );

    const canonicalRole = (
      row: Pick<DeliveryUnreadRow, "conversationId" | "kind" | "programId" | "role" | "userId">,
    ): boolean => {
      if (row.kind !== "program") return true;
      const programId = row.programId?.toString();
      if (!programId) return false;
      return eligibleProgramMemberKeys.has(
        `${programId}\u0000${row.conversationId.toString()}\u0000${row.userId.toString()}\u0000${row.role}`,
      );
    };

    const unreadTotals = new Map<string, number>();
    for (const userId of actorIdsByText.keys()) unreadTotals.set(userId, 0);
    for (const row of unreadRows) {
      if (!canonicalRole(row)) continue;
      const userId = row.userId.toString();
      const unreadCount =
        Number.isSafeInteger(row.unreadCount) && row.unreadCount > 0
          ? row.unreadCount
          : 0;
      const total = (unreadTotals.get(userId) ?? 0) + unreadCount;
      unreadTotals.set(
        userId,
        Number.isSafeInteger(total) ? total : Number.MAX_SAFE_INTEGER,
      );
    }

    const targetRowsByUserId = new Map<string, DeliveryMemberRow[]>();
    for (const member of targetMembers) {
      const userId = member.userId.toString();
      const rows = targetRowsByUserId.get(userId) ?? [];
      rows.push(member);
      targetRowsByUserId.set(userId, rows);
    }
    const states: BatchDeliveryState[] = [];
    for (const userId of actorIdsByText.keys()) {
      const rows = targetRowsByUserId.get(userId);
      if (!rows || rows.length !== 1) continue;
      const member = rows[0]!;
      if (
        !canonicalRole({
          conversationId: roomId,
          kind: conversation.kind,
          programId: conversation.programId,
          role: member.role,
          userId: member.userId,
        })
      ) {
        continue;
      }
      states.push(
        Object.freeze({
          userId,
          roomUnreadCount: member.roomUnreadCount,
          lastReadSequence: member.lastReadSequence,
          chatUnreadTotal: unreadTotals.get(userId) ?? 0,
        }),
      );
    }
    return Object.freeze(states);
  }

  async getMemberDeliveryState(
    conversationId: string,
    userId: string,
    sequence: number,
  ): Promise<DeliveryState | null> {
    const [state] = await this.getMemberDeliveryStates(
      conversationId,
      [userId],
      sequence,
    );
    if (!state) return null;
    return Object.freeze({
      roomUnreadCount: state.roomUnreadCount,
      lastReadSequence: state.lastReadSequence,
      chatUnreadTotal: state.chatUnreadTotal,
    });
  }

  /** Narrow final authorization for one recipient-scoped external event. */
  async isActiveRetainedMemberForDelivery(
    conversationId: string,
    userId: string,
    sequence: number,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(sequence) || sequence < 1) return false;
    const roomId = objectId(conversationId);
    const actorId = objectId(userId);
    const now = this.requireNow();
    const conversation = await Conversation.findOne({
      _id: roomId,
      status: "current",
      ...retainedFilter(now),
    })
      .select("_id kind programId")
      .lean<{
        readonly _id: mongoose.Types.ObjectId;
        readonly kind: IConversation["kind"];
        readonly programId?: mongoose.Types.ObjectId | null;
      }>()
      .exec();
    if (!conversation) return false;

    if (conversation.kind !== "program") {
      const activeUser = await User.exists({
        _id: actorId,
        isActive: true,
        isVerified: true,
      }).exec();
      if (!activeUser) return false;
    }
    const member = await ConversationMember.findOne({
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
    })
      .select("role")
      .lean<{ readonly role: IConversationMember["role"] }>()
      .exec();
    if (!member) return false;
    if (conversation.kind === "program") {
      if (!conversation.programId) return false;
      // Canonical resolution is intentionally the final await on this path.
      // A stale materialized member cannot authorize a post-revocation push.
      const resolution =
        await this.programMembershipResolver.resolveProgramMember(
          conversation.programId,
          actorId,
          { now },
        );
      return (
        resolution.state === "open" &&
        resolution.conversationId === roomId.toString() &&
        resolution.membership?.role === member.role
      );
    }
    return true;
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

  private async requireCanonicalProgramActorCurrentAccess(
    access: RoomAccess,
    actorId: mongoose.Types.ObjectId,
    now: Date,
    session: ClientSession,
  ): Promise<void> {
    if (access.conversation.kind !== "program") return;
    const programId = access.conversation.programId;
    if (!programId) throw chatRoomReadOnly();
    let resolution;
    try {
      resolution = await this.programMembershipResolver.resolveProgramMember(
        programId,
        actorId,
        { now, session },
      );
    } catch {
      throw chatRoomReadOnly();
    }
    if (
      resolution.state !== "open" ||
      resolution.conversationId !== access.conversation._id.toString() ||
      !resolution.membership ||
      resolution.membership.role !== access.member.role
    ) {
      throw chatRoomReadOnly();
    }
  }

  private async requireCanonicalProgramMembership(
    access: RoomAccess,
    actorId: mongoose.Types.ObjectId,
    now: Date,
    session: ClientSession,
  ): Promise<ProgramMembershipResolution | null> {
    if (access.conversation.kind !== "program") return null;
    const programId = access.conversation.programId;
    if (!programId) throw chatRoomReadOnly();
    let resolution: ProgramMembershipResolution;
    try {
      resolution = await this.programMembershipResolver.resolveProgram(
        programId,
        { now, session },
      );
    } catch {
      throw chatRoomReadOnly();
    }
    if (
      resolution.state !== "open" ||
      resolution.conversationId !== access.conversation._id.toString() ||
      !resolution.memberships.some(
        (membership) => membership.userId === actorId.toString(),
      )
    ) {
      throw chatRoomReadOnly();
    }
    await this.assertCanonicalProgramProjection(
      access,
      resolution,
      now,
      session,
    );
    return resolution;
  }

  private async assertCanonicalProgramProjection(
    access: RoomAccess,
    resolution: ProgramMembershipResolution,
    now: Date,
    session: ClientSession,
  ): Promise<void> {
    const nextSequence = access.conversation.lastSequence + 1;
    if (!Number.isSafeInteger(nextSequence)) throw chatRoomReadOnly();
    const materialized = await ConversationMember.find({
      conversationId: access.conversation._id,
      status: "active",
      accessWindows: {
        $elemMatch: {
          visibleFromSequence: { $lte: nextSequence },
          visibleThroughSequence: null,
        },
      },
      ...retainedFilter(now),
    })
      .select("userId role")
      .session(session)
      .lean<
        Array<{
          readonly userId: mongoose.Types.ObjectId;
          readonly role: IConversationMember["role"];
        }>
      >();
    if (materialized.length !== resolution.memberships.length) {
      throw chatRoomReadOnly();
    }
    const materializedRoles = new Map(
      materialized.map((member) => [member.userId.toString(), member.role]),
    );
    if (
      resolution.memberships.some(
        (membership) =>
          materializedRoles.get(membership.userId) !== membership.role,
      )
    ) {
      throw chatRoomReadOnly();
    }
  }

  private async assertCanonicalProgramReadAccess(
    access: RoomAccess,
    actorId: mongoose.Types.ObjectId,
    now: Date,
  ): Promise<void> {
    if (
      access.conversation.kind !== "program" ||
      access.conversation.status !== "current" ||
      !memberHasCurrentAccess(access.member)
    ) {
      return;
    }
    const programId = access.conversation.programId;
    if (!programId) throw chatRoomNotFound();
    let resolution;
    try {
      resolution = await this.programMembershipResolver.resolveProgramMember(
        programId,
        actorId,
        { now },
      );
    } catch {
      throw chatRoomNotFound();
    }
    const canonicalActor = resolution.membership;
    if (
      resolution.state !== "open" ||
      resolution.conversationId !== access.conversation._id.toString() ||
      !canonicalActor ||
      canonicalActor.role !== access.member.role
    ) {
      throw chatRoomNotFound();
    }
  }

  private async listIneligibleCurrentProgramRoomIds(
    actorId: mongoose.Types.ObjectId,
    now: Date,
  ): Promise<readonly mongoose.Types.ObjectId[]> {
    const candidates = await ConversationMember.aggregate<ConversationListRow>([
      ...this.listPipeline(actorId, "current", now),
      { $match: { "conversation.kind": "program" } },
      {
        $project: {
          "member._id": 1,
          "member.conversationId": 1,
          "member.userId": 1,
          "member.role": 1,
          "member.status": 1,
          "member.accessWindows": 1,
          "conversation._id": 1,
          "conversation.kind": 1,
          "conversation.status": 1,
          "conversation.programId": 1,
        },
      },
    ]).exec();
    if (candidates.length === 0) return Object.freeze([]);
    const batchCandidates: ProgramActorRoomReadCandidate[] = [];
    const excluded = new Set<string>();
    for (const candidate of candidates) {
      const programId = candidate.conversation.programId;
      const role = candidate.member.role;
      if (
        !programId ||
        (role !== "mentor" &&
          role !== "class_representative" &&
          role !== "mentee")
      ) {
        excluded.add(candidate.conversation._id.toString());
        continue;
      }
      batchCandidates.push(
        Object.freeze({
          programId,
          conversationId: candidate.conversation._id,
          materializedRole: role,
        }),
      );
    }
    const eligible = await this.programActorRoomReadResolver.resolveEligibleRooms(
      actorId,
      batchCandidates,
      { now },
    );
    const eligibleRoomIds = new Set(
      eligible.map((room) => room.conversationId),
    );
    for (const candidate of candidates) {
      const roomId = candidate.conversation._id.toString();
      if (!eligibleRoomIds.has(roomId)) excluded.add(roomId);
    }
    return Object.freeze(
      Array.from(excluded, (roomId) => new mongoose.Types.ObjectId(roomId)),
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
    excludedProgramRoomIds: readonly mongoose.Types.ObjectId[] = [],
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
            ...(excludedProgramRoomIds.length > 0
              ? [
                  {
                    "conversation._id": {
                      $nin: excludedProgramRoomIds,
                    },
                  },
                ]
              : []),
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
    const alumniHelpRoomIds = rows
      .filter(({ conversation }) => conversation.kind === "alumni_help")
      .map(({ conversation }) => conversation._id);
    const programIds = rows.flatMap(({ conversation }) =>
      conversation.kind === "program" && conversation.programId
        ? [conversation.programId]
        : [],
    );
    const [otherMembers, programs, actorSummary] = await Promise.all([
      alumniHelpRoomIds.length > 0
        ? ConversationMember.find({
            conversationId: { $in: alumniHelpRoomIds },
            userId: { $ne: actorId },
            ...retainedFilter(now),
          })
            .select("conversationId userId")
            .lean<
              Array<{
                conversationId: mongoose.Types.ObjectId;
                userId: mongoose.Types.ObjectId;
              }>
            >()
            .exec()
        : Promise.resolve([]),
      programIds.length > 0
        ? Program.find({ _id: { $in: programIds } })
            .select("_id title")
            .lean<ProgramSummary[]>()
            .exec()
        : Promise.resolve([]),
      programIds.length > 0
        ? User.findOne({ _id: actorId, isActive: true, isVerified: true })
            .select("_id role")
            .lean<UserSummary>()
            .exec()
        : Promise.resolve(null),
    ]);
    const users =
      otherMembers.length > 0
        ? await User.find({
            _id: { $in: otherMembers.map((member) => member.userId) },
          })
            .select("_id username firstName lastName avatar")
            .lean<UserSummary[]>()
            .exec()
        : [];
    const usersById = new Map(users.map((user) => [String(user._id), user]));
    const programTitlesById = new Map(
      programs.map((program) => [String(program._id), program.title?.trim()]),
    );
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
        const canAnnounce =
          canSend &&
          room.kind === "program" &&
          (member.role === "mentor" ||
            member.role === "class_representative" ||
            (member.role === "mentee" &&
              RoleUtils.isLeaderOrHigher(actorSummary?.role ?? "")));
        const viewer: ChatRoomViewerDTO = Object.freeze({
          role: member.role,
          status: member.status,
          lastReadSequence: member.lastReadSequence,
          unreadCount: member.status === "active" ? member.unreadCount : 0,
          muted: member.muted,
          accessMode: canSend ? "read_write" : "read_only",
          canSend,
          canAnnounce,
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
              : programTitlesById.get(String(room.programId)) || "Program Room",
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
    expectedKind: IChatMessage["kind"] = "text",
  ): void {
    if (
      !isSequenceVisibleInAccessWindows(message.sequence, member.accessWindows)
    ) {
      throw chatRoomNotFound();
    }
    if (message.kind !== expectedKind || !payloadsEqual(message, input)) {
      throw chatMessageIdempotencyConflict();
    }
  }

  private async replayMessage(
    actorId: mongoose.Types.ObjectId,
    member: IConversationMember,
    message: IChatMessage,
    input: Pick<SendChatMessageInput, "content" | "safeLink">,
    now: Date,
    expectedKind: IChatMessage["kind"] = "text",
  ): Promise<ChatMessageMutationDataDTO> {
    this.assertReplayAllowed(member, message, input, expectedKind);
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
    ineligibleProgramRoomIds?: readonly mongoose.Types.ObjectId[],
  ): Promise<number> {
    const ineligibleCurrentProgramRoomIds =
      ineligibleProgramRoomIds ??
      (await this.listIneligibleCurrentProgramRoomIds(actorId, now));
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
          ...(ineligibleCurrentProgramRoomIds.length > 0
            ? {
                "conversation._id": {
                  $nin: ineligibleCurrentProgramRoomIds,
                },
              }
            : {}),
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
