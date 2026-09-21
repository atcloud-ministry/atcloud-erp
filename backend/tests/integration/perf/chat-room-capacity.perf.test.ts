import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatMessagePurgeAt } from "../../../src/contracts/chatRooms";
import { createRuntimeConfigDTO } from "../../../src/contracts/runtimeConfig";
import AuditLog from "../../../src/models/AuditLog";
import ChatMessage from "../../../src/models/ChatMessage";
import Conversation from "../../../src/models/Conversation";
import ConversationMember from "../../../src/models/ConversationMember";
import IdempotencyRecord from "../../../src/models/IdempotencyRecord";
import NotificationOutbox from "../../../src/models/NotificationOutbox";
import User from "../../../src/models/User";
import { enqueueChatMessagePersisted } from "../../../src/services/chat/ChatMessageOutbox";
import { ChatRoomService } from "../../../src/services/chat/ChatRoomService";
import { ChatSendRateLimiter } from "../../../src/services/chat/ChatSendRateLimiter";
import { IdempotencyService } from "../../../src/services/reliability/IdempotencyService";
import { MongoTransactionService } from "../../../src/services/reliability/MongoTransactionService";
import { ensureIntegrationDB } from "../setup/connect";

const APPROVED_PROFILE = process.env.M4_CHAT_LOAD_PROFILE === "approved";
const PROFILE = Object.freeze(
  APPROVED_PROFILE
    ? {
        name: "approved",
        users: 2_000,
        rooms: 5_000,
        messages: 1_000_000,
        samples: 25,
        sendSeconds: 5 * 60,
        sendsPerSecond: 20,
      }
    : {
        name: "smoke",
        users: 100,
        rooms: 100,
        messages: 5_000,
        samples: 10,
        sendSeconds: 2,
        sendsPerSecond: 20,
      },
);
const NOW = new Date("2032-09-12T12:00:00.000Z");
const MESSAGE_PURGE_AT = chatMessagePurgeAt(NOW);
const INSERT_BATCH_SIZE = 5_000;
const LIST_HISTORY_P95_MAX_MS = 1_000;
const SEND_ACK_P95_MAX_MS = 1_500;
const SEND_ACK_P99_MAX_MS = 3_000;

const collections = [
  AuditLog,
  ChatMessage,
  ConversationMember,
  Conversation,
  IdempotencyRecord,
  NotificationOutbox,
  User,
] as const;

let userIds: mongoose.Types.ObjectId[] = [];
let roomIds: mongoose.Types.ObjectId[] = [];
let roomMemberIds: Array<readonly [mongoose.Types.ObjectId, mongoose.Types.ObjectId]> = [];
let service: ChatRoomService;

function percentile(samples: readonly number[], value: number): number {
  if (samples.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...samples].sort((first, second) => first - second);
  return sorted[Math.max(0, Math.ceil(value * sorted.length) - 1)]!;
}

function deterministicUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

async function seedUsers(): Promise<void> {
  userIds = Array.from({ length: PROFILE.users }, () => new mongoose.Types.ObjectId());
  await User.collection.insertMany(
    userIds.map((_id, index) => ({
      _id,
      username: `m4-load-user-${index}`,
      usernameLower: `m4-load-user-${index}`,
      email: `m4-load-user-${index}@private.example.org`,
      phone: "+12065550199",
      birthYear: 1988,
      password: "load-test-only",
      firstName: `Member${index}`,
      lastName: "Load",
      avatar: null,
      role: "Participant",
      isAtCloudLeader: false,
      isActive: true,
      isVerified: true,
      emailNotifications: false,
      loginAttempts: 0,
      hasReceivedWelcomeMessage: false,
      createdAt: NOW,
      updatedAt: NOW,
    })),
  );
}

