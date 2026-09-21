import {
  CHAT_MESSAGE_FIELD_LIMITS,
  UUID_PATTERN,
  isValidChatMessagePayload,
  isValidChatSafeLinkUrl,
  isValidChatText,
  isValidSafeLinkLabel,
  normalizeChatText,
  normalizeSafeLinkLabel,
  type ChatMessageKind,
  type ChatSafeLink,
  type ConversationKind,
  type ConversationMemberRole,
  type ConversationMemberStatus,
  type ConversationStatus,
} from "./chatRooms";

export const CHAT_ROOM_LIST_VIEWS = ["current", "past"] as const;
export type ChatRoomListView = (typeof CHAT_ROOM_LIST_VIEWS)[number];

export const CHAT_HTTP_PAYLOAD_MAX_BYTES = 16 * 1024;
export const CHAT_ROOM_PAGE_DEFAULT = 30;
export const CHAT_ROOM_PAGE_MAXIMUM = 100;
export const CHAT_HISTORY_PAGE_DEFAULT = 50;
export const CHAT_HISTORY_PAGE_MAXIMUM = 100;

export interface ChatRoomFlowIssue {
  readonly path: string;
  readonly msg: string;
}

export class ChatRoomFlowValidationError extends Error {
  readonly name = "ChatRoomFlowValidationError";
  readonly code = "CHAT_ROOM_INPUT_INVALID";

  constructor(public readonly issues: readonly ChatRoomFlowIssue[]) {
    super("Validation failed");
  }
}

export class ChatRoomPayloadTooLargeError extends Error {
  readonly name = "ChatRoomPayloadTooLargeError";
  readonly code = "CHAT_MESSAGE_PAYLOAD_TOO_LARGE";

  constructor(public readonly maxBytes = CHAT_HTTP_PAYLOAD_MAX_BYTES) {
    super(`Chat message payload exceeds ${maxBytes} bytes.`);
  }
}

export interface ChatRoomListQuery {
  readonly view: ChatRoomListView;
  readonly page: number;
  readonly limit: number;
}

export interface ChatMessageHistoryQuery {
  readonly beforeSequence?: number;
  readonly afterSequence?: number;
  readonly limit: number;
}

export interface SendChatMessageBody {
  readonly clientMessageId: string;
  readonly content: string | null;
  readonly safeLink: ChatSafeLink | null;
}

export interface ReadChatRoomBody {
  readonly throughSequence: number;
}

export interface MuteChatRoomBody {
  readonly muted: boolean;
}

export interface ChatParticipantDTO {
  readonly id: string;
  readonly displayName: string;
  readonly avatar: string | null;
}

export interface ChatMessageDTO {
  readonly id: string;
  readonly conversationId: string;
  readonly sequence: number;
  readonly sender: ChatParticipantDTO;
  readonly clientMessageId: string;
  readonly kind: ChatMessageKind;
  readonly content: string | null;
  readonly safeLink: ChatSafeLink | null;
  readonly createdAt: string;
}

export interface ChatLastMessageDTO {
  readonly id: string;
  readonly sequence: number;
  readonly kind: ChatMessageKind;
  readonly sender: ChatParticipantDTO;
  readonly contentPreview: string | null;
  readonly safeLink: ChatSafeLink | null;
  readonly createdAt: string;
}

export interface ChatRoomViewerDTO {
  readonly role: ConversationMemberRole;
  readonly status: ConversationMemberStatus;
  readonly lastReadSequence: number;
  readonly unreadCount: number;
  readonly muted: boolean;
  readonly accessMode: "read_write" | "read_only";
  readonly canSend: boolean;
  readonly canAnnounce: boolean;
}

