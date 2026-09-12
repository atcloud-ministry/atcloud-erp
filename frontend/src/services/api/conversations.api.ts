import { BaseApiClient } from "./common";
import {
  CHAT_HISTORY_DEFAULT_PAGE_SIZE,
  CHAT_HISTORY_MAX_PAGE_SIZE,
  CHAT_HTTP_PAYLOAD_MAX_BYTES,
  CHAT_MESSAGE_MAX_CODE_POINTS,
  CHAT_ROOM_DEFAULT_PAGE_SIZE,
  CHAT_ROOM_MAX_PAGE_SIZE,
  CHAT_SAFE_LINK_MAX_LABEL_CODE_POINTS,
  CONVERSATION_SECTIONS,
  decodeChatHistory,
  decodeChatMuteMutation,
  decodeChatMessageMutation,
  decodeChatReadMutation,
  decodeChatUnreadCount,
  decodeConversationDetail,
  decodeConversationList,
  isValidChatSafeLinkUrl,
  type ChatHistoryDTO,
  type ChatMuteMutationDTO,
  type ChatMessageMutationDTO,
  type ChatReadMutationDTO,
  type ConversationDetailDTO,
  type ConversationListDTO,
  type ConversationSection,
} from "./conversations.contracts";

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ConversationListParams {
  view: ConversationSection;
  page?: number;
  limit?: number;
}

export interface ChatHistoryParams {
  beforeSequence?: number;
  afterSequence?: number;
  limit?: number;
}

export interface SendChatMessageInput {
  clientMessageId: string;
  content: string | null;
  safeLink?: {
    url: string;
    label?: string;
  };
}

function requireObjectId(value: string, label: string): string {
  if (!OBJECT_ID_PATTERN.test(value)) {
    throw new Error(`${label} must be a valid ObjectId`);
  }
  return value;
}

function requireUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new Error("clientMessageId must be an RFC 4122 UUID");
  }
  return value;
}

function requirePage(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Conversation page must be a positive integer");
  }
  return value;
}

