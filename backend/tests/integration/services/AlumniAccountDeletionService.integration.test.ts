import crypto from "crypto";
import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addFixedDays,
  addUtcCalendarMonths,
  deriveAlumniAffiliationKey,
} from "../../../src/contracts/alumniDirectoryData";
import AlumniAffiliation from "../../../src/models/AlumniAffiliation";
import AlumniHelpRequest from "../../../src/models/AlumniHelpRequest";
import AlumniProfile from "../../../src/models/AlumniProfile";
import AuditLog from "../../../src/models/AuditLog";
import Conversation from "../../../src/models/Conversation";
import ConversationMember from "../../../src/models/ConversationMember";
import ConsentRecord from "../../../src/models/ConsentRecord";
import NotificationPreference from "../../../src/models/NotificationPreference";
import PushSubscription from "../../../src/models/PushSubscription";
import RefreshSession from "../../../src/models/RefreshSession";
import User from "../../../src/models/User";
import { AlumniAccountDeletionService } from "../../../src/services/alumni/AlumniAccountDeletionService";
import { MongoTransactionService } from "../../../src/services/reliability/MongoTransactionService";
import { ensureIntegrationDB } from "../setup/connect";

const NOW = new Date("2032-01-31T20:15:00.000Z");
const HASH = (character: string) => character.repeat(64);
const models = [
  AlumniAffiliation,
  AlumniHelpRequest,
  AlumniProfile,
  AuditLog,
  Conversation,
  ConversationMember,
  ConsentRecord,
  NotificationPreference,
  PushSubscription,
  RefreshSession,
  User,
] as const;

