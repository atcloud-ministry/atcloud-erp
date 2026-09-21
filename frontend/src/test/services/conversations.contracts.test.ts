import { describe, expect, it } from "vitest";
import {
  decodeChatHistory,
  decodeChatMessage,
  decodeChatUnreadUpdate,
  decodeConversation,
  decodeConversationParticipant,
  decodeConversationList,
  decodeProgramChatRoomLink,
} from "../../services/api/conversations.contracts";

const IDS = {
  room: "64b000000000000000000001",
  request: "64b000000000000000000002",
  user: "64b000000000000000000003",
  message: "64b000000000000000000004",
};

const participant = {
  id: IDS.user,
  displayName: "Amy Chen",
  avatar: null,
};

const message = {
  id: IDS.message,
  conversationId: IDS.room,
  sequence: 1,
  kind: "text",
  sender: participant,
  content: "Hello",
  safeLink: null,
  clientMessageId: "20000000-0000-4000-8000-000000000001",
  createdAt: "2026-09-13T12:00:00.000Z",
};

const preview = {
  id: IDS.message,
  sequence: 1,
  kind: "text",
  sender: participant,
  contentPreview: "Hello",
  safeLink: null,
  createdAt: "2026-09-13T12:00:00.000Z",
};

const conversation = {
  id: IDS.room,
  kind: "alumni_help",
  status: "current",
  section: "current",
  title: "Amy Chen",
  helpRequestId: IDS.request,
  programId: null,
  counterpart: participant,
  lastSequence: 1,
  lastMessage: preview,
  viewer: {
    role: "requester",
    status: "active",
    lastReadSequence: 0,
    unreadCount: 1,
    muted: false,
    canSend: true,
    canAnnounce: false,
    accessMode: "read_write",
  },
  archivedAt: null,
  createdAt: "2026-09-13T11:00:00.000Z",
  updatedAt: "2026-09-13T12:00:00.000Z",
};

