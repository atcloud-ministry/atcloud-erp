import type { RuntimeConfigSuccessDTO } from "../../contracts/runtimeConfig";
import type { ChatMessageDTO } from "../../contracts/chatRoomFlow";
import { readAlumniNetworkReleaseAvailable } from "../../config/alumniNetworkFeature";
import { featureControlService } from "../runtime/FeatureControlService";
import type {
  NotificationOutboxDeliveryContext,
  NotificationOutboxDeliveryHandler,
} from "../reliability/NotificationOutboxDeliveryRegistry";
import type { ClaimedNotificationOutbox } from "../reliability/NotificationOutboxService";
import {
  DeferredNotificationOutboxDeliveryError,
  PermanentNotificationOutboxDeliveryError,
  RetryableNotificationOutboxDeliveryError,
} from "../reliability/NotificationOutboxWorker";
import {
  CHAT_MESSAGE_PERSISTED_PAYLOAD_VERSION,
  CHAT_MESSAGE_PERSISTED_TOPIC,
  parseChatMessagePersistedPayload,
} from "./ChatMessageOutbox";
import { chatRoomService } from "./ChatRoomService";

interface ChatMessageRuntimeReader {
  getOperationalRuntimeConfig(options?: {
    readonly signal?: AbortSignal;
  }): Promise<RuntimeConfigSuccessDTO>;
}

interface ChatMessageDeliveryService {
  loadRetainedMessageForDelivery(input: {
    readonly conversationId: string;
    readonly messageId: string;
    readonly sequence: number;
  }): Promise<ChatMessageDTO | null>;
  listActiveRetainedMemberUserIds(
    conversationId: string,
    sequence: number,
  ): Promise<readonly string[]>;
  getMemberDeliveryState(
    conversationId: string,
    userId: string,
    sequence: number,
  ): Promise<{
    readonly roomUnreadCount: number;
    readonly lastReadSequence: number;
    readonly chatUnreadTotal: number;
  } | null>;
}

interface ChatMessageSocketPort {
  emitChatMessageToUser(
    userId: string,
    conversationId: string,
    update: { readonly message: ChatMessageDTO },
  ): boolean;
  emitChatUnreadUpdate(
    userId: string,
    update: {
      readonly conversationId: string;
      readonly roomUnreadCount: number;
      readonly chatUnreadTotal: number;
      readonly lastReadSequence: number;
    },
  ): boolean;
}

export interface ChatMessageDeliveryDependencies {
  readonly releaseAvailable?: () => boolean;
  readonly runtimeReader?: ChatMessageRuntimeReader;
  readonly rooms?: ChatMessageDeliveryService;
  readonly socket?: ChatMessageSocketPort;
  readonly socketResolver?: () => Promise<ChatMessageSocketPort>;
}

interface ResolvedChatMessageDelivery {
  readonly conversationId: string;
  readonly message: ChatMessageDTO;
  readonly recipientUserIds: readonly string[];
}

function permanent(code: string): never {
  throw new PermanentNotificationOutboxDeliveryError(code);
}

/**
 * Delivers only content that still exists inside its logical retention window.
 * Recipient IDs are reloaded immediately before each attempt and delivery uses
 * account rooms, so a stale conversation-room subscription is never a data
 * confidentiality boundary.
 */
