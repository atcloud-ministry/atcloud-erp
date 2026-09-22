import {
  CHAT_MESSAGE_FIELD_LIMITS,
  UUID_PATTERN,
  isValidChatText,
  normalizeChatText,
} from "./chatRooms";
import {
  CHAT_HTTP_PAYLOAD_MAX_BYTES,
  ChatRoomFlowValidationError,
  ChatRoomPayloadTooLargeError,
} from "./chatRoomFlow";

export interface PublishProgramAnnouncementBody {
  readonly clientMessageId: string;
  readonly content: string;
}

function fail(path: string, msg: string): never {
  throw new ChatRoomFlowValidationError([
    Object.freeze({ path, msg }),
  ]);
}

function strictObject(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("body", "body must be an object");
  }
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return fail("body", "body must be a plain data object");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return fail("body", "body must be a plain data object");
  }
  const allowed = new Set(["clientMessageId", "content"]);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) {
      return fail(
        typeof key === "string" ? `body.${key}` : "body",
        "Unknown field",
      );
    }
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) {
      return fail(`body.${key}`, "Accessor fields are not allowed");
    }
    result[key] = descriptor.value;
  }
  return result;
}

function assertPayloadBytes(value: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return fail("body", "body must contain JSON data");
  }
  if (Buffer.byteLength(serialized, "utf8") > CHAT_HTTP_PAYLOAD_MAX_BYTES) {
    throw new ChatRoomPayloadTooLargeError();
  }
}

/** Strict, normalized DTO decoder for Program Room announcements. */
export function parsePublishProgramAnnouncementBody(
  value: unknown,
): PublishProgramAnnouncementBody {
  assertPayloadBytes(value);
  const source = strictObject(value);
  if (!Object.prototype.hasOwnProperty.call(source, "clientMessageId")) {
    return fail("body.clientMessageId", "Required field is missing");
  }
  if (
    typeof source.clientMessageId !== "string" ||
    !UUID_PATTERN.test(source.clientMessageId)
  ) {
    return fail("body.clientMessageId", "A UUID clientMessageId is required");
  }
  if (!Object.prototype.hasOwnProperty.call(source, "content")) {
    return fail("body.content", "Required field is missing");
  }
  if (typeof source.content !== "string") {
    return fail("body.content", "body.content must be a string");
  }
  const content = normalizeChatText(source.content);
  if (!isValidChatText(content)) {
    return fail(
      "body.content",
      `Announcement content must contain 1-${CHAT_MESSAGE_FIELD_LIMITS.content} safe characters`,
    );
  }
  const result = Object.freeze({
    clientMessageId: source.clientMessageId.toLowerCase(),
    content,
  });
  assertPayloadBytes(result);
  return result;
}
