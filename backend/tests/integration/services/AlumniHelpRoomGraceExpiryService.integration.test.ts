import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import AuditLog from "../../../src/models/AuditLog";
import Conversation from "../../../src/models/Conversation";
import ConversationMember from "../../../src/models/ConversationMember";
import {
  AlumniHelpRoomGraceExpiryService,
} from "../../../src/services/alumni/AlumniHelpRoomGraceExpiryService";
import {
  WORKER_RUN_TRIGGERS,
  WORKER_SERVICE_KEYS,
  workerAuthorizationService,
} from "../../../src/services/authorization/WorkerAuthorizationService";
import { MongoTransactionService } from "../../../src/services/reliability/MongoTransactionService";
import { ensureIntegrationDB } from "../setup/connect";

const collections = [AuditLog, ConversationMember, Conversation] as const;
const NOW = new Date("2032-09-12T12:00:00.000Z");
const GRACE_DEADLINE = new Date("2032-09-12T11:59:00.000Z");
const ROOM_CREATED_AT = new Date("2032-09-05T12:00:00.000Z");

let transactions: MongoTransactionService;

async function insertExpiredRoom() {
  const conversationId = new mongoose.Types.ObjectId();
  const helpRequestId = new mongoose.Types.ObjectId();
  const requesterId = new mongoose.Types.ObjectId();
  const providerId = new mongoose.Types.ObjectId();

  await Conversation.collection.insertOne({
    _id: conversationId,
    kind: "alumni_help",
    status: "current",
    helpRequestId,
    programId: null,
    lastSequence: 0,
    lastMessageId: null,
    latestMessagePurgeAt: null,
    writeAccessEndsAt: GRACE_DEADLINE,
    archivedAt: null,
    purgeAt: null,
    revision: 0,
    createdAt: ROOM_CREATED_AT,
    updatedAt: ROOM_CREATED_AT,
  });
  await ConversationMember.collection.insertMany([
    {
      _id: new mongoose.Types.ObjectId(),
      conversationId,
      userId: requesterId,
      role: "requester",
      status: "active",
      joinedAt: ROOM_CREATED_AT,
      accessWindows: [
        {
          visibleFromSequence: 1,
          visibleThroughSequence: null,
          openedAt: ROOM_CREATED_AT,
          closedAt: null,
        },
      ],
      lastReadSequence: 0,
      unreadCount: 0,
      unreadReconciledThroughSequence: 0,
      unreadReconciledAt: ROOM_CREATED_AT,
      muted: false,
      mutedAt: null,
      purgeAt: null,
      revision: 0,
      createdAt: ROOM_CREATED_AT,
      updatedAt: ROOM_CREATED_AT,
    },
    {
      _id: new mongoose.Types.ObjectId(),
      conversationId,
      userId: providerId,
      role: "provider",
      status: "active",
      joinedAt: ROOM_CREATED_AT,
      accessWindows: [
        {
          visibleFromSequence: 1,
          visibleThroughSequence: null,
          openedAt: ROOM_CREATED_AT,
          closedAt: null,
        },
      ],
      lastReadSequence: 0,
      unreadCount: 0,
      unreadReconciledThroughSequence: 0,
      unreadReconciledAt: ROOM_CREATED_AT,
      muted: false,
      mutedAt: null,
      purgeAt: null,
      revision: 0,
      createdAt: ROOM_CREATED_AT,
      updatedAt: ROOM_CREATED_AT,
    },
  ]);
  return { conversationId, helpRequestId };
}

describe("AlumniHelpRoomGraceExpiryService integration", () => {
  beforeAll(async () => {
    await ensureIntegrationDB();
    await Promise.all(collections.map((model) => model.init()));
    transactions = new MongoTransactionService(mongoose.connection);
    await expect(transactions.assertTopologyCapability(true)).resolves.toMatchObject({
      supported: true,
    });
  });

  beforeEach(async () => {
    await Promise.all(collections.map((model) => model.deleteMany({})));
  });

  afterAll(async () => {
    await Promise.all(collections.map((model) => model.deleteMany({})));
  });

  it("archives only after grace expires, preserving the deadline as the archive clock", async () => {
    const { conversationId, helpRequestId } = await insertExpiredRoom();
    const service = new AlumniHelpRoomGraceExpiryService({
      now: () => new Date(NOW),
      transactions,
    });

    await expect(
      service.runBounded(
        workerAuthorizationService.createRunContext(
          WORKER_SERVICE_KEYS.ALUMNI_HELP_ROOM_GRACE,
          WORKER_RUN_TRIGGERS.SCHEDULED,
        ),
      ),
    ).resolves.toMatchObject({
      candidatesScanned: 1,
      archived: 1,
      racedOrUnavailable: 0,
      remainingOverdue: 0,
    });

    await expect(Conversation.findById(conversationId).lean().orFail()).resolves.toMatchObject({
      status: "archived",
      archivedAt: GRACE_DEADLINE,
      writeAccessEndsAt: GRACE_DEADLINE,
      revision: 1,
    });
    await expect(
      ConversationMember.find({ conversationId }).sort({ _id: 1 }).lean(),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "history_only",
          unreadCount: 0,
          revision: 1,
          accessWindows: [
            expect.objectContaining({
              visibleThroughSequence: 0,
              closedAt: GRACE_DEADLINE,
            }),
          ],
        }),
      ]),
    );
    await expect(
      AuditLog.findOne({
        action: "alumni_help.room_grace_expired",
        targetId: conversationId.toString(),
      })
        .lean()
        .orFail(),
    ).resolves.toMatchObject({
      actorType: "worker",
      actorKey: WORKER_SERVICE_KEYS.ALUMNI_HELP_ROOM_GRACE,
      reasonCode: "grace_period_elapsed",
      details: expect.objectContaining({
        helpRequestId: helpRequestId.toString(),
        writeAccessEndedAt: GRACE_DEADLINE.toISOString(),
      }),
    });
  });
});