async function insertUser(id: mongoose.Types.ObjectId, suffix: string) {
  await User.collection.insertOne({
    _id: id,
    username: `account-${suffix}`,
    usernameLower: `account-${suffix}`,
    email: `${suffix}@example.org`,
    password: "integration-test-only",
    firstName: "Private",
    lastName: "Person",
    role: suffix === "admin" ? "Super Admin" : "Participant",
    isActive: true,
    isVerified: true,
    emailNotifications: true,
    loginAttempts: 0,
    hasReceivedWelcomeMessage: false,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function createPublishedFixture() {
  const targetUserId = new mongoose.Types.ObjectId();
  const actorId = new mongoose.Types.ObjectId();
  const profileId = new mongoose.Types.ObjectId();
  const consentId = new mongoose.Types.ObjectId();
  await Promise.all([
    insertUser(targetUserId, targetUserId.toString()),
    insertUser(actorId, "admin"),
  ]);
  await AlumniProfile.create({
    _id: profileId,
    userId: targetUserId,
    publishStatus: "published",
    currentPublicationConsentId: consentId,
    publishedAt: NOW,
    helpOfferings: {
      careerAdvice: true,
      warmIntroduction: false,
      formalEmployeeReferral: false,
    },
    searchProjection: {},
    revision: 0,
  });
  await Promise.all([
    ConsentRecord.create({
      _id: consentId,
      subjectUserId: targetUserId,
      alumniProfileId: profileId,
      purpose: "alumni_profile_publication",
      consentVersion: "v1",
      documentHash: HASH("a"),
      status: "active",
      acceptedAt: NOW,
      revision: 0,
    }),
    AlumniAffiliation.create({
      alumniProfileId: profileId,
      programName: "Leadership Program",
      cohortLabel: "2031",
      affiliationKey: deriveAlumniAffiliationKey({
        programName: "Leadership Program",
        cohortLabel: "2031",
      }),
      verificationStatus: "verified",
      reviewedAt: NOW,
      reviewedBy: actorId,
      revision: 0,
    }),
    PushSubscription.create({
      userId: targetUserId,
      installationId: "account-deletion-test",
      endpoint: "https://push.example.org/private-endpoint",
      endpointHash: HASH("b"),
      vapidKeyId: HASH("c"),
      keys: { p256dh: "private-key", auth: "private-auth" },
      staleAt: addFixedDays(NOW, 90),
      revision: 0,
    }),
    NotificationPreference.create({
      userId: targetUserId,
      pushEnabled: true,
      emailEnabled: true,
      revision: 0,
    }),
    RefreshSession.create({
      familyId: crypto.randomUUID(),
      userId: targetUserId,
      currentJtiHash: HASH("9"),
      refreshLifetimeMs: 86_400_000,
      expiresAt: addFixedDays(NOW, 1),
    }),
  ]);
  return { targetUserId, actorId, profileId, consentId };
}

describe("G1-01 Alumni account deletion privacy transaction", () => {
  beforeAll(async () => {
    await ensureIntegrationDB();
    await Promise.all(models.map((model) => model.init()));
    await new MongoTransactionService(mongoose.connection).assertTopologyCapability(
      true,
    );
  });

  beforeEach(async () => {
    await Promise.all(models.map((model) => model.deleteMany({})));
  });

  afterAll(async () => {
    await Promise.all(models.map((model) => model.deleteMany({})));
  });

  it("withdraws public data and starts approved clocks atomically with deletion", async () => {
    const fixture = await createPublishedFixture();
    const service = new AlumniAccountDeletionService({
      now: () => new Date(NOW),
      transactions: new MongoTransactionService(mongoose.connection),
    });

    await expect(
      service.deleteAccount({
        targetUserId: fixture.targetUserId.toString(),
        actor: { id: fixture.actorId.toString(), role: "Super Admin" },
        correlationId: "g1-account-deletion",
      }),
    ).resolves.toEqual({
      profileScheduled: true,
      affiliationsScheduled: 1,
      consentsTerminated: 1,
      helpRequestsTerminated: 0,
      helpRoomsArchived: 0,
      accessWindowsClosed: 0,
    });

    const [
      user,
      profile,
      affiliation,
      consent,
      pushCount,
      preferenceCount,
      refreshSessionCount,
      audit,
    ] =
      await Promise.all([
        User.findById(fixture.targetUserId),
        AlumniProfile.findById(fixture.profileId),
        AlumniAffiliation.findOne({ alumniProfileId: fixture.profileId }),
        ConsentRecord.findById(fixture.consentId),
        PushSubscription.countDocuments({ userId: fixture.targetUserId }),
        NotificationPreference.countDocuments({ userId: fixture.targetUserId }),
        RefreshSession.countDocuments({ userId: fixture.targetUserId }),
        AuditLog.findOne({
          action: "alumni_account.deleted",
          targetId: fixture.targetUserId.toString(),
        }).lean(),
      ]);

    expect(user).toBeNull();
    expect(profile).toMatchObject({
      publishStatus: "withdrawn",
      currentPublicationConsentId: undefined,
      withdrawnAt: NOW,
      accountDeletionApprovedAt: NOW,
      purgeAt: addFixedDays(NOW, 30),
      revision: 1,
    });
    expect(affiliation).toMatchObject({
      accountDeletionApprovedAt: NOW,
      purgeAt: addFixedDays(NOW, 30),
      revision: 1,
    });
    expect(consent).toMatchObject({
      status: "account_deleted",
      accountDeletionApprovedAt: NOW,
      purgeAt: addUtcCalendarMonths(NOW, 12),
      revision: 1,
    });
    expect(pushCount).toBe(0);
    expect(preferenceCount).toBe(0);
    expect(refreshSessionCount).toBe(0);
    expect(audit).toMatchObject({
      version: 2,
      actorType: "user",
      actorKey: fixture.actorId.toString(),
      correlationId: "g1-account-deletion",
      outcome: "success",
      details: {
        profileScheduled: true,
        affiliationsScheduled: 1,
        consentsTerminated: 1,
        helpRequestsTerminated: 0,
        helpRoomsArchived: 0,
        accessWindowsClosed: 0,
        profileRetentionDays: 30,
        consentRetentionMonths: 12,
      },
    });
  });

  it("terminates active Help workflows and closes every remaining access window", async () => {
    const fixture = await createPublishedFixture();
    const peerId = new mongoose.Types.ObjectId();
    const peerProfileId = new mongoose.Types.ObjectId();
    const acceptedRequestId = new mongoose.Types.ObjectId();
    const acceptedRoomId = new mongoose.Types.ObjectId();
    const pendingRequestId = new mongoose.Types.ObjectId();
    const programRoomId = new mongoose.Types.ObjectId();
    const acceptedAt = new Date(NOW.getTime() - 24 * 60 * 60 * 1_000);
    await insertUser(peerId, peerId.toString());
    await AlumniProfile.create({
      _id: peerProfileId,
      userId: peerId,
      publishStatus: "draft",
      helpOfferings: {
        careerAdvice: true,
        warmIntroduction: false,
        formalEmployeeReferral: false,
      },
      searchProjection: {},
      revision: 0,
    });
    await Conversation.create({
      _id: acceptedRoomId,
      kind: "alumni_help",
      status: "current",
      helpRequestId: acceptedRequestId,
      lastSequence: 0,
      lastMessageId: null,
      latestMessagePurgeAt: null,
      revision: 0,
    });
    await AlumniHelpRequest.create({
      _id: acceptedRequestId,
      requesterId: peerId,
      providerId: fixture.targetUserId,
      alumniProfileId: fixture.profileId,
      requesterSnapshot: { displayName: "Requesting Peer", avatar: null },
      providerSnapshot: { displayName: "Deleted Provider", avatar: null },
      requestedHelpType: "career_advice",
      agreedHelpType: "career_advice",
      consentVersion: "alumni-help-consent-v2",
      consentDocumentHash: HASH("d"),
      disclaimerVersion: "alumni-help-disclaimer-v2",
      disclaimerDocumentHash: HASH("e"),
      termsAcceptedAt: acceptedAt,
      status: "accepted",
      hasBeenAccepted: true,
      activeUniqueness: true,
      acceptedAt,
      conversationId: acceptedRoomId,
      lifecycleTimeline: [
        {
          _id: new mongoose.Types.ObjectId(),
          sequence: 1,
          action: "create",
          fromStatus: null,
          toStatus: "requested",
          actorRole: "requester",
          actorId: peerId,
          note: null,
          helpType: "career_advice",
          occurredAt: acceptedAt,
        },
        {
          _id: new mongoose.Types.ObjectId(),
          sequence: 2,
          action: "accept",
          fromStatus: "requested",
          toStatus: "accepted",
          actorRole: "provider",
          actorId: fixture.targetUserId,
          note: null,
          helpType: "career_advice",
          occurredAt: acceptedAt,
        },
      ],
      revision: 0,
    });
    await ConversationMember.create([
      {
        conversationId: acceptedRoomId,
        userId: peerId,
        role: "requester",
        status: "active",
        joinedAt: acceptedAt,
        accessWindows: [
          {
            visibleFromSequence: 1,
            visibleThroughSequence: null,
            openedAt: acceptedAt,
            closedAt: null,
          },
        ],
        revision: 0,
      },
      {
        conversationId: acceptedRoomId,
        userId: fixture.targetUserId,
        role: "provider",
        status: "active",
        joinedAt: acceptedAt,
        accessWindows: [
          {
            visibleFromSequence: 1,
            visibleThroughSequence: null,
            openedAt: acceptedAt,
            closedAt: null,
          },
        ],
        revision: 0,
      },
    ]);
    await AlumniHelpRequest.create({
      _id: pendingRequestId,
      requesterId: fixture.targetUserId,
      providerId: peerId,
      alumniProfileId: peerProfileId,
      requesterSnapshot: { displayName: "Deleted Requester", avatar: null },
      providerSnapshot: { displayName: "Helping Peer", avatar: null },
      requestedHelpType: "career_advice",
      consentVersion: "alumni-help-consent-v2",
      consentDocumentHash: HASH("f"),
      disclaimerVersion: "alumni-help-disclaimer-v2",
      disclaimerDocumentHash: HASH("1"),
      termsAcceptedAt: acceptedAt,
      status: "requested",
      hasBeenAccepted: false,
      activeUniqueness: true,
      lifecycleTimeline: [
        {
          _id: new mongoose.Types.ObjectId(),
          sequence: 1,
          action: "create",
          fromStatus: null,
          toStatus: "requested",
          actorRole: "requester",
          actorId: fixture.targetUserId,
          note: null,
          helpType: "career_advice",
          occurredAt: acceptedAt,
        },
      ],
      revision: 0,
    });
    await Conversation.create({
      _id: programRoomId,
      kind: "program",
      status: "current",
      programId: new mongoose.Types.ObjectId(),
      lastSequence: 2,
      lastMessageId: new mongoose.Types.ObjectId(),
      latestMessagePurgeAt: addUtcCalendarMonths(NOW, 12),
      revision: 0,
    });
    await ConversationMember.create({
      conversationId: programRoomId,
      userId: fixture.targetUserId,
      role: "mentee",
      status: "active",
      joinedAt: acceptedAt,
      accessWindows: [
        {
          visibleFromSequence: 1,
          visibleThroughSequence: null,
          openedAt: acceptedAt,
          closedAt: null,
        },
      ],
      unreadCount: 2,
      revision: 0,
    });

    const service = new AlumniAccountDeletionService({
      now: () => new Date(NOW),
      transactions: new MongoTransactionService(mongoose.connection),
    });
    await expect(
      service.deleteAccount({
        targetUserId: fixture.targetUserId.toString(),
        actor: { id: fixture.actorId.toString(), role: "Super Admin" },
      }),
    ).resolves.toMatchObject({
      helpRequestsTerminated: 2,
      helpRoomsArchived: 1,
      accessWindowsClosed: 1,
    });

    const [accepted, pending, helpRoom, helpMembers, programMember] =
      await Promise.all([
        AlumniHelpRequest.findById(acceptedRequestId),
        AlumniHelpRequest.findById(pendingRequestId),
        Conversation.findById(acceptedRoomId),
        ConversationMember.find({ conversationId: acceptedRoomId }).sort({ role: 1 }),
        ConversationMember.findOne({ conversationId: programRoomId }),
      ]);
    expect(accepted).toMatchObject({
      status: "closed",
      closedAt: NOW,
      purgeAt: addUtcCalendarMonths(NOW, 12),
      revision: 1,
    });
    expect(pending).toMatchObject({
      status: "withdrawn",
      withdrawnAt: NOW,
      purgeAt: addUtcCalendarMonths(NOW, 2),
      revision: 1,
    });
    expect(helpRoom).toMatchObject({
      status: "archived",
      archivedAt: NOW,
      purgeAt: addUtcCalendarMonths(NOW, 24),
      revision: 1,
    });
    expect(helpMembers).toHaveLength(2);
    expect(helpMembers.every((member) => member.status === "history_only")).toBe(
      true,
    );
    expect(
      helpMembers.every(
        (member) =>
          member.purgeAt?.getTime() ===
          addUtcCalendarMonths(NOW, 24).getTime(),
      ),
    ).toBe(true);
    expect(programMember).toMatchObject({
      status: "history_only",
      lastReadSequence: 2,
      unreadCount: 0,
      unreadReconciledThroughSequence: 2,
      purgeAt: null,
      revision: 1,
    });
    expect(programMember?.accessWindows[0]).toMatchObject({
      visibleThroughSequence: 2,
      closedAt: NOW,
    });
  });

  it("rolls every privacy and deletion write back when mandatory audit fails", async () => {
    const fixture = await createPublishedFixture();
    const service = new AlumniAccountDeletionService({
      now: () => new Date(NOW),
      transactions: new MongoTransactionService(mongoose.connection),
      audit: {
        recordRequiredInTransaction: vi
          .fn()
          .mockRejectedValue(new Error("mandatory audit unavailable")),
      },
    });

    await expect(
      service.deleteAccount(
        {
          targetUserId: fixture.targetUserId.toString(),
          actor: { id: fixture.actorId.toString(), role: "Super Admin" },
        },
        async ({ targetUserId, session }) => {
          await User.updateOne(
            { _id: targetUserId },
            { $set: { firstName: "Should Roll Back" } },
            { session },
          );
        },
      ),
    ).rejects.toThrow("mandatory audit unavailable");

    const [user, profile, affiliation, consent, pushCount, preferenceCount] =
      await Promise.all([
        User.findById(fixture.targetUserId),
        AlumniProfile.findById(fixture.profileId),
        AlumniAffiliation.findOne({ alumniProfileId: fixture.profileId }),
        ConsentRecord.findById(fixture.consentId),
        PushSubscription.countDocuments({ userId: fixture.targetUserId }),
        NotificationPreference.countDocuments({ userId: fixture.targetUserId }),
      ]);
    expect(user).toMatchObject({ firstName: "Private" });
    expect(profile).toMatchObject({
      publishStatus: "published",
      accountDeletionApprovedAt: null,
      purgeAt: null,
      revision: 0,
    });
    expect(affiliation).toMatchObject({
      accountDeletionApprovedAt: null,
      purgeAt: null,
      revision: 0,
    });
    expect(consent).toMatchObject({ status: "active", revision: 0 });
    expect(pushCount).toBe(1);
    expect(preferenceCount).toBe(1);
  });
});