export class ChatMessageDeliveryHandler
  implements NotificationOutboxDeliveryHandler
{
  readonly topic = CHAT_MESSAGE_PERSISTED_TOPIC;
  readonly payloadVersion = CHAT_MESSAGE_PERSISTED_PAYLOAD_VERSION;

  private readonly releaseAvailable: () => boolean;
  private readonly runtimeReader: ChatMessageRuntimeReader;
  private readonly rooms: ChatMessageDeliveryService;
  private readonly socket?: ChatMessageSocketPort;
  private readonly socketResolver?: () => Promise<ChatMessageSocketPort>;

  constructor(dependencies: ChatMessageDeliveryDependencies = {}) {
    this.releaseAvailable =
      dependencies.releaseAvailable ?? readAlumniNetworkReleaseAvailable;
    this.runtimeReader = dependencies.runtimeReader ?? featureControlService;
    this.rooms = dependencies.rooms ?? chatRoomService;
    this.socket = dependencies.socket;
    this.socketResolver = dependencies.socketResolver;
  }

  async canClaim(signal: AbortSignal): Promise<boolean> {
    return this.isRuntimeReadable(signal);
  }

  async assertCanDeliver(
    event: ClaimedNotificationOutbox,
    context: NotificationOutboxDeliveryContext,
  ): Promise<void> {
    await this.assertRuntimeReadable(context.signal);
    await this.resolveDelivery(event, context.signal);
  }

  async deliver(
    event: ClaimedNotificationOutbox,
    context: NotificationOutboxDeliveryContext,
  ): Promise<void> {
    await this.assertRuntimeReadable(context.signal);
    const delivery = await this.resolveDelivery(event, context.signal);
    context.signal.throwIfAborted();

    // Resolve the potentially lazy SocketService import before the final
    // authorization reads. From the state reads through the emit loop there
    // must be no await that can let a same-process membership revocation commit.
    const socket = await this.resolveSocket();
    context.signal.throwIfAborted();

    let eligibleRecipientFound = false;
    for (const userId of delivery.recipientUserIds) {
      let state;
      try {
        state = await this.rooms.getMemberDeliveryState(
          delivery.conversationId,
          userId,
          delivery.message.sequence,
        );
      } catch {
        throw new RetryableNotificationOutboxDeliveryError(
          "CHAT_MESSAGE_COUNTER_READ_FAILED",
        );
      }
      context.signal.throwIfAborted();
      if (!state) continue;
      eligibleRecipientFound = true;

      // No await is permitted between the final recipient authorization read
      // above and these account-room emits. A later recipient must never hold
      // an already-authorized recipient's content in an in-memory batch.
      if (
        !socket.emitChatMessageToUser(
          userId,
          delivery.conversationId,
          { message: delivery.message },
        )
      ) {
        throw new RetryableNotificationOutboxDeliveryError(
          "CHAT_MESSAGE_SOCKET_EMIT_FAILED",
        );
      }
      if (
        !socket.emitChatUnreadUpdate(userId, {
          conversationId: delivery.conversationId,
          roomUnreadCount: state.roomUnreadCount,
          chatUnreadTotal: state.chatUnreadTotal,
          lastReadSequence: state.lastReadSequence,
        })
      ) {
        throw new RetryableNotificationOutboxDeliveryError(
          "CHAT_UNREAD_SOCKET_EMIT_FAILED",
        );
      }
    }
    if (!eligibleRecipientFound) {
      permanent("CHAT_MESSAGE_RECIPIENT_UNAVAILABLE");
    }
  }

  private async resolveSocket(): Promise<ChatMessageSocketPort> {
    if (this.socket) return this.socket;
    if (this.socketResolver) return this.socketResolver();
    const { socketService } = await import("../infrastructure/SocketService");
    return socketService;
  }

  private async isRuntimeReadable(signal: AbortSignal): Promise<boolean> {
    try {
      signal.throwIfAborted();
      if (!this.releaseAvailable()) return false;
      const config = await this.runtimeReader.getOperationalRuntimeConfig({
        signal,
      });
      signal.throwIfAborted();
      return config.data.alumniNetwork.readable === true;
    } catch {
      return false;
    }
  }

  private async assertRuntimeReadable(signal: AbortSignal): Promise<void> {
    if (!(await this.isRuntimeReadable(signal))) {
      throw new DeferredNotificationOutboxDeliveryError(
        "ALUMNI_NETWORK_NOT_READABLE",
      );
    }
  }

  private async resolveDelivery(
    event: ClaimedNotificationOutbox,
    signal: AbortSignal,
  ): Promise<ResolvedChatMessageDelivery> {
    signal.throwIfAborted();
    const payload = parseChatMessagePersistedPayload(event.payload);
    let message: ChatMessageDTO | null;
    let recipientUserIds: readonly string[];
    try {
      [message, recipientUserIds] = await Promise.all([
        this.rooms.loadRetainedMessageForDelivery(payload),
        this.rooms.listActiveRetainedMemberUserIds(
          payload.conversationId,
          payload.sequence,
        ),
      ]);
    } catch (error) {
      if (error instanceof PermanentNotificationOutboxDeliveryError) {
        throw error;
      }
      throw new RetryableNotificationOutboxDeliveryError(
        "CHAT_MESSAGE_STATE_READ_FAILED",
      );
    }
    signal.throwIfAborted();
    if (!message) permanent("CHAT_MESSAGE_EVENT_STALE");
    if (recipientUserIds.length === 0) {
      permanent("CHAT_MESSAGE_RECIPIENT_UNAVAILABLE");
    }
    return Object.freeze({
      conversationId: payload.conversationId,
      message,
      recipientUserIds: Object.freeze([...new Set(recipientUserIds)]),
    });
  }
}

export const chatMessageDeliveryHandler = new ChatMessageDeliveryHandler();
