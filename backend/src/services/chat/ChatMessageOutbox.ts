import type { ClientSession } from "mongoose";
import {
  notificationOutboxService,
  type NotificationOutboxRecord,
  type NotificationOutboxService,
} from "../reliability/NotificationOutboxService";
import { PermanentNotificationOutboxDeliveryError } from "../reliability/NotificationOutboxWorker";

export const CHAT_MESSAGE_PERSISTED_TOPIC = "chat.message.persisted" as const;
export const CHAT_MESSAGE_PERSISTED_PAYLOAD_VERSION = 1 as const;

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const PAYLOAD_KEYS = new Set([
  "conversationId",
  "messageId",
  "sequence",
  "occurredAt",
]);

export interface ChatMessagePersistedPayloadV1 {
  readonly conversationId: string;
  readonly messageId: string;
  readonly sequence: number;
  readonly occurredAt: string;
}

export interface EnqueueChatMessagePersistedInput
  extends ChatMessagePersistedPayloadV1 {
  readonly session: ClientSession;
  readonly correlationId?: string;
}

function inputObjectId(value: string, field: string): string {
  if (!OBJECT_ID_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a valid ObjectId.`);
  }
  return value.toLowerCase();
}

function permanentInvalid(): never {
  throw new PermanentNotificationOutboxDeliveryError(
    "CHAT_MESSAGE_EVENT_INVALID",
  );
}

export function parseChatMessagePersistedPayload(
  value: unknown,
): ChatMessagePersistedPayloadV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return permanentInvalid();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return permanentInvalid();
  }
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some((key) => !PAYLOAD_KEYS.has(key))) {
    return permanentInvalid();
  }
  if (
    typeof source.conversationId !== "string" ||
    !OBJECT_ID_PATTERN.test(source.conversationId) ||
    typeof source.messageId !== "string" ||
    !OBJECT_ID_PATTERN.test(source.messageId) ||
    !Number.isSafeInteger(source.sequence) ||
    Number(source.sequence) < 1 ||
    typeof source.occurredAt !== "string"
  ) {
    return permanentInvalid();
  }
  const occurredAt = new Date(source.occurredAt);
  if (
    Number.isNaN(occurredAt.getTime()) ||
    occurredAt.toISOString() !== source.occurredAt
  ) {
    return permanentInvalid();
  }
  return Object.freeze({
    conversationId: source.conversationId.toLowerCase(),
    messageId: source.messageId.toLowerCase(),
    sequence: Number(source.sequence),
    occurredAt: source.occurredAt,
  });
}

export async function enqueueChatMessagePersisted(
  input: EnqueueChatMessagePersistedInput,
  outbox: Pick<NotificationOutboxService, "enqueueInTransaction"> =
    notificationOutboxService,
): Promise<NotificationOutboxRecord> {
  const conversationId = inputObjectId(
    input.conversationId,
    "conversationId",
  );
  const messageId = inputObjectId(input.messageId, "messageId");
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw new TypeError("sequence must be a positive safe integer.");
  }
  const occurredAt = new Date(input.occurredAt);
  if (
    Number.isNaN(occurredAt.getTime()) ||
    occurredAt.toISOString() !== input.occurredAt
  ) {
    throw new TypeError("occurredAt must be an ISO timestamp.");
  }
  return outbox.enqueueInTransaction({
    topic: CHAT_MESSAGE_PERSISTED_TOPIC,
    dedupeKey: `chat-message:${messageId}`,
    payloadVersion: CHAT_MESSAGE_PERSISTED_PAYLOAD_VERSION,
    payload: {
      conversationId,
      messageId,
      sequence: input.sequence,
      occurredAt: input.occurredAt,
    },
    session: input.session,
    correlationId: input.correlationId,
  });
}
