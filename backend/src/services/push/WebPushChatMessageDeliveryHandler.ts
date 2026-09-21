import type { ChatMessageDTO } from "../../contracts/chatRoomFlow";
import type { RuntimeConfigSuccessDTO } from "../../contracts/runtimeConfig";
import { readAlumniNetworkReleaseAvailable } from "../../config/alumniNetworkFeature";
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
import { chatRoomService } from "../chat/ChatRoomService";
import { featureControlService } from "../runtime/FeatureControlService";
import {
  parseWebPushChatMessagePayload,
  WEB_PUSH_CHAT_MESSAGE_PAYLOAD_VERSION,
  WEB_PUSH_CHAT_MESSAGE_TOPIC,
} from "./WebPushChatMessageOutbox";
import {
  externalNotificationRouter,
  type ExternalNotificationRouter,
} from "./ExternalNotificationRouter";

interface ChatPushRoomReader {
  loadRetainedMessageForDelivery(input: {
    readonly conversationId: string;
    readonly messageId: string;
    readonly sequence: number;
  }): Promise<ChatMessageDTO | null>;
  isActiveRetainedMemberForDelivery(
    conversationId: string,
    userId: string,
    sequence: number,
  ): Promise<boolean>;
}

interface ChatPushRuntimeReader {
  getOperationalRuntimeConfig(options?: {
    readonly signal?: AbortSignal;
  }): Promise<RuntimeConfigSuccessDTO>;
}

interface WebPushChatMessageDeliveryDependencies {
  readonly releaseAvailable?: () => boolean;
  readonly runtimeReader?: ChatPushRuntimeReader;
  readonly rooms?: ChatPushRoomReader;
  readonly router?: Pick<ExternalNotificationRouter, "deliverChat">;
}

interface ResolvedChatPush {
  readonly message: ChatMessageDTO;
}

export class WebPushChatMessageDeliveryHandler
  implements NotificationOutboxDeliveryHandler
{
  readonly topic = WEB_PUSH_CHAT_MESSAGE_TOPIC;
  readonly payloadVersion = WEB_PUSH_CHAT_MESSAGE_PAYLOAD_VERSION;

  private readonly releaseAvailable: () => boolean;
  private readonly runtimeReader: ChatPushRuntimeReader;
  private readonly rooms: ChatPushRoomReader;
  private readonly router: Pick<ExternalNotificationRouter, "deliverChat">;

  constructor(dependencies: WebPushChatMessageDeliveryDependencies = {}) {
    this.releaseAvailable =
      dependencies.releaseAvailable ?? readAlumniNetworkReleaseAvailable;
    this.runtimeReader = dependencies.runtimeReader ?? featureControlService;
    this.rooms = dependencies.rooms ?? chatRoomService;
    this.router = dependencies.router ?? externalNotificationRouter;
  }

  async canClaim(signal: AbortSignal): Promise<boolean> {
    return this.isRuntimeReadable(signal);
  }

  async assertCanDeliver(
    event: ClaimedNotificationOutbox,
    context: NotificationOutboxDeliveryContext,
  ): Promise<void> {
    await this.assertRuntimeReadable(context.signal);
    context.signal.throwIfAborted();
    // Validate the durable envelope here; deliver owns the one final fresh
    // recipient authorization so the worker does not double the database load.
    parseWebPushChatMessagePayload(event.payload);
  }

  async deliver(
    event: ClaimedNotificationOutbox,
    context: NotificationOutboxDeliveryContext,
  ): Promise<void> {
    await this.assertRuntimeReadable(context.signal);
    const payload = parseWebPushChatMessagePayload(event.payload);
    const resolved = await this.resolve(event, context.signal);
    if (payload.recipientUserId === resolved.message.sender.id) {
      throw new PermanentNotificationOutboxDeliveryError(
        "WEB_PUSH_RECIPIENT_UNAVAILABLE",
      );
    }

    context.signal.throwIfAborted();
    try {
      const delivery = await this.router.deliverChat({
        eventId: event.eventId,
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        recipientUserId: payload.recipientUserId,
        sequence: payload.sequence,
        ...(resolved.message.kind === "announcement"
          ? { kind: "announcement" as const }
          : {}),
        authorizeRecipient: () =>
          this.authorizeRecipient(payload, context.signal),
        signal: context.signal,
      });
      if (delivery.route === "retry") {
        throw new RetryableNotificationOutboxDeliveryError(
          "WEB_PUSH_PROVIDER_TRANSIENT",
        );
      }
    } catch (error) {
      if (context.signal.aborted) {
        throw context.signal.reason ?? error;
      }
      if (error instanceof RetryableNotificationOutboxDeliveryError) {
        throw error;
      }
      throw new RetryableNotificationOutboxDeliveryError(
        "WEB_PUSH_RECIPIENT_DELIVERY_FAILED",
      );
    }
  }

  private async isRuntimeReadable(signal: AbortSignal): Promise<boolean> {
    try {
      signal.throwIfAborted();
      if (!this.releaseAvailable()) return false;
      const config = await this.runtimeReader.getOperationalRuntimeConfig({ signal });
      signal.throwIfAborted();
      return config.data.alumniNetwork.readable === true;
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
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

  private async resolve(
    event: ClaimedNotificationOutbox,
    signal: AbortSignal,
  ): Promise<ResolvedChatPush> {
    const payload = parseWebPushChatMessagePayload(event.payload);
    let message: ChatMessageDTO | null;
    try {
      message = await this.rooms.loadRetainedMessageForDelivery(payload);
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (error instanceof RetryableNotificationOutboxDeliveryError) throw error;
      throw new RetryableNotificationOutboxDeliveryError(
        "WEB_PUSH_STATE_READ_FAILED",
      );
    }
    signal.throwIfAborted();
    if (!message) {
      throw new PermanentNotificationOutboxDeliveryError(
        "WEB_PUSH_MESSAGE_STALE",
      );
    }
    if (payload.recipientUserId === message.sender.id) {
      throw new PermanentNotificationOutboxDeliveryError(
        "WEB_PUSH_RECIPIENT_UNAVAILABLE",
      );
    }
    return Object.freeze({ message });
  }

  private async authorizeRecipient(
    payload: ReturnType<typeof parseWebPushChatMessagePayload>,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      signal.throwIfAborted();
      const authorized = await this.rooms.isActiveRetainedMemberForDelivery(
        payload.conversationId,
        payload.recipientUserId,
        payload.sequence,
      );
      signal.throwIfAborted();
      return authorized;
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (error instanceof RetryableNotificationOutboxDeliveryError) throw error;
      throw new RetryableNotificationOutboxDeliveryError(
        "WEB_PUSH_STATE_READ_FAILED",
      );
    }
  }
}

export const webPushChatMessageDeliveryHandler =
  new WebPushChatMessageDeliveryHandler();
