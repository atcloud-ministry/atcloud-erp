import { performance } from "node:perf_hooks";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Conversation from "../../../src/models/Conversation";
import ConversationMember from "../../../src/models/ConversationMember";
import Program from "../../../src/models/Program";
import ProgramCommunitySettings from "../../../src/models/ProgramCommunitySettings";
import Purchase from "../../../src/models/Purchase";
import User from "../../../src/models/User";
import { ChatRoomService } from "../../../src/services/chat/ChatRoomService";
import {
  MongoProgramMemberBatchReadDataSource,
  ProgramMemberBatchReadResolver,
  type ProgramMemberBatchReadDataSource,
} from "../../../src/services/programs/ProgramMemberBatchReadResolver";
import { ensureIntegrationDB } from "../setup/connect";

const APPROVED_PROFILE =
  process.env.M6_PROGRAM_ROOM_LOAD_PROFILE === "approved";
const PROFILE = Object.freeze(
  APPROVED_PROFILE
    ? { name: "approved", programs: 50, members: 500, samples: 20 }
    : { name: "smoke", programs: 5, members: 50, samples: 5 },
);
const NOW = new Date("2032-09-12T12:00:00.000Z");
const DELIVERY_P95_MAX_MS = 1_500;
const DELIVERY_P99_MAX_MS = 3_000;
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

