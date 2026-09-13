export const CONVERSATION_KINDS = ["alumni_help", "program"] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

export const CONVERSATION_STATUSES = ["current", "archived"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const CONVERSATION_SECTIONS = ["current", "past"] as const;
export type ConversationSection = (typeof CONVERSATION_SECTIONS)[number];

export const CONVERSATION_MEMBER_ROLES = [
  "requester",
  "provider",
  "mentor",
  "class_representative",
  "mentee",
] as const;
export type ConversationMemberRole =
  (typeof CONVERSATION_MEMBER_ROLES)[number];

export const CONVERSATION_MEMBER_STATUSES = [
  "active",
  "history_only",
] as const;
export type ConversationMemberStatus =
  (typeof CONVERSATION_MEMBER_STATUSES)[number];

export const CONVERSATION_ACCESS_MODES = ["read_write", "read_only"] as const;
export type ConversationAccessMode =
  (typeof CONVERSATION_ACCESS_MODES)[number];

export const CHAT_MESSAGE_KINDS = ["text", "announcement"] as const;
export type ChatMessageKind = (typeof CHAT_MESSAGE_KINDS)[number];

export const CHAT_MESSAGE_MAX_CODE_POINTS = 4_000;
export const CHAT_LAST_MESSAGE_PREVIEW_MAX_CODE_POINTS = 161;
export const CHAT_SAFE_LINK_MAX_URL_LENGTH = 2_048;
export const CHAT_SAFE_LINK_MAX_LABEL_CODE_POINTS = 200;
export const CHAT_PARTICIPANT_DISPLAY_NAME_MAX_CODE_POINTS = 160;
export const CHAT_PARTICIPANT_AVATAR_MAX_CODE_POINTS = 2_048;
export const CHAT_HTTP_PAYLOAD_MAX_BYTES = 16 * 1024;
export const CHAT_ROOM_DEFAULT_PAGE_SIZE = 30;
export const CHAT_ROOM_MAX_PAGE_SIZE = 100;
export const CHAT_HISTORY_DEFAULT_PAGE_SIZE = 50;
export const CHAT_HISTORY_MAX_PAGE_SIZE = 100;

export interface ConversationParticipantDTO {
  id: string;
  displayName: string;
  avatar: string | null;
}

export interface ChatSafeLinkDTO {
  url: string;
  label: string;
}

export interface ChatMessageDTO {
  id: string;
  conversationId: string;
  sequence: number;
  kind: ChatMessageKind;
  sender: ConversationParticipantDTO;
  content: string | null;
  safeLink: ChatSafeLinkDTO | null;
  clientMessageId: string;
  createdAt: string;
}

export interface ConversationViewerDTO {
  role: ConversationMemberRole;
  status: ConversationMemberStatus;
  lastReadSequence: number;
  unreadCount: number;
  muted: boolean;
  canSend: boolean;
  canAnnounce: boolean;
  accessMode: ConversationAccessMode;
}

export interface ChatMessagePreviewDTO {
  id: string;
  sequence: number;
  kind: ChatMessageKind;
  sender: ConversationParticipantDTO;
  contentPreview: string | null;
  safeLink: ChatSafeLinkDTO | null;
  createdAt: string;
}

export interface ConversationDTO {
  id: string;
  kind: ConversationKind;
  status: ConversationStatus;
  section: ConversationSection;
  title: string;
  helpRequestId: string | null;
  programId: string | null;
  counterpart: ConversationParticipantDTO | null;
  lastSequence: number;
  lastMessage: ChatMessagePreviewDTO | null;
  viewer: ConversationViewerDTO;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationPaginationDTO {
  currentPage: number;
  totalPages: number;
  totalCount: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface ConversationListDTO {
  conversations: ConversationDTO[];
  pagination: ConversationPaginationDTO;
  chatUnreadTotal: number;
}

export interface ConversationDetailDTO {
  conversation: ConversationDTO;
  chatUnreadTotal: number;
}

export interface ProgramChatRoomLinkDTO {
  id: string;
  programId: string;
  status: ConversationStatus;
  section: ConversationSection;
  viewer: {
    status: ConversationMemberStatus;
    accessMode: ConversationAccessMode;
  };
}

export interface ProgramChatRoomLinkDataDTO {
  room: ProgramChatRoomLinkDTO;
}

export interface ChatMessageMutationDTO {
  message: ChatMessageDTO;
  roomUnreadCount: number;
  chatUnreadTotal: number;
}

export interface ChatHistoryPaginationDTO {
  limit: number;
  hasMore: boolean;
  beforeSequence: number | null;
  afterSequence: number | null;
  nextBeforeSequence: number | null;
  nextAfterSequence: number | null;
}

export interface ChatHistoryDTO {
  conversationId: string;
  messages: ChatMessageDTO[];
  pagination: ChatHistoryPaginationDTO;
  roomUnreadCount: number;
  chatUnreadTotal: number;
}

export interface ChatReadMutationDTO {
  conversationId: string;
  lastReadSequence: number;
  unreadCount: number;
  chatUnreadTotal: number;
}

export interface ChatMuteMutationDTO {
  conversationId: string;
  muted: boolean;
  chatUnreadTotal: number;
}

export interface ChatUnreadCountDTO {
  chatUnreadTotal: number;
}

export interface ChatMessageEventDTO {
  message: ChatMessageDTO;
  timestamp: string;
}

export interface ChatUnreadUpdateDTO {
  conversationId: string;
  roomUnreadCount: number;
  chatUnreadTotal: number;
  lastReadSequence: number;
  timestamp: string;
}

type JsonObject = Record<string, unknown>;

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function contractError(path: string, expectation: string): never {
  throw new Error(
    `Invalid Conversations API response at ${path}: expected ${expectation}`,
  );
}

function exactObjectAt(
  value: unknown,
  path: string,
  expectedKeys: readonly string[],
): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return contractError(path, "object");
  }
  const object = value as JsonObject;
  const keys = Object.keys(object);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => !expectedKeys.includes(key))
  ) {
    return contractError(path, `exact keys ${expectedKeys.join(", ")}`);
  }
  return object;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string") return contractError(path, "string");
  return value;
}