async function seedRoomsAndMembers(): Promise<void> {
  roomIds = Array.from({ length: PROFILE.rooms }, () => new mongoose.Types.ObjectId());
  roomMemberIds = roomIds.map((_roomId, index) => {
    const first = index < 30 ? userIds[0]! : userIds[(index * 2) % userIds.length]!;
    let second = userIds[(index * 2 + 1) % userIds.length]!;
    if (first.equals(second)) second = userIds[(index * 2 + 2) % userIds.length]!;
    return Object.freeze([first, second] as const);
  });
  await Conversation.collection.insertMany(
    roomIds.map((_id) => ({
      _id,
      kind: "alumni_help",
      status: "current",
      helpRequestId: new mongoose.Types.ObjectId(),
      programId: null,
      lastSequence: 0,
      lastMessageId: null,
      latestMessagePurgeAt: null,
      archivedAt: null,
      purgeAt: null,
      revision: 0,
      createdAt: NOW,
      updatedAt: NOW,
    })),
  );
  const memberDocuments = roomIds.flatMap((conversationId, index) =>
    roomMemberIds[index]!.map((userId, memberIndex) => ({
      _id: new mongoose.Types.ObjectId(),
      conversationId,
      userId,
      role: memberIndex === 0 ? "requester" : "provider",
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
      lastReadSequence: 0,
      unreadCount: 0,
      unreadReconciledThroughSequence: 0,
      unreadReconciledAt: NOW,
      muted: false,
      mutedAt: null,
      purgeAt: null,
      revision: 0,
      createdAt: NOW,
      updatedAt: NOW,
    })),
  );
  await ConversationMember.collection.insertMany(memberDocuments);
}

async function seedMessages(): Promise<void> {
  const basePerRoom = Math.floor(PROFILE.messages / PROFILE.rooms);
  const extraRooms = PROFILE.messages % PROFILE.rooms;
  let globalIndex = 1;
  let batch: Record<string, unknown>[] = [];
  const roomUpdates: Parameters<typeof Conversation.collection.bulkWrite>[0] = [];
  for (let roomIndex = 0; roomIndex < roomIds.length; roomIndex += 1) {
    const conversationId = roomIds[roomIndex]!;
    const count = basePerRoom + (roomIndex < extraRooms ? 1 : 0);
    let lastMessageId: mongoose.Types.ObjectId | null = null;
    for (let sequence = 1; sequence <= count; sequence += 1) {
      const _id = new mongoose.Types.ObjectId();
      lastMessageId = _id;
      const senderId = roomMemberIds[roomIndex]![sequence % 2];
      batch.push({
        _id,
        conversationId,
        sequence,
        senderId,
        senderSnapshot: {
          displayName: `Load Member ${senderId.toString().slice(-6)}`,
          avatar: null,
        },
        clientMessageId: deterministicUuid(globalIndex),
        kind: "text",
        content: `capacity-message-${globalIndex}`,
        safeLink: null,
        createdAt: NOW,
        purgeAt: MESSAGE_PURGE_AT,
      });
      globalIndex += 1;
      if (batch.length === INSERT_BATCH_SIZE) {
        await ChatMessage.collection.insertMany(batch, { ordered: true });
        batch = [];
      }
    }
    roomUpdates.push({
      updateOne: {
        filter: { _id: conversationId },
        update: {
          $set: {
            lastSequence: count,
            lastMessageId,
            latestMessagePurgeAt: count > 0 ? MESSAGE_PURGE_AT : null,
            updatedAt: NOW,
          },
        },
      },
    });
  }
  if (batch.length > 0) {
    await ChatMessage.collection.insertMany(batch, { ordered: true });
  }
  await Conversation.collection.bulkWrite(roomUpdates, { ordered: false });
}