function requireLimit(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function requireSequence(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function requireNonNegativeSequence(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function conversationPath(conversationId: string): string {
  return `/conversations/${encodeURIComponent(
    requireObjectId(conversationId, "Conversation ID"),
  )}`;
}

function normalizeContent(value: string): string {
  const content = value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  if (!content) throw new Error("Enter a message before sending");
  if (Array.from(content).length > CHAT_MESSAGE_MAX_CODE_POINTS) {
    throw new Error("Messages cannot exceed 4,000 characters");
  }
  return content;
}

class ConversationsApiClient extends BaseApiClient {
  async list(
    params: ConversationListParams,
    signal?: AbortSignal,
  ): Promise<ConversationListDTO> {
    if (!CONVERSATION_SECTIONS.includes(params.view)) {
      throw new Error("Invalid conversation view");
    }
    const page = requirePage(params.page ?? 1);
    const limit = requireLimit(
      params.limit ?? CHAT_ROOM_DEFAULT_PAGE_SIZE,
      CHAT_ROOM_MAX_PAGE_SIZE,
      "Conversation limit",
    );
    const maximumPage = Math.floor(
      (Number.MAX_SAFE_INTEGER - (limit - 1)) / limit,
    );
    if (page > maximumPage) {
      throw new Error("Conversation page is outside the supported range");
    }
    const query = new URLSearchParams({
      view: params.view,
      page: String(page),
      limit: String(limit),
    });
    const response = await this.request<unknown>(
      `/conversations?${query.toString()}`,
      { signal },
    );
    if (response.data === undefined) {
      throw new Error(response.message || "Failed to load Chat Rooms");
    }
    return decodeConversationList(response.data);
  }

  async getUnreadCount(signal?: AbortSignal): Promise<number> {
    const response = await this.request<unknown>(
      "/conversations/unread-count",
      { signal },
    );
    if (response.data === undefined) {
      throw new Error(response.message || "Failed to load chat unread count");
    }
    return decodeChatUnreadCount(response.data).chatUnreadTotal;
  }

  async get(
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<ConversationDetailDTO> {
    const response = await this.request<unknown>(conversationPath(conversationId), {
      signal,
    });
    if (response.data === undefined) {
      throw new Error(response.message || "Failed to load Chat Room");
    }
    return decodeConversationDetail(response.data);
  }

  async history(
    conversationId: string,
    params: ChatHistoryParams = {},
    signal?: AbortSignal,
  ): Promise<ChatHistoryDTO> {
    if (
      params.beforeSequence !== undefined &&
      params.afterSequence !== undefined
    ) {
      throw new Error(
        "Chat history cannot request beforeSequence and afterSequence together",
      );
    }
    const query = new URLSearchParams({
      limit: String(
        requireLimit(
          params.limit ?? CHAT_HISTORY_DEFAULT_PAGE_SIZE,
          CHAT_HISTORY_MAX_PAGE_SIZE,
          "Chat history limit",
        ),
      ),
    });
    if (params.beforeSequence !== undefined) {
      query.set(
        "beforeSequence",
        String(requireSequence(params.beforeSequence, "beforeSequence")),
      );
    }
    if (params.afterSequence !== undefined) {
      query.set(
        "afterSequence",
        String(
          requireNonNegativeSequence(params.afterSequence, "afterSequence"),
        ),
      );
    }
    const response = await this.request<unknown>(
      `${conversationPath(conversationId)}/messages?${query.toString()}`,
      { signal },
    );
    if (response.data === undefined) {
      throw new Error(response.message || "Failed to load chat history");
    }
    return decodeChatHistory(response.data);
  }

  async send(
    conversationId: string,
    input: SendChatMessageInput,
  ): Promise<ChatMessageMutationDTO> {
    const clientMessageId = requireUuid(input.clientMessageId);
    if (input.safeLink && !isValidChatSafeLinkUrl(input.safeLink.url)) {
      throw new Error("The shared link must use a valid http:// or https:// URL");
    }
    const normalizedContent = input.content
      ? normalizeContent(input.content)
      : null;
    if (!normalizedContent && !input.safeLink) {
      throw new Error("Enter a message or link before sending");
    }
    const safeLinkLabel = input.safeLink
      ? (input.safeLink.label?.normalize("NFC").replace(/\s+/gu, " ").trim() ||
        input.safeLink.url)
      : null;
    if (
      safeLinkLabel &&
      Array.from(safeLinkLabel).length > CHAT_SAFE_LINK_MAX_LABEL_CODE_POINTS
    ) {
      throw new Error("Link labels cannot exceed 200 characters");
    }
    const body = {
      clientMessageId,
      content: normalizedContent,
      ...(input.safeLink
        ? {
            safeLink: {
              url: input.safeLink.url,
              label: safeLinkLabel,
            },
          }
        : {}),
    };
    if (
      new TextEncoder().encode(JSON.stringify(body)).byteLength >
      CHAT_HTTP_PAYLOAD_MAX_BYTES
    ) {
      throw new Error("The message payload cannot exceed 16 KiB");
    }
    const response = await this.request<unknown>(
      `${conversationPath(conversationId)}/messages`,
      {
        method: "POST",
        headers: { "Idempotency-Key": clientMessageId },
        body: JSON.stringify(body),
      },
    );
    if (response.data === undefined) {
      throw new Error(response.message || "Failed to send message");
    }
    return decodeChatMessageMutation(response.data);
  }

  async markRead(
    conversationId: string,
    throughSequence: number,
  ): Promise<ChatReadMutationDTO> {
    const response = await this.request<unknown>(
      `${conversationPath(conversationId)}/read`,
      {
        method: "PATCH",
        body: JSON.stringify({
          throughSequence:
            throughSequence === 0
              ? 0
              : requireSequence(throughSequence, "throughSequence"),
        }),
      },
    );
    if (response.data === undefined) {
      throw new Error(response.message || "Failed to update read state");
    }
    return decodeChatReadMutation(response.data);
  }

  async setMuted(
    conversationId: string,
    muted: boolean,
  ): Promise<ChatMuteMutationDTO> {
    if (typeof muted !== "boolean") throw new Error("muted must be boolean");
    const response = await this.request<unknown>(
      `${conversationPath(conversationId)}/mute`,
      { method: "PATCH", body: JSON.stringify({ muted }) },
    );
    if (response.data === undefined) {
      throw new Error(response.message || "Failed to update Room notifications");
    }
    return decodeChatMuteMutation(response.data);
  }
}

export const conversationsService = new ConversationsApiClient();
export { ConversationsApiClient };