function nonemptyStringAt(value: unknown, path: string): string {
  const result = stringAt(value, path);
  if (!result.trim()) return contractError(path, "non-empty string");
  return result;
}

function boundedStringAt(
  value: unknown,
  path: string,
  maximumCodePoints: number,
  { nonempty = false }: { nonempty?: boolean } = {},
): string {
  const result = nonempty
    ? nonemptyStringAt(value, path)
    : stringAt(value, path);
  if (Array.from(result).length > maximumCodePoints) {
    return contractError(path, `at most ${maximumCodePoints} code points`);
  }
  return result;
}

function nullableStringAt(value: unknown, path: string): string | null {
  return value === null ? null : stringAt(value, path);
}

function objectIdAt(value: unknown, path: string): string {
  const result = stringAt(value, path);
  if (!OBJECT_ID_PATTERN.test(result)) {
    return contractError(path, "24-character ObjectId string");
  }
  return result;
}

function nullableObjectIdAt(value: unknown, path: string): string | null {
  return value === null ? null : objectIdAt(value, path);
}

function uuidAt(value: unknown, path: string): string {
  const result = stringAt(value, path);
  if (!UUID_PATTERN.test(result)) return contractError(path, "RFC 4122 UUID");
  return result;
}

function dateAt(value: unknown, path: string): string {
  const result = stringAt(value, path);
  if (
    Number.isNaN(Date.parse(result)) ||
    new Date(result).toISOString() !== result
  ) {
    return contractError(path, "canonical ISO date string");
  }
  return result;
}