describe(`M6 Program Socket delivery capacity (${PROFILE.name} profile)`, () => {
  const userIds = Array.from(
    { length: PROFILE.members },
    () => new mongoose.Types.ObjectId(),
  );
  const programIds = Array.from(
    { length: PROFILE.programs },
    () => new mongoose.Types.ObjectId(),
  );
  const roomIds = Array.from(
    { length: PROFILE.programs },
    () => new mongoose.Types.ObjectId(),
  );
  // The approved baseline has one 500-member target Room and 50 open Rooms in
  // the system. It does not require every one of those 500 people to belong to
  // every open Room; keep the overlap real and bounded here. The 50 x 500
  // algorithmic upper bound is covered separately by the unit stress test.
  const membersByProgram = programIds.map((_programId, programIndex) =>
    programIndex === 0
      ? userIds
      : Array.from(
          { length: Math.min(10, userIds.length) },
          (_unused, offset) =>
            userIds[(programIndex * 10 + offset) % userIds.length]!,
        ),
  );
  const batchReads = {
    users: 0,
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
        const username = `m6-socket-capacity-${index}`;
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
        title: `M6 Socket Capacity Program ${index}`,
        programType: "EMBA Mentor Circles",
        isFree: true,
        fullPriceTicket: 0,
        createdBy: userIds[0],
        mentors: [],
        adminEnrollments: {
          classReps: [],
          mentees: membersByProgram[index],
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
      programIds.map((programId) => ({
        _id: new mongoose.Types.ObjectId(),
        programId,
        enabled: true,
        opensAt: new Date("2032-01-01T00:00:00.000Z"),
        closesAt: new Date("2033-01-01T00:00:00.000Z"),
        archivedAt: null,
        studentRoleMappings: [
          { studentRoleId: "participant", memberRole: "mentee" },
        ],
        membershipFenceRevision: 1,
        membershipProjectionRevision: 1,
        membershipProjectionState: "open",
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
        lastSequence: 1,
        lastMessageId: new mongoose.Types.ObjectId(),
        latestMessagePurgeAt: new Date("2033-09-12T12:00:00.000Z"),
        archivedAt: null,
        purgeAt: null,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      })),
    );
    await ConversationMember.collection.insertMany(
      roomIds.flatMap((conversationId, programIndex) =>
        membersByProgram[programIndex]!.map((userId) => ({
          _id: new mongoose.Types.ObjectId(),
          conversationId,
          userId,
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
          unreadCount: 1,
          unreadReconciledThroughSequence: 1,
          unreadReconciledAt: NOW,
          muted: false,
          mutedAt: null,
          purgeAt: null,
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        })),
      ),
    );

    const mongoDataSource = new MongoProgramMemberBatchReadDataSource();
    const countingDataSource: ProgramMemberBatchReadDataSource = {
      loadEligibleUsers: (...args) => {
        batchReads.users += 1;
        return mongoDataSource.loadEligibleUsers(...args);
      },
      loadSettings: (...args) => {
        batchReads.settings += 1;
        return mongoDataSource.loadSettings(...args);
      },
      loadPrograms: (...args) => {
        batchReads.programs += 1;
        return mongoDataSource.loadPrograms(...args);
      },
      loadPrimaryConversations: (...args) => {
        batchReads.conversations += 1;
        return mongoDataSource.loadPrimaryConversations(...args);
      },
      loadEffectivePurchases: (...args) => {
        batchReads.purchases += 1;
        return mongoDataSource.loadEffectivePurchases(...args);
      },
    };
    service = new ChatRoomService({
      now: () => new Date(NOW),
      programMemberBatchReadResolver: new ProgramMemberBatchReadResolver({
        dataSource: countingDataSource,
        now: () => new Date(NOW),
      }),
    });
  }, APPROVED_PROFILE ? 3 * 60_000 : 60_000);

  afterAll(async () => {
    await Promise.all(models.map((model) => model.deleteMany({})));
  }, APPROVED_PROFILE ? 2 * 60_000 : 30_000);

  it("filters the approved 20-message burst with fixed canonical reads", async () => {
    expect(mongoose.connection.getClient().options.maxPoolSize).toBe(10);
    const recipientIds = userIds.map((userId) => userId.toString());
    await service.getMemberDeliveryStates(
      roomIds[0]!.toString(),
      recipientIds,
      1,
    );
    Object.keys(batchReads).forEach((key) => {
      batchReads[key as keyof typeof batchReads] = 0;
    });

    const latencies: number[] = [];
    let failures = 0;
    const started = performance.now();
    const deliveries = Array.from({ length: PROFILE.samples }, async () => {
      const deliveryStarted = performance.now();
      try {
        const states = await service.getMemberDeliveryStates(
          roomIds[0]!.toString(),
          recipientIds,
          1,
        );
        latencies.push(performance.now() - deliveryStarted);
        expect(states).toHaveLength(PROFILE.members);
        expect(states[0]).toMatchObject({ roomUnreadCount: 1 });
        for (const state of states) {
          const userId = new mongoose.Types.ObjectId(state.userId);
          const expectedUnread = membersByProgram.filter((members) =>
            members.some((memberId) => memberId.equals(userId)),
          ).length;
          expect(state.chatUnreadTotal).toBe(expectedUnread);
        }
      } catch (error) {
        failures += 1;
        throw error;
      }
    });
    await Promise.all(deliveries);
    const drainMs = performance.now() - started;
    const p95 = percentile(latencies, 0.95);
    const p99 = percentile(latencies, 0.99);
    console.info(
      `M6_PROGRAM_SOCKET profile=${PROFILE.name} programs=${PROFILE.programs} members=${PROFILE.members} burst=${PROFILE.samples} failures=${failures} drain_ms=${drainMs.toFixed(1)} p95_ms=${p95.toFixed(1)} p99_ms=${p99.toFixed(1)} batch_reads_per_message=5 max_pool_size=10 final_backlog=0`,
    );

    expect(failures).toBe(0);
    expect(batchReads).toEqual({
      users: PROFILE.samples,
      settings: PROFILE.samples,
      programs: PROFILE.samples,
      conversations: PROFILE.samples,
      purchases: PROFILE.samples,
    });
    expect(p95).toBeLessThanOrEqual(DELIVERY_P95_MAX_MS);
    expect(p99).toBeLessThanOrEqual(DELIVERY_P99_MAX_MS);
  }, APPROVED_PROFILE ? 3 * 60_000 : 60_000);
});
