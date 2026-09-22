import { performance } from "node:perf_hooks";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntimeConfigDTO } from "../../../src/contracts/runtimeConfig";
import Conversation from "../../../src/models/Conversation";
import ConversationMember from "../../../src/models/ConversationMember";
import Program from "../../../src/models/Program";
import ProgramCommunitySettings from "../../../src/models/ProgramCommunitySettings";
import Purchase from "../../../src/models/Purchase";
import User from "../../../src/models/User";
import { ChatRoomService } from "../../../src/services/chat/ChatRoomService";
import {
  MongoProgramActorRoomReadDataSource,
  ProgramActorRoomReadResolver,
  type ProgramActorRoomReadDataSource,
} from "../../../src/services/programs/ProgramActorRoomReadResolver";
import { ensureIntegrationDB } from "../setup/connect";

const APPROVED_PROFILE =
  process.env.M6_PROGRAM_ROOM_LOAD_PROFILE === "approved";
const PROFILE = Object.freeze(
  APPROVED_PROFILE
    ? {
        name: "approved",
        users: 2_000,
        programs: 500,
        openPrograms: 50,
        samples: 20,
      }
    : {
        name: "smoke",
        users: 100,
        programs: 20,
        openPrograms: 5,
        samples: 5,
      },
);
const NOW = new Date("2032-09-12T12:00:00.000Z");
const LIST_P95_MAX_MS = 1_000;
const models = [
  ConversationMember,
  Conversation,
  ProgramCommunitySettings,
  Purchase,
  Program,
  User,
] as const;

function percentile(samples: readonly number[], value: number): number {
  const sorted = [...samples].sort((first, second) => first - second);
  return sorted[Math.max(0, Math.ceil(value * sorted.length) - 1)]!;
}