function nullableDateAt(value: unknown, path: string): string | null {
  return value === null ? null : dateAt(value, path);
}

function safeIntegerAt(value: unknown, path: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    return contractError(path, `safe integer >= ${minimum}`);
  }
  return Number(value);
}

function nullableSequenceAt(value: unknown, path: string): number | null {
  return value === null ? null : safeIntegerAt(value, path, 1);
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") return contractError(path, "boolean");
  return value;
}

function enumAt<T extends string>(
  value: unknown,
  path: string,
  values: readonly T[],
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    return contractError(path, values.join(" | "));
  }
  return value as T;
}

function arrayAt<T>(
  value: unknown,
  path: string,
  decoder: (entry: unknown, entryPath: string) => T,
): T[] {
  if (!Array.isArray(value)) return contractError(path, "array");
  return value.map((entry, index) => decoder(entry, `${path}[${index}]`));
}

function safeUrlAt(value: unknown, path: string): string {
  const result = nonemptyStringAt(value, path);
  if (Array.from(result).length > CHAT_SAFE_LINK_MAX_URL_LENGTH) {
    return contractError(path, "HTTP(S) URL with at most 2,048 code points");
  }
  try {
    const parsed = new URL(result);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    ) {
      return contractError(path, "credential-free HTTP(S) URL");
    }
  } catch {
    return contractError(path, "valid HTTP(S) URL");
  }
  return result;
}

export function decodeConversationParticipant(
  value: unknown,
  path: string,
): ConversationParticipantDTO {
  const participant = exactObjectAt(value, path, [
    "id",
    "displayName",
    "avatar",
  ]);
  return {
    id: objectIdAt(participant.id, `${path}.id`),
    displayName: boundedStringAt(
      participant.displayName,
      `${path}.displayName`,
      CHAT_PARTICIPANT_DISPLAY_NAME_MAX_CODE_POINTS,
      { nonempty: true },
    ),
    avatar:
      participant.avatar === null
        ? null
        : boundedStringAt(
            participant.avatar,
            `${path}.avatar`,
            CHAT_PARTICIPANT_AVATAR_MAX_CODE_POINTS,
          ),
  };
}

function decodeSafeLink(value: unknown, path: string): ChatSafeLinkDTO {
  const link = exactObjectAt(value, path, ["url", "label"]);
  return {
    url: safeUrlAt(link.url, `${path}.url`),
    label: boundedStringAt(
      link.label,
      `${path}.label`,
      CHAT_SAFE_LINK_MAX_LABEL_CODE_POINTS,
      { nonempty: true },
    ),
  };
}

export function decodeChatMessage(
  value: unknown,
  path = "data.message",
): ChatMessageDTO {
  const message = exactObjectAt(value, path, [
    "id",
    "conversationId",
    "sequence",
    "kind",
    "sender",
    "content",
    "safeLink",
    "clientMessageId",
    "createdAt",
  ]);
  const content = nullableStringAt(message.content, `${path}.content`);
  if (content !== null && Array.from(content).length > CHAT_MESSAGE_MAX_CODE_POINTS) {
    return contractError(`${path}.content`, "at most 4,000 code points");
  }
  const safeLink =
    message.safeLink === null
      ? null
      : decodeSafeLink(message.safeLink, `${path}.safeLink`);
  if ((content === null || !content.trim()) && safeLink === null) {
    return contractError(path, "content, safeLink, or both");
  }
  return {
    id: objectIdAt(message.id, `${path}.id`),
    conversationId: objectIdAt(
      message.conversationId,
      `${path}.conversationId`,
    ),
    sequence: safeIntegerAt(message.sequence, `${path}.sequence`, 1),
    kind: enumAt(message.kind, `${path}.kind`, CHAT_MESSAGE_KINDS),
    sender: decodeConversationParticipant(message.sender, `${path}.sender`),
    content,
    safeLink,
    clientMessageId: uuidAt(
      message.clientMessageId,
      `${path}.clientMessageId`,
    ),
    createdAt: dateAt(message.createdAt, `${path}.createdAt`),
  };
}

