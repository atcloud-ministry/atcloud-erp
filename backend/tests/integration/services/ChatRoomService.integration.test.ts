import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  chatMessagePurgeAt,
  conversationPurgeAt,
} from "../../../src/contracts/chatRooms";
import { createRuntimeConfigDTO } from "../../../src/contracts/runtimeConfig";
import AuditLog from "../../../src/models/AuditLog";
import ChatMessage from "../../../src/models/ChatMessage";
import Conversation from "../../../src/models/Conversation";
import ConversationMember from "../../../src/models/ConversationMember";
import IdempotencyRecord from "../../../src/models/IdempotencyRecord";
import NotificationOutbox from "../../../src/models/NotificationOutbox";
import Program from "../../../src/models/Program";
import ProgramCommunitySettings from "../../../src/models/ProgramCommunitySettings";
import Purchase from "../../../src/models/Purchase";
import User from "../../../src/models/User";
import {
  ChatRoomService,
  type ChatActor,
} from "../../../src/services/chat/ChatRoomService";
import { ChatSendRateLimiter } from "../../../src/services/chat/ChatSendRateLimiter";
import { enqueueChatMessagePersisted } from "../../../src/services/chat/ChatMessageOutbox";
import { ChatUnreadReconciliationService } from "../../../src/services/chat/ChatUnreadReconciliationService";
import { AlumniHelpRoomProvisioner } from "../../../src/services/alumni/AlumniHelpRoomProvisioner";
import { ProgramMemberBatchReadResolver } from "../../../src/services/programs/ProgramMemberBatchReadResolver";
import { IdempotencyService } from "../../../src/services/reliability/IdempotencyService";
import { MongoTransactionService } from "../../../src/services/reliability/MongoTransactionService";
import { authorizationService } from "../../../src/services/authorization/AuthorizationService";
import { AUTHORIZATION_ACTIONS } from "../../../src/services/authorization/types";
import { ensureIntegrationDB } from "../setup/connect";

const collections = [
  AuditLog,
  ChatMessage,
  ConversationMember,
  Conversation,
  IdempotencyRecord,
  NotificationOutbox,
  ProgramCommunitySettings,
  Purchase,
  Program,
  User,
] as const;

let nowValue = new Date("2032-09-12T12:00:00.000Z");
let transactions: MongoTransactionService;
let service: ChatRoomService;

function actor(userId: mongoose.Types.ObjectId): ChatActor {
  return Object.freeze({ id: userId.toString(), role: "Participant" });
}

async function insertUser(label: string): Promise<mongoose.Types.ObjectId> {
  const _id = new mongoose.Types.ObjectId();
  const username = `chat-${label}-${_id.toString().slice(-8)}`.toLowerCase();
  await User.collection.insertOne({
    _id,
    username,
    usernameLower: username,
    email: `${username}@private.example.org`,
    phone: "+12065550199",
    birthYear: 1988,
    password: "integration-test-only",
    firstName: label,
    lastName: "Member",
    avatar: null,
    residenceCity: "Seattle",
    residenceRegion: "US-WA",
    residenceCountryCode: "US",
    employmentStatus: "employed",
    company: "Private Employer",
    occupation: "Product Manager",
    isAtCloudLeader: false,
    role: "Participant",
    isActive: true,
    isVerified: true,
    emailNotifications: true,
    loginAttempts: 0,
    hasReceivedWelcomeMessage: false,
    createdAt: nowValue,
    updatedAt: nowValue,
  });
  return _id;
}

async function createRoom(
  firstUserId: mongoose.Types.ObjectId,
  secondUserId: mongoose.Types.ObjectId,
) {
  const conversation = await Conversation.create({
    kind: "alumni_help",
    helpRequestId: new mongoose.Types.ObjectId(),
  });
  await ConversationMember.create([
    {
      conversationId: conversation._id,
      userId: firstUserId,
      role: "requester",
      status: "active",
      joinedAt: nowValue,
      accessWindows: [
        {
          visibleFromSequence: 1,
          visibleThroughSequence: null,
          openedAt: nowValue,
          closedAt: null,
        },
      ],
    },
    {
      conversationId: conversation._id,
      userId: secondUserId,
      role: "provider",
      status: "active",
      joinedAt: nowValue,
      accessWindows: [
        {
          visibleFromSequence: 1,
          visibleThroughSequence: null,
          openedAt: nowValue,
          closedAt: null,
        },
      ],
    },
  ]);
  return conversation;
}

async function insertProgram(
  title: string,
  createdBy: mongoose.Types.ObjectId,
): Promise<mongoose.Types.ObjectId> {
  const _id = new mongoose.Types.ObjectId();
  await Program.collection.insertOne({
    _id,
    title,
    programType: "EMBA Mentor Circles",
    hostedBy: "@Cloud Marketplace Ministry",
    isFree: true,
    fullPriceTicket: 0,
    classRepDiscount: 0,
    earlyBirdDiscount: 0,
    classRepLimit: 0,
    classRepCount: 0,
    mentors: [{ userId: createdBy }],
    adminEnrollments: { classReps: [], mentees: [] },
    programRoles: {
      teacherRoleName: "Mentor",
      studentRoles: [
        {
          id: "participant",
          name: "Participant",
          discountEligible: false,
          discountAmount: 0,
          limit: 0,
          count: 0,
        },
      ],
    },
    createdBy,
    createdAt: nowValue,
    updatedAt: nowValue,
  });
  await ProgramCommunitySettings.create({
    programId: _id,
    enabled: true,
    opensAt: new Date("2032-01-01T00:00:00.000Z"),
    closesAt: new Date("2033-01-01T00:00:00.000Z"),
    studentRoleMappings: [
      { studentRoleId: "participant", memberRole: "mentee" },
    ],
  });
  return _id;
}

function sendInput(
  conversationId: mongoose.Types.ObjectId,
  senderId: mongoose.Types.ObjectId,
  content: string,
  clientMessageId = randomUUID(),
  idempotencyKey = randomUUID(),
) {
  return {
    conversationId: conversationId.toString(),
    actor: actor(senderId),
    clientMessageId,
    idempotencyKey,
    content,
    safeLink: null,
  } as const;
}

