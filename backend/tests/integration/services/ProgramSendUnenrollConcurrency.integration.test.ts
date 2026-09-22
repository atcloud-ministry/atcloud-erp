import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { enqueueChatMessagePersisted } from "../../../src/services/chat/ChatMessageOutbox";
import { ChatRoomService } from "../../../src/services/chat/ChatRoomService";
import { ChatSendRateLimiter } from "../../../src/services/chat/ChatSendRateLimiter";
import { enqueueWebPushChatMessagesBatch } from "../../../src/services/push/WebPushChatMessageOutbox";
import { ProgramMembershipResolver } from "../../../src/services/programs/ProgramMembershipResolver";
import { ProgramRoomMembershipSyncService } from "../../../src/services/programs/ProgramRoomMembershipSyncService";
import { IdempotencyService } from "../../../src/services/reliability/IdempotencyService";
import { MongoTransactionService } from "../../../src/services/reliability/MongoTransactionService";
import { ensureIntegrationDB } from "../setup/connect";

const NOW = new Date("2032-09-12T18:00:00.000Z");
const RUNTIME = Object.freeze({
  getOperationalRuntimeConfig: async () => createRuntimeConfigDTO("on", 1),
});
const models = [
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

let transactions: MongoTransactionService;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function expectSoon(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for the canonical read gate.")),
          5_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function userDocument(label: string) {
  const _id = new mongoose.Types.ObjectId();
  const username = `m6-linear-${label}-${_id.toString().slice(-6)}`;
  return {
    _id,
    username,
    usernameLower: username,
    email: `${username}@private.example.org`,
    phone: "+12065550199",
    birthYear: 1988,
    password: "Integration1",
    firstName: label,
    lastName: "Member",
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
  };
}

async function createFixture() {
  const mentor = userDocument("mentor");
  const sender = userDocument("sender");
  await User.collection.insertMany([mentor, sender]);
  const program = await Program.create({
    title: `M6 linearization ${randomUUID()}`,
    programType: "EMBA Mentor Circles",
    isFree: true,
    fullPriceTicket: 0,
    createdBy: mentor._id,
    mentors: [{ userId: mentor._id }],
    adminEnrollments: { classReps: [], mentees: [sender._id] },
    programRoles: {
      teacherRoleName: "Mentor",
      studentRoles: [{ id: "participant", name: "Participant" }],
    },
  });
  await ProgramCommunitySettings.create({
    programId: program._id,
    enabled: true,
    opensAt: new Date("2032-09-01T00:00:00.000Z"),
    closesAt: new Date("2033-01-01T00:00:00.000Z"),
    archivedAt: null,
    studentRoleMappings: [
      { studentRoleId: "participant", memberRole: "mentee" },
    ],
    revision: 1,
  });
  const room = await Conversation.create({
    kind: "program",
    status: "current",
    programId: program._id,
    helpRequestId: null,
    lastSequence: 0,
    revision: 0,
  });
  const sync = new ProgramRoomMembershipSyncService({
    now: () => new Date(NOW),
    runtimeReader: RUNTIME,
    transactions,
  });
  await expect(sync.reconcileProgram(program._id)).resolves.toMatchObject({
    desiredMemberships: 2,
    createdMemberships: 2,
  });
  return { mentorId: mentor._id, senderId: sender._id, program, room, sync };
}

function createChatService(
  resolver: Pick<
    ProgramMembershipResolver,
    "resolveProgram" | "resolveProgramMember"
  > = new ProgramMembershipResolver({ now: () => new Date(NOW) }),
) {
  return new ChatRoomService({
    now: () => new Date(NOW),
    runtime: RUNTIME,
    transactions,
    idempotency: new IdempotencyService(
      transactions,
      IdempotencyRecord as never,
      () => new Date(NOW),
    ),
    rateLimiter: new ChatSendRateLimiter({ now: () => NOW.getTime() }),
    programMembershipResolver: resolver,
    enqueueMessage: (input) => enqueueChatMessagePersisted(input),
    enqueuePushMessagesBatch: (inputs) =>
      enqueueWebPushChatMessagesBatch(inputs),
  });
}

function sendInput(
  roomId: mongoose.Types.ObjectId,
  senderId: mongoose.Types.ObjectId,
  content: string,
) {
  return {
    conversationId: roomId.toString(),
    actor: { id: senderId.toString(), role: "Participant" },
    clientMessageId: randomUUID(),
    idempotencyKey: randomUUID(),
    content,
    safeLink: null,
  } as const;
}

async function commitCanonicalUnenroll(
  programId: mongoose.Types.ObjectId,
  senderId: mongoose.Types.ObjectId,
) {
  const result = await Program.updateOne(
    { _id: programId, "adminEnrollments.mentees": senderId },
    { $pull: { "adminEnrollments.mentees": senderId } },
  );
  expect(result.modifiedCount).toBe(1);
}

describe("M6 Program send/unenroll linearization", () => {
  beforeAll(async () => {
    await ensureIntegrationDB();
    await Promise.all(models.map((model) => model.init()));
    transactions = new MongoTransactionService(mongoose.connection);
    await expect(
      transactions.assertTopologyCapability(true),
    ).resolves.toMatchObject({ supported: true, topology: "replica_set" });
  });

  beforeEach(async () => {
    await Promise.all(models.map((model) => model.deleteMany({})));
  });

  afterAll(async () => {
    await Promise.all(models.map((model) => model.deleteMany({})));
  });

  it("linearizes an overlapping send before unenroll and cuts history off at that sequence", async () => {
    const fixture = await createFixture();
    const delegate = new ProgramMembershipResolver({
      now: () => new Date(NOW),
    });
    const canonicalRead = deferred();
    const releaseSend = deferred();
    let paused = false;
    const gatedResolver: Pick<
      ProgramMembershipResolver,
      "resolveProgram" | "resolveProgramMember"
    > = {
      resolveProgramMember: (...args) => delegate.resolveProgramMember(...args),
      resolveProgram: async (...args) => {
        const resolution = await delegate.resolveProgram(...args);
        if (
          !paused &&
          resolution.state === "open" &&
          resolution.memberships.some(
            ({ userId }) => userId === fixture.senderId.toString(),
          )
        ) {
          paused = true;
          canonicalRead.resolve();
          await releaseSend.promise;
        }
        return resolution;
      },
    };
    const chat = createChatService(gatedResolver);
    const pendingSend = chat.send(
      sendInput(fixture.room._id, fixture.senderId, "wins the overlap"),
    );

    await expectSoon(canonicalRead.promise);
    await commitCanonicalUnenroll(fixture.program._id, fixture.senderId);
    releaseSend.resolve();
    const sent = await pendingSend;
    expect(sent.message).toMatchObject({
      sequence: 1,
      content: "wins the overlap",
    });

    await expect(
      fixture.sync.reconcileProgram(fixture.program._id),
    ).resolves.toMatchObject({ closedMemberships: 1 });
    const senderMember = await ConversationMember.findOne({
      conversationId: fixture.room._id,
      userId: fixture.senderId,
    })
      .lean()
      .orFail();
    expect(senderMember).toMatchObject({
      status: "history_only",
      unreadCount: 0,
      accessWindows: [
        expect.objectContaining({ visibleThroughSequence: 1, closedAt: NOW }),
      ],
    });
    await expect(
      chat.history(fixture.senderId.toString(), fixture.room._id.toString(), {
        limit: 30,
      }),
    ).resolves.toMatchObject({
      messages: [expect.objectContaining({ sequence: 1, content: "wins the overlap" })],
    });
    await expect(
      chat.send(
        sendInput(fixture.room._id, fixture.senderId, "must be rejected"),
      ),
    ).rejects.toMatchObject({ code: "CHAT_ROOM_READ_ONLY" });
    await expect(
      Conversation.findById(fixture.room._id).lean().orFail(),
    ).resolves.toMatchObject({ lastSequence: 1 });
    expect(
      await ChatMessage.countDocuments({ conversationId: fixture.room._id }),
    ).toBe(1);
  });

  it("fails closed without allocating a sequence when canonical unenroll commits first", async () => {
    const fixture = await createFixture();
    const chat = createChatService();
    await commitCanonicalUnenroll(fixture.program._id, fixture.senderId);

    await expect(
      chat.send(
        sendInput(fixture.room._id, fixture.senderId, "must never persist"),
      ),
    ).rejects.toMatchObject({ code: "CHAT_ROOM_READ_ONLY" });
    await expect(
      Conversation.findById(fixture.room._id).lean().orFail(),
    ).resolves.toMatchObject({ lastSequence: 0, lastMessageId: null });
    expect(
      await ChatMessage.countDocuments({ conversationId: fixture.room._id }),
    ).toBe(0);
    expect(
      await NotificationOutbox.countDocuments({
        $or: [
          { topic: "chat.message.persisted" },
          { topic: "web_push.chat_message" },
        ],
      }),
    ).toBe(0);
  });
});