export function decodeChatMessagePreview(
  value: unknown,
  path: string,
): ChatMessagePreviewDTO {
  const message = exactObjectAt(value, path, [
    "id",
    "sequence",
    "kind",
    "sender",
    "contentPreview",
    "safeLink",
    "createdAt",
  ]);
  const contentPreview = nullableStringAt(
    message.contentPreview,
    `${path}.contentPreview`,
  );
  if (
    contentPreview !== null &&
    Array.from(contentPreview).length >
      CHAT_LAST_MESSAGE_PREVIEW_MAX_CODE_POINTS
  ) {
    return contractError(`${path}.contentPreview`, "bounded message preview");
  }
  return {
    id: objectIdAt(message.id, `${path}.id`),
    sequence: safeIntegerAt(message.sequence, `${path}.sequence`, 1),
    kind: enumAt(message.kind, `${path}.kind`, CHAT_MESSAGE_KINDS),
    sender: decodeConversationParticipant(message.sender, `${path}.sender`),
    contentPreview,
    safeLink:
      message.safeLink === null
        ? null
        : decodeSafeLink(message.safeLink, `${path}.safeLink`),
    createdAt: dateAt(message.createdAt, `${path}.createdAt`),
  };
}

function decodeViewer(value: unknown, path: string): ConversationViewerDTO {
  const viewer = exactObjectAt(value, path, [
    "role",
    "status",
    "lastReadSequence",
    "unreadCount",
    "muted",
    "canSend",
    "canAnnounce",
    "accessMode",
  ]);
  const canSend = booleanAt(viewer.canSend, `${path}.canSend`);
  const canAnnounce = booleanAt(
    viewer.canAnnounce,
    `${path}.canAnnounce`,
  );
  const accessMode = enumAt(
    viewer.accessMode,
    `${path}.accessMode`,
    CONVERSATION_ACCESS_MODES,
  );
  if (canSend !== (accessMode === "read_write")) {
    return contractError(`${path}.canSend`, "value consistent with accessMode");
  }
  return {
    role: enumAt(viewer.role, `${path}.role`, CONVERSATION_MEMBER_ROLES),
    status: enumAt(
      viewer.status,
      `${path}.status`,
      CONVERSATION_MEMBER_STATUSES,
    ),
    lastReadSequence: safeIntegerAt(
      viewer.lastReadSequence,
      `${path}.lastReadSequence`,
      0,
    ),
    unreadCount: safeIntegerAt(
      viewer.unreadCount,
      `${path}.unreadCount`,
      0,
    ),
    muted: booleanAt(viewer.muted, `${path}.muted`),
    canSend,
    canAnnounce,
    accessMode,
  };
}