async function insertMessage(input: {
  conversationId: mongoose.Types.ObjectId;
  senderId: mongoose.Types.ObjectId;
  sequence: number;
  createdAt?: Date;
}) {
  const createdAt = input.createdAt ?? nowValue;
  return ChatMessage.create({
    conversationId: input.conversationId,
    sequence: input.sequence,
    senderId: input.senderId,
    senderSnapshot: { displayName: "History Sender", avatar: null },
    clientMessageId: randomUUID(),
    kind: "text",
    content: `message-${input.sequence}`,
    safeLink: null,
    createdAt,
    purgeAt: chatMessagePurgeAt(createdAt),
  });
}

describe("M4 ChatRoomService integration", () => {
  beforeAll(async () => {
    await ensureIntegrationDB();
    await Promise.all(collections.map((model) => model.init()));
    transactions = new MongoTransactionService(mongoose.connection);
    const capability = await transactions.assertTopologyCapability(true);
    expect(capability.supported).toBe(true);
  });

  beforeEach(async () => {
    await Promise.all(collections.map((model) => model.deleteMany({})));
    nowValue = new Date("2032-09-12T12:00:00.000Z");
    const idempotency = new IdempotencyService(
      transactions,
      IdempotencyRecord as never,
      () => new Date(nowValue),
    );
    service = new ChatRoomService({
      now: () => new Date(nowValue),
      runtime: {
        getOperationalRuntimeConfig: async () =>
          createRuntimeConfigDTO("on", 1),
      },
      transactions,
      idempotency,
      rateLimiter: new ChatSendRateLimiter({
        now: () => nowValue.getTime(),
      }),
      enqueueMessage: (input) => enqueueChatMessagePersisted(input),
    });
  });

  afterAll(async () => {
    await Promise.all(collections.map((model) => model.deleteMany({})));
  });

  it("allocates concurrent sequences and commits message, counters, audit, and outbox atomically", async () => {
    const senderId = await insertUser("Sender");
    const recipientId = await insertUser("Recipient");
    const room = await createRoom(senderId, recipientId);

    const responses = await Promise.all([
      service.send(sendInput(room._id, senderId, "first")),
      service.send(sendInput(room._id, senderId, "second")),
    ]);

    expect(responses.map(({ message }) => message.sequence).sort()).toEqual([
      1, 2,
    ]);
    const messages = await ChatMessage.find({ conversationId: room._id })
      .sort({ sequence: 1 })
      .lean();
    expect(messages.map((message) => message.sequence)).toEqual([1, 2]);
    expect(new Set(messages.map((message) => message.clientMessageId)).size).toBe(2);
    await expect(Conversation.findById(room._id).lean().orFail()).resolves.toMatchObject({
      lastSequence: 2,
      lastMessageId: messages[1]!._id,
    });
    await expect(
      ConversationMember.findOne({
        conversationId: room._id,
        userId: recipientId,
      })
        .lean()
        .orFail(),
    ).resolves.toMatchObject({
      unreadCount: 2,
      unreadReconciledThroughSequence: 2,
      unreadReconciledAt: null,
    });
    expect(
      await NotificationOutbox.countDocuments({
        topic: "chat.message.persisted",
      }),
    ).toBe(2);
    const externalEvents = await NotificationOutbox.find({
      topic: "web_push.chat_message",
    })
      .sort({ createdAt: 1 })
      .lean();
    expect(externalEvents).toHaveLength(2);
    expect(
      externalEvents.map((entry) => entry.payload.recipientUserId),
    ).toEqual([recipientId.toString(), recipientId.toString()]);
    expect(
      new Set(externalEvents.map((entry) => entry.dedupeKeyHash)).size,
    ).toBe(2);
    expect(await AuditLog.countDocuments({ action: "chat.message_sent" })).toBe(
      2,
    );
  });

  it("replays one client identity exactly and rejects a changed payload without duplicate persistence", async () => {
    const senderId = await insertUser("Sender");
    const recipientId = await insertUser("Recipient");
    const room = await createRoom(senderId, recipientId);
    const clientMessageId = randomUUID();
    const first = await service.send(
      sendInput(room._id, senderId, "same", clientMessageId),
    );
    const retry = await service.send(
      sendInput(room._id, senderId, "same", clientMessageId),
    );

    expect(retry.message).toEqual(first.message);
    await expect(
      service.send(
        sendInput(room._id, senderId, "changed", clientMessageId),
      ),
    ).rejects.toMatchObject({ code: "CHAT_MESSAGE_IDEMPOTENCY_CONFLICT" });
    expect(await ChatMessage.countDocuments({ conversationId: room._id })).toBe(
      1,
    );
    expect(
      await NotificationOutbox.countDocuments({
        topic: "chat.message.persisted",
      }),
    ).toBe(1);
    expect(
      await NotificationOutbox.countDocuments({
        topic: "web_push.chat_message",
        "payload.recipientUserId": recipientId.toString(),
      }),
    ).toBe(1);
    expect(
      await ConversationMember.findOne({
        conversationId: room._id,
        userId: recipientId,
      })
        .select("unreadCount")
        .lean(),
    ).toMatchObject({ unreadCount: 1 });
  });

  it("rolls back the sequence, message, unread, audit, receipt, and outbox when enqueue fails", async () => {
    const senderId = await insertUser("Sender");
    const recipientId = await insertUser("Recipient");
    const room = await createRoom(senderId, recipientId);
    const failingService = new ChatRoomService({
      now: () => new Date(nowValue),
      runtime: {
        getOperationalRuntimeConfig: async () =>
          createRuntimeConfigDTO("on", 1),
      },
      transactions,
      idempotency: new IdempotencyService(
        transactions,
        IdempotencyRecord as never,
        () => new Date(nowValue),
      ),
      rateLimiter: new ChatSendRateLimiter({
        now: () => nowValue.getTime(),
      }),
      enqueueMessage: async () => {
        throw new Error("injected outbox failure");
      },
    });

    await expect(
      failingService.send(sendInput(room._id, senderId, "must rollback")),
    ).rejects.toThrow("injected outbox failure");
    await expect(Conversation.findById(room._id).lean().orFail()).resolves.toMatchObject({
      lastSequence: 0,
      lastMessageId: null,
      latestMessagePurgeAt: null,
    });
    expect(await ChatMessage.countDocuments({ conversationId: room._id })).toBe(
      0,
    );
    expect(await NotificationOutbox.countDocuments({})).toBe(0);
    expect(await IdempotencyRecord.countDocuments({})).toBe(0);
    expect(await AuditLog.countDocuments({ action: "chat.message_sent" })).toBe(
      0,
    );
    await expect(
      ConversationMember.findOne({
        conversationId: room._id,
        userId: recipientId,
      })
        .lean()
        .orFail(),
    ).resolves.toMatchObject({ unreadCount: 0, revision: 0 });
  });

  it("fails closed when the runtime mode flips after the outer check but before persistence", async () => {
    const senderId = await insertUser("Sender");
    const recipientId = await insertUser("Recipient");
    const room = await createRoom(senderId, recipientId);
    let runtimeReads = 0;
    const flippingService = new ChatRoomService({
      now: () => new Date(nowValue),
      runtime: {
        getOperationalRuntimeConfig: async () => {
          runtimeReads += 1;
          return createRuntimeConfigDTO(runtimeReads === 1 ? "on" : "read_only", runtimeReads);
        },
      },
      transactions,
      idempotency: new IdempotencyService(
        transactions,
        IdempotencyRecord as never,
        () => new Date(nowValue),
      ),
      rateLimiter: new ChatSendRateLimiter({ now: () => nowValue.getTime() }),
      enqueueMessage: (input) => enqueueChatMessagePersisted(input),
    });

    await expect(
      flippingService.send(sendInput(room._id, senderId, "must not commit")),
    ).rejects.toMatchObject({ code: "CHAT_ROOM_READ_ONLY" });
    expect(runtimeReads).toBe(2);
    expect(await ChatMessage.countDocuments({ conversationId: room._id })).toBe(0);
    expect(await NotificationOutbox.countDocuments({})).toBe(0);
    await expect(Conversation.findById(room._id).lean().orFail()).resolves.toMatchObject({
      lastSequence: 0,
      lastMessageId: null,
    });
    await expect(
      ConversationMember.findOne({
        conversationId: room._id,
        userId: recipientId,
      })
        .lean()
        .orFail(),
    ).resolves.toMatchObject({ unreadCount: 0 });
  });

  it("keeps Current and Past list views isolated", async () => {
    const viewerId = await insertUser("Viewer");
    const counterpartId = await insertUser("Counterpart");
    const current = await createRoom(viewerId, counterpartId);
    const past = await Conversation.create({
      kind: "alumni_help",
      helpRequestId: new mongoose.Types.ObjectId(),
    });
    await ConversationMember.create([
      {
        conversationId: past._id,
        userId: viewerId,
        role: "requester",
        status: "history_only",
        joinedAt: new Date("2032-09-01T12:00:00.000Z"),
        accessWindows: [
          {
            visibleFromSequence: 1,
            visibleThroughSequence: 0,
            openedAt: new Date("2032-09-01T12:00:00.000Z"),
            closedAt: nowValue,
          },
        ],
      },
      {
        conversationId: past._id,
        userId: counterpartId,
        role: "provider",
        status: "active",
        joinedAt: nowValue,
        accessWindows: [
          {
            visibleFromSequence: 1,
            visibleThroughSequence: null,
            openedAt: nowValue,
            closedAt: null,
          },
        ],
      },
    ]);

    const [currentList, pastList] = await Promise.all([
      service.list(viewerId.toString(), { view: "current", page: 1, limit: 30 }),
      service.list(viewerId.toString(), { view: "past", page: 1, limit: 30 }),
    ]);
    expect(currentList.conversations.map(({ id }) => id)).toEqual([
      current._id.toString(),
    ]);
    expect(pastList.conversations.map(({ id }) => id)).toEqual([
      past._id.toString(),
    ]);
    expect(currentList.conversations[0]?.section).toBe("current");
    expect(pastList.conversations[0]?.section).toBe("past");
  });

  it("uses live Program titles, skips counterpart fan-out, and conceals Room discovery", async () => {
    const viewerId = await insertUser("ProgramViewer");
    const outsiderId = await insertUser("ProgramOutsider");
    const programId = await insertProgram("Original Program Title", viewerId);
    const room = await Conversation.create({ kind: "program", programId });
    const member = await ConversationMember.create({
      conversationId: room._id,
      userId: viewerId,
      role: "mentor",
      status: "active",
      joinedAt: nowValue,
      accessWindows: [
        {
          visibleFromSequence: 1,
          visibleThroughSequence: null,
          openedAt: nowValue,
          closedAt: null,
        },
      ],
    });

    const counterpartFind = vi.spyOn(ConversationMember, "find");
    const current = await service.list(viewerId.toString(), {
      view: "current",
      page: 1,
      limit: 30,
    });
    expect(current.conversations[0]).toMatchObject({
      id: room._id.toString(),
      programId: programId.toString(),
      title: "Original Program Title",
      kind: "program",
      status: "current",
      section: "current",
      counterpart: null,
      viewer: { status: "active", accessMode: "read_write" },
    });
    expect(counterpartFind).not.toHaveBeenCalled();
    counterpartFind.mockRestore();

    await Program.collection.updateOne(
      { _id: programId },
      { $set: { title: "Renamed Program", updatedAt: new Date(nowValue.getTime() + 1) } },
    );
    const renamed = await service.get(viewerId.toString(), room._id.toString());
    expect(renamed.conversation).toMatchObject({
      id: room._id.toString(),
      title: "Renamed Program",
    });

    const retainedMessage = await insertMessage({
      conversationId: room._id,
      senderId: viewerId,
      sequence: 1,
    });
    await Conversation.collection.updateOne(
      { _id: room._id },
      {
        $set: {
          lastSequence: 1,
          lastMessageId: retainedMessage._id,
          latestMessagePurgeAt: retainedMessage.purgeAt,
          updatedAt: nowValue,
        },
      },
    );
    await ConversationMember.collection.updateOne(
      { _id: member._id },
      { $set: { unreadCount: 1, updatedAt: nowValue } },
    );
    await Program.collection.updateOne(
      { _id: programId },
      { $set: { mentors: [], updatedAt: nowValue } },
    );

    const staleCurrentList = await service.list(viewerId.toString(), {
      view: "current",
      page: 1,
      limit: 30,
    });
    expect(staleCurrentList.conversations).toEqual([]);
    expect(staleCurrentList.pagination).toMatchObject({
      totalCount: 0,
      totalPages: 0,
      hasNext: false,
      hasPrev: false,
    });
    expect(staleCurrentList.chatUnreadTotal).toBe(0);
    await expect(service.unreadTotal(viewerId.toString())).resolves.toEqual({
      chatUnreadTotal: 0,
    });
    await expect(
      service.list(viewerId.toString(), {
        view: "past",
        page: 1,
        limit: 30,
      }),
    ).resolves.toMatchObject({ chatUnreadTotal: 0 });
    await expect(
      service.markRead({
        conversationId: room._id.toString(),
        actor: actor(viewerId),
        throughSequence: 1,
      }),
    ).rejects.toMatchObject({ code: "CHAT_ROOM_READ_ONLY" });
    await expect(
      service.setMuted({
        conversationId: room._id.toString(),
        actor: actor(viewerId),
        muted: true,
      }),
    ).rejects.toMatchObject({ code: "CHAT_ROOM_READ_ONLY" });
    await expect(
      service.get(viewerId.toString(), room._id.toString()),
    ).rejects.toMatchObject({ code: "CHAT_ROOM_NOT_FOUND", httpStatus: 404 });
    await expect(
      service.history(viewerId.toString(), room._id.toString(), { limit: 30 }),
    ).rejects.toMatchObject({ code: "CHAT_ROOM_NOT_FOUND", httpStatus: 404 });
    await expect(
      service.getProgramRoomLink(viewerId.toString(), programId.toString()),
    ).rejects.toMatchObject({ code: "CHAT_ROOM_NOT_FOUND", httpStatus: 404 });

    await expect(
      service.getProgramRoomLink(outsiderId.toString(), programId.toString()),
    ).rejects.toMatchObject({ code: "CHAT_ROOM_NOT_FOUND", httpStatus: 404 });
    await expect(
      service.getProgramRoomLink(viewerId.toString(), new mongoose.Types.ObjectId().toString()),
    ).rejects.toMatchObject({ code: "CHAT_ROOM_NOT_FOUND", httpStatus: 404 });

    await ConversationMember.collection.updateOne(
      { _id: member._id },
      {
        $set: {
          status: "history_only",
          accessWindows: [
            {
              visibleFromSequence: 1,
              visibleThroughSequence: 1,
              openedAt: nowValue,
              closedAt: new Date(nowValue.getTime() + 1),
            },
          ],
          unreadCount: 0,
          updatedAt: new Date(nowValue.getTime() + 1),
        },
      },
    );
    await expect(
      service.history(viewerId.toString(), room._id.toString(), { limit: 30 }),
    ).resolves.toMatchObject({
      messages: [{ sequence: 1, content: "message-1" }],
    });
    await expect(
      service.getProgramRoomLink(viewerId.toString(), programId.toString()),
    ).resolves.toEqual({
      room: {
        id: room._id.toString(),
        programId: programId.toString(),
        status: "current",
        section: "past",
        viewer: { status: "history_only", accessMode: "read_only" },
      },
    });

    await Program.deleteOne({ _id: programId });
    const deletedProgramFallback = await service.get(
      viewerId.toString(),
      room._id.toString(),
    );
    expect(deletedProgramFallback.conversation).toMatchObject({
      id: room._id.toString(),
      title: "Program Room",
      section: "past",
      viewer: { accessMode: "read_only" },
    });
  });

  it("batch-validates every current Program candidate before list pagination", async () => {
    const viewerId = await insertUser("BatchProgramViewer");
    const firstProgramId = await insertProgram("Eligible Program", viewerId);
    const secondProgramId = await insertProgram("Excluded Program", viewerId);
    const [firstRoom, secondRoom] = await Conversation.create([
      { kind: "program", programId: firstProgramId },
      { kind: "program", programId: secondProgramId },
    ]);
    await ConversationMember.create([
      {
        conversationId: firstRoom!._id,
        userId: viewerId,
        role: "mentor",
        status: "active",
        joinedAt: nowValue,
        accessWindows: [
          {
            visibleFromSequence: 1,
            visibleThroughSequence: null,
            openedAt: nowValue,
            closedAt: null,
          },
        ],
      },
      {
        conversationId: secondRoom!._id,
        userId: viewerId,
        role: "mentor",
        status: "active",
        joinedAt: nowValue,
        accessWindows: [
          {
            visibleFromSequence: 1,
            visibleThroughSequence: null,
            openedAt: nowValue,
            closedAt: null,
          },
        ],
      },
    ]);
    const resolveEligibleRooms = vi.fn().mockResolvedValue([
      {
        programId: firstProgramId.toString(),
        conversationId: firstRoom!._id.toString(),
        role: "mentor",
      },
    ]);
    const batchService = new ChatRoomService({
      now: () => new Date(nowValue),
      runtime: {
        getOperationalRuntimeConfig: async () =>
          createRuntimeConfigDTO("on", 1),
      },
      programActorRoomReadResolver: { resolveEligibleRooms },
    });

    const result = await batchService.list(viewerId.toString(), {
      view: "current",
      page: 1,
      limit: 30,
    });

    expect(resolveEligibleRooms).toHaveBeenCalledOnce();
    expect(resolveEligibleRooms).toHaveBeenCalledWith(
      viewerId,
      expect.arrayContaining([
        expect.objectContaining({
          programId: firstProgramId,
          conversationId: firstRoom!._id,
          materializedRole: "mentor",
        }),
        expect.objectContaining({
          programId: secondProgramId,
          conversationId: secondRoom!._id,
          materializedRole: "mentor",
        }),
      ]),
      { now: nowValue },
    );
    expect(result.conversations.map(({ id }) => id)).toEqual([
      firstRoom!._id.toString(),
    ]);
    expect(result.pagination.totalCount).toBe(1);
  });

  it("conceals real database ACL failures while retaining read-only history access", async () => {
    const viewerId = await insertUser("Viewer");
    const counterpartId = await insertUser("Counterpart");
    const outsiderId = await insertUser("Outsider");
    const current = await createRoom(viewerId, counterpartId);
    const past = await Conversation.create({
      kind: "alumni_help",
      helpRequestId: new mongoose.Types.ObjectId(),
    });
    await ConversationMember.create({
      conversationId: past._id,
      userId: viewerId,
      role: "requester",
      status: "history_only",
      joinedAt: new Date("2032-09-01T12:00:00.000Z"),
      accessWindows: [
        {
          visibleFromSequence: 1,
          visibleThroughSequence: 0,
          openedAt: new Date("2032-09-01T12:00:00.000Z"),
          closedAt: nowValue,
        },
      ],
    });
    const principal = (id: mongoose.Types.ObjectId) => ({
      kind: "user" as const,
      userId: id.toString(),
      role: "Participant" as const,
      isActive: true,
      isVerified: true,
    });

    await expect(
      authorizationService.authorize({
        source: "http",
        principal: principal(viewerId),
        action: AUTHORIZATION_ACTIONS.CONVERSATION_SEND,
        resource: { type: "conversation", id: current._id.toString() },
      }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      authorizationService.authorize({
        source: "http",
        principal: principal(viewerId),
        action: AUTHORIZATION_ACTIONS.CONVERSATION_READ,
        resource: { type: "conversation", id: past._id.toString() },
      }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      authorizationService.authorize({
        source: "http",
        principal: principal(viewerId),
        action: AUTHORIZATION_ACTIONS.CONVERSATION_SEND_OR_REPLAY,
        resource: { type: "conversation", id: past._id.toString() },
      }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      authorizationService.authorize({
        source: "http",
        principal: principal(viewerId),
        action: AUTHORIZATION_ACTIONS.CONVERSATION_SEND,
        resource: { type: "conversation", id: past._id.toString() },
      }),
    ).resolves.toEqual({
      allowed: false,
      reasonCode: "not_resource_member",
      concealExistence: true,
    });
    await expect(
      authorizationService.authorize({
        source: "http",
        principal: principal(outsiderId),
        action: AUTHORIZATION_ACTIONS.CONVERSATION_READ,
        resource: { type: "conversation", id: current._id.toString() },
      }),
    ).resolves.toEqual({
      allowed: false,
      reasonCode: "resource_not_found",
      concealExistence: true,
    });
    await expect(
      authorizationService.authorize({
        source: "http",
        principal: principal(outsiderId),
        action: AUTHORIZATION_ACTIONS.CONVERSATION_SEND_OR_REPLAY,
        resource: { type: "conversation", id: current._id.toString() },
      }),
    ).resolves.toEqual({
      allowed: false,
      reasonCode: "resource_not_found",
      concealExistence: true,
    });
    await expect(
      authorizationService.authorize({
        source: "http",
        principal: principal(viewerId),
        action: AUTHORIZATION_ACTIONS.CONVERSATION_READ,
        resource: { type: "conversation", id: "invalid-object-id" },
      }),
    ).resolves.toEqual({
      allowed: false,
      reasonCode: "resource_not_found",
      concealExistence: true,
    });
  });

  it("returns only retained messages inside every authorized sequence window", async () => {
    const viewerId = await insertUser("Viewer");
    const senderId = await insertUser("Sender");
    const room = await Conversation.create({
      kind: "alumni_help",
      helpRequestId: new mongoose.Types.ObjectId(),
    });
    const createdMessages = [];
    for (let sequence = 1; sequence <= 6; sequence += 1) {
      createdMessages.push(
        await insertMessage({
          conversationId: room._id,
          senderId,
          sequence,
          ...(sequence === 2
            ? { createdAt: new Date("2031-09-12T12:00:00.000Z") }
            : {}),
        }),
      );
    }
    await Conversation.collection.updateOne(
      { _id: room._id },
      {
        $set: {
          lastSequence: 6,
          lastMessageId: createdMessages[5]!._id,
          latestMessagePurgeAt: createdMessages[5]!.purgeAt,
          updatedAt: nowValue,
        },
      },
    );
    await ConversationMember.create([
      {
        conversationId: room._id,
        userId: viewerId,
        role: "requester",
        status: "active",
        joinedAt: new Date("2032-01-01T12:00:00.000Z"),
        accessWindows: [
          {
            visibleFromSequence: 1,
            visibleThroughSequence: 2,
            openedAt: new Date("2032-01-01T12:00:00.000Z"),
            closedAt: new Date("2032-02-01T12:00:00.000Z"),
          },
          {
            visibleFromSequence: 5,
            visibleThroughSequence: null,
            openedAt: new Date("2032-03-01T12:00:00.000Z"),
            closedAt: null,
          },
        ],
      },
      {
        conversationId: room._id,
        userId: senderId,
        role: "provider",
        status: "active",
        joinedAt: nowValue,
        accessWindows: [
          {
            visibleFromSequence: 1,
            visibleThroughSequence: null,
            openedAt: nowValue,
            closedAt: null,
          },
        ],
      },
    ]);

    const result = await service.history(viewerId.toString(), room._id.toString(), {
      afterSequence: 0,
      limit: 100,
    });
    expect(result.messages.map(({ sequence }) => sequence)).toEqual([1, 5, 6]);
  });

  it("does not leak post-exit preview, sequence, or activity time to a history-only member", async () => {
    const viewerId = await insertUser("FormerMember");
    const senderId = await insertUser("Sender");
    const room = await Conversation.create({
      kind: "alumni_help",
      helpRequestId: new mongoose.Types.ObjectId(),
    });
    const messages = [];
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      messages.push(
        await insertMessage({
          conversationId: room._id,
          senderId,
          sequence,
        }),
      );
    }
    await Conversation.collection.updateOne(
      { _id: room._id },
      {
        $set: {
          lastSequence: 3,
          lastMessageId: messages[2]!._id,
          latestMessagePurgeAt: messages[2]!.purgeAt,
          updatedAt: nowValue,
        },
      },
    );
    const leftAt = new Date("2032-05-01T12:00:00.000Z");
    const former = await ConversationMember.create({
      conversationId: room._id,
      userId: viewerId,
      role: "requester",
      status: "history_only",
      joinedAt: new Date("2032-01-01T12:00:00.000Z"),
      accessWindows: [
        {
          visibleFromSequence: 1,
          visibleThroughSequence: 1,
          openedAt: new Date("2032-01-01T12:00:00.000Z"),
          closedAt: leftAt,
        },
      ],
    });
    await ConversationMember.collection.updateOne(
      { _id: former._id },
      { $set: { updatedAt: leftAt } },
    );
    await ConversationMember.create({
      conversationId: room._id,
      userId: senderId,
      role: "provider",
      status: "active",
      joinedAt: nowValue,
      accessWindows: [
        {
          visibleFromSequence: 1,
          visibleThroughSequence: null,
          openedAt: nowValue,
          closedAt: null,
        },
      ],
    });

    const detail = await service.get(viewerId.toString(), room._id.toString());
    expect(detail.conversation).toMatchObject({
      section: "past",
      lastSequence: 1,
      updatedAt: leftAt.toISOString(),
      lastMessage: {
        id: messages[0]!._id.toString(),
        sequence: 1,
        contentPreview: "message-1",
      },
      viewer: { accessMode: "read_only", canSend: false },
    });
    expect(JSON.stringify(detail)).not.toContain(messages[2]!._id.toString());
    expect(JSON.stringify(detail)).not.toContain("message-3");
    const past = await service.list(viewerId.toString(), {
      view: "past",
      page: 1,
      limit: 30,
    });
    expect(past.conversations[0]).toMatchObject({
      lastSequence: 1,
      updatedAt: leftAt.toISOString(),
      lastMessage: { sequence: 1, contentPreview: "message-1" },
    });
    await expect(
      service.history(viewerId.toString(), room._id.toString(), {
        afterSequence: 0,
        limit: 50,
      }),
    ).resolves.toMatchObject({
      messages: [expect.objectContaining({ sequence: 1 })],
    });
  });

  it("keeps each Room paired with its own access windows when resolving list previews", async () => {
    const viewerId = await insertUser("Viewer");
    const senderId = await insertUser("Sender");
    const highRoom = await Conversation.create({
      kind: "alumni_help",
      helpRequestId: new mongoose.Types.ObjectId(),
    });
    const lowRoom = await Conversation.create({
      kind: "alumni_help",
      helpRequestId: new mongoose.Types.ObjectId(),
    });
    const highVisible = await ChatMessage.create({
      conversationId: highRoom._id,
      sequence: 55,
      senderId,
      senderSnapshot: { displayName: "Sender Member", avatar: null },
      clientMessageId: randomUUID(),
      kind: "text",
      content: "high-room-visible-55",
      safeLink: null,
      createdAt: nowValue,
      purgeAt: chatMessagePurgeAt(nowValue),
    });
    const lowVisible = await ChatMessage.create({
      conversationId: lowRoom._id,
      sequence: 5,
      senderId,
      senderSnapshot: { displayName: "Sender Member", avatar: null },
      clientMessageId: randomUUID(),
      kind: "text",
      content: "low-room-visible-5",
      safeLink: null,
      createdAt: nowValue,
      purgeAt: chatMessagePurgeAt(nowValue),
    });
    const lowSecret = await ChatMessage.create({
      conversationId: lowRoom._id,
      sequence: 55,
      senderId,
      senderSnapshot: { displayName: "Sender Member", avatar: null },
      clientMessageId: randomUUID(),
      kind: "text",
      content: "low-room-secret-55",
      safeLink: null,
      createdAt: nowValue,
      purgeAt: chatMessagePurgeAt(nowValue),
    });
    await Conversation.collection.bulkWrite([
      {
        updateOne: {
          filter: { _id: highRoom._id },
          update: {
            $set: {
              lastSequence: 55,
              lastMessageId: highVisible._id,
              latestMessagePurgeAt: highVisible.purgeAt,
              updatedAt: nowValue,
            },
          },
        },
      },
      {
        updateOne: {
          filter: { _id: lowRoom._id },
          update: {
            $set: {
              lastSequence: 55,
              lastMessageId: lowSecret._id,
              latestMessagePurgeAt: lowSecret.purgeAt,
              updatedAt: nowValue,
            },
          },
        },
      },
    ]);
    const membershipInput = (
      conversationId: mongoose.Types.ObjectId,
      visibleFromSequence: number,
      visibleThroughSequence: number,
    ) => ({
      conversationId,
      userId: viewerId,
      role: "requester" as const,
      status: "history_only" as const,
      joinedAt: new Date("2032-01-01T12:00:00.000Z"),
      accessWindows: [
        {
          visibleFromSequence,
          visibleThroughSequence,
          openedAt: new Date("2032-01-01T12:00:00.000Z"),
          closedAt: new Date("2032-02-01T12:00:00.000Z"),
        },
      ],
    });
    await ConversationMember.create([
      membershipInput(highRoom._id, 50, 60),
      membershipInput(lowRoom._id, 1, 10),
      {
        conversationId: highRoom._id,
        userId: senderId,
        role: "provider",
        status: "active",
        joinedAt: nowValue,
        accessWindows: [
          {
            visibleFromSequence: 1,
            visibleThroughSequence: null,
            openedAt: nowValue,
            closedAt: null,
          },
        ],
      },
      {
        conversationId: lowRoom._id,
        userId: senderId,
        role: "provider",
        status: "active",
        joinedAt: nowValue,
        accessWindows: [
          {
            visibleFromSequence: 1,
            visibleThroughSequence: null,
            openedAt: nowValue,
            closedAt: null,
          },
        ],
      },
    ]);

    const result = await service.list(viewerId.toString(), {
      view: "past",
      page: 1,
      limit: 30,
    });
    const byId = new Map(
      result.conversations.map((conversation) => [conversation.id, conversation]),
    );
    expect(byId.get(highRoom._id.toString())).toMatchObject({
      lastSequence: 55,
      lastMessage: { id: highVisible._id.toString(), contentPreview: "high-room-visible-55" },
    });
    expect(byId.get(lowRoom._id.toString())).toMatchObject({
      lastSequence: 5,
      lastMessage: { id: lowVisible._id.toString(), contentPreview: "low-room-visible-5" },
    });
    expect(JSON.stringify(result)).not.toContain("low-room-secret-55");
  });

  it("recounts read/unread from retained visible messages and repairs materialized drift", async () => {
    const senderId = await insertUser("Sender");
    const recipientId = await insertUser("Recipient");
    const room = await createRoom(senderId, recipientId);
    await service.send(sendInput(room._id, senderId, "first"));
    await service.send(sendInput(room._id, senderId, "second"));

    const partial = await service.markRead({
      conversationId: room._id.toString(),
      actor: actor(recipientId),
      throughSequence: 1,
    });
    expect(partial).toMatchObject({
      lastReadSequence: 1,
      unreadCount: 1,
      chatUnreadTotal: 1,
    });
    await ConversationMember.updateOne(
      { conversationId: room._id, userId: recipientId },
      { $set: { unreadCount: 99 } },
      { runValidators: false },
    );
    const reconciliation = new ChatUnreadReconciliationService({
      now: () => new Date(nowValue),
      transactions,
    });
    await expect(
      reconciliation.reconcileMember(
        (
          await ConversationMember.findOne({
            conversationId: room._id,
            userId: recipientId,
          }).orFail()
        )._id,
      ),
    ).resolves.toEqual({ reconciled: true, corrected: true });
    await expect(
      ConversationMember.findOne({
        conversationId: room._id,
        userId: recipientId,
      })
        .lean()
        .orFail(),
    ).resolves.toMatchObject({
      lastReadSequence: 1,
      unreadCount: 1,
      unreadReconciledThroughSequence: 2,
      unreadReconciledAt: nowValue,
    });
  });

  it("keeps the read cursor monotonic when two clients mark different sequences concurrently", async () => {
    const senderId = await insertUser("Sender");
    const recipientId = await insertUser("Recipient");
    const room = await createRoom(senderId, recipientId);
    await service.send(sendInput(room._id, senderId, "first"));
    await service.send(sendInput(room._id, senderId, "second"));

    await Promise.all([
      service.markRead({
        conversationId: room._id.toString(),
        actor: actor(recipientId),
        throughSequence: 2,
      }),
      service.markRead({
        conversationId: room._id.toString(),
        actor: actor(recipientId),
        throughSequence: 1,
      }),
    ]);

    await expect(
      ConversationMember.findOne({
        conversationId: room._id,
        userId: recipientId,
      })
        .lean()
        .orFail(),
    ).resolves.toMatchObject({
      lastReadSequence: 2,
      unreadCount: 0,
      unreadReconciledThroughSequence: 2,
    });
    await expect(service.unreadTotal(recipientId.toString())).resolves.toEqual({
      chatUnreadTotal: 0,
    });
  });

  it("uses the delivered sequence when selecting active recipients after re-enrollment", async () => {
    const senderId = await insertUser("Sender");
    const rejoinedId = await insertUser("Rejoined");
    const newlyJoinedId = await insertUser("NewlyJoined");
    const room = await Conversation.create({
      kind: "alumni_help",
      helpRequestId: new mongoose.Types.ObjectId(),
    });
    await Conversation.collection.updateOne(
      { _id: room._id },
      {
        $set: {
          lastSequence: 10,
          latestMessagePurgeAt: chatMessagePurgeAt(nowValue),
        },
      },
    );
    await ConversationMember.create([
      {
        conversationId: room._id,
        userId: senderId,
        role: "provider",
        status: "active",
        joinedAt: nowValue,
        accessWindows: [
          {
            visibleFromSequence: 1,
            visibleThroughSequence: null,
            openedAt: nowValue,
            closedAt: null,
          },
        ],
      },
      {
        conversationId: room._id,
        userId: rejoinedId,
        role: "requester",
        status: "active",
        joinedAt: new Date("2032-01-01T12:00:00.000Z"),
        accessWindows: [
          {
            visibleFromSequence: 1,
            visibleThroughSequence: 2,
            openedAt: new Date("2032-01-01T12:00:00.000Z"),
            closedAt: new Date("2032-02-01T12:00:00.000Z"),
          },
          {
            visibleFromSequence: 5,
            visibleThroughSequence: null,
            openedAt: new Date("2032-03-01T12:00:00.000Z"),
            closedAt: null,
          },
        ],
      },
      {
        conversationId: room._id,
        userId: newlyJoinedId,
        role: "requester",
        status: "active",
        joinedAt: nowValue,
        accessWindows: [
          {
            visibleFromSequence: 11,
            visibleThroughSequence: null,
            openedAt: nowValue,
            closedAt: null,
          },
        ],
      },
    ]);

    const sequenceThreeRecipients =
      await service.listActiveRetainedMemberUserIds(room._id.toString(), 3);
    const sequenceTenRecipients =
      await service.listActiveRetainedMemberUserIds(room._id.toString(), 10);
    expect(sequenceThreeRecipients).toEqual([senderId.toString()]);
    expect(new Set(sequenceTenRecipients)).toEqual(
      new Set([senderId.toString(), rejoinedId.toString()]),
    );
    await expect(
      service.getMemberDeliveryState(
        room._id.toString(),
        newlyJoinedId.toString(),
        10,
      ),
    ).resolves.toBeNull();
  });

  it("propagates transient delivery-state database errors for durable retry", async () => {
    const userId = await insertUser("Recipient");
    const senderId = await insertUser("Sender");
    const room = await createRoom(senderId, userId);
    const failure = new Error("transient database failure");
    const lookup = vi
      .spyOn(ConversationMember, "aggregate")
      .mockImplementationOnce(() => {
        throw failure;
      });

    await expect(
      service.getMemberDeliveryState(room._id.toString(), userId.toString(), 1),
    ).rejects.toBe(failure);
    lookup.mockRestore();
  });

  it("propagates canonical Program delivery resolver failures for durable retry", async () => {
    const userId = await insertUser("ProgramDeliveryRecipient");
    const programId = await insertProgram("Delivery resolver failure", userId);
    const room = await Conversation.create({ kind: "program", programId });
    await ConversationMember.create({
      conversationId: room._id,
      userId,
      role: "mentor",
      status: "active",
      joinedAt: nowValue,
      accessWindows: [
        {
          visibleFromSequence: 1,
          visibleThroughSequence: null,
          openedAt: nowValue,
          closedAt: null,
        },
      ],
    });
    const failure = new Error("canonical resolver database unavailable");
    const failingService = new ChatRoomService({
      now: () => new Date(nowValue),
      runtime: {
        getOperationalRuntimeConfig: async () =>
          createRuntimeConfigDTO("on", 1),
      },
      programMembershipResolver: {
        resolveProgram: vi.fn().mockRejectedValue(failure),
        resolveProgramMember: vi.fn().mockRejectedValue(failure),
      },
    });

    await expect(
      failingService.listActiveRetainedMemberUserIds(
        room._id.toString(),
        1,
      ),
    ).rejects.toBe(failure);
    await expect(
      failingService.isActiveRetainedMemberForDelivery(
        room._id.toString(),
        userId.toString(),
        1,
      ),
    ).rejects.toBe(failure);
  });

  it("performs the canonical Program check after the delivery counter snapshot", async () => {
    const mentorId = await insertUser("Mentor");
    const programId = await insertProgram("Delivery authorization", mentorId);
    const room = await Conversation.create({ kind: "program", programId });
    await ConversationMember.create({
      conversationId: room._id,
      userId: mentorId,
      role: "mentor",
      status: "active",
      joinedAt: nowValue,
      accessWindows: [
        {
          visibleFromSequence: 1,
          visibleThroughSequence: null,
          openedAt: nowValue,
          closedAt: null,
        },
      ],
      unreadCount: 1,
    });
    let releaseCanonical!: () => void;
    const canonicalReady = new Promise<void>((resolve) => {
      releaseCanonical = resolve;
    });
    let canonicalStarted!: () => void;
    const canonicalStartedPromise = new Promise<void>((resolve) => {
      canonicalStarted = resolve;
    });
    const resolver = new ProgramMemberBatchReadResolver({
      now: () => new Date(nowValue),
    });
    const gatedService = new ChatRoomService({
      now: () => new Date(nowValue),
      runtime: {
        getOperationalRuntimeConfig: async () =>
          createRuntimeConfigDTO("on", 1),
      },
      programMemberBatchReadResolver: {
        resolveEligibleMemberships: async (...args) => {
          canonicalStarted();
          await canonicalReady;
          return resolver.resolveEligibleMemberships(...args);
        },
      },
    });
    const statePending = gatedService.getMemberDeliveryStates(
      room._id.toString(),
      [mentorId.toString()],
      1,
    );
    await canonicalStartedPromise;

    await Program.collection.updateOne(
      { _id: programId },
      { $set: { mentors: [], updatedAt: nowValue } },
    );
    releaseCanonical();

    await expect(statePending).resolves.toEqual([]);
  });

  it("continues delayed delivery inside an access window while runtime mode is read-only", async () => {
    const senderId = await insertUser("Sender");
    const recipientId = await insertUser("Recipient");
    const room = await createRoom(senderId, recipientId);
    const message = await insertMessage({
      conversationId: room._id,
      senderId,
      sequence: 1,
    });
    await Conversation.collection.updateOne(
      { _id: room._id },
      {
        $set: {
          lastSequence: 1,
          lastMessageId: message._id,
          latestMessagePurgeAt: message.purgeAt,
          updatedAt: nowValue,
        },
      },
    );
    const readOnlyService = new ChatRoomService({
      now: () => new Date(nowValue),
      runtime: {
        getOperationalRuntimeConfig: async () =>
          createRuntimeConfigDTO("read_only", 2),
      },
    });

    const detail = await readOnlyService.get(
      recipientId.toString(),
      room._id.toString(),
    );
    expect(detail.conversation.viewer).toMatchObject({
      accessMode: "read_only",
      canSend: false,
    });
    await expect(
      readOnlyService.listActiveRetainedMemberUserIds(room._id.toString(), 1),
    ).resolves.toEqual(
      expect.arrayContaining([senderId.toString(), recipientId.toString()]),
    );
    await expect(
      readOnlyService.getMemberDeliveryState(
        room._id.toString(),
        recipientId.toString(),
        1,
      ),
    ).resolves.toMatchObject({
      roomUnreadCount: 0,
      lastReadSequence: 0,
    });
    await expect(
      readOnlyService.send({
        conversationId: room._id.toString(),
        actor: actor(senderId),
        clientMessageId: message.clientMessageId,
        idempotencyKey: randomUUID(),
        content: "message-1",
        safeLink: null,
      }),
    ).resolves.toMatchObject({
      message: { id: message._id.toString(), sequence: 1 },
    });
  });

  it("archives a Help Room transactionally into Past/read-only history with the approved retention clock", async () => {
    const senderId = await insertUser("Sender");
    const recipientId = await insertUser("Recipient");
    const room = await createRoom(senderId, recipientId);
    const sent = await service.send(sendInput(room._id, senderId, "retained"));
    const helpRequestId = room.helpRequestId!;
    const provisioner = new AlumniHelpRoomProvisioner();

    await transactions.run((session) =>
      provisioner.archiveInTransaction({
        conversationId: room._id,
        helpRequestId,
        archivedAt: nowValue,
        session,
      }),
    );
    // Repeating the exact lifecycle operation remains a no-op for transaction
    // retries/recovery and must not advance revisions again.
    await transactions.run((session) =>
      provisioner.archiveInTransaction({
        conversationId: room._id,
        helpRequestId,
        archivedAt: nowValue,
        session,
      }),
    );

    const expectedPurgeAt = conversationPurgeAt(
      nowValue,
      chatMessagePurgeAt(new Date(sent.message.createdAt)),
    );
    const archived = await Conversation.findById(room._id).lean().orFail();
    expect(archived).toMatchObject({
      status: "archived",
      archivedAt: nowValue,
      purgeAt: expectedPurgeAt,
      revision: 2,
    });
    const members = await ConversationMember.find({ conversationId: room._id })
      .sort({ _id: 1 })
      .lean();
    expect(members).toHaveLength(2);
    for (const member of members) {
      expect(member).toMatchObject({
        status: "history_only",
        unreadCount: 0,
        purgeAt: expectedPurgeAt,
        revision: 2,
        accessWindows: [
          expect.objectContaining({
            visibleThroughSequence: 1,
            closedAt: nowValue,
          }),
        ],
      });
    }

    const past = await service.list(recipientId.toString(), {
      view: "past",
      page: 1,
      limit: 30,
    });
    expect(past.conversations).toHaveLength(1);
    expect(past.conversations[0]).toMatchObject({
      id: room._id.toString(),
      section: "past",
      status: "archived",
      viewer: { accessMode: "read_only", canSend: false },
    });
    await expect(
      service.history(recipientId.toString(), room._id.toString(), {
        afterSequence: 0,
        limit: 50,
      }),
    ).resolves.toMatchObject({
      messages: [expect.objectContaining({ sequence: 1, content: "retained" })],
    });
    await expect(
      service.send(sendInput(room._id, senderId, "too late")),
    ).rejects.toMatchObject({ code: "CHAT_ROOM_READ_ONLY" });
    await expect(
      service.send({
        conversationId: room._id.toString(),
        actor: actor(senderId),
        clientMessageId: sent.message.clientMessageId,
        idempotencyKey: randomUUID(),
        content: "retained",
        safeLink: null,
      }),
    ).resolves.toEqual(sent);
    await expect(
      service.markRead({
        conversationId: room._id.toString(),
        actor: actor(recipientId),
        throughSequence: 1,
      }),
    ).rejects.toMatchObject({ code: "CHAT_ROOM_READ_ONLY" });
    await expect(
      service.setMuted({
        conversationId: room._id.toString(),
        actor: actor(recipientId),
        muted: true,
      }),
    ).resolves.toMatchObject({
      conversationId: room._id.toString(),
      muted: true,
      chatUnreadTotal: 0,
    });
    await expect(
      ConversationMember.findOne({
        conversationId: room._id,
        userId: recipientId,
      })
        .lean()
        .orFail(),
    ).resolves.toMatchObject({ status: "history_only", muted: true });
    await expect(
      service.listActiveRetainedMemberUserIds(room._id.toString(), 1),
    ).resolves.toEqual([]);
    await expect(
      service.getMemberDeliveryState(
        room._id.toString(),
        recipientId.toString(),
        1,
      ),
    ).resolves.toBeNull();
  });
});
