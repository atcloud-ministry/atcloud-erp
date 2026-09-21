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
import { ChatRoomService } from "../../../src/services/chat/ChatRoomService";
import { ChatSendRateLimiter } from "../../../src/services/chat/ChatSendRateLimiter";
import { enqueueChatMessagePersisted } from "../../../src/services/chat/ChatMessageOutbox";
import { ProgramMembershipResolver } from "../../../src/services/programs/ProgramMembershipResolver";
import { enqueueWebPushChatMessagesBatch } from "../../../src/services/push/WebPushChatMessageOutbox";
import { IdempotencyService } from "../../../src/services/reliability/IdempotencyService";
import { MongoTransactionService } from "../../../src/services/reliability/MongoTransactionService";
import { ensureIntegrationDB } from "../setup/connect";

const NOW = new Date("2026-09-12T18:00:00.000Z");
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

interface UserFixture {
  readonly id: mongoose.Types.ObjectId;
  readonly role: "Participant" | "Leader" | "Administrator";
}

interface ProgramFixture {
  readonly programId: mongoose.Types.ObjectId;
  readonly roomId: mongoose.Types.ObjectId;
  readonly users: Readonly<Record<string, UserFixture>>;
}

let transactions: MongoTransactionService;

function userDocument(
  label: string,
  role: UserFixture["role"] = "Participant",
): Record<string, unknown> & { _id: mongoose.Types.ObjectId } {
  const _id = new mongoose.Types.ObjectId();
  const username = `pa-${label}-${_id.toString().slice(-8)}`
    .toLowerCase()
    .slice(0, 40);
  return {
    _id,
    username,
    usernameLower: username,
    email: `${username}@private.example.org`,
    phone: "+12065550199",
    birthYear: 1988,
    password: "Integration1",
    firstName: label.slice(0, 80),
    lastName: "Member",
    avatar: null,
    residenceCity: "Seattle",
    residenceRegion: "US-WA",
    residenceCountryCode: "US",
    employmentStatus: "employed",
    company: "Private Employer",
    occupation: "Product Manager",
    isAtCloudLeader: role !== "Participant",
    role,
    isActive: true,
    isVerified: true,
    emailNotifications: true,
    loginAttempts: 0,
    hasReceivedWelcomeMessage: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function memberDocument(
  conversationId: mongoose.Types.ObjectId,
  userId: mongoose.Types.ObjectId,
  role: "mentor" | "class_representative" | "mentee",
  muted = false,
) {
  return {
    _id: new mongoose.Types.ObjectId(),
    conversationId,
    userId,
    role,
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
    unreadReconciledAt: null,
    muted,
    mutedAt: muted ? NOW : null,
    purgeAt: null,
    revision: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function createProgramFixture(input: {
  readonly users: Readonly<Record<string, UserFixture>>;
  readonly mentorKeys: readonly string[];
  readonly classRepresentativeKeys?: readonly string[];
  readonly menteeKeys?: readonly string[];
  readonly staleMemberKeys?: readonly string[];
  readonly mutedKeys?: readonly string[];
}): Promise<ProgramFixture> {
  const programId = new mongoose.Types.ObjectId();
  const createdBy = Object.values(input.users)[0]!.id;
  await Program.collection.insertOne({
    _id: programId,
    title: `Program announcement ${randomUUID()}`,
    programType: "EMBA Mentor Circles",
    hostedBy: "@Cloud Marketplace Ministry",
    isFree: true,
    fullPriceTicket: 0,
    classRepDiscount: 0,
    earlyBirdDiscount: 0,
    classRepLimit: 0,
    classRepCount: 0,
    mentors: input.mentorKeys.map((key) => ({ userId: input.users[key]!.id })),
    adminEnrollments: {
      classReps: (input.classRepresentativeKeys ?? []).map(
        (key) => input.users[key]!.id,
      ),
      mentees: (input.menteeKeys ?? []).map((key) => input.users[key]!.id),
    },
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
    createdAt: NOW,
    updatedAt: NOW,
  });
  await ProgramCommunitySettings.create({
    programId,
    enabled: true,
    opensAt: new Date("2026-09-01T00:00:00.000Z"),
    closesAt: new Date("2027-01-01T00:00:00.000Z"),
    archivedAt: null,
    studentRoleMappings: [
      { studentRoleId: "participant", memberRole: "mentee" },
    ],
    revision: 1,
  });
  const room = await Conversation.create({
    kind: "program",
    status: "current",
    programId,
    helpRequestId: null,
    lastSequence: 0,
    revision: 0,
  });
  const mentorKeys = new Set(input.mentorKeys);
  const classRepresentativeKeys = new Set(
    input.classRepresentativeKeys ?? [],
  );
  const staleMemberKeys = new Set(input.staleMemberKeys ?? []);
  const mutedKeys = new Set(input.mutedKeys ?? []);
  await ConversationMember.collection.insertMany(
    Object.entries(input.users)
      .filter(([key]) =>
        mentorKeys.has(key) ||
        classRepresentativeKeys.has(key) ||
        (input.menteeKeys ?? []).includes(key) ||
        staleMemberKeys.has(key),
      )
      .map(([key, user]) =>
        memberDocument(
          room._id,
          user.id,
          mentorKeys.has(key)
            ? "mentor"
            : classRepresentativeKeys.has(key)
              ? "class_representative"
              : "mentee",
          mutedKeys.has(key),
        ),
      ),
  );
  return { programId, roomId: room._id, users: input.users };
}

async function insertUsers(
  definitions: Readonly<Record<string, UserFixture["role"]>>,
): Promise<Readonly<Record<string, UserFixture>>> {
  const documents = Object.entries(definitions).map(([key, role]) => [
    key,
    userDocument(key, role),
  ] as const);
  await User.collection.insertMany(documents.map(([, document]) => document));
  return Object.freeze(
    Object.fromEntries(
      documents.map(([key, document]) => [
        key,
        Object.freeze({ id: document._id, role: document.role }),
      ]),
    ) as Record<string, UserFixture>,
  );
}

function createService(batchSizes: number[] = []): ChatRoomService {
  const idempotency = new IdempotencyService(
    transactions,
    IdempotencyRecord as never,
    () => new Date(NOW),
  );
  return new ChatRoomService({
    now: () => new Date(NOW),
    runtime: {
      getOperationalRuntimeConfig: async () => createRuntimeConfigDTO("on", 1),
    },
    transactions,
    idempotency,
    rateLimiter: new ChatSendRateLimiter({ now: () => NOW.getTime() }),
    programMembershipResolver: new ProgramMembershipResolver({
      now: () => new Date(NOW),
    }),
    enqueueMessage: (input) => enqueueChatMessagePersisted(input),
    enqueuePushMessagesBatch: async (inputs) => {
      batchSizes.push(inputs.length);
      return enqueueWebPushChatMessagesBatch(inputs);
    },
  });
}

function publishInput(
  fixture: ProgramFixture,
  actorKey: string,
  clientMessageId = randomUUID(),
  idempotencyKey = randomUUID(),
) {
  const actor = fixture.users[actorKey]!;
  return {
    conversationId: fixture.roomId.toString(),
    actor: { id: actor.id.toString(), role: actor.role },
    clientMessageId,
    idempotencyKey,
    content: `Program update ${clientMessageId}`,
  } as const;
}

describe("M6 Program announcement transaction integration", () => {
  beforeAll(async () => {
    await ensureIntegrationDB();
    await Promise.all(collections.map((model) => model.init()));
    transactions = new MongoTransactionService(mongoose.connection);
    const capability = await transactions.assertTopologyCapability(true);
    expect(capability.supported).toBe(true);
  });

  beforeEach(async () => {
    await Promise.all(collections.map((model) => model.deleteMany({})));
  });

  afterAll(async () => {
    await Promise.all(collections.map((model) => model.deleteMany({})));
  });

  it("authorizes only canonical Mentor, Class Representative, and Leader+ Mentee members", async () => {
    const users = await insertUsers({
      mentor: "Participant",
      classRepresentative: "Participant",
      leaderMentee: "Leader",
      participantMentee: "Participant",
      staleAdministrator: "Administrator",
    });
    const fixture = await createProgramFixture({
      users,
      mentorKeys: ["mentor"],
      classRepresentativeKeys: ["classRepresentative"],
      menteeKeys: ["leaderMentee", "participantMentee"],
    });
    const service = createService();

    await expect(
      service.publishAnnouncement(publishInput(fixture, "mentor")),
    ).resolves.toMatchObject({ message: { kind: "announcement" } });
    await expect(
      service.publishAnnouncement(
        publishInput(fixture, "classRepresentative"),
      ),
    ).resolves.toMatchObject({ message: { kind: "announcement" } });
    await expect(
      service.publishAnnouncement(publishInput(fixture, "leaderMentee")),
    ).resolves.toMatchObject({ message: { kind: "announcement" } });
    await expect(
      service.publishAnnouncement(
        publishInput(fixture, "participantMentee"),
      ),
    ).rejects.toMatchObject({
      code: "CHAT_ANNOUNCEMENT_FORBIDDEN",
      httpStatus: 403,
    });

    const staleFixture = await createProgramFixture({
      users,
      mentorKeys: ["mentor"],
      staleMemberKeys: ["staleAdministrator"],
    });
    await expect(
      service.publishAnnouncement(
        publishInput(staleFixture, "staleAdministrator"),
      ),
    ).rejects.toMatchObject({ code: "CHAT_ROOM_READ_ONLY" });
  });

  it("increments canonical muted recipients and replays exactly once", async () => {
    const users = await insertUsers({
      mentor: "Participant",
      active: "Participant",
      muted: "Participant",
    });
    const fixture = await createProgramFixture({
      users,
      mentorKeys: ["mentor"],
      menteeKeys: ["active", "muted"],
      mutedKeys: ["muted"],
    });
    const batchSizes: number[] = [];
    const service = createService(batchSizes);
    const clientMessageId = randomUUID();
    const idempotencyKey = randomUUID();
    const input = publishInput(
      fixture,
      "mentor",
      clientMessageId,
      idempotencyKey,
    );

    const first = await service.publishAnnouncement(input);
    const replay = await service.publishAnnouncement(input);

    expect(replay.message.id).toBe(first.message.id);
    expect(replay.message.sequence).toBe(first.message.sequence);
    expect(batchSizes).toEqual([2]);
    const members = await ConversationMember.find({
      conversationId: fixture.roomId,
    })
      .select("userId unreadCount muted")
      .lean<Array<{ userId: mongoose.Types.ObjectId; unreadCount: number; muted: boolean }>>();
    const unreadByUser = new Map(
      members.map((member) => [member.userId.toString(), member.unreadCount]),
    );
    expect(unreadByUser.get(users.mentor!.id.toString())).toBe(0);
    expect(unreadByUser.get(users.active!.id.toString())).toBe(1);
    expect(unreadByUser.get(users.muted!.id.toString())).toBe(1);
    expect(
      await service.listActiveRetainedMemberUserIds(
        fixture.roomId.toString(),
        first.message.sequence,
      ),
    ).toEqual(
      expect.arrayContaining([
        users.mentor!.id.toString(),
        users.active!.id.toString(),
        users.muted!.id.toString(),
      ]),
    );
    expect(
      await NotificationOutbox.countDocuments({ topic: "chat.message.persisted" }),
    ).toBe(1);
    expect(
      await NotificationOutbox.countDocuments({ topic: "web_push.chat_message" }),
    ).toBe(2);
    expect(await ChatMessage.countDocuments({ kind: "announcement" })).toBe(1);
    expect(
      await AuditLog.countDocuments({
        action: "chat.program_announcement_published",
      }),
    ).toBe(1);
  });

  it("blocks a removal projection gap without consuming a sequence, then resumes at N+1 after cutoff", async () => {
    const users = await insertUsers({
      mentor: "Participant",
      removedMentee: "Participant",
    });
    const fixture = await createProgramFixture({
      users,
      mentorKeys: ["mentor"],
      menteeKeys: ["removedMentee"],
    });
    const service = createService();
    const initial = await service.publishAnnouncement(
      publishInput(fixture, "mentor"),
    );
    expect(initial.message.sequence).toBe(1);

    await Program.collection.updateOne(
      { _id: fixture.programId },
      { $set: { "adminEnrollments.mentees": [], updatedAt: NOW } },
    );
    await expect(
      service.isActiveRetainedMemberForDelivery(
        fixture.roomId.toString(),
        users.removedMentee!.id.toString(),
        1,
      ),
    ).resolves.toBe(false);
    await expect(
      service.send({
        conversationId: fixture.roomId.toString(),
        actor: {
          id: users.mentor!.id.toString(),
          role: users.mentor!.role,
        },
        clientMessageId: randomUUID(),
        idempotencyKey: randomUUID(),
        content: "Blocked while removal projection is stale",
        safeLink: null,
      }),
    ).rejects.toMatchObject({ code: "CHAT_ROOM_READ_ONLY" });
    expect(
      await Conversation.findById(fixture.roomId).distinct("lastSequence"),
    ).toEqual([1]);

    await ConversationMember.collection.updateOne(
      {
        conversationId: fixture.roomId,
        userId: users.removedMentee!.id,
      },
      {
        $set: {
          status: "history_only",
          accessWindows: [
            {
              visibleFromSequence: 1,
              visibleThroughSequence: 1,
              openedAt: NOW,
              closedAt: NOW,
            },
          ],
          unreadCount: 0,
          updatedAt: NOW,
        },
      },
    );
    const resumed = await service.send({
      conversationId: fixture.roomId.toString(),
      actor: {
        id: users.mentor!.id.toString(),
        role: users.mentor!.role,
      },
      clientMessageId: randomUUID(),
      idempotencyKey: randomUUID(),
      content: "Resumed after removal cutoff",
      safeLink: null,
    });
    expect(resumed.message.sequence).toBe(2);
    const removedHistory = await service.history(
      users.removedMentee!.id.toString(),
      fixture.roomId.toString(),
      { limit: 30 },
    );
    expect(removedHistory.messages.map(({ sequence }) => sequence)).toEqual([1]);
  });

  it("blocks an addition and role projection gap, then includes the member after sync", async () => {
    const users = await insertUsers({
      mentor: "Participant",
      addedMentee: "Participant",
    });
    const fixture = await createProgramFixture({
      users,
      mentorKeys: ["mentor"],
    });
    const batchSizes: number[] = [];
    const service = createService(batchSizes);
    const initial = await service.publishAnnouncement(
      publishInput(fixture, "mentor"),
    );
    expect(initial.message.sequence).toBe(1);
    batchSizes.length = 0;

    await Program.collection.updateOne(
      { _id: fixture.programId },
      {
        $set: {
          "adminEnrollments.mentees": [users.addedMentee!.id],
          updatedAt: NOW,
        },
      },
    );
    await expect(
      service.publishAnnouncement(publishInput(fixture, "mentor")),
    ).rejects.toMatchObject({ code: "CHAT_ROOM_READ_ONLY" });

    await ConversationMember.create({
      ...memberDocument(
        fixture.roomId,
        users.addedMentee!.id,
        "class_representative",
      ),
      accessWindows: [
        {
          visibleFromSequence: 2,
          visibleThroughSequence: null,
          openedAt: NOW,
          closedAt: null,
        },
      ],
    });
    await expect(
      service.isActiveRetainedMemberForDelivery(
        fixture.roomId.toString(),
        users.addedMentee!.id.toString(),
        2,
      ),
    ).resolves.toBe(false);
    await expect(
      service.publishAnnouncement(publishInput(fixture, "mentor")),
    ).rejects.toMatchObject({ code: "CHAT_ROOM_READ_ONLY" });
    await ConversationMember.collection.updateOne(
      {
        conversationId: fixture.roomId,
        userId: users.addedMentee!.id,
      },
      { $set: { role: "mentee", updatedAt: NOW } },
    );
    await expect(
      service.isActiveRetainedMemberForDelivery(
        fixture.roomId.toString(),
        users.addedMentee!.id.toString(),
        2,
      ),
    ).resolves.toBe(true);

    const resumed = await service.publishAnnouncement(
      publishInput(fixture, "mentor"),
    );
    expect(resumed.message.sequence).toBe(2);
    expect(batchSizes).toEqual([1]);
    const addedMember = await ConversationMember.findOne({
      conversationId: fixture.roomId,
      userId: users.addedMentee!.id,
    }).lean<{ unreadCount: number }>();
    expect(addedMember?.unreadCount).toBe(1);
    const addedHistory = await service.history(
      users.addedMentee!.id.toString(),
      fixture.roomId.toString(),
      { limit: 30 },
    );
    expect(addedHistory.messages.map(({ sequence }) => sequence)).toEqual([2]);
  });

  it("enforces ten persisted announcements per Program per hour without charging replay", async () => {
    const users = await insertUsers({ mentor: "Participant" });
    const fixture = await createProgramFixture({
      users,
      mentorKeys: ["mentor"],
    });
    const service = createService();
    const firstInput = publishInput(fixture, "mentor");
    const first = await service.publishAnnouncement(firstInput);
    const replay = await service.publishAnnouncement(firstInput);
    expect(replay.message.id).toBe(first.message.id);
    for (let index = 1; index < 10; index += 1) {
      await service.publishAnnouncement(publishInput(fixture, "mentor"));
    }

    await expect(
      service.publishAnnouncement(publishInput(fixture, "mentor")),
    ).rejects.toMatchObject({
      code: "CHAT_ANNOUNCEMENT_RATE_LIMITED",
      httpStatus: 429,
      retryAfterSeconds: 3_600,
    });
    expect(await ChatMessage.countDocuments({ kind: "announcement" })).toBe(10);
  });

  it("commits only ten of eleven concurrent announcements and rate-limits the retry", async () => {
    const users = await insertUsers({ mentor: "Participant" });
    const fixture = await createProgramFixture({
      users,
      mentorKeys: ["mentor"],
    });
    const service = createService();

    const results = await Promise.allSettled(
      Array.from({ length: 11 }, () =>
        service.publishAnnouncement(publishInput(fixture, "mentor")),
      ),
    );
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.publishAnnouncement>>> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(10);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      code: "CHAT_ANNOUNCEMENT_RATE_LIMITED",
      httpStatus: 429,
      retryAfterSeconds: 3_600,
    });
    expect(
      fulfilled.map(({ value }) => value.message.sequence).sort((a, b) => a - b),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await expect(
      Conversation.findById(fixture.roomId).lean().orFail(),
    ).resolves.toMatchObject({ lastSequence: 10 });
    expect(
      await ChatMessage.countDocuments({
        conversationId: fixture.roomId,
        kind: "announcement",
      }),
    ).toBe(10);
  });

  it("writes 500-recipient announcement and text fan-outs in durable batches of 100", async () => {
    const documents = [
      userDocument("mentor"),
      ...Array.from({ length: 500 }, (_, index) =>
        userDocument(`recipient-${index}`),
      ),
    ];
    await User.collection.insertMany(documents);
    const users: Record<string, UserFixture> = {
      mentor: { id: documents[0]!._id, role: "Participant" },
    };
    for (let index = 0; index < 500; index += 1) {
      users[`recipient-${index}`] = {
        id: documents[index + 1]!._id,
        role: "Participant",
      };
    }
    const recipientKeys = Array.from(
      { length: 500 },
      (_, index) => `recipient-${index}`,
    );
    const fixture = await createProgramFixture({
      users,
      mentorKeys: ["mentor"],
      menteeKeys: recipientKeys,
    });
    const batchSizes: number[] = [];
    const service = createService(batchSizes);

    await service.publishAnnouncement(publishInput(fixture, "mentor"));

    expect(batchSizes).toEqual([100, 100, 100, 100, 100]);
    expect(
      await NotificationOutbox.countDocuments({ topic: "web_push.chat_message" }),
    ).toBe(500);
    expect(
      await ConversationMember.countDocuments({
        conversationId: fixture.roomId,
        unreadCount: 1,
      }),
    ).toBe(500);

    batchSizes.length = 0;
    await service.send({
      conversationId: fixture.roomId.toString(),
      actor: {
        id: users.mentor!.id.toString(),
        role: users.mentor!.role,
      },
      clientMessageId: randomUUID(),
      idempotencyKey: randomUUID(),
      content: "Program discussion message",
      safeLink: null,
    });
    expect(batchSizes).toEqual([100, 100, 100, 100, 100]);
    expect(
      await NotificationOutbox.countDocuments({ topic: "web_push.chat_message" }),
    ).toBe(1_000);
    expect(
      await ConversationMember.countDocuments({
        conversationId: fixture.roomId,
        unreadCount: 2,
      }),
    ).toBe(500);

    const deliveryUserIds = Object.values(users).map(({ id }) => id.toString());
    const aggregate = vi.spyOn(ConversationMember, "aggregate");
    const deliveryStates = await service.getMemberDeliveryStates(
      fixture.roomId.toString(),
      deliveryUserIds,
      2,
    );
    expect(deliveryStates).toHaveLength(501);
    expect(aggregate).toHaveBeenCalledTimes(2);
    expect(
      deliveryStates.find(
        ({ userId }) => userId === users["recipient-0"]!.id.toString(),
      ),
    ).toMatchObject({ roomUnreadCount: 2, chatUnreadTotal: 2 });

    const removedId = users["recipient-499"]!.id;
    const roleMismatchId = users["recipient-498"]!.id;
    await Program.collection.updateOne(
      { _id: fixture.programId },
      { $pull: { "adminEnrollments.mentees": removedId } },
    );
    await ConversationMember.collection.updateOne(
      { conversationId: fixture.roomId, userId: roleMismatchId },
      { $set: { role: "mentor", updatedAt: NOW } },
    );
    const revalidatedStates = await service.getMemberDeliveryStates(
      fixture.roomId.toString(),
      deliveryUserIds,
      2,
    );
    expect(revalidatedStates).toHaveLength(499);
    expect(aggregate).toHaveBeenCalledTimes(4);
    expect(
      revalidatedStates.some(
        ({ userId }) =>
          userId === removedId.toString() ||
          userId === roleMismatchId.toString(),
      ),
    ).toBe(false);
    aggregate.mockRestore();
  });
});