export function decodeConversation(
  value: unknown,
  path = "data.conversation",
): ConversationDTO {
  const conversation = exactObjectAt(value, path, [
    "id",
    "kind",
    "status",
    "section",
    "title",
    "helpRequestId",
    "programId",
    "counterpart",
    "lastSequence",
    "lastMessage",
    "viewer",
    "createdAt",
    "archivedAt",
    "updatedAt",
  ]);
  const kind = enumAt(
    conversation.kind,
    `${path}.kind`,
    CONVERSATION_KINDS,
  );
  const helpRequestId = nullableObjectIdAt(
    conversation.helpRequestId,
    `${path}.helpRequestId`,
  );
  const programId = nullableObjectIdAt(
    conversation.programId,
    `${path}.programId`,
  );
  if (
    (kind === "alumni_help" && (!helpRequestId || programId)) ||
    (kind === "program" && (!programId || helpRequestId))
  ) {
    return contractError(path, "resource identity consistent with kind");
  }
  const id = objectIdAt(conversation.id, `${path}.id`);
  const lastMessage =
    conversation.lastMessage === null
      ? null
      : decodeChatMessagePreview(
          conversation.lastMessage,
          `${path}.lastMessage`,
        );
  const viewer = decodeViewer(conversation.viewer, `${path}.viewer`);
  if (
    viewer.canAnnounce &&
    (kind !== "program" ||
      conversation.status !== "current" ||
      conversation.section !== "current" ||
      viewer.status !== "active" ||
      !viewer.canSend)
  ) {
    return contractError(
      `${path}.viewer.canAnnounce`,
      "current writable Program Room announcement access",
    );
  }
  return {
    id,
    kind,
    status: enumAt(
      conversation.status,
      `${path}.status`,
      CONVERSATION_STATUSES,
    ),
    section: enumAt(
      conversation.section,
      `${path}.section`,
      CONVERSATION_SECTIONS,
    ),
    title: nonemptyStringAt(conversation.title, `${path}.title`),
    helpRequestId,
    programId,
    counterpart:
      conversation.counterpart === null
        ? null
        : decodeConversationParticipant(
            conversation.counterpart,
            `${path}.counterpart`,
          ),
    lastSequence: safeIntegerAt(
      conversation.lastSequence,
      `${path}.lastSequence`,
      0,
    ),
    lastMessage,
    viewer,
    createdAt: dateAt(conversation.createdAt, `${path}.createdAt`),
    archivedAt: nullableDateAt(
      conversation.archivedAt,
      `${path}.archivedAt`,
    ),
    updatedAt: dateAt(conversation.updatedAt, `${path}.updatedAt`),
  };
}

function decodePagination(
  value: unknown,
  path: string,
): ConversationPaginationDTO {
  const pagination = exactObjectAt(value, path, [
    "currentPage",
    "totalPages",
    "totalCount",
    "hasNext",
    "hasPrev",
  ]);
  const currentPage = safeIntegerAt(
    pagination.currentPage,
    `${path}.currentPage`,
    1,
  );
  const totalPages = safeIntegerAt(
    pagination.totalPages,
    `${path}.totalPages`,
    0,
  );
  const totalCount = safeIntegerAt(
    pagination.totalCount,
    `${path}.totalCount`,
    0,
  );
  const hasNext = booleanAt(pagination.hasNext, `${path}.hasNext`);
  const hasPrev = booleanAt(pagination.hasPrev, `${path}.hasPrev`);
  if (hasNext !== (currentPage < totalPages)) {
    return contractError(`${path}.hasNext`, "value consistent with pagination");
  }
  if (hasPrev !== (totalCount > 0 && currentPage > 1)) {
    return contractError(`${path}.hasPrev`, "value consistent with pagination");
  }
  if ((totalCount === 0) !== (totalPages === 0)) {
    return contractError(path, "consistent totalCount and totalPages");
  }
  return { currentPage, totalPages, totalCount, hasNext, hasPrev };
}

export function decodeConversationList(value: unknown): ConversationListDTO {
  const data = exactObjectAt(value, "data", [
    "conversations",
    "pagination",
    "chatUnreadTotal",
  ]);
  return {
    conversations: arrayAt(
      data.conversations,
      "data.conversations",
      decodeConversation,
    ),
    pagination: decodePagination(data.pagination, "data.pagination"),
    chatUnreadTotal: safeIntegerAt(
      data.chatUnreadTotal,
      "data.chatUnreadTotal",
      0,
    ),
  };
}

export function decodeConversationDetail(
  value: unknown,
): ConversationDetailDTO {
  const data = exactObjectAt(value, "data", [
    "conversation",
    "chatUnreadTotal",
  ]);
  return {
    conversation: decodeConversation(data.conversation),
    chatUnreadTotal: safeIntegerAt(
      data.chatUnreadTotal,
      "data.chatUnreadTotal",
      0,
    ),
  };
}

