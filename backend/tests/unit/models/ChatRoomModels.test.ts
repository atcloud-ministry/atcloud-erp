import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { describe, expect, it } from "vitest";
import {
  CHAT_MESSAGE_MAX_SERIALIZED_PAYLOAD_BYTES,
  chatMessagePurgeAt,
  chatPayloadUtf8Bytes,
  conversationPurgeAt,
  isSequenceVisibleInAccessWindows,
  isUnreadChatMessage,
  isValidChatMessagePayload,
} from "../../../src/contracts/chatRooms";
import ChatMessage from "../../../src/models/ChatMessage";
import Conversation from "../../../src/models/Conversation";
import ConversationMember from "../../../src/models/ConversationMember";

const CREATED_AT = new Date("2026-08-31T12:30:00.000Z");

function chatMessage(overrides: Record<string, unknown> = {}) {
  return new ChatMessage({
    conversationId: new mongoose.Types.ObjectId(),
    sequence: 1,
    senderId: new mongoose.Types.ObjectId(),
    senderSnapshot: { displayName: "  Amy   Chen  ", avatar: null },
    clientMessageId: randomUUID(),
    kind: "text",
    content: " Hello\r\nthere ",
    safeLink: null,
    createdAt: CREATED_AT,
    purgeAt: chatMessagePurgeAt(CREATED_AT),
    ...overrides,
  });
}

function activeMember(overrides: Record<string, unknown> = {}) {
  return new ConversationMember({
    conversationId: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
    role: "requester",
    status: "active",
    joinedAt: CREATED_AT,
    accessWindows: [
      {
        visibleFromSequence: 1,
        visibleThroughSequence: null,
        openedAt: CREATED_AT,
        closedAt: null,
      },
    ],
    ...overrides,
  });
}

describe("chat room contract primitives", () => {
  it("uses the approved UTC calendar-month and archive/message retention clocks", () => {
    expect(chatMessagePurgeAt(CREATED_AT).toISOString()).toBe(
      "2027-08-31T12:30:00.000Z",
    );
    const archivedAt = new Date("2026-09-30T12:30:00.000Z");
    expect(conversationPurgeAt(archivedAt).toISOString()).toBe(
      "2028-09-30T12:30:00.000Z",
    );
    expect(
      conversationPurgeAt(
        archivedAt,
        new Date("2027-09-15T12:30:00.000Z"),
      ).toISOString(),
    ).toBe("2028-09-30T12:30:00.000Z");
  });

  it("accepts bounded text/safe links and measures the actual UTF-8 payload", () => {
    expect(isValidChatMessagePayload({ content: "a".repeat(4_000) })).toBe(true);
    expect(
      isValidChatMessagePayload({
        safeLink: { url: "https://example.org/jobs/123", label: "View link" },
      }),
    ).toBe(true);
    expect(isValidChatMessagePayload({ content: null, safeLink: null })).toBe(false);
    expect(
      isValidChatMessagePayload({
        safeLink: { url: "javascript:alert(1)", label: "Unsafe" },
      }),
    ).toBe(false);

    const emojiPayload = { content: "😀".repeat(4_000) };
    expect(chatPayloadUtf8Bytes(emojiPayload)).toBeLessThan(
      CHAT_MESSAGE_MAX_SERIALIZED_PAYLOAD_BYTES,
    );
    const oversizedPayload = {
      content: `${"😀".repeat(4_000)}${"a".repeat(500)}`,
    };
    expect(chatPayloadUtf8Bytes(oversizedPayload)).toBeGreaterThan(
      CHAT_MESSAGE_MAX_SERIALIZED_PAYLOAD_BYTES,
    );
    expect(isValidChatMessagePayload(oversizedPayload)).toBe(false);
  });

  it("applies access windows to current history and unread semantics", () => {
    const windows = [
      {
        visibleFromSequence: 2,
        visibleThroughSequence: 5,
        openedAt: CREATED_AT,
        closedAt: new Date("2026-09-01T12:30:00.000Z"),
      },
      {
        visibleFromSequence: 9,
        visibleThroughSequence: null,
        openedAt: new Date("2026-09-02T12:30:00.000Z"),
        closedAt: null,
      },
    ];
    expect(isSequenceVisibleInAccessWindows(1, windows)).toBe(false);
    expect(isSequenceVisibleInAccessWindows(5, windows)).toBe(true);
    expect(isSequenceVisibleInAccessWindows(7, windows)).toBe(false);
    expect(isSequenceVisibleInAccessWindows(9, windows)).toBe(true);
    expect(
      isUnreadChatMessage(
        { sequence: 10, senderId: "other", kind: "text" },
        "viewer",
        9,
        windows,
      ),
    ).toBe(true);
    expect(
      isUnreadChatMessage(
        { sequence: 10, senderId: "viewer", kind: "text" },
        "viewer",
        9,
        windows,
      ),
    ).toBe(false);
  });
});

