import type { ClientSession } from "mongoose";
import {
  NOTIFICATION_OUTBOX_ENQUEUE_BATCH_MAXIMUM,
  notificationOutboxService,
  type NotificationOutboxRecord,
  type NotificationOutboxService,
} from "../reliability/NotificationOutboxService";
import { PermanentNotificationOutboxDeliveryError } from "../reliability/NotificationOutboxWorker";

export const WEB_PUSH_CHAT_MESSAGE_TOPIC = "web_push.chat_message" as const;
export const WEB_PUSH_CHAT_MESSAGE_PAYLOAD_VERSION = 1 as const;

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const PAYLOAD_KEYS = new Set([
  "conversationId",
  "messageId",
  "recipientUserId",
  "sequence",
  "occurredAt",
]);

export interface WebPushChatMessagePayloadV1 {
  readonly conversationId: string;
  readonly messageId: string;
  readonly recipientUserId: string;
  readonly sequence: number;
  readonly occurredAt: string;
}

export interface EnqueueWebPushChatMessageInput
  extends WebPushChatMessagePayloadV1 {
  readonly session: ClientSession;
  readonly correlationId?: string;
}

function invalid(): never {
  throw new PermanentNotificationOutboxDeliveryError("WEB_PUSH_EVENT_INVALID");
}

export function parseWebPushChatMessagePayload(
  value: unknown,
): WebPushChatMessagePayloadV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some((key) => !PAYLOAD_KEYS.has(key))) return invalid();
  if (
    typeof source.conversationId !== "string" ||
    !OBJECT_ID_PATTERN.test(source.conversationId) ||
    typeof source.messageId !== "string" ||
    !OBJECT_ID_PATTERN.test(source.messageId) ||
    typeof source.recipientUserId !== "string" ||
    !OBJECT_ID_PATTERN.test(source.recipientUserId) ||
    !Number.isSafeInteger(source.sequence) ||
    Number(source.sequence) < 1 ||
    typeof source.occurredAt !== "string"
  ) {
    return invalid();
  }
  const occurredAt = new Date(source.occurredAt);
  if (Number.isNaN(occurredAt.getTime()) || occurredAt.toISOString() !== source.occurredAt) {
    return invalid();
  }
  return Object.freeze({
    conversationId: source.conversationId.toLowerCase(),
    messageId: source.messageId.toLowerCase(),
    recipientUserId: source.recipientUserId.toLowerCase(),
    sequence: Number(source.sequence),
    occurredAt: source.occurredAt,
  });
}

export async function enqueueWebPushChatMessage(
  input: EnqueueWebPushChatMessageInput,
  outbox: Pick<NotificationOutboxService, "enqueueInTransaction"> =
    notificationOutboxService,
): Promise<NotificationOutboxRecord> {
  const payload = parseWebPushChatMessagePayload({
    conversationId: input.conversationId,
    messageId: input.messageId,
    recipientUserId: input.recipientUserId,
    sequence: input.sequence,
    occurredAt: input.occurredAt,
  });
  return outbox.enqueueInTransaction({
    topic: WEB_PUSH_CHAT_MESSAGE_TOPIC,
    dedupeKey: `web-push-chat-message:${payload.messageId}:${payload.recipientUserId}`,
    payloadVersion: WEB_PUSH_CHAT_MESSAGE_PAYLOAD_VERSION,
    payload,
    session: input.session,
    correlationId: input.correlationId,
  });
}

export async function enqueueWebPushChatMessagesBatch(
  inputs: readonly EnqueueWebPushChatMessageInput[],
  outbox: Pick<NotificationOutboxService, "enqueueManyInTransaction"> =
    notificationOutboxService,
): Promise<readonly NotificationOutboxRecord[]> {
  if (
    inputs.length < 1 ||
    inputs.length > NOTIFICATION_OUTBOX_ENQUEUE_BATCH_MAXIMUM
  ) {
    throw new TypeError(
      `Web Push chat batch must contain 1-${NOTIFICATION_OUTBOX_ENQUEUE_BATCH_MAXIMUM} recipients.`,
    );
  }
  const firstSession = inputs[0]!.session;
  const events = inputs.map((input) => {
    if (input.session !== firstSession) {
      throw new TypeError("Web Push chat batch must share one session.");
    }
    const payload = parseWebPushChatMessagePayload({
      conversationId: input.conversationId,
      messageId: input.messageId,
      recipientUserId: input.recipientUserId,
      sequence: input.sequence,
      occurredAt: input.occurredAt,
    });
    return {
      topic: WEB_PUSH_CHAT_MESSAGE_TOPIC,
      dedupeKey: `web-push-chat-message:${payload.messageId}:${payload.recipientUserId}`,
      payloadVersion: WEB_PUSH_CHAT_MESSAGE_PAYLOAD_VERSION,
      payload,
      session: input.session,
      correlationId: input.correlationId,
    } as const;
  });
  return outbox.enqueueManyInTransaction(events);
}