describe(`M6 Program Room list capacity (${PROFILE.name} profile)`, () => {
  const actorId = new mongoose.Types.ObjectId();
  const userIds = Array.from(
    { length: PROFILE.users },
    (_unused, index) => (index === 0 ? actorId : new mongoose.Types.ObjectId()),
  );
  const programIds = Array.from(
    { length: PROFILE.programs },
    () => new mongoose.Types.ObjectId(),
  );
  const roomIds = Array.from(
    { length: PROFILE.openPrograms },
    () => new mongoose.Types.ObjectId(),
  );
  const batchReads = {
    actor: 0,
    settings: 0,
    programs: 0,
    conversations: 0,
    purchases: 0,
  };
  let service: ChatRoomService;

  beforeAll(async () => {
    await ensureIntegrationDB();
    await Promise.all(models.map((model) => model.init()));
    await Promise.all(models.map((model) => model.deleteMany({})));

    await User.collection.insertMany(
      userIds.map((_id, index) => {
        const username = `m6-room-list-${index}`;
        return {
          _id,
          username,
          usernameLower: username,
          email: `${username}@private.example.org`,
          phone: "+12065550199",
          birthYear: 1988,
          password: "load-test-only",
          firstName: `Member${index}`,
          lastName: "Load",
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
    await Program.collection.insertMany(
      programIds.map((_id, index) => ({
        _id,
        title: `M6 Capacity Program ${index}`,
        programType: "EMBA Mentor Circles",
        isFree: true,
        fullPriceTicket: 0,
        createdBy: actorId,
        mentors: [],
        adminEnrollments: {
          classReps: [],
          mentees: index < PROFILE.openPrograms ? [actorId] : [],
        },
        programRoles: {
          teacherRoleName: "Mentor",
          studentRoles: [{ id: "participant", name: "Participant" }],
        },
        createdAt: NOW,
        updatedAt: NOW,
      })),
    );
    await ProgramCommunitySettings.collection.insertMany(
      programIds.map((programId, index) => ({
        _id: new mongoose.Types.ObjectId(),
        programId,
        enabled: index < PROFILE.openPrograms,
        opensAt: new Date("2032-01-01T00:00:00.000Z"),
        closesAt: new Date("2033-01-01T00:00:00.000Z"),
        archivedAt: null,
        studentRoleMappings: [
          { studentRoleId: "participant", memberRole: "mentee" },
        ],
        membershipFenceRevision: 1,
        membershipProjectionRevision: 1,
        membershipProjectionState:
          index < PROFILE.openPrograms ? "open" : "cutoff",
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      })),
    );
    await Conversation.collection.insertMany(
      roomIds.map((_id, index) => ({
        _id,
        kind: "program",
        status: "current",
        programId: programIds[index],
        helpRequestId: null,
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
    await ConversationMember.collection.insertMany(
      roomIds.map((conversationId) => ({
        _id: new mongoose.Types.ObjectId(),
        conversationId,
        userId: actorId,
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
        createdAt: NOW,
        updatedAt: NOW,
      })),
    );

    const mongoDataSource = new MongoProgramActorRoomReadDataSource();
    const countingDataSource: ProgramActorRoomReadDataSource = {
      loadEligibleActor: (...args) => {
        batchReads.actor += 1;
        return mongoDataSource.loadEligibleActor(...args);
      },
      loadSettings: (...args) => {
        batchReads.settings += 1;
        return mongoDataSource.loadSettings(...args);
      },
      loadProgramsForActor: (...args) => {
        batchReads.programs += 1;
        return mongoDataSource.loadProgramsForActor(...args);
      },
      loadPrimaryConversations: (...args) => {
        batchReads.conversations += 1;
        return mongoDataSource.loadPrimaryConversations(...args);
      },
      loadEffectivePurchasesForActor: (...args) => {
        batchReads.purchases += 1;
        return mongoDataSource.loadEffectivePurchasesForActor(...args);
      },
    };
    service = new ChatRoomService({
      now: () => new Date(NOW),
      runtime: {
        getOperationalRuntimeConfig: async () =>
          createRuntimeConfigDTO("on", 1),
      },
      programActorRoomReadResolver: new ProgramActorRoomReadResolver({
        dataSource: countingDataSource,
        now: () => new Date(NOW),
      }),
    });
  }, 120_000);

  afterAll(async () => {
    await Promise.all(models.map((model) => model.deleteMany({})));
  }, 60_000);

  it("keeps a 50-Program actor list within the approved p95 using fixed batch reads", async () => {
    for (let warmup = 0; warmup < 3; warmup += 1) {
      await service.list(actorId.toString(), {
        view: "current",
        page: 1,
        limit: 30,
      });
    }
    Object.keys(batchReads).forEach((key) => {
      batchReads[key as keyof typeof batchReads] = 0;
    });

    const latencies: number[] = [];
    for (let sample = 0; sample < PROFILE.samples; sample += 1) {
      const started = performance.now();
      const result = await service.list(actorId.toString(), {
        view: "current",
        page: 1,
        limit: 30,
      });
      latencies.push(performance.now() - started);
      expect(result.conversations).toHaveLength(
        Math.min(30, PROFILE.openPrograms),
      );
      expect(result.pagination.totalCount).toBe(PROFILE.openPrograms);
    }
    const p95 = percentile(latencies, 0.95);
    console.info(
      `M6_PROGRAM_LIST profile=${PROFILE.name} programs=${PROFILE.programs} open_programs=${PROFILE.openPrograms} samples=${PROFILE.samples} p95_ms=${p95.toFixed(1)} actor_batch_reads_per_list=5`,
    );

    expect(batchReads).toEqual({
      actor: PROFILE.samples,
      settings: PROFILE.samples,
      programs: PROFILE.samples,
      conversations: PROFILE.samples,
      purchases: PROFILE.samples,
    });
    expect(p95).toBeLessThanOrEqual(LIST_P95_MAX_MS);
  }, 60_000);
});
