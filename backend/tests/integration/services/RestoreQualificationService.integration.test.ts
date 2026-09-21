import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import AlumniAffiliation from "../../../src/models/AlumniAffiliation";
import AlumniHelpOutcomeSubmission from "../../../src/models/AlumniHelpOutcomeSubmission";
import AlumniHelpRequest from "../../../src/models/AlumniHelpRequest";
import AlumniImportBatch from "../../../src/models/AlumniImportBatch";
import AlumniInvitation from "../../../src/models/AlumniInvitation";
import AlumniProfile from "../../../src/models/AlumniProfile";
import AuditLog from "../../../src/models/AuditLog";
import ChatMessage from "../../../src/models/ChatMessage";
import ConsentRecord from "../../../src/models/ConsentRecord";
import Conversation from "../../../src/models/Conversation";
import ConversationMember from "../../../src/models/ConversationMember";
import IdempotencyRecord from "../../../src/models/IdempotencyRecord";
import NotificationOutbox from "../../../src/models/NotificationOutbox";
import Program from "../../../src/models/Program";
import ProgramCommunitySettings from "../../../src/models/ProgramCommunitySettings";
import Purchase from "../../../src/models/Purchase";
import SchemaMigration from "../../../src/models/SchemaMigration";
import User from "../../../src/models/User";
import {
  RestoreQualificationService,
  type RestoreQualificationReport,
} from "../../../src/services/operations/RestoreQualificationService";
import type { MigrationStatusResult } from "../../../src/services/migrations/MigrationRunner";
import { MongoTransactionService } from "../../../src/services/reliability/MongoTransactionService";
import { ensureIntegrationDB } from "../setup/connect";

const NOW = new Date("2030-09-19T12:00:00.000Z");
const FUTURE = new Date("2031-09-19T12:00:00.000Z");

const trackedModels = [
  User,
  Program,
  Purchase,
  AlumniProfile,
  AlumniAffiliation,
  AlumniInvitation,
  AlumniImportBatch,
  ConsentRecord,
  AlumniHelpRequest,
  AlumniHelpOutcomeSubmission,
  Conversation,
  ConversationMember,
  ChatMessage,
  ProgramCommunitySettings,
  NotificationOutbox,
  IdempotencyRecord,
  AuditLog,
  SchemaMigration,
] as const;

const healthyMigration: MigrationStatusResult = Object.freeze({
  healthy: true,
  recoveryRequired: false,
  appliedCount: 10,
  pendingCount: 0,
  entries: [],
  issues: [],
});

function createService(): RestoreQualificationService {
  return new RestoreQualificationService(mongoose.connection, {
    now: () => new Date(NOW),
    migrationStatus: async () => healthyMigration,
  });
}

function changedManifest(
  report: RestoreQualificationReport,
): RestoreQualificationReport {
  return {
    ...report,
    collections: {
      ...report.collections,
      chat_messages: {
        ...report.collections.chat_messages,
        count: report.collections.chat_messages.count + 1,
      },
    },
  };
}