export interface ConversationDTO {
  readonly id: string;
  readonly kind: ConversationKind;
  readonly status: ConversationStatus;
  readonly section: ChatRoomListView;
  readonly title: string;
  readonly helpRequestId: string | null;
  readonly programId: string | null;
  readonly counterpart: ChatParticipantDTO | null;
  readonly lastSequence: number;
  readonly lastMessage: ChatLastMessageDTO | null;
  readonly viewer: ChatRoomViewerDTO;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface ChatPaginationDTO {
  readonly currentPage: number;
  readonly totalPages: number;
  readonly totalCount: number;
  readonly hasNext: boolean;
  readonly hasPrev: boolean;
}

export interface ChatRoomListDataDTO {
  readonly conversations: readonly ConversationDTO[];
  readonly pagination: ChatPaginationDTO;
  readonly chatUnreadTotal: number;
}

export interface ChatRoomDataDTO {
  readonly conversation: ConversationDTO;
  readonly chatUnreadTotal: number;
}

export interface ProgramChatRoomLinkDTO {
  readonly id: string;
  readonly programId: string;
  readonly status: ConversationStatus;
  readonly section: ChatRoomListView;
  readonly viewer: Readonly<{
    status: ConversationMemberStatus;
    accessMode: "read_write" | "read_only";
  }>;
}

export interface ProgramChatRoomLinkDataDTO {
  readonly room: ProgramChatRoomLinkDTO;
}

export interface ChatMessageHistoryPaginationDTO {
  readonly limit: number;
  readonly hasMore: boolean;
  readonly beforeSequence: number | null;
  readonly afterSequence: number | null;
  readonly nextBeforeSequence: number | null;
  readonly nextAfterSequence: number | null;
}

export interface ChatMessageHistoryDataDTO {
  readonly conversationId: string;
  readonly messages: readonly ChatMessageDTO[];
  readonly pagination: ChatMessageHistoryPaginationDTO;
  readonly roomUnreadCount: number;
  readonly chatUnreadTotal: number;
}

export interface ChatMessageMutationDataDTO {
  readonly message: ChatMessageDTO;
  readonly roomUnreadCount: number;
  readonly chatUnreadTotal: number;
}

export interface ChatRoomReadDataDTO {
  readonly conversationId: string;
  readonly lastReadSequence: number;
  readonly unreadCount: number;
  readonly chatUnreadTotal: number;
}

export interface ChatRoomMuteDataDTO {
  readonly conversationId: string;
  readonly muted: boolean;
  readonly chatUnreadTotal: number;
}

export interface ChatUnreadTotalDTO {
  readonly chatUnreadTotal: number;
}

type StrictObject = Readonly<Record<string, unknown>>;

function fail(path: string, msg: string): never {
  throw new ChatRoomFlowValidationError([
    Object.freeze({ path, msg }),
  ]);
}

function strictObject(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): StrictObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail(path, `${path} must be an object`);
  }
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return fail(path, `${path} must be a plain data object`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(path, `${path} must be a plain data object`);
  }
  const allowed = new Set(allowedKeys);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) {
      return fail(
        typeof key === "string" ? `${path}.${key}` : path,
        "Unknown field",
      );
    }
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) {
      return fail(`${path}.${key}`, "Accessor fields are not allowed");
    }
    result[key] = descriptor.value;
  }
  return result;
}

function required(object: StrictObject, key: string, path: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(object, key)) {
    return fail(`${path}.${key}`, "Required field is missing");
  }
  return object[key];
}

function oneQueryValue(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return fail(path, `${path} is invalid`);
  return value;
}

function boundedInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (
    !Number.isSafeInteger(numeric) ||
    numeric < minimum ||
    numeric > maximum
  ) {
    return fail(path, `${path} must be an integer from ${minimum} to ${maximum}`);
  }
  return numeric;
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

function normalizeSafeLink(value: unknown): ChatSafeLink | null {
  if (value === undefined || value === null) return null;
  const source = strictObject(value, "body.safeLink", ["url", "label"]);
  const rawUrl = required(source, "url", "body.safeLink");
  const rawLabel = required(source, "label", "body.safeLink");
  if (typeof rawUrl !== "string" || !isValidChatSafeLinkUrl(rawUrl)) {
    return fail("body.safeLink.url", "A safe HTTP or HTTPS URL is required");
  }
  if (typeof rawLabel !== "string") {
    return fail("body.safeLink.label", "A safe link label is required");
  }
  const label = normalizeSafeLinkLabel(rawLabel);
  if (!isValidSafeLinkLabel(label)) {
    return fail(
      "body.safeLink.label",
      `Link label must contain 1-${CHAT_MESSAGE_FIELD_LIMITS.safeLinkLabel} safe characters`,
    );
  }
  const url = new URL(rawUrl).toString();
  if (!isValidChatSafeLinkUrl(url)) {
    return fail("body.safeLink.url", "A safe HTTP or HTTPS URL is required");
  }
  return Object.freeze({ url, label });
}

