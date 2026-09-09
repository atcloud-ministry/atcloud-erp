import type {
  SystemMessageRealtimeCreatorDTO,
  SystemMessageRealtimeDTO,
} from "../contracts/systemMessageRealtime";

type MessageSource = {
  _id?: unknown;
  id?: unknown;
  title?: unknown;
  content?: unknown;
  type?: unknown;
  priority?: unknown;
  createdAt?: unknown;
  creator?: unknown;
  hideCreator?: unknown;
  targetUserId?: unknown;
  metadata?: unknown;
};

const FORBIDDEN_KEYS = new Set([
  "_id",
  "__v",
  "createdBy",
  "userStates",
  "targetRoles",
  "recipients",
  "recipientIds",
  "targetUserIds",
]);

function objectSource(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function dateString(value: unknown): string {
  const date = value instanceof Date ? value : new Date(requiredString(value));
  if (Number.isNaN(date.valueOf())) {
    throw new TypeError("System message createdAt must be a valid date");
  }
  return date.toISOString();
}

function serializeCreator(
  value: unknown,
): SystemMessageRealtimeCreatorDTO | undefined {
  const creator = objectSource(value);
  if (!creator) return undefined;

  const gender = creator.gender === "female" ? "female" : "male";
  const avatar = optionalString(creator.avatar);
  const roleInAtCloud = optionalString(creator.roleInAtCloud);

  return {
    id: requiredString(creator.id),
    firstName: requiredString(creator.firstName),
    lastName: requiredString(creator.lastName),
    username: requiredString(creator.username),
    ...(avatar ? { avatar } : {}),
    gender,
    authLevel: requiredString(creator.authLevel),
    ...(roleInAtCloud ? { roleInAtCloud } : {}),
  };
}

function sanitizeRealtimeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizeRealtimeValue);

  const source = objectSource(value);
  if (!source) return value;

  return Object.fromEntries(
    Object.entries(source)
      .filter(([key]) => !FORBIDDEN_KEYS.has(key))
      .map(([key, entry]) => [key, sanitizeRealtimeValue(entry)]),
  );
}

function serializeMetadata(value: unknown): Record<string, unknown> | undefined {
  const source = objectSource(value);
  if (!source) return undefined;
  return sanitizeRealtimeValue(source) as Record<string, unknown>;
}

/**
 * Builds a message_created payload without serializing the database document.
 * The recipient is supplied explicitly so a target user id can only be echoed
 * to that same user.
 */
export function serializeSystemMessageForRecipient(
  message: MessageSource,
  recipientId: string,
): SystemMessageRealtimeDTO {
  const persistedId = message._id ?? message.id;
  const creator =
    message.hideCreator === true ? undefined : serializeCreator(message.creator);
  const targetUserId = optionalString(message.targetUserId);
  const metadata = serializeMetadata(message.metadata);

  return {
    id: requiredString(persistedId),
    title: requiredString(message.title),
    content: requiredString(message.content),
    type: requiredString(message.type),
    priority: requiredString(message.priority),
    createdAt: dateString(message.createdAt),
    ...(creator ? { creator } : {}),
    ...(targetUserId === recipientId ? { targetUserId } : {}),
    ...(metadata ? { metadata } : {}),
  };
}