export function decodeProgramChatRoomLink(
  value: unknown,
): ProgramChatRoomLinkDataDTO {
  const data = exactObjectAt(value, "data", ["room"]);
  const room = exactObjectAt(data.room, "data.room", [
    "id",
    "programId",
    "status",
    "section",
    "viewer",
  ]);
  const viewer = exactObjectAt(room.viewer, "data.room.viewer", [
    "status",
    "accessMode",
  ]);
  const status = enumAt(
    room.status,
    "data.room.status",
    CONVERSATION_STATUSES,
  );
  const section = enumAt(
    room.section,
    "data.room.section",
    CONVERSATION_SECTIONS,
  );
  const viewerStatus = enumAt(
    viewer.status,
    "data.room.viewer.status",
    CONVERSATION_MEMBER_STATUSES,
  );
  const accessMode = enumAt(
    viewer.accessMode,
    "data.room.viewer.accessMode",
    CONVERSATION_ACCESS_MODES,
  );
  const expectedSection =
    status === "current" && viewerStatus === "active" ? "current" : "past";
  if (section !== expectedSection) {
    return contractError(
      "data.room.section",
      "value consistent with Room and member status",
    );
  }
  if (section === "past" && accessMode !== "read_only") {
    return contractError(
      "data.room.viewer.accessMode",
      "read_only access for a past Room",
    );
  }
  return {
    room: {
      id: objectIdAt(room.id, "data.room.id"),
      programId: objectIdAt(room.programId, "data.room.programId"),
      status,
      section,
      viewer: { status: viewerStatus, accessMode },
    },
  };
}

export function decodeChatMessageMutation(
  value: unknown,
): ChatMessageMutationDTO {
  const data = exactObjectAt(value, "data", [
    "message",
    "roomUnreadCount",
    "chatUnreadTotal",
  ]);
  return {
    message: decodeChatMessage(data.message),
    roomUnreadCount: safeIntegerAt(
      data.roomUnreadCount,
      "data.roomUnreadCount",
      0,
    ),
    chatUnreadTotal: safeIntegerAt(
      data.chatUnreadTotal,
      "data.chatUnreadTotal",
      0,
    ),
  };
}

export function decodeChatHistory(value: unknown): ChatHistoryDTO {
  const data = exactObjectAt(value, "data", [
    "conversationId",
    "messages",
    "pagination",
    "roomUnreadCount",
    "chatUnreadTotal",
  ]);
  const pagination = exactObjectAt(data.pagination, "data.pagination", [
    "limit",
    "hasMore",
    "beforeSequence",
    "afterSequence",
    "nextBeforeSequence",
    "nextAfterSequence",
  ]);
  const messages = arrayAt(data.messages, "data.messages", decodeChatMessage);
  const conversationId = objectIdAt(
    data.conversationId,
    "data.conversationId",
  );
  if (messages.some((message) => message.conversationId !== conversationId)) {
    return contractError(
      "data.messages[].conversationId",
      "history conversation ID",
    );
  }
  for (let index = 1; index < messages.length; index += 1) {
    if (messages[index - 1].sequence >= messages[index].sequence) {
      return contractError("data.messages", "strict ascending sequence order");
    }
  }
  const limit = safeIntegerAt(pagination.limit, "data.pagination.limit", 1);
  if (limit > CHAT_HISTORY_MAX_PAGE_SIZE) {
    return contractError("data.pagination.limit", "integer from 1 to 100");
  }
  if (
    pagination.beforeSequence !== null &&
    pagination.afterSequence !== null
  ) {
    return contractError(
      "data.pagination",
      "mutually exclusive beforeSequence or afterSequence",
    );
  }
  return {
    conversationId,
    messages,
    pagination: {
      limit,
      hasMore: booleanAt(
        pagination.hasMore,
        "data.pagination.hasMore",
      ),
      beforeSequence:
        pagination.beforeSequence === null
          ? null
          : safeIntegerAt(
              pagination.beforeSequence,
              "data.pagination.beforeSequence",
              1,
            ),
      afterSequence:
        pagination.afterSequence === null
          ? null
          : safeIntegerAt(
              pagination.afterSequence,
              "data.pagination.afterSequence",
              0,
            ),
      nextBeforeSequence: nullableSequenceAt(
        pagination.nextBeforeSequence,
        "data.pagination.nextBeforeSequence",
      ),
      nextAfterSequence: nullableSequenceAt(
        pagination.nextAfterSequence,
        "data.pagination.nextAfterSequence",
      ),
    },
    roomUnreadCount: safeIntegerAt(
      data.roomUnreadCount,
      "data.roomUnreadCount",
      0,
    ),
    chatUnreadTotal: safeIntegerAt(
      data.chatUnreadTotal,
      "data.chatUnreadTotal",
      0,
    ),
  };
}

