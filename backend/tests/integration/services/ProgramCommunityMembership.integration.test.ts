import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { createRuntimeConfigDTO } from "../../../src/contracts/runtimeConfig";
import AuditLog from "../../../src/models/AuditLog";
import Conversation from "../../../src/models/Conversation";
import ConversationMember from "../../../src/models/ConversationMember";
import IdempotencyRecord from "../../../src/models/IdempotencyRecord";
import Program from "../../../src/models/Program";
import ProgramCommunitySettings from "../../../src/models/ProgramCommunitySettings";
import Purchase from "../../../src/models/Purchase";
import User from "../../../src/models/User";
import { ProgramCommunitySettingsService } from "../../../src/services/programs/ProgramCommunitySettingsService";
import { ProgramMembershipResolver } from "../../../src/services/programs/ProgramMembershipResolver";
import { ProgramRoomMembershipSyncService } from "../../../src/services/programs/ProgramRoomMembershipSyncService";
import {
  ProgramMembershipReconciliationService,
  type ProgramMembershipReconciliationRunContext,
} from "../../../src/services/programs/ProgramMembershipReconciliationService";
import { MongoTransactionService } from "../../../src/services/reliability/MongoTransactionService";
import { ChatRoomService } from "../../../src/services/chat/ChatRoomService";
import { conversationPurgeAt } from "../../../src/contracts/chatRooms";
import { ensureIntegrationDB } from "../setup/connect";

const NOW = new Date("2026-09-12T16:00:00.000Z");
const OPENS_AT = new Date("2026-09-01T00:00:00.000Z");
const CLOSES_AT = new Date("2027-01-01T00:00:00.000Z");
const WRITABLE_RUNTIME_READER = Object.freeze({
  getOperationalRuntimeConfig: async () => createRuntimeConfigDTO("on", 1),
});
const RECONCILIATION_RUN_CONTEXT: ProgramMembershipReconciliationRunContext =
  Object.freeze({
  source: "worker",
  runId: "m6-membership-integration",
  trigger: "manual",
  principal: {
    kind: "service",
    serviceKey: "program-membership-reconciler",
    capabilities: ["program.membership.reconcile"] as const,
    runId: "m6-membership-integration",
  },
  });
const models = [
  AuditLog,
  ConversationMember,
  Conversation,
  IdempotencyRecord,
  ProgramCommunitySettings,
  Purchase,
  Program,
  User,
] as const;

async function insertUser(label: string): Promise<mongoose.Types.ObjectId> {
  const _id = new mongoose.Types.ObjectId();
  const suffix = _id.toString().slice(-8);
  const username = `m6${label}${suffix}`.toLowerCase().slice(0, 20);
  await User.collection.insertOne({
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
    createdAt: NOW,
    updatedAt: NOW,
  });
  return _id;
}

async function createProgram(input: {
  createdBy: mongoose.Types.ObjectId;
  mentors?: mongoose.Types.ObjectId[];
  mentees?: mongoose.Types.ObjectId[];
  classReps?: mongoose.Types.ObjectId[];
}) {
  return Program.create({
    title: `M6 Program ${randomUUID()}`,
    programType: "EMBA Mentor Circles",
    isFree: true,
    fullPriceTicket: 0,
    createdBy: input.createdBy,
    mentors: input.mentors?.map((userId) => ({ userId })),
    adminEnrollments: {
      mentees: input.mentees ?? [],
      classReps: input.classReps ?? [],
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
        {
          id: "class-rep",
          name: "Class Representative",
          discountEligible: true,
          discountAmount: 0,
          limit: 0,
          count: 0,
        },
      ],
    },
  });
}

function settingsUpdateInput(
  programId: mongoose.Types.ObjectId,
  actorId: mongoose.Types.ObjectId,
  idempotencyKey: string,
) {
  return {
    programId: programId.toString(),
    actor: { id: actorId.toString(), role: "Administrator" },
    idempotencyKey,
    correlationId: `m6-concurrent-${idempotencyKey}`,
    enabled: true,
    opensAt: OPENS_AT,
    closesAt: CLOSES_AT,
    studentRoleMappings: [
      { studentRoleId: "participant", memberRole: "mentee" as const },
      {
        studentRoleId: "class-rep",
        memberRole: "class_representative" as const,
      },
    ],
    expectedRevision: 0,
  };
}

