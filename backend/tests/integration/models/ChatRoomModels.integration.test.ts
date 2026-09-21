import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  chatMessagePurgeAt,
  conversationPurgeAt,
} from "../../../src/contracts/chatRooms";
import ChatMessage from "../../../src/models/ChatMessage";
import Conversation from "../../../src/models/Conversation";
import ConversationMember from "../../../src/models/ConversationMember";
import { initializeAlumniDataModels } from "../../../src/models/initializeAlumniDataModels";
import { ensureIntegrationDB } from "../setup/connect";

const models = [ChatMessage, ConversationMember, Conversation] as const;
const NOW = new Date("2026-09-12T12:00:00.000Z");

function messageInput(
  conversationId: mongoose.Types.ObjectId,
  senderId: mongoose.Types.ObjectId,
  overrides: Record<string, unknown> = {},
) {
  return {
    conversationId,
    sequence: 1,
    senderId,
    senderSnapshot: { displayName: "Amy Chen", avatar: null },
    clientMessageId: randomUUID(),
    kind: "text" as const,
    content: "Hello",
    safeLink: null,
    createdAt: NOW,
    purgeAt: chatMessagePurgeAt(NOW),
    ...overrides,
  };
}

describe("M4 chat room model indexes and persistence", () => {
  beforeAll(async () => {
    await ensureIntegrationDB();
    await initializeAlumniDataModels();
  });

  beforeEach(async () => {
    await Promise.all(models.map((model) => model.deleteMany({})));
  });

  afterAll(async () => {
    await Promise.all(models.map((model) => model.deleteMany({})));
  });

  it("creates stable identity, history, unread, retry, and TTL indexes", async () => {
    const [conversationIndexes, memberIndexes, messageIndexes] =
      await Promise.all([
        Conversation.collection.indexes(),
        ConversationMember.collection.indexes(),
        ChatMessage.collection.indexes(),
      ]);

    expect(conversationIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "uniq_conversation_alumni_help_request",
          key: { helpRequestId: 1 },
          unique: true,
        }),
        expect.objectContaining({
          name: "uniq_conversation_program",
          key: { programId: 1 },
          unique: true,
        }),
        expect.objectContaining({
          name: "ttl_conversation_purge_at",
          key: { purgeAt: 1 },
          expireAfterSeconds: 0,
        }),
        expect.objectContaining({
          name: "idx_program_conversation_membership_repair",
          key: { kind: 1, status: 1, _id: 1 },
        }),
        expect.objectContaining({
          name: "idx_alumni_help_conversation_grace_expiry",
          key: { kind: 1, status: 1, writeAccessEndsAt: 1, _id: 1 },
        }),
      ]),
    );
    expect(memberIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "uniq_conversation_member_user",
          key: { conversationId: 1, userId: 1 },
          unique: true,
        }),
        expect.objectContaining({
          name: "idx_conversation_member_user_unread",
          key: { userId: 1, status: 1, unreadCount: 1, conversationId: 1 },
        }),
        expect.objectContaining({
          name: "idx_conversation_member_unread_reconciliation",
          key: { status: 1, unreadReconciledAt: 1, _id: 1 },
        }),
        expect.objectContaining({
          name: "ttl_conversation_member_purge_at",
          expireAfterSeconds: 0,
        }),
      ]),
    );
    expect(messageIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "uniq_chat_message_room_sequence",
          key: { conversationId: 1, sequence: 1 },
          unique: true,
        }),
        expect.objectContaining({
          name: "uniq_chat_message_client_retry",
          key: { conversationId: 1, senderId: 1, clientMessageId: 1 },
          unique: true,
        }),
        expect.objectContaining({
          name: "idx_chat_message_room_kind_created_at",
          key: { conversationId: 1, kind: 1, createdAt: 1 },
        }),
        expect.objectContaining({
          name: "ttl_chat_message_purge_at",
          key: { purgeAt: 1 },
          expireAfterSeconds: 0,
        }),
      ]),
    );
  });

  it("persists access/read/mute primitives and permits same-role Program members", async () => {
    const conversation = await Conversation.create({
      kind: "program",
      programId: new mongoose.Types.ObjectId(),
    });
    const firstUserId = new mongoose.Types.ObjectId();
    const secondUserId = new mongoose.Types.ObjectId();
    await ConversationMember.create([
      {
        conversationId: conversation._id,
        userId: firstUserId,
        role: "mentee",
        status: "active",
        joinedAt: NOW,
        accessWindows: [
          {
            visibleFromSequence: 1,
            visibleThroughSequence: null,
            openedAt: NOW,
            closedAt: null,
          },
        ],
        lastReadSequence: 2,
        unreadCount: 3,
        unreadReconciledThroughSequence: 5,
        unreadReconciledAt: NOW,
        muted: true,
        mutedAt: NOW,
      },
      {
        conversationId: conversation._id,
        userId: secondUserId,
        role: "mentee",
        status: "active",
        joinedAt: NOW,
        accessWindows: [
          {
            visibleFromSequence: 1,
            visibleThroughSequence: null,
            openedAt: NOW,
            closedAt: null,
          },
        ],
      },
    ]);

    const stored = await ConversationMember.findOne({ userId: firstUserId })
      .lean()
      .orFail();
    expect(stored).toMatchObject({
      role: "mentee",
      status: "active",
      lastReadSequence: 2,
      unreadCount: 3,
      unreadReconciledThroughSequence: 5,
      muted: true,
    });
    expect(stored.accessWindows).toHaveLength(1);
  });

  it("enforces room sequence and sender-scoped client retry identities", async () => {
    const conversationId = new mongoose.Types.ObjectId();
    const senderId = new mongoose.Types.ObjectId();
    const clientMessageId = randomUUID();
    await ChatMessage.create(
      messageInput(conversationId, senderId, { clientMessageId }),
    );

    await expect(
      ChatMessage.create(
        messageInput(conversationId, new mongoose.Types.ObjectId(), {
          sequence: 1,
        }),
      ),
    ).rejects.toMatchObject({ code: 11000 });
    await expect(
      ChatMessage.create(
        messageInput(conversationId, senderId, {
          sequence: 2,
          clientMessageId,
        }),
      ),
    ).rejects.toMatchObject({ code: 11000 });

    await expect(
      ChatMessage.create(
        messageInput(conversationId, new mongoose.Types.ObjectId(), {
          sequence: 2,
          clientMessageId,
        }),
      ),
    ).resolves.toBeDefined();
  });

  it("retains immutable sender/safe-link history and approved purge clocks", async () => {
    const conversation = await Conversation.create({
      kind: "alumni_help",
      helpRequestId: new mongoose.Types.ObjectId(),
    });
    const message = await ChatMessage.create(
      messageInput(conversation._id, new mongoose.Types.ObjectId(), {
        content: null,
        safeLink: {
          url: "https://example.org/opportunities/123",
          label: "Opportunity",
        },
      }),
    );
    conversation.lastSequence = 1;
    conversation.lastMessageId = message._id;
    conversation.latestMessagePurgeAt = message.purgeAt;
    await conversation.save();

    const archivedAt = new Date("2026-10-01T12:00:00.000Z");
    conversation.status = "archived";
    conversation.archivedAt = archivedAt;
    conversation.purgeAt = conversationPurgeAt(
      archivedAt,
      message.purgeAt,
    );
    await conversation.save();

    const stored = await ChatMessage.findById(message._id).lean().orFail();
    expect(stored.senderSnapshot.displayName).toBe("Amy Chen");
    expect(stored.safeLink).toEqual({
      url: "https://example.org/opportunities/123",
      label: "Opportunity",
    });
    expect(stored.purgeAt.toISOString()).toBe("2027-09-12T12:00:00.000Z");
    expect(conversation.purgeAt?.toISOString()).toBe(
      "2028-10-01T12:00:00.000Z",
    );
  });
});