describe(`M4 chat capacity (${PROFILE.name} profile)`, () => {
  beforeAll(async () => {
    await ensureIntegrationDB();
    await Promise.all(collections.map((model) => model.init()));
    await Promise.all(collections.map((model) => model.deleteMany({})));
    await seedUsers();
    await seedRoomsAndMembers();
    await seedMessages();
    const transactions = new MongoTransactionService(mongoose.connection);
    const capability = await transactions.assertTopologyCapability(true);
    expect(capability.supported).toBe(true);
    service = new ChatRoomService({
      now: () => new Date(NOW),
      runtime: {
        getOperationalRuntimeConfig: async () =>
          createRuntimeConfigDTO("on", 1),
      },
      transactions,
      idempotency: new IdempotencyService(
        transactions,
        IdempotencyRecord as never,
        () => new Date(NOW),
      ),
      rateLimiter: new ChatSendRateLimiter({ now: () => Date.now() }),
      enqueueMessage: (input) => enqueueChatMessagePersisted(input),
    });
  }, APPROVED_PROFILE ? 5 * 60_000 : 60_000);

  afterAll(async () => {
    await Promise.all(collections.map((model) => model.deleteMany({})));
  }, APPROVED_PROFILE ? 2 * 60_000 : 30_000);

  it("meets Room list and visible-history p95 gates", async () => {
    const viewerId = userIds[0]!.toString();
    const conversationId = roomIds[0]!.toString();
    await service.list(viewerId, { view: "current", page: 1, limit: 30 });
    await service.history(viewerId, conversationId, { limit: 50 });
    const listLatencies: number[] = [];
    const historyLatencies: number[] = [];
    for (let sample = 0; sample < PROFILE.samples; sample += 1) {
      let started = performance.now();
      const list = await service.list(viewerId, {
        view: "current",
        page: 1,
        limit: 30,
      });
      listLatencies.push(performance.now() - started);
      expect(list.conversations.length).toBeGreaterThanOrEqual(30);

      started = performance.now();
      const history = await service.history(viewerId, conversationId, {
        limit: 50,
      });
      historyLatencies.push(performance.now() - started);
      expect(history.messages).toHaveLength(50);
    }
    const listP95 = percentile(listLatencies, 0.95);
    const historyP95 = percentile(historyLatencies, 0.95);
    console.info(
      `M4_CAPACITY profile=${PROFILE.name} rooms=${PROFILE.rooms} messages=${PROFILE.messages} list_p95_ms=${listP95.toFixed(1)} history_p95_ms=${historyP95.toFixed(1)}`,
    );
    expect(listP95).toBeLessThanOrEqual(LIST_HISTORY_P95_MAX_MS);
    expect(historyP95).toBeLessThanOrEqual(LIST_HISTORY_P95_MAX_MS);
  });

  it(
    "sustains 20 persisted acknowledgements/second with bounded percentiles and no duplicate persistence",
    async () => {
      const latencies: number[] = [];
      const clientMessageIds: string[] = [];
      let failures = 0;
      for (let second = 0; second < PROFILE.sendSeconds; second += 1) {
        const tickStarted = performance.now();
        const sends = Array.from(
          { length: PROFILE.sendsPerSecond },
          async (_unused, offset) => {
            const roomIndex =
              30 +
              ((second * PROFILE.sendsPerSecond + offset) %
                Math.max(1, roomIds.length - 30));
            const conversationId = roomIds[roomIndex]!;
            const senderId = roomMemberIds[roomIndex]![0];
            const clientMessageId = randomUUID();
            clientMessageIds.push(clientMessageId);
            const started = performance.now();
            try {
              await service.send({
                conversationId: conversationId.toString(),
                actor: {
                  id: senderId.toString(),
                  role: "Participant",
                },
                clientMessageId,
                idempotencyKey: randomUUID(),
                content: `load-send-${second}-${offset}`,
                safeLink: null,
              });
              latencies.push(performance.now() - started);
            } catch {
              failures += 1;
            }
          },
        );
        await Promise.all(sends);
        const remainingMs = 1_000 - (performance.now() - tickStarted);
        if (remainingMs > 0 && second + 1 < PROFILE.sendSeconds) {
          await new Promise<void>((resolve) => setTimeout(resolve, remainingMs));
        }
      }

      const expected = PROFILE.sendSeconds * PROFILE.sendsPerSecond;
      const persisted = await ChatMessage.countDocuments({
        clientMessageId: { $in: clientMessageIds },
      });
      const distinctPersisted = await ChatMessage.distinct("clientMessageId", {
        clientMessageId: { $in: clientMessageIds },
      });
      const p95 = percentile(latencies, 0.95);
      const p99 = percentile(latencies, 0.99);
      console.info(
        `M4_CAPACITY profile=${PROFILE.name} sends=${expected} failures=${failures} ack_p95_ms=${p95.toFixed(1)} ack_p99_ms=${p99.toFixed(1)}`,
      );
      expect(failures / expected).toBeLessThan(0.01);
      expect(persisted).toBe(expected - failures);
      expect(distinctPersisted).toHaveLength(persisted);
      expect(
        await NotificationOutbox.countDocuments({
          topic: "chat.message.persisted",
        }),
      ).toBe(persisted);
      expect(p95).toBeLessThanOrEqual(SEND_ACK_P95_MAX_MS);
      expect(p99).toBeLessThanOrEqual(SEND_ACK_P99_MAX_MS);
    },
    APPROVED_PROFILE ? 7 * 60_000 : 30_000,
  );
});