export function parseChatRoomListQuery(value: unknown): ChatRoomListQuery {
  const source = strictObject(value, "query", ["view", "page", "limit"]);
  const rawView = oneQueryValue(source.view, "query.view") ?? "current";
  if (!(CHAT_ROOM_LIST_VIEWS as readonly string[]).includes(rawView)) {
    return fail("query.view", "query.view is invalid");
  }
  return Object.freeze({
    view: rawView as ChatRoomListView,
    page:
      source.page === undefined
        ? 1
        : boundedInteger(source.page, "query.page", 1, Number.MAX_SAFE_INTEGER),
    limit:
      source.limit === undefined
        ? CHAT_ROOM_PAGE_DEFAULT
        : boundedInteger(
            source.limit,
            "query.limit",
            1,
            CHAT_ROOM_PAGE_MAXIMUM,
          ),
  });
}

export function parseChatMessageHistoryQuery(
  value: unknown,
): ChatMessageHistoryQuery {
  const source = strictObject(value, "query", [
    "beforeSequence",
    "afterSequence",
    "limit",
  ]);
  if (source.beforeSequence !== undefined && source.afterSequence !== undefined) {
    return fail(
      "query",
      "beforeSequence and afterSequence cannot be used together",
    );
  }
  const beforeSequence =
    source.beforeSequence === undefined
      ? undefined
      : boundedInteger(
          source.beforeSequence,
          "query.beforeSequence",
          1,
          Number.MAX_SAFE_INTEGER,
        );
  const afterSequence =
    source.afterSequence === undefined
      ? undefined
      : boundedInteger(
          source.afterSequence,
          "query.afterSequence",
          0,
          Number.MAX_SAFE_INTEGER - 1,
        );
  return Object.freeze({
    ...(beforeSequence === undefined ? {} : { beforeSequence }),
    ...(afterSequence === undefined ? {} : { afterSequence }),
    limit:
      source.limit === undefined
        ? CHAT_HISTORY_PAGE_DEFAULT
        : boundedInteger(
            source.limit,
            "query.limit",
            1,
            CHAT_HISTORY_PAGE_MAXIMUM,
          ),
  });
}

export function parseSendChatMessageBody(value: unknown): SendChatMessageBody {
  assertPayloadBytes(value);
  const source = strictObject(value, "body", [
    "clientMessageId",
    "content",
    "safeLink",
  ]);
  const rawClientMessageId = required(source, "clientMessageId", "body");
  if (
    typeof rawClientMessageId !== "string" ||
    !UUID_PATTERN.test(rawClientMessageId)
  ) {
    return fail("body.clientMessageId", "A UUID clientMessageId is required");
  }

  let content: string | null = null;
  if (source.content !== undefined && source.content !== null) {
    if (typeof source.content !== "string") {
      return fail("body.content", "body.content must be a string");
    }
    content = normalizeChatText(source.content);
    if (!isValidChatText(content)) {
      return fail(
        "body.content",
        `Message content must contain 1-${CHAT_MESSAGE_FIELD_LIMITS.content} safe characters`,
      );
    }
  }
  const safeLink = normalizeSafeLink(source.safeLink);
  if (!isValidChatMessagePayload({ content, safeLink })) {
    return fail("body", "A message requires valid content or a safe link");
  }
  const result = Object.freeze({
    clientMessageId: rawClientMessageId.toLowerCase(),
    content,
    safeLink,
  });
  // Normalization can expand escaped URL output; enforce the stored/request DTO
  // representation as well as the raw JSON envelope.
  assertPayloadBytes(result);
  return result;
}

export function parseReadChatRoomBody(value: unknown): ReadChatRoomBody {
  const source = strictObject(value, "body", ["throughSequence"]);
  return Object.freeze({
    throughSequence: boundedInteger(
      required(source, "throughSequence", "body"),
      "body.throughSequence",
      0,
      Number.MAX_SAFE_INTEGER - 1,
    ),
  });
}

export function parseMuteChatRoomBody(value: unknown): MuteChatRoomBody {
  const source = strictObject(value, "body", ["muted"]);
  const muted = required(source, "muted", "body");
  if (typeof muted !== "boolean") {
    return fail("body.muted", "body.muted must be a boolean");
  }
  return Object.freeze({ muted });
}