describe("Conversations API response contracts", () => {
  it("decodes a viewer-scoped room list and bounded preview", () => {
    expect(
      decodeConversationList({
        conversations: [conversation],
        pagination: {
          currentPage: 1,
          totalPages: 1,
          totalCount: 1,
          hasNext: false,
          hasPrev: false,
        },
        chatUnreadTotal: 1,
      }),
    ).toMatchObject({
      conversations: [{ id: IDS.room, lastMessage: { contentPreview: "Hello" } }],
      chatUnreadTotal: 1,
    });
  });

  it("accepts an empty out-of-range page without a previous-page claim", () => {
    expect(
      decodeConversationList({
        conversations: [],
        pagination: {
          currentPage: 2,
          totalPages: 0,
          totalCount: 0,
          hasNext: false,
          hasPrev: false,
        },
        chatUnreadTotal: 0,
      }).pagination,
    ).toMatchObject({ currentPage: 2, hasPrev: false });
  });

  it("rejects extra raw-resource fields and inconsistent access capability", () => {
    expect(() =>
      decodeConversation({ ...conversation, rawUser: { email: "private@example.com" } }),
    ).toThrow(/exact keys/);
    expect(() =>
      decodeConversation({
        ...conversation,
        viewer: { ...conversation.viewer, canSend: false },
      }),
    ).toThrow(/consistent with accessMode/);
  });

  it("accepts only server-granted announcement capability on a current Program Room", () => {
    const programConversation = {
      ...conversation,
      kind: "program",
      title: "EMBA 2026",
      helpRequestId: null,
      programId: IDS.request,
      counterpart: null,
      viewer: {
        ...conversation.viewer,
        role: "mentee",
        canAnnounce: true,
      },
    };
    expect(decodeConversation(programConversation).viewer.canAnnounce).toBe(true);
    expect(() =>
      decodeConversation({
        ...conversation,
        viewer: { ...conversation.viewer, canAnnounce: true },
      }),
    ).toThrow(/Program Room announcement access/);
    expect(() =>
      decodeConversation({
        ...programConversation,
        section: "past",
        viewer: {
          ...programConversation.viewer,
          status: "history_only",
          canSend: false,
          accessMode: "read_only",
        },
      }),
    ).toThrow(/Program Room announcement access/);
  });

  it("accepts safe-link-only messages but rejects unsafe URLs", () => {
    expect(
      decodeChatMessage({
        ...message,
        content: null,
        safeLink: { url: "https://example.com/resource", label: "Resource" },
      }).safeLink,
    ).toEqual({ url: "https://example.com/resource", label: "Resource" });
    expect(() =>
      decodeChatMessage({
        ...message,
        safeLink: { url: "javascript:alert(1)", label: "Unsafe" },
      }),
    ).toThrow(/HTTP/);
    expect(() =>
      decodeChatMessage({
        ...message,
        safeLink: {
          url: "https://example.com/resource",
          label: "x".repeat(201),
        },
      }),
    ).toThrow(/at most 200 code points/);
  });

  it("bounds participant display names and avatars before rendering", () => {
    expect(
      decodeConversationParticipant(
        {
          ...participant,
          displayName: "😀".repeat(160),
          avatar: "a".repeat(2_048),
        },
        "participant",
      ),
    ).toMatchObject({ id: IDS.user });
    expect(() =>
      decodeConversationParticipant(
        { ...participant, displayName: "😀".repeat(161) },
        "participant",
      ),
    ).toThrow(/at most 160 code points/);
    expect(() =>
      decodeConversationParticipant(
        { ...participant, avatar: "a".repeat(2_049) },
        "participant",
      ),
    ).toThrow(/at most 2048 code points/);
  });

  it("requires strictly ascending, conversation-scoped history", () => {
    const base = {
      conversationId: IDS.room,
      messages: [message, { ...message, id: "64b000000000000000000005", sequence: 2 }],
      pagination: {
        limit: 50,
        hasMore: false,
        beforeSequence: null,
        afterSequence: null,
        nextBeforeSequence: null,
        nextAfterSequence: null,
      },
      roomUnreadCount: 2,
      chatUnreadTotal: 2,
    };
    expect(decodeChatHistory(base).messages.map((item) => item.sequence)).toEqual([1, 2]);
    expect(() =>
      decodeChatHistory({ ...base, messages: [...base.messages].reverse() }),
    ).toThrow(/ascending/);
    expect(() =>
      decodeChatHistory({
        ...base,
        messages: [{ ...message, conversationId: IDS.request }],
      }),
    ).toThrow(/history conversation ID/);
  });

  it("rejects ambiguous history cursors and invalid realtime counters", () => {
    expect(() =>
      decodeChatHistory({
        conversationId: IDS.room,
        messages: [],
        pagination: {
          limit: 50,
          hasMore: false,
          beforeSequence: 4,
          afterSequence: 5,
          nextBeforeSequence: null,
          nextAfterSequence: null,
        },
        roomUnreadCount: 0,
        chatUnreadTotal: 0,
      }),
    ).toThrow(/mutually exclusive/);
    expect(() =>
      decodeChatUnreadUpdate({
        conversationId: IDS.room,
        roomUnreadCount: -1,
        chatUnreadTotal: 0,
        lastReadSequence: 0,
        timestamp: "2026-09-13T12:00:00.000Z",
      }),
    ).toThrow(/safe integer/);
  });

  it("decodes a membership-scoped Program Room link and rejects incoherent access", () => {
    const data = {
      room: {
        id: IDS.room,
        programId: IDS.request,
        status: "current",
        section: "past",
        viewer: { status: "history_only", accessMode: "read_only" },
      },
    };
    expect(decodeProgramChatRoomLink(data)).toEqual(data);
    expect(() =>
      decodeProgramChatRoomLink({
        room: {
          ...data.room,
          section: "current",
        },
      }),
    ).toThrow(/consistent with Room and member status/);
    expect(() =>
      decodeProgramChatRoomLink({
        room: {
          ...data.room,
          viewer: { status: "history_only", accessMode: "read_write" },
        },
      }),
    ).toThrow(/read_only access/);
  });
});
