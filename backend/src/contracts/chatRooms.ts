import { codePointLength } from "@atcloud/shared-time/registration-profile";
import {
  addFixedDays,
  addUtcCalendarMonths,
  isNonNegativeSafeInteger,
} from "./alumniDirectoryData";

export const CONVERSATION_KINDS = ["alumni_help", "program"] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

export const CONVERSATION_STATUSES = ["current", "archived"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

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

export const CHAT_MESSAGE_KINDS = ["text", "announcement"] as const;
export type ChatMessageKind = (typeof CHAT_MESSAGE_KINDS)[number];

export const CHAT_MESSAGE_RETENTION_MONTHS = 12;
export const CONVERSATION_RETENTION_MONTHS = 24;
export const CHAT_RETENTION_SAFETY_DAYS = 30;

export const CHAT_MESSAGE_FIELD_LIMITS = Object.freeze({
  content: 4_000,
  safeLinkUrl: 2_048,
  safeLinkLabel: 200,
});
export const CHAT_MESSAGE_MAX_SERIALIZED_PAYLOAD_BYTES = 16 * 1_024;

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const UNSAFE_CHAT_CONTROL_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

export interface ChatSafeLink {
  readonly url: string;
  readonly label: string;
}

export interface ChatMessagePayload {
  readonly content?: string | null;
  readonly safeLink?: ChatSafeLink | null;
}

export interface ConversationAccessWindowValue {
  readonly visibleFromSequence: number;
  readonly visibleThroughSequence?: number | null;
  readonly openedAt: Date;
  readonly closedAt?: Date | null;
}

export function chatMessagePurgeAt(createdAt: Date): Date {
  return addUtcCalendarMonths(createdAt, CHAT_MESSAGE_RETENTION_MONTHS);
}

export function conversationPurgeAt(
  archivedAt: Date,
  latestChatMessagePurgeAt?: Date | null,
): Date {
  const archiveClock = addUtcCalendarMonths(
    archivedAt,
    CONVERSATION_RETENTION_MONTHS,
  );
  if (!latestChatMessagePurgeAt) return archiveClock;
  const messageClock = addFixedDays(
    latestChatMessagePurgeAt,
    CHAT_RETENTION_SAFETY_DAYS,
  );
  return messageClock > archiveClock ? messageClock : archiveClock;
}

export function normalizeChatText(value: string): string {
  return value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
}

export function isValidChatText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !UNSAFE_CHAT_CONTROL_PATTERN.test(value) &&
    codePointLength(value) <= CHAT_MESSAGE_FIELD_LIMITS.content
  );
}

export function normalizeSafeLinkLabel(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

export function isValidSafeLinkLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !UNSAFE_CHAT_CONTROL_PATTERN.test(value) &&
    codePointLength(value) <= CHAT_MESSAGE_FIELD_LIMITS.safeLinkLabel
  );
}

export function isValidChatSafeLinkUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    codePointLength(value) > CHAT_MESSAGE_FIELD_LIMITS.safeLinkUrl ||
    UNSAFE_CHAT_CONTROL_PATTERN.test(value)
  ) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.hostname.length > 0 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0
    );
  } catch {
    return false;
  }
}

export function chatPayloadUtf8Bytes(
  payload: ChatMessagePayload,
): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

export function isValidChatMessagePayload(
  payload: ChatMessagePayload,
): boolean {
  const content = payload.content ?? null;
  const safeLink = payload.safeLink ?? null;
  return (
    (content !== null || safeLink !== null) &&
    (content === null || isValidChatText(content)) &&
    (safeLink === null ||
      (isValidChatSafeLinkUrl(safeLink.url) &&
        isValidSafeLinkLabel(safeLink.label))) &&
    chatPayloadUtf8Bytes(payload) <= CHAT_MESSAGE_MAX_SERIALIZED_PAYLOAD_BYTES
  );
}

export function isSequenceVisibleInAccessWindows(
  sequence: number,
  windows: readonly ConversationAccessWindowValue[],
): boolean {
  if (!Number.isSafeInteger(sequence) || sequence < 1) return false;
  return windows.some(
    (window) =>
      sequence >= window.visibleFromSequence &&
      (window.visibleThroughSequence == null ||
        sequence <= window.visibleThroughSequence),
  );
}

export function hasOpenAccessWindow(
  windows: readonly ConversationAccessWindowValue[],
): boolean {
  return windows.some((window) => window.visibleThroughSequence == null);
}

export function isValidAccessWindowSequenceRange(
  window: Pick<
    ConversationAccessWindowValue,
    "visibleFromSequence" | "visibleThroughSequence"
  >,
): boolean {
  return (
    Number.isSafeInteger(window.visibleFromSequence) &&
    window.visibleFromSequence >= 1 &&
    (window.visibleThroughSequence == null ||
      (isNonNegativeSafeInteger(window.visibleThroughSequence) &&
        window.visibleThroughSequence >= window.visibleFromSequence - 1))
  );
}

export interface ChatUnreadCandidate {
  readonly sequence: number;
  readonly senderId: string;
  readonly kind: ChatMessageKind;
}

export function isUnreadChatMessage(
  message: ChatUnreadCandidate,
  currentUserId: string,
  lastReadSequence: number,
  windows: readonly ConversationAccessWindowValue[],
): boolean {
  return (
    (message.kind === "text" || message.kind === "announcement") &&
    message.senderId !== currentUserId &&
    message.sequence > lastReadSequence &&
    isSequenceVisibleInAccessWindows(message.sequence, windows)
  );
}