export function decodeChatReadMutation(value: unknown): ChatReadMutationDTO {
  const data = exactObjectAt(value, "data", [
    "conversationId",
    "lastReadSequence",
    "unreadCount",
    "chatUnreadTotal",
  ]);
  return {
    conversationId: objectIdAt(data.conversationId, "data.conversationId"),
    lastReadSequence: safeIntegerAt(
      data.lastReadSequence,
      "data.lastReadSequence",
      0,
    ),
    unreadCount: safeIntegerAt(data.unreadCount, "data.unreadCount", 0),
    chatUnreadTotal: safeIntegerAt(
      data.chatUnreadTotal,
      "data.chatUnreadTotal",
      0,
    ),
  };
}

export function decodeChatMuteMutation(value: unknown): ChatMuteMutationDTO {
  const data = exactObjectAt(value, "data", [
    "conversationId",
    "muted",
    "chatUnreadTotal",
  ]);
  return {
    conversationId: objectIdAt(data.conversationId, "data.conversationId"),
    muted: booleanAt(data.muted, "data.muted"),
    chatUnreadTotal: safeIntegerAt(
      data.chatUnreadTotal,
      "data.chatUnreadTotal",
      0,
    ),
  };
}

export function decodeChatUnreadCount(value: unknown): ChatUnreadCountDTO {
  const data = exactObjectAt(value, "data", ["chatUnreadTotal"]);
  return {
    chatUnreadTotal: safeIntegerAt(
      data.chatUnreadTotal,
      "data.chatUnreadTotal",
      0,
    ),
  };
}

export function decodeChatMessageEvent(value: unknown): ChatMessageEventDTO {
  const event = exactObjectAt(value, "event", ["message", "timestamp"]);
  return {
    message: decodeChatMessage(event.message, "event.message"),
    timestamp: dateAt(event.timestamp, "event.timestamp"),
  };
}

export function decodeChatUnreadUpdate(value: unknown): ChatUnreadUpdateDTO {
  const event = exactObjectAt(value, "event", [
    "conversationId",
    "roomUnreadCount",
    "chatUnreadTotal",
    "lastReadSequence",
    "timestamp",
  ]);
  return {
    conversationId: objectIdAt(
      event.conversationId,
      "event.conversationId",
    ),
    roomUnreadCount: safeIntegerAt(
      event.roomUnreadCount,
      "event.roomUnreadCount",
      0,
    ),
    chatUnreadTotal: safeIntegerAt(
      event.chatUnreadTotal,
      "event.chatUnreadTotal",
      0,
    ),
    lastReadSequence: safeIntegerAt(
      event.lastReadSequence,
      "event.lastReadSequence",
      0,
    ),
    timestamp: dateAt(event.timestamp, "event.timestamp"),
  };
}

export function isValidChatSafeLinkUrl(value: string): boolean {
  try {
    safeUrlAt(value, "safeLink.url");
    return true;
  } catch {
    return false;
  }
}