async function insertProgramPurchase(input: {
  programId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  studentRoleId: "participant" | "class-rep";
}) {
  const _id = new mongoose.Types.ObjectId();
  await Purchase.collection.insertOne({
    _id,
    userId: input.userId,
    purchaseType: "program",
    programId: input.programId,
    orderNumber: `M6-${randomUUID()}`,
    studentRoleId: input.studentRoleId,
    status: "completed",
    purchaseDate: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return _id;
}

async function createMembershipFixture() {
  const actorId = await insertUser("actor");
  const mentorId = await insertUser("mentor");
  const classRepId = await insertUser("classrep");
  const menteeId = await insertUser("mentee");
  const purchasedClassRepId = await insertUser("purchased");
  const program = await createProgram({
    createdBy: actorId,
    mentors: [mentorId],
    classReps: [mentorId, classRepId],
    mentees: [mentorId, classRepId, menteeId],
  });

  await ProgramCommunitySettings.create({
    programId: program._id,
    enabled: true,
    opensAt: OPENS_AT,
    closesAt: CLOSES_AT,
    archivedAt: null,
    studentRoleMappings: [
      { studentRoleId: "participant", memberRole: "mentee" },
      { studentRoleId: "class-rep", memberRole: "class_representative" },
    ],
    revision: 1,
  });
  const room = await Conversation.create({
    kind: "program",
    status: "current",
    programId: program._id,
    helpRequestId: null,
    lastSequence: 7,
    lastMessageId: new mongoose.Types.ObjectId(),
    latestMessagePurgeAt: new Date("2027-09-12T16:00:00.000Z"),
    revision: 0,
  });

  await Promise.all([
    insertProgramPurchase({
      programId: program._id,
      userId: mentorId,
      studentRoleId: "participant",
    }),
    insertProgramPurchase({
      programId: program._id,
      userId: classRepId,
      studentRoleId: "participant",
    }),
    insertProgramPurchase({
      programId: program._id,
      userId: menteeId,
      studentRoleId: "participant",
    }),
    insertProgramPurchase({
      programId: program._id,
      userId: purchasedClassRepId,
      studentRoleId: "class-rep",
    }),
  ]);

  return {
    program,
    room,
    mentorId,
    classRepId,
    menteeId,
    purchasedClassRepId,
  };
}

function createReconciliationService(now: Date, limit = 10) {
  return new ProgramMembershipReconciliationService({
    now: () => now,
    limit,
    sync: new ProgramRoomMembershipSyncService({
      now: () => now,
      runtimeReader: WRITABLE_RUNTIME_READER,
    }),
    authorization: {
      assertCapability: async () => undefined,
    },
    runtimeReader: WRITABLE_RUNTIME_READER,
  });
}

describe("M6 Program community membership transaction integration", () => {
  beforeAll(async () => {
    await ensureIntegrationDB();
    await Promise.all(models.map((model) => model.init()));
    const capability = await new MongoTransactionService(
      mongoose.connection,
    ).assertTopologyCapability(true);
    expect(capability.supported).toBe(true);
  });

  beforeEach(async () => {
    await Promise.all(models.map((model) => model.deleteMany({})));
  });

  afterAll(async () => {
    await Promise.all(models.map((model) => model.deleteMany({})));
  });

  it("keeps one primary Program Room when two enable transactions race", async () => {
    const actorId = await insertUser("owner");
    const program = await createProgram({ createdBy: actorId });
    const service = new ProgramCommunitySettingsService({ now: () => NOW });

    const attempts = await Promise.allSettled([
      service.update(
        settingsUpdateInput(program._id, actorId, randomUUID()),
      ),
      service.update(
        settingsUpdateInput(program._id, actorId, randomUUID()),
      ),
    ]);

    const fulfilled = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof service.update>>> =>
        attempt.status === "fulfilled",
    );
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult =>
        attempt.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({
      code: "PROGRAM_COMMUNITY_SETTINGS_REVISION_CONFLICT",
    });
    expect(await ProgramCommunitySettings.countDocuments({
      programId: program._id,
    })).toBe(1);
    expect(await Conversation.countDocuments({
      kind: "program",
      programId: program._id,
    })).toBe(1);
    expect(await AuditLog.countDocuments({
      action: "program.community_settings_updated",
    })).toBe(1);
  });

  it("deduplicates canonical sources and applies mentor/class-representative/mentee priority", async () => {
    const fixture = await createMembershipFixture();
    const resolver = new ProgramMembershipResolver({ now: () => NOW });

    const resolution = await resolver.resolveProgram(fixture.program._id);

    expect(resolution.state).toBe("open");
    expect(resolution.memberships).toEqual([
      {
        userId: fixture.mentorId.toString(),
        role: "mentor",
        sourceKinds: [
          "mentor_assignment",
          "admin_class_representative",
          "admin_mentee",
          "program_purchase",
        ],
      },
      {
        userId: fixture.classRepId.toString(),
        role: "class_representative",
        sourceKinds: [
          "admin_class_representative",
          "admin_mentee",
          "program_purchase",
        ],
      },
      {
        userId: fixture.menteeId.toString(),
        role: "mentee",
        sourceKinds: ["admin_mentee", "program_purchase"],
      },
      {
        userId: fixture.purchasedClassRepId.toString(),
        role: "class_representative",
        sourceKinds: ["program_purchase"],
      },
    ].sort((first, second) => first.userId.localeCompare(second.userId)));
  });

  it("fails the whole membership projection closed when Program roles drift from enabled mappings", async () => {
    const fixture = await createMembershipFixture();
    const resolver = new ProgramMembershipResolver({ now: () => NOW });
    const service = new ProgramRoomMembershipSyncService({
      resolver,
      now: () => NOW,
      runtimeReader: WRITABLE_RUNTIME_READER,
    });

    await Program.collection.updateOne(
      { _id: fixture.program._id },
      {
        $push: {
          "programRoles.studentRoles": {
            id: "new-role",
            name: "New Role",
            discountEligible: false,
            discountAmount: 0,
            limit: 0,
            count: 0,
          },
        },
      },
    );

    const resolution = await resolver.resolveProgram(fixture.program._id);
    const syncResult = await service.reconcileProgram(fixture.program._id);

    expect(resolution).toMatchObject({
      state: "role_mapping_invalid",
      conversationId: null,
      memberships: [],
      roleMappingDiagnostics: {
        canonicalRoleCount: 3,
        configuredMappingCount: 2,
        missingMappingCount: 1,
      },
    });
    expect(syncResult).toMatchObject({
      resolutionState: "role_mapping_invalid",
      desiredMemberships: 0,
      createdMemberships: 0,
      updatedRoles: 0,
    });
    expect(await ConversationMember.countDocuments({
      conversationId: fixture.room._id,
    })).toBe(0);
  });

  it("keeps mappings valid when Program student roles are only reordered", async () => {
    const fixture = await createMembershipFixture();
    const roles = fixture.program.programRoles!.studentRoles;
    await Program.collection.updateOne(
      { _id: fixture.program._id },
      { $set: { "programRoles.studentRoles": [...roles].reverse() } },
    );

    const resolution = await new ProgramMembershipResolver({
      now: () => NOW,
    }).resolveProgram(fixture.program._id);

    expect(resolution.state).toBe("open");
    expect(resolution.roleMappingDiagnostics).toMatchObject({
      missingMappingCount: 0,
      unexpectedMappingCount: 0,
      duplicateCanonicalRoleIdCount: 0,
      duplicateConfiguredRoleIdCount: 0,
    });
  });

  it("starts access at N+1 and advances only the Room fence on a repeated projection", async () => {
    const fixture = await createMembershipFixture();
    const service = new ProgramRoomMembershipSyncService({
      now: () => NOW,
      runtimeReader: WRITABLE_RUNTIME_READER,
    });

    const first = await service.reconcileProgram(fixture.program._id);
    const firstMembers = await ConversationMember.find({
      conversationId: fixture.room._id,
    })
      .sort({ userId: 1 })
      .lean();
    const roomAfterFirst = await Conversation.findById(fixture.room._id)
      .lean()
      .orFail();

    expect(first).toMatchObject({
      resolutionState: "open",
      desiredMemberships: 4,
      createdMemberships: 4,
      updatedRoles: 0,
      unchangedMemberships: 0,
      deferredRevocations: 0,
    });
    expect(firstMembers).toHaveLength(4);
    for (const member of firstMembers) {
      expect(member).toMatchObject({
        status: "active",
        accessWindows: [
          {
            visibleFromSequence: 8,
            visibleThroughSequence: null,
            openedAt: NOW,
            closedAt: null,
          },
        ],
        lastReadSequence: 7,
        unreadCount: 0,
        unreadReconciledThroughSequence: 7,
        revision: 0,
      });
    }

    const second = await service.reconcileProgram(fixture.program._id);
    const secondMembers = await ConversationMember.find({
      conversationId: fixture.room._id,
    })
      .sort({ userId: 1 })
      .lean();
    const roomAfterSecond = await Conversation.findById(fixture.room._id)
      .lean()
      .orFail();

    expect(second).toMatchObject({
      desiredMemberships: 4,
      createdMemberships: 0,
      updatedRoles: 0,
      unchangedMemberships: 4,
      deferredRevocations: 0,
    });
    expect(secondMembers).toEqual(firstMembers);
    expect(roomAfterSecond).toMatchObject({
      _id: roomAfterFirst._id,
      lastSequence: roomAfterFirst.lastSequence,
      lastMessageId: roomAfterFirst.lastMessageId,
      revision: roomAfterFirst.revision + 1,
    });
    expect(await AuditLog.countDocuments({
      action: "program.membership_synchronized",
    })).toBe(1);
  });

  it("retries an uncommitted first-Room projection after settings are disabled", async () => {
    const actorId = await insertUser("provisionactor");
    const mentorId = await insertUser("provisionmentor");
    const program = await createProgram({
      createdBy: actorId,
      mentors: [mentorId],
    });
    await ProgramCommunitySettings.create({
      programId: program._id,
      enabled: true,
      opensAt: OPENS_AT,
      closesAt: CLOSES_AT,
      archivedAt: null,
      studentRoleMappings: [
        { studentRoleId: "participant", memberRole: "mentee" },
        {
          studentRoleId: "class-rep",
          memberRole: "class_representative",
        },
      ],
      membershipFenceRevision: 0,
      revision: 1,
    });

    let signalMissingRoomRead!: () => void;
    const missingRoomRead = new Promise<void>((resolve) => {
      signalMissingRoomRead = resolve;
    });
    let releaseMissingRoomResolution!: () => void;
    const missingRoomRelease = new Promise<void>((resolve) => {
      releaseMissingRoomResolution = resolve;
    });
    const canonicalResolver = new ProgramMembershipResolver({ now: () => NOW });
    let resolverCalls = 0;
    const pausedResolver: Pick<ProgramMembershipResolver, "resolveProgram"> = {
      resolveProgram: async (programId, options) => {
        const resolution = await canonicalResolver.resolveProgram(
          programId,
          options,
        );
        resolverCalls += 1;
        if (resolverCalls === 1) {
          expect(resolution.state).toBe("room_unavailable");
          signalMissingRoomRead();
          await missingRoomRelease;
        }
        return resolution;
      },
    };
    const staleSync = new ProgramRoomMembershipSyncService({
      resolver: pausedResolver,
      now: () => NOW,
      runtimeReader: WRITABLE_RUNTIME_READER,
    });

    const staleAttempt = staleSync.reconcileProgram(program._id);
    await missingRoomRead;

    const disabled = await new ProgramCommunitySettingsService({
      now: () => NOW,
    }).update({
      programId: program._id.toString(),
      actor: { id: actorId.toString(), role: "Administrator" },
      idempotencyKey: randomUUID(),
      correlationId: "m6-disable-during-room-repair",
      enabled: false,
      opensAt: OPENS_AT,
      closesAt: CLOSES_AT,
      studentRoleMappings: [
        { studentRoleId: "participant", memberRole: "mentee" },
        {
          studentRoleId: "class-rep",
          memberRole: "class_representative",
        },
      ],
      expectedRevision: 1,
    });
    expect(disabled.settings).toMatchObject({ enabled: false, revision: 2 });

    releaseMissingRoomResolution();
    const retried = await staleAttempt;
    expect(retried).toMatchObject({
      resolutionState: "closed",
      roomProvisioned: false,
      desiredMemberships: 0,
      createdMemberships: 0,
    });
    expect(resolverCalls).toBeGreaterThanOrEqual(2);
    expect(await Conversation.countDocuments({ programId: program._id })).toBe(0);
    expect(await ConversationMember.countDocuments({ userId: mentorId })).toBe(0);
    await expect(
      ProgramCommunitySettings.findOne({ programId: program._id })
        .lean()
        .orFail(),
    ).resolves.toMatchObject({
      enabled: false,
      revision: 2,
      membershipFenceRevision: 0,
      membershipProjectionRevision: 2,
      membershipProjectionState: "cutoff",
    });
  });

  it("retries a stale no-Room cutoff after enable atomically provisions the first Room", async () => {
    const actorId = await insertUser("reverseactor");
    const mentorId = await insertUser("reversementor");
    const program = await createProgram({
      createdBy: actorId,
      mentors: [mentorId],
    });
    await ProgramCommunitySettings.create({
      programId: program._id,
      enabled: false,
      opensAt: OPENS_AT,
      closesAt: CLOSES_AT,
      archivedAt: null,
      studentRoleMappings: [
        { studentRoleId: "participant", memberRole: "mentee" },
        {
          studentRoleId: "class-rep",
          memberRole: "class_representative",
        },
      ],
      revision: 1,
    });

    let signalCutoffRead!: () => void;
    const cutoffRead = new Promise<void>((resolve) => {
      signalCutoffRead = resolve;
    });
    let releaseCutoff!: () => void;
    const cutoffRelease = new Promise<void>((resolve) => {
      releaseCutoff = resolve;
    });
    const canonicalResolver = new ProgramMembershipResolver({ now: () => NOW });
    let resolverCalls = 0;
    const pausedResolver: Pick<ProgramMembershipResolver, "resolveProgram"> = {
      resolveProgram: async (programId, options) => {
        const resolved = await canonicalResolver.resolveProgram(
          programId,
          options,
        );
        resolverCalls += 1;
        if (resolverCalls === 1) {
          expect(resolved).toMatchObject({
            lifecycleAction: "cutoff",
            lifecycleReason: "community_disabled",
          });
          signalCutoffRead();
          await cutoffRelease;
        }
        return resolved;
      },
    };
    const staleSync = new ProgramRoomMembershipSyncService({
      resolver: pausedResolver,
      now: () => NOW,
      runtimeReader: WRITABLE_RUNTIME_READER,
    });

    const staleAttempt = staleSync.reconcileProgram(program._id);
    await cutoffRead;
    await new ProgramCommunitySettingsService({ now: () => NOW }).update({
      programId: program._id.toString(),
      actor: { id: actorId.toString(), role: "Administrator" },
      idempotencyKey: randomUUID(),
      correlationId: "m6-enable-during-cutoff",
      enabled: true,
      opensAt: OPENS_AT,
      closesAt: CLOSES_AT,
      studentRoleMappings: [
        { studentRoleId: "participant", memberRole: "mentee" },
        {
          studentRoleId: "class-rep",
          memberRole: "class_representative",
        },
      ],
      expectedRevision: 1,
    });
    releaseCutoff();

    await expect(staleAttempt).resolves.toMatchObject({
      resolutionState: "open",
      roomProvisioned: false,
      createdMemberships: 1,
    });
    expect(resolverCalls).toBeGreaterThanOrEqual(2);
    const room = await Conversation.findOne({
      kind: "program",
      programId: program._id,
    })
      .lean()
      .orFail();
    await expect(
      ConversationMember.findOne({
        conversationId: room._id,
        userId: mentorId,
      })
        .lean()
        .orFail(),
    ).resolves.toMatchObject({
      role: "mentor",
      status: "active",
      accessWindows: [
        expect.objectContaining({ visibleFromSequence: 1 }),
      ],
    });
    await expect(
      ProgramCommunitySettings.findOne({ programId: program._id })
        .lean()
        .orFail(),
    ).resolves.toMatchObject({
      revision: 2,
      membershipProjectionRevision: 2,
      membershipProjectionState: "open",
    });
  });

  it("fences a stale projection when the newer canonical sync is a member no-op", async () => {
    const actorId = await insertUser("raceactor");
    const memberId = await insertUser("racemember");
    const program = await createProgram({
      createdBy: actorId,
      classReps: [memberId],
      mentees: [memberId],
    });
    await ProgramCommunitySettings.create({
      programId: program._id,
      enabled: true,
      opensAt: OPENS_AT,
      closesAt: CLOSES_AT,
      archivedAt: null,
      studentRoleMappings: [
        { studentRoleId: "participant", memberRole: "mentee" },
        {
          studentRoleId: "class-rep",
          memberRole: "class_representative",
        },
      ],
      revision: 1,
    });
    const room = await Conversation.create({
      kind: "program",
      status: "current",
      programId: program._id,
      helpRequestId: null,
      lastSequence: 0,
      lastMessageId: null,
      latestMessagePurgeAt: null,
      revision: 0,
    });
    await ConversationMember.create({
      conversationId: room._id,
      userId: memberId,
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
      lastReadSequence: 0,
      unreadCount: 0,
      unreadReconciledThroughSequence: 0,
      unreadReconciledAt: NOW,
      muted: false,
      mutedAt: null,
      purgeAt: null,
      revision: 0,
    });

    let signalStaleResolutionRead!: () => void;
    const staleResolutionRead = new Promise<void>((resolve) => {
      signalStaleResolutionRead = resolve;
    });
    let releaseStaleResolution!: () => void;
    const staleResolutionRelease = new Promise<void>((resolve) => {
      releaseStaleResolution = resolve;
    });
    const canonicalResolver = new ProgramMembershipResolver({ now: () => NOW });
    let staleResolverCalls = 0;
    const pausedResolver: Pick<ProgramMembershipResolver, "resolveProgram"> = {
      resolveProgram: async (programId, options) => {
        const resolution = await canonicalResolver.resolveProgram(
          programId,
          options,
        );
        staleResolverCalls += 1;
        if (staleResolverCalls === 1) {
          expect(resolution.memberships).toEqual([
            expect.objectContaining({
              userId: memberId.toString(),
              role: "class_representative",
            }),
          ]);
          signalStaleResolutionRead();
          await staleResolutionRelease;
        }
        return resolution;
      },
    };
    const staleSync = new ProgramRoomMembershipSyncService({
      resolver: pausedResolver,
      now: () => NOW,
      runtimeReader: WRITABLE_RUNTIME_READER,
    });
    const currentSync = new ProgramRoomMembershipSyncService({
      now: () => NOW,
      runtimeReader: WRITABLE_RUNTIME_READER,
    });

    const staleAttempt = staleSync.reconcileProgram(program._id);
    await staleResolutionRead;

    await Program.collection.updateOne(
      { _id: program._id },
      { $pull: { "adminEnrollments.classReps": memberId } },
    );
    const currentResult = await currentSync.reconcileProgram(program._id);
    expect(currentResult).toMatchObject({
      desiredMemberships: 1,
      createdMemberships: 0,
      updatedRoles: 0,
      unchangedMemberships: 1,
    });

    releaseStaleResolution();
    const retriedStaleResult = await staleAttempt;
    expect(retriedStaleResult).toMatchObject({
      desiredMemberships: 1,
      createdMemberships: 0,
      updatedRoles: 0,
      unchangedMemberships: 1,
    });
    expect(staleResolverCalls).toBeGreaterThanOrEqual(2);

    await expect(
      ConversationMember.findOne({ conversationId: room._id, userId: memberId })
        .lean()
        .orFail(),
    ).resolves.toMatchObject({ role: "mentee", revision: 0 });
    await expect(Conversation.findById(room._id).lean().orFail()).resolves.toMatchObject({
      lastSequence: 0,
      revision: 2,
    });
  });

  it("fences a stale open grant after a newer sync observes the Program community closed", async () => {
    const fixture = await createMembershipFixture();
    let signalStaleResolutionRead!: () => void;
    const staleResolutionRead = new Promise<void>((resolve) => {
      signalStaleResolutionRead = resolve;
    });
    let releaseStaleResolution!: () => void;
    const staleResolutionRelease = new Promise<void>((resolve) => {
      releaseStaleResolution = resolve;
    });
    const canonicalResolver = new ProgramMembershipResolver({ now: () => NOW });
    let staleResolverCalls = 0;
    const pausedResolver: Pick<ProgramMembershipResolver, "resolveProgram"> = {
      resolveProgram: async (programId, options) => {
        const resolution = await canonicalResolver.resolveProgram(
          programId,
          options,
        );
        staleResolverCalls += 1;
        if (staleResolverCalls === 1) {
          expect(resolution).toMatchObject({
            state: "open",
            conversationId: fixture.room._id.toString(),
          });
          expect(resolution.memberships).toHaveLength(4);
          signalStaleResolutionRead();
          await staleResolutionRelease;
        }
        return resolution;
      },
    };
    const staleSync = new ProgramRoomMembershipSyncService({
      resolver: pausedResolver,
      now: () => NOW,
      runtimeReader: WRITABLE_RUNTIME_READER,
    });
    const currentSync = new ProgramRoomMembershipSyncService({
      now: () => NOW,
      runtimeReader: WRITABLE_RUNTIME_READER,
    });

    const staleAttempt = staleSync.reconcileProgram(fixture.program._id);
    await staleResolutionRead;

    await ProgramCommunitySettings.collection.updateOne(
      { programId: fixture.program._id },
      { $set: { enabled: false }, $inc: { revision: 1 } },
    );
    const closedResult = await currentSync.reconcileProgram(fixture.program._id);
    expect(closedResult).toMatchObject({
      resolutionState: "closed",
      desiredMemberships: 0,
      createdMemberships: 0,
    });

    releaseStaleResolution();
    const retriedStaleResult = await staleAttempt;
    expect(retriedStaleResult).toMatchObject({
      resolutionState: "closed",
      desiredMemberships: 0,
      createdMemberships: 0,
    });
    expect(staleResolverCalls).toBeGreaterThanOrEqual(2);
    expect(await ConversationMember.countDocuments({
      conversationId: fixture.room._id,
    })).toBe(0);
    await expect(
      Conversation.findById(fixture.room._id).lean().orFail(),
    ).resolves.toMatchObject({ lastSequence: 7, revision: 2 });
  });

  it("keeps multi-source membership, cuts off the last source, and re-enters at N+1 without losing mute", async () => {
    const fixture = await createMembershipFixture();
    const service = new ProgramRoomMembershipSyncService({
      now: () => NOW,
      runtimeReader: WRITABLE_RUNTIME_READER,
    });
    await service.reconcileProgram(fixture.program._id);

    await Program.collection.updateOne(
      { _id: fixture.program._id },
      { $pull: { "adminEnrollments.classReps": fixture.classRepId } },
    );
    const roleRefresh = await service.reconcileProgram(fixture.program._id);
    const refreshed = await ConversationMember.findOne({
      conversationId: fixture.room._id,
      userId: fixture.classRepId,
    })
      .lean()
      .orFail();

    expect(roleRefresh).toMatchObject({
      createdMemberships: 0,
      updatedRoles: 1,
      unchangedMemberships: 3,
      deferredRevocations: 0,
    });
    expect(refreshed).toMatchObject({
      role: "mentee",
      status: "active",
      revision: 1,
      accessWindows: [
        {
          visibleFromSequence: 8,
          visibleThroughSequence: null,
          openedAt: NOW,
          closedAt: null,
        },
      ],
    });

    const chat = new ChatRoomService({
      now: () => NOW,
      runtime: WRITABLE_RUNTIME_READER,
    });
    await chat.setMuted({
      conversationId: fixture.room._id.toString(),
      actor: {
        id: fixture.purchasedClassRepId.toString(),
        role: "Participant",
      },
      muted: true,
    });
    await Program.collection.updateOne(
      { _id: fixture.program._id },
      {
        $addToSet: {
          "adminEnrollments.mentees": fixture.purchasedClassRepId,
        },
      },
    );
    await Purchase.deleteMany({
      programId: fixture.program._id,
      userId: fixture.purchasedClassRepId,
    });
    const remainingSource = await service.reconcileProgram(
      fixture.program._id,
    );
    expect(remainingSource).toMatchObject({
      desiredMemberships: 4,
      updatedRoles: 1,
      closedMemberships: 0,
    });
    await expect(
      ConversationMember.findOne({
        conversationId: fixture.room._id,
        userId: fixture.purchasedClassRepId,
      })
        .lean()
        .orFail(),
    ).resolves.toMatchObject({
      role: "mentee",
      status: "active",
      muted: true,
    });

    await Conversation.collection.updateOne(
      { _id: fixture.room._id },
      { $set: { lastSequence: 9 } },
    );
    await Program.collection.updateOne(
      { _id: fixture.program._id },
      {
        $pull: {
          "adminEnrollments.mentees": fixture.purchasedClassRepId,
        },
      },
    );
    const cutoff = await service.reconcileProgram(fixture.program._id);
    const historyOnly = await ConversationMember.findOne({
      conversationId: fixture.room._id,
      userId: fixture.purchasedClassRepId,
    })
      .lean()
      .orFail();

    expect(cutoff).toMatchObject({
      desiredMemberships: 3,
      closedMemberships: 1,
      reactivatedMemberships: 0,
      deferredRevocations: 0,
    });
    expect(historyOnly).toMatchObject({
      role: "mentee",
      status: "history_only",
      muted: true,
      lastReadSequence: 9,
      unreadCount: 0,
      unreadReconciledThroughSequence: 9,
      accessWindows: [
        {
          visibleFromSequence: 8,
          visibleThroughSequence: 9,
          openedAt: NOW,
          closedAt: NOW,
        },
      ],
    });

    await Conversation.collection.updateOne(
      { _id: fixture.room._id },
      { $set: { lastSequence: 12 } },
    );
    await insertProgramPurchase({
      programId: fixture.program._id,
      userId: fixture.purchasedClassRepId,
      studentRoleId: "participant",
    });
    const reentry = await service.reconcileProgram(fixture.program._id);
    const activeAgain = await ConversationMember.findOne({
      conversationId: fixture.room._id,
      userId: fixture.purchasedClassRepId,
    })
      .lean()
      .orFail();

    expect(reentry).toMatchObject({
      desiredMemberships: 4,
      createdMemberships: 0,
      updatedRoles: 0,
      closedMemberships: 0,
      reactivatedMemberships: 1,
      deferredReactivations: 0,
    });
    expect(activeAgain).toMatchObject({
      status: "active",
      role: "mentee",
      muted: true,
      lastReadSequence: 12,
      unreadCount: 0,
      unreadReconciledThroughSequence: 12,
      purgeAt: null,
      accessWindows: [
        {
          visibleFromSequence: 8,
          visibleThroughSequence: 9,
          closedAt: NOW,
        },
        {
          visibleFromSequence: 13,
          visibleThroughSequence: null,
          openedAt: NOW,
          closedAt: null,
        },
      ],
    });
  });

  it("cuts off an ineligible account and appends a fresh window only after both account gates recover", async () => {
    const fixture = await createMembershipFixture();
    const service = new ProgramRoomMembershipSyncService({
      now: () => NOW,
      runtimeReader: WRITABLE_RUNTIME_READER,
    });
    await service.reconcileProgram(fixture.program._id);
    await Conversation.collection.updateOne(
      { _id: fixture.room._id },
      { $set: { lastSequence: 8 } },
    );
    await User.collection.updateOne(
      { _id: fixture.menteeId },
      { $set: { isActive: false } },
    );

    await expect(
      service.reconcileProgram(fixture.program._id),
    ).resolves.toMatchObject({ closedMemberships: 1 });
    await expect(
      ConversationMember.findOne({
        conversationId: fixture.room._id,
        userId: fixture.menteeId,
      })
        .lean()
        .orFail(),
    ).resolves.toMatchObject({
      status: "history_only",
      accessWindows: [expect.objectContaining({ visibleThroughSequence: 8 })],
    });

    await User.collection.updateOne(
      { _id: fixture.menteeId },
      { $set: { isActive: true, isVerified: false } },
    );
    await expect(
      service.reconcileProgram(fixture.program._id),
    ).resolves.toMatchObject({ reactivatedMemberships: 0 });

    await Conversation.collection.updateOne(
      { _id: fixture.room._id },
      { $set: { lastSequence: 10 } },
    );
    await User.collection.updateOne(
      { _id: fixture.menteeId },
      { $set: { isVerified: true } },
    );
    await expect(
      service.reconcileProgram(fixture.program._id),
    ).resolves.toMatchObject({ reactivatedMemberships: 1 });
    await expect(
      ConversationMember.findOne({
        conversationId: fixture.room._id,
        userId: fixture.menteeId,
      })
        .lean()
        .orFail(),
    ).resolves.toMatchObject({
      status: "active",
      lastReadSequence: 10,
      unreadCount: 0,
      accessWindows: [
        expect.objectContaining({ visibleThroughSequence: 8 }),
        expect.objectContaining({
          visibleFromSequence: 11,
          visibleThroughSequence: null,
        }),
      ],
    });
  });

  it("repairs a lost disabled hint and a missing-settings cutoff through bounded durable lanes", async () => {
    const disabledFixture = await createMembershipFixture();
    const sync = new ProgramRoomMembershipSyncService({
      now: () => NOW,
      runtimeReader: WRITABLE_RUNTIME_READER,
    });
    await sync.reconcileProgram(disabledFixture.program._id);
    await ProgramCommunitySettings.collection.updateOne(
      { programId: disabledFixture.program._id },
      { $set: { enabled: false }, $inc: { revision: 1 } },
    );

    const disabledRepair = await createReconciliationService(NOW).runBounded(
      RECONCILIATION_RUN_CONTEXT,
    );
    expect(disabledRepair).toMatchObject({
      reconciledPrograms: 1,
      closedMemberships: 4,
      racedOrUnavailable: 0,
    });
    expect(
      await ConversationMember.countDocuments({
        conversationId: disabledFixture.room._id,
        status: "active",
      }),
    ).toBe(0);
    await expect(
      ProgramCommunitySettings.findOne({
        programId: disabledFixture.program._id,
      })
        .lean()
        .orFail(),
    ).resolves.toMatchObject({
      membershipProjectionRevision: 2,
      membershipProjectionState: "cutoff",
    });

    const missingFixture = await createMembershipFixture();
    await sync.reconcileProgram(missingFixture.program._id);
    await ProgramCommunitySettings.deleteOne({
      programId: missingFixture.program._id,
    });
    const missingRepair = await createReconciliationService(NOW).runBounded(
      RECONCILIATION_RUN_CONTEXT,
    );
    expect(missingRepair).toMatchObject({
      reconciledPrograms: 1,
      closedMemberships: 4,
      racedOrUnavailable: 0,
    });
    expect(
      await ConversationMember.countDocuments({
        conversationId: missingFixture.room._id,
        status: "active",
      }),
    ).toBe(0);
  });

  it("archives at the actual repair time for a retroactive close and idempotently repairs retention", async () => {
    const fixture = await createMembershipFixture();
    const initialSync = new ProgramRoomMembershipSyncService({
      now: () => NOW,
      runtimeReader: WRITABLE_RUNTIME_READER,
    });
    await initialSync.reconcileProgram(fixture.program._id);
    const archiveNow = new Date("2026-09-13T16:00:00.000Z");
    const retroactiveClose = new Date("2026-09-02T00:00:00.000Z");
    await ProgramCommunitySettings.collection.updateOne(
      { programId: fixture.program._id },
      { $set: { closesAt: retroactiveClose } },
    );
    const expectedPurgeAt = conversationPurgeAt(
      archiveNow,
      fixture.room.latestMessagePurgeAt,
    );
    const reconciliation = createReconciliationService(archiveNow);

    const archived = await reconciliation.runBounded(
      RECONCILIATION_RUN_CONTEXT,
    );

    expect(archived).toMatchObject({
      reconciledPrograms: 1,
      archivedRooms: 1,
      closedMemberships: 4,
    });
    await expect(
      Conversation.findById(fixture.room._id).lean().orFail(),
    ).resolves.toMatchObject({
      status: "archived",
      archivedAt: archiveNow,
      purgeAt: expectedPurgeAt,
    });
    const archivedMembers = await ConversationMember.find({
      conversationId: fixture.room._id,
    }).lean();
    expect(archivedMembers).toHaveLength(4);
    for (const member of archivedMembers) {
      expect(member).toMatchObject({
        status: "history_only",
        muted: false,
        purgeAt: expectedPurgeAt,
        accessWindows: [
          expect.objectContaining({
            visibleThroughSequence: 7,
            closedAt: archiveNow,
          }),
        ],
      });
    }
    await expect(
      ProgramCommunitySettings.findOne({ programId: fixture.program._id })
        .lean()
        .orFail(),
    ).resolves.toMatchObject({
      enabled: false,
      archivedAt: archiveNow,
      membershipProjectionState: "archived",
      membershipProjectionRevision: 2,
      revision: 2,
    });

    const archivedSync = new ProgramRoomMembershipSyncService({
      now: () => new Date("2026-09-14T16:00:00.000Z"),
      runtimeReader: WRITABLE_RUNTIME_READER,
    });
    const auditCount = await AuditLog.countDocuments({
      action: "program.room_archived",
      "details.programId": fixture.program._id.toString(),
    });
    await expect(
      archivedSync.reconcileProgram(fixture.program._id),
    ).resolves.toMatchObject({
      roomArchived: false,
      closedMemberships: 0,
    });
    expect(
      await AuditLog.countDocuments({
        action: "program.room_archived",
        "details.programId": fixture.program._id.toString(),
      }),
    ).toBe(auditCount);

    await Conversation.collection.updateOne(
      { _id: fixture.room._id },
      { $set: { purgeAt: new Date("2027-01-01T00:00:00.000Z") } },
    );
    await ConversationMember.collection.updateOne(
      { conversationId: fixture.room._id },
      { $set: { purgeAt: null } },
    );
    await archivedSync.reconcileProgram(fixture.program._id);
    await expect(
      Conversation.findById(fixture.room._id).lean().orFail(),
    ).resolves.toMatchObject({ purgeAt: expectedPurgeAt });
    expect(
      await ConversationMember.countDocuments({
        conversationId: fixture.room._id,
        purgeAt: expectedPurgeAt,
      }),
    ).toBe(4);
    expect(
      await AuditLog.countDocuments({
        action: "program.room_archived",
        "details.programId": fixture.program._id.toString(),
      }),
    ).toBe(auditCount + 1);
  });

  it("archives an already-cutoff Room after Program deletion and retains archived settings", async () => {
    const fixture = await createMembershipFixture();
    const sync = new ProgramRoomMembershipSyncService({
      now: () => NOW,
      runtimeReader: WRITABLE_RUNTIME_READER,
    });
    await sync.reconcileProgram(fixture.program._id);
    await ProgramCommunitySettings.collection.updateOne(
      { programId: fixture.program._id },
      { $set: { enabled: false }, $inc: { revision: 1 } },
    );
    await sync.reconcileProgram(fixture.program._id);
    await Program.deleteOne({ _id: fixture.program._id });
    const archiveNow = new Date("2026-09-13T20:00:00.000Z");

    const result = await createReconciliationService(archiveNow).runBounded(
      RECONCILIATION_RUN_CONTEXT,
    );

    expect(result).toMatchObject({
      reconciledPrograms: 1,
      archivedRooms: 1,
    });
    await expect(
      Conversation.findById(fixture.room._id).lean().orFail(),
    ).resolves.toMatchObject({
      status: "archived",
      archivedAt: archiveNow,
    });
    await expect(
      ProgramCommunitySettings.findOne({ programId: fixture.program._id })
        .lean()
        .orFail(),
    ).resolves.toMatchObject({
      enabled: false,
      archivedAt: archiveNow,
      membershipProjectionState: "archived",
      revision: 3,
      membershipProjectionRevision: 3,
    });
  });

  it("materializes 500 canonical members on rs0 in five batches of 100", async () => {
    const fixture = await createMembershipFixture();
    const additionalUserIds = Array.from(
      { length: 496 },
      () => new mongoose.Types.ObjectId(),
    );
    await User.collection.insertMany(
      additionalUserIds.map((_id, index) => {
        const username = `m6capacity${index}${_id.toString().slice(-5)}`;
        return {
          _id,
          username,
          usernameLower: username,
          email: `${username}@private.example.org`,
          phone: "+12065550199",
          birthYear: 1988,
          password: "Integration1",
          firstName: `Capacity${index}`,
          lastName: "Member",
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
      }),
    );
    await Program.collection.updateOne(
      { _id: fixture.program._id },
      {
        $push: {
          "adminEnrollments.mentees": { $each: additionalUserIds },
        },
      },
    );

    const batchSizes: number[] = [];
    const memberModel = new Proxy(ConversationMember, {
      get(target, property) {
        if (property === "bulkWrite") {
          return async (...args: Parameters<typeof ConversationMember.bulkWrite>) => {
            batchSizes.push(args[0].length);
            return ConversationMember.bulkWrite(...args);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const sync = new ProgramRoomMembershipSyncService({
      now: () => NOW,
      memberModel,
      runtimeReader: WRITABLE_RUNTIME_READER,
    });

    await expect(
      sync.reconcileProgram(fixture.program._id),
    ).resolves.toMatchObject({
      desiredMemberships: 500,
      createdMemberships: 500,
      updatedRoles: 0,
      closedMemberships: 0,
    });
    expect(batchSizes).toEqual([100, 100, 100, 100, 100]);
    expect(
      await ConversationMember.countDocuments({
        conversationId: fixture.room._id,
        status: "active",
      }),
    ).toBe(500);
    expect(
      await ConversationMember.distinct("userId", {
        conversationId: fixture.room._id,
      }),
    ).toHaveLength(500);
  });
});