describe("RestoreQualificationService restored-database qualification", () => {
  beforeAll(async () => {
    expect(process.env.MONGODB_TEST_URI).toBeTruthy();
    await ensureIntegrationDB();
    await Promise.all(trackedModels.map((model) => model.syncIndexes()));
    const topology = await new MongoTransactionService(
      mongoose.connection,
    ).assertTopologyCapability(true);
    expect(topology.supported).toBe(true);
  });

  beforeEach(async () => {
    await Promise.all(trackedModels.map((model) => model.deleteMany({})));
  });

  afterAll(async () => {
    await Promise.all(trackedModels.map((model) => model.deleteMany({})));
  });

  it("emits a read-only PII-free report with exact indexes and an exact manifest", async () => {
    const privateEmail = "restored-person@example.invalid";
    const privateMessage = "Call the applicant at 555-0100";
    const userId = new mongoose.Types.ObjectId();
    const programId = new mongoose.Types.ObjectId();
    const conversationId = new mongoose.Types.ObjectId();
    const messageId = new mongoose.Types.ObjectId();
    await User.collection.insertOne({
      _id: userId,
      email: privateEmail,
      username: "restored-private-user",
      legalName: "Private Person",
      isActive: true,
      isVerified: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await Program.collection.insertOne({ _id: programId });
    await Conversation.collection.insertOne({
      _id: conversationId,
      kind: "program",
      status: "current",
      programId,
      lastSequence: 1,
      lastMessageId: messageId,
      latestMessagePurgeAt: FUTURE,
      archivedAt: null,
      purgeAt: null,
      revision: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ChatMessage.collection.insertOne({
      _id: messageId,
      conversationId,
      sequence: 1,
      senderId: userId,
      senderSnapshot: { displayName: "Private Person", avatar: null },
      clientMessageId: "11111111-1111-4111-8111-111111111111",
      kind: "text",
      content: privateMessage,
      safeLink: null,
      createdAt: NOW,
      purgeAt: FUTURE,
    });
    await ConversationMember.collection.insertOne({
      _id: new mongoose.Types.ObjectId(),
      conversationId,
      userId,
      role: "mentee",
      status: "active",
      accessWindows: [
        {
          visibleFromSequence: 1,
          visibleThroughSequence: null,
          openedAt: NOW,
          closedAt: null,
        },
      ],
      lastReadSequence: 1,
      unreadCount: 0,
      unreadReconciledThroughSequence: 1,
      muted: false,
      mutedAt: null,
    });
    const before = await User.collection.findOne({ _id: userId });
    const countsBefore = await Promise.all(
      trackedModels.map((model) => model.countDocuments({})),
    );
    const indexNamesBefore = await Promise.all(
      trackedModels.map(async (model) =>
        (await mongoose.connection.db!
          .collection(model.collection.name)
          .listIndexes()
          .toArray())
          .map((index) => index.name)
          .sort(),
      ),
    );

    const service = createService();
    const report = await service.inspect();

    expect(report.issues).toEqual([]);
    expect(report.status).toBe("passed");
    expect(report.indexes).toMatchObject({ missing: 0, mismatched: 0 });
    expect(report.indexes.expected).toBeGreaterThan(0);
    expect(report.collections).toMatchObject({
      users: { count: 1 },
      chat_messages: { count: 1 },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(privateEmail);
    expect(serialized).not.toContain(privateMessage);
    expect(serialized).not.toContain("Private Person");
    expect(await User.collection.findOne({ _id: userId })).toEqual(before);
    await expect(
      Promise.all(trackedModels.map((model) => model.countDocuments({}))),
    ).resolves.toEqual(countsBefore);
    await expect(
      Promise.all(
        trackedModels.map(async (model) =>
          (await mongoose.connection.db!
            .collection(model.collection.name)
            .listIndexes()
            .toArray())
            .map((index) => index.name)
            .sort(),
        ),
      ),
    ).resolves.toEqual(indexNamesBefore);

    await expect(service.verify(report)).resolves.toMatchObject({
      status: "passed",
      comparison: { manifestProvided: true, mismatchedCollections: 0 },
    });
    await expect(service.verify(changedManifest(report))).resolves.toMatchObject({
      status: "failed",
      comparison: { manifestProvided: true, mismatchedCollections: 1 },
      issues: expect.arrayContaining([
        { code: "RESTORE_MANIFEST_MISMATCH", count: 1 },
      ]),
    });
  });

  it("rejects missing and altered native text-index metadata", async () => {
    const collection = mongoose.connection.db!.collection(
      AlumniProfile.collection.name,
    );
    const indexName = "text_alumni_profile_search";

    await collection.dropIndex(indexName);
    try {
      await expect(createService().inspect()).resolves.toMatchObject({
        status: "failed",
        indexes: { missing: 1, mismatched: 0 },
        issues: expect.arrayContaining([
          { code: "RESTORE_INDEX_MISSING", count: 1 },
        ]),
      });

      await collection.createIndex(
        { "searchProjection.searchText": "text" },
        {
          name: indexName,
          weights: { "searchProjection.searchText": 2 },
        },
      );
      await expect(createService().inspect()).resolves.toMatchObject({
        status: "failed",
        indexes: { missing: 0, mismatched: 1 },
        issues: expect.arrayContaining([
          { code: "RESTORE_INDEX_MISMATCH", count: 1 },
        ]),
      });
    } finally {
      await collection.dropIndex(indexName).catch(() => undefined);
      await AlumniProfile.syncIndexes();
    }
  });

  it("fails closed for representative chat, help, and membership structural damage", async () => {
    const conversationId = new mongoose.Types.ObjectId();
    const requesterId = new mongoose.Types.ObjectId();
    const helpRequestId = new mongoose.Types.ObjectId();
    const latestOutcomeId = new mongoose.Types.ObjectId();
    const existingProgramId = new mongoose.Types.ObjectId();

    await Conversation.collection.insertOne({
      _id: conversationId,
      kind: "direct",
      status: "active",
      lastSequence: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ChatMessage.collection.insertMany([
      {
        _id: new mongoose.Types.ObjectId(),
        conversationId,
        sequence: 2,
        senderId: requesterId,
        clientMessageId: "beyond-sequence",
        kind: "text",
        createdAt: NOW,
        purgeAt: new Date("2031-09-20T12:00:00.000Z"),
      },
      {
        _id: new mongoose.Types.ObjectId(),
        conversationId: new mongoose.Types.ObjectId(),
        sequence: 1,
        senderId: requesterId,
        clientMessageId: "orphan-message",
        kind: "text",
        createdAt: NOW,
        purgeAt: FUTURE,
      },
    ]);
    await ConversationMember.collection.insertOne({
      _id: new mongoose.Types.ObjectId(),
      conversationId,
      userId: requesterId,
      status: "active",
      accessWindows: [],
      joinedAt: NOW,
    });

    await AlumniHelpRequest.collection.insertOne({
      _id: helpRequestId,
      latestOutcomeSubmissionId: latestOutcomeId,
      latestOutcomeRevisionNumber: 2,
      latestOutcomeStatus: "pending",
      latestOutcomeDueAt: FUTURE,
      hasBeenAccepted: true,
    });
    await AlumniHelpOutcomeSubmission.collection.insertMany([
      {
        _id: latestOutcomeId,
        helpRequestId,
        revisionNumber: 1,
        status: "pending",
        dueAt: FUTURE,
      },
      {
        _id: new mongoose.Types.ObjectId(),
        helpRequestId: new mongoose.Types.ObjectId(),
        revisionNumber: 1,
        status: "pending",
        dueAt: FUTURE,
      },
    ]);

    await Program.collection.insertOne({ _id: existingProgramId });
    await ProgramCommunitySettings.collection.insertMany([
      {
        _id: new mongoose.Types.ObjectId(),
        programId: new mongoose.Types.ObjectId(),
        enabled: false,
        archivedAt: null,
        membershipProjectionState: "complete",
        membershipProjectionRevision: 1,
        revision: 1,
      },
      {
        _id: new mongoose.Types.ObjectId(),
        programId: existingProgramId,
        enabled: true,
        archivedAt: null,
        membershipProjectionState: "pending",
        membershipProjectionRevision: 0,
        revision: 1,
      },
    ]);

    const report = await createService().inspect();

    expect(report.status).toBe("failed");
    expect(report.integrity.chat).toMatchObject({
      orphanMessages: 1,
      messagesBeyondConversationSequence: 1,
      orphanMembers: 0,
      invalidAccessWindows: 1,
      invalidConversationMetadata: 1,
      invalidMessageRetention: 1,
      invalidMemberState: 1,
      messagesOutsideMemberAccess: 1,
      invalidMessagePayload: 1,
    });
    expect(report.integrity.help).toMatchObject({
      orphanOutcomes: 1,
      inconsistentLatestOutcomes: 1,
      invalidOutcomeAncestry: 1,
      invalidLifecycleTimelines: 1,
      invalidRoomLinkage: 1,
    });
    expect(report.integrity.membership).toMatchObject({
      settingsMissingProgram: 1,
      enabledSettingsMissingRoom: 1,
      reconciliationRequired: 1,
    });
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "RESTORE_CHAT_INTEGRITY_INVALID" }),
        expect.objectContaining({ code: "RESTORE_HELP_INTEGRITY_INVALID" }),
        expect.objectContaining({ code: "RESTORE_MEMBERSHIP_INTEGRITY_INVALID" }),
      ]),
    );
  });
});