describe("Conversation model", () => {
  it("requires a kind-specific resource identity and exact archive retention", async () => {
    const missingIdentity = new Conversation({ kind: "program" });
    await expect(missingIdentity.validate()).rejects.toThrow(
      "resource identity",
    );

    const archivedAt = new Date("2026-09-30T12:30:00.000Z");
    const latestMessagePurgeAt = new Date("2027-09-15T12:30:00.000Z");
    const room = new Conversation({
      kind: "program",
      programId: new mongoose.Types.ObjectId(),
      status: "archived",
      lastSequence: 4,
      lastMessageId: new mongoose.Types.ObjectId(),
      latestMessagePurgeAt,
      archivedAt,
      purgeAt: conversationPurgeAt(archivedAt, latestMessagePurgeAt),
    });
    await expect(room.validate()).resolves.toBeUndefined();

    room.purgeAt = new Date("2027-10-15T12:30:00.000Z");
    await expect(room.validate()).rejects.toThrow("approved retention");
  });

  it("declares resource uniqueness, room listing, and retention indexes", () => {
    expect(Conversation.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { helpRequestId: 1 },
          expect.objectContaining({
            unique: true,
            name: "uniq_conversation_alumni_help_request",
          }),
        ],
        [
          { programId: 1 },
          expect.objectContaining({
            unique: true,
            name: "uniq_conversation_program",
          }),
        ],
        [
          { purgeAt: 1 },
          expect.objectContaining({
            expireAfterSeconds: 0,
            name: "ttl_conversation_purge_at",
          }),
        ],
      ]),
    );
  });
});

describe("ConversationMember model", () => {
  it("validates active/history-only windows, unread, and mute state", async () => {
    await expect(activeMember().validate()).resolves.toBeUndefined();

    const historyOnly = activeMember({
      status: "history_only",
      accessWindows: [
        {
          visibleFromSequence: 1,
          visibleThroughSequence: 0,
          openedAt: CREATED_AT,
          closedAt: CREATED_AT,
        },
      ],
      unreadCount: 0,
    });
    await expect(historyOnly.validate()).resolves.toBeUndefined();

    historyOnly.unreadCount = 1;
    await expect(historyOnly.validate()).rejects.toThrow("unread count");

    const invalidMute = activeMember({ muted: true, mutedAt: null });
    await expect(invalidMute.validate()).rejects.toThrow("mutedAt");
  });

  it("rejects unordered, overlapping, or multiple open access windows", async () => {
    const overlapping = activeMember({
      accessWindows: [
        {
          visibleFromSequence: 1,
          visibleThroughSequence: 5,
          openedAt: CREATED_AT,
          closedAt: new Date("2026-09-01T12:30:00.000Z"),
        },
        {
          visibleFromSequence: 5,
          visibleThroughSequence: null,
          openedAt: new Date("2026-09-02T12:30:00.000Z"),
          closedAt: null,
        },
      ],
    });
    await expect(overlapping.validate()).rejects.toThrow("non-overlapping");
  });

  it("declares identity, access, unread, and retention indexes", () => {
    expect(ConversationMember.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { conversationId: 1, userId: 1 },
          expect.objectContaining({ unique: true }),
        ],
        [
          { userId: 1, status: 1, unreadCount: 1, conversationId: 1 },
          expect.objectContaining({
            name: "idx_conversation_member_user_unread",
          }),
        ],
        [
          { status: 1, unreadReconciledAt: 1, _id: 1 },
          expect.objectContaining({
            name: "idx_conversation_member_unread_reconciliation",
          }),
        ],
        [
          { purgeAt: 1 },
          expect.objectContaining({ expireAfterSeconds: 0 }),
        ],
      ]),
    );
  });
});

describe("ChatMessage model", () => {
  it("normalizes immutable sender and text snapshots with exact retention", async () => {
    const message = chatMessage();
    await expect(message.validate()).resolves.toBeUndefined();
    expect(message.senderSnapshot.displayName).toBe("Amy Chen");
    expect(message.content).toBe("Hello\nthere");
    expect(message.purgeAt.toISOString()).toBe("2027-08-31T12:30:00.000Z");
  });

  it("allows a safe link without text and rejects empty or invalid payloads", async () => {
    await expect(
      chatMessage({
        content: null,
        safeLink: {
          url: "https://example.org/referral?id=123",
          label: " Open   opportunity ",
        },
      }).validate(),
    ).resolves.toBeUndefined();
    await expect(
      chatMessage({ content: null, safeLink: null }).validate(),
    ).rejects.toThrow("text or safeLink");
    await expect(
      chatMessage({
        content: null,
        safeLink: { url: "file:///private/data", label: "Open" },
      }).validate(),
    ).rejects.toThrow();
  });

  it("rejects retention drift and declares sequence/retry/TTL indexes", async () => {
    await expect(
      chatMessage({ purgeAt: new Date("2027-09-01T12:30:00.000Z") }).validate(),
    ).rejects.toThrow("twelve UTC calendar months");

    expect(ChatMessage.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { conversationId: 1, sequence: 1 },
          expect.objectContaining({ unique: true }),
        ],
        [
          { conversationId: 1, senderId: 1, clientMessageId: 1 },
          expect.objectContaining({ unique: true }),
        ],
        [
          { purgeAt: 1 },
          expect.objectContaining({ expireAfterSeconds: 0 }),
        ],
      ]),
    );
  });
});
