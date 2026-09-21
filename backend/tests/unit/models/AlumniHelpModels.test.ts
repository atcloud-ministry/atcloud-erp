import mongoose from "mongoose";
import { describe, expect, it } from "vitest";
import { ALUMNI_HELP_TERMS } from "../../../src/config/alumniHelpTerms";
import { conversationPurgeAt } from "../../../src/contracts/chatRooms";
import {
  acceptedHelpRequestPurgeAt,
  helpOutcomeDueAt,
  neverAcceptedHelpRequestPurgeAt,
} from "../../../src/contracts/alumniHelpFlow";
import AlumniHelpOutcomeSubmission from "../../../src/models/AlumniHelpOutcomeSubmission";
import AlumniHelpRequest from "../../../src/models/AlumniHelpRequest";
import Conversation from "../../../src/models/Conversation";
import ConversationMember from "../../../src/models/ConversationMember";

function ids() {
  return {
    requesterId: new mongoose.Types.ObjectId(),
    providerId: new mongoose.Types.ObjectId(),
    alumniProfileId: new mongoose.Types.ObjectId(),
  };
}

function requested(overrides: Record<string, unknown> = {}) {
  const identity = ids();
  const occurredAt = new Date("2026-09-12T12:00:00.000Z");
  return new AlumniHelpRequest({
    ...identity,
    requesterSnapshot: { displayName: " Requester ", avatar: null },
    providerSnapshot: { displayName: " Provider ", avatar: null },
    requestedHelpType: "career_advice",
    consentVersion: ALUMNI_HELP_TERMS.consent.version,
    consentDocumentHash: ALUMNI_HELP_TERMS.consent.documentHash,
    disclaimerVersion: ALUMNI_HELP_TERMS.disclaimer.version,
    disclaimerDocumentHash: ALUMNI_HELP_TERMS.disclaimer.documentHash,
    termsAcceptedAt: occurredAt,
    status: "requested",
    hasBeenAccepted: false,
    lifecycleTimeline: [
      {
        sequence: 1,
        action: "create",
        fromStatus: null,
        toStatus: "requested",
        actorRole: "requester",
        actorId: identity.requesterId,
        occurredAt,
        helpType: "career_advice",
      },
    ],
    ...overrides,
  });
}

function pendingOutcome(overrides: Record<string, unknown> = {}) {
  const submittedAt = new Date("2026-09-12T12:00:00.000Z");
  return new AlumniHelpOutcomeSubmission({
    helpRequestId: new mongoose.Types.ObjectId(),
    revisionNumber: 1,
    previousSubmissionId: null,
    submittedBy: new mongoose.Types.ObjectId(),
    agreedHelpType: "career_advice",
    outcomeCode: "completed",
    status: "pending",
    submittedAt,
    dueAt: helpOutcomeDueAt(submittedAt),
    ...overrides,
  });
}

describe("AlumniHelpRequest model", () => {
  it("normalizes immutable participant snapshots and notes", async () => {
    const request = requested({ openingNote: "  Please   help. " });
    await expect(request.validate()).resolves.toBeUndefined();
    expect(request.requesterSnapshot.displayName).toBe("Requester");
    expect(request.openingNote).toBe("Please help.");
    expect(request.activeUniqueness).toBe(true);
  });

  it("requires distinct participants and an exact contiguous lifecycle", async () => {
    const sameParticipant = requested();
    sameParticipant.providerId = sameParticipant.requesterId;
    await expect(sameParticipant.validate()).rejects.toThrow(
      "Requester and provider",
    );

    const invalidTimeline = requested();
    invalidTimeline.lifecycleTimeline[0].sequence = 2;
    await expect(invalidTimeline.validate()).rejects.toThrow(
      "sequences must be contiguous",
    );
  });

  it("requires the room and agreed type throughout accepted lifecycle", async () => {
    const invalid = requested({
      status: "accepted",
      hasBeenAccepted: true,
      acceptedAt: new Date("2026-09-13T12:00:00.000Z"),
      agreedHelpType: "career_advice",
      lifecycleTimeline: [],
    });
    await expect(invalid.validate()).rejects.toThrow("Alumni Help Room");

    const valid = requested();
    const acceptedAt = new Date("2026-09-13T12:00:00.000Z");
    valid.status = "accepted";
    valid.hasBeenAccepted = true;
    valid.acceptedAt = acceptedAt;
    valid.agreedHelpType = "career_advice";
    valid.conversationId = new mongoose.Types.ObjectId();
    valid.lifecycleTimeline.push({
      _id: new mongoose.Types.ObjectId(),
      sequence: 2,
      action: "accept",
      fromStatus: "requested",
      toStatus: "accepted",
      actorRole: "provider",
      actorId: valid.providerId,
      note: null,
      helpType: "career_advice",
      occurredAt: acceptedAt,
    });
    await expect(valid.validate()).resolves.toBeUndefined();
  });

  it("enforces proposed and agreed help-type relationships", async () => {
    const sameAlternative = requested({ proposedHelpType: "career_advice" });
    await expect(sameAlternative.validate()).rejects.toThrow(
      "must differ from the requested",
    );

    const missingAlternative = requested({
      status: "alternative_proposed",
      lifecycleTimeline: [],
    });
    await expect(missingAlternative.validate()).rejects.toThrow(
      "requires proposedHelpType",
    );
  });

  it("enforces never-accepted and accepted retention clocks", async () => {
    const declinedAt = new Date("2026-10-31T12:00:00.000Z");
    const declined = requested();
    declined.status = "declined";
    declined.declinedAt = declinedAt;
    declined.purgeAt = neverAcceptedHelpRequestPurgeAt(declinedAt);
    declined.lifecycleTimeline.push({
      _id: new mongoose.Types.ObjectId(),
      sequence: 2,
      action: "decline",
      fromStatus: "requested",
      toStatus: "declined",
      actorRole: "provider",
      actorId: declined.providerId,
      note: null,
      helpType: null,
      occurredAt: declinedAt,
    });
    await expect(declined.validate()).resolves.toBeUndefined();

    declined.purgeAt = new Date("2027-01-01T12:00:00.000Z");
    await expect(declined.validate()).rejects.toThrow("approved retention");

    const closedAt = new Date("2026-09-15T12:00:00.000Z");
    const latestDueAt = new Date("2027-09-20T12:00:00.000Z");
    const closed = requested();
    const acceptedAt = new Date("2026-09-13T12:00:00.000Z");
    closed.status = "closed";
    closed.hasBeenAccepted = true;
    closed.acceptedAt = acceptedAt;
    closed.agreedHelpType = "career_advice";
    closed.conversationId = new mongoose.Types.ObjectId();
    closed.closedAt = closedAt;
    closed.latestOutcomeSubmissionId = new mongoose.Types.ObjectId();
    closed.latestOutcomeRevisionNumber = 1;
    closed.latestOutcomeStatus = "pending";
    closed.latestOutcomeDueAt = latestDueAt;
    closed.purgeAt = acceptedHelpRequestPurgeAt(closedAt, latestDueAt);
    closed.lifecycleTimeline.push({
      _id: new mongoose.Types.ObjectId(),
      sequence: 2,
      action: "accept",
      fromStatus: "requested",
      toStatus: "accepted",
      actorRole: "provider",
      actorId: closed.providerId,
      note: null,
      helpType: "career_advice",
      occurredAt: acceptedAt,
    });
    closed.lifecycleTimeline.push({
      _id: new mongoose.Types.ObjectId(),
      sequence: 3,
      action: "close",
      fromStatus: "accepted",
      toStatus: "closed",
      actorRole: "requester",
      actorId: closed.requesterId,
      note: null,
      helpType: null,
      occurredAt: closedAt,
    });
    await expect(closed.validate()).resolves.toBeUndefined();
    expect(closed.purgeAt?.toISOString()).toBe("2027-10-20T12:00:00.000Z");
  });

  it("declares active identity, participant, action, room, and TTL indexes", () => {
    const indexes = AlumniHelpRequest.schema.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        [
          { requesterId: 1, alumniProfileId: 1, requestedHelpType: 1 },
          expect.objectContaining({
            unique: true,
            name: "uniq_alumni_help_request_active_identity",
            partialFilterExpression: { activeUniqueness: true },
          }),
        ],
        [
          { conversationId: 1 },
          expect.objectContaining({
            unique: true,
            name: "uniq_alumni_help_request_conversation",
          }),
        ],
        [
          { purgeAt: 1 },
          expect.objectContaining({
            expireAfterSeconds: 0,
            name: "ttl_alumni_help_request_purge_at",
          }),
        ],
      ]),
    );
  });
});

describe("AlumniHelpOutcomeSubmission model", () => {
  it("accepts each approved type-specific outcome and exact deadline", async () => {
    await expect(pendingOutcome().validate()).resolves.toBeUndefined();
    await expect(
      pendingOutcome({
        agreedHelpType: "formal_employee_referral",
        outcomeCode: "interview_not_hired",
      }).validate(),
    ).resolves.toBeUndefined();
  });

  it("rejects incompatible outcomes, deadline drift, and broken ancestry", async () => {
    await expect(
      pendingOutcome({ outcomeCode: "interview_not_hired" }).validate(),
    ).rejects.toThrow("not available");
    await expect(
      pendingOutcome({
        dueAt: new Date("2026-09-20T12:00:00.000Z"),
      }).validate(),
    ).rejects.toThrow("exactly 480 hours");
    await expect(
      pendingOutcome({ revisionNumber: 2 }).validate(),
    ).rejects.toThrow("ancestry");
  });

  it("enforces provider, automatic, and denial decision metadata", async () => {
    await expect(
      pendingOutcome({
        status: "confirmed",
        decidedAt: new Date("2026-09-13T12:00:00.000Z"),
        decidedBy: new mongoose.Types.ObjectId(),
        confirmationMethod: "provider",
        revision: 1,
      }).validate(),
    ).resolves.toBeUndefined();
    await expect(
      pendingOutcome({
        status: "confirmed",
        decidedAt: new Date("2026-10-03T12:00:00.000Z"),
        confirmationMethod: "automatic_20_day",
        revision: 1,
      }).validate(),
    ).resolves.toBeUndefined();
    await expect(
      pendingOutcome({
        status: "denied",
        decidedAt: new Date("2026-09-13T12:00:00.000Z"),
        decidedBy: new mongoose.Types.ObjectId(),
        revision: 1,
      }).validate(),
    ).resolves.toBeUndefined();
  });

  it("declares revision, pending, deadline, history, and TTL indexes", () => {
    expect(AlumniHelpOutcomeSubmission.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { helpRequestId: 1, revisionNumber: 1 },
          expect.objectContaining({ unique: true }),
        ],
        [
          { helpRequestId: 1 },
          expect.objectContaining({
            unique: true,
            partialFilterExpression: { status: "pending" },
          }),
        ],
        [
          { status: 1, dueAt: 1, _id: 1 },
          expect.objectContaining({ name: "idx_alumni_help_outcome_deadline" }),
        ],
        [
          { purgeAt: 1 },
          expect.objectContaining({ expireAfterSeconds: 0 }),
        ],
      ]),
    );
  });
});

describe("base Alumni Help Room models", () => {
  it("requires archive state and timestamp to agree", async () => {
    const current = new Conversation({
      helpRequestId: new mongoose.Types.ObjectId(),
    });
    await expect(current.validate()).resolves.toBeUndefined();
    expect(current.kind).toBe("alumni_help");
    expect(current.lastSequence).toBe(0);

    current.status = "archived";
    await expect(current.validate()).rejects.toThrow("archivedAt");
    current.archivedAt = new Date("2026-09-12T12:00:00.000Z");
    current.purgeAt = conversationPurgeAt(current.archivedAt);
    await expect(current.validate()).resolves.toBeUndefined();
  });

  it("declares one room per request and one membership per room/user", () => {
    expect(Conversation.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { helpRequestId: 1 },
          expect.objectContaining({ unique: true }),
        ],
      ]),
    );
    expect(ConversationMember.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { conversationId: 1, userId: 1 },
          expect.objectContaining({ unique: true }),
        ],
        [
          { userId: 1, status: 1, unreadCount: 1, conversationId: 1 },
          expect.objectContaining({
            name: "idx_conversation_member_user_unread",
          }),
        ],
      ]),
    );
  });

  it("accepts only the base active requester/provider membership primitive", async () => {
    const member = new ConversationMember({
      conversationId: new mongoose.Types.ObjectId(),
      userId: new mongoose.Types.ObjectId(),
      role: "requester",
      joinedAt: new Date("2026-09-12T12:00:00.000Z"),
      accessWindows: [
        {
          visibleFromSequence: 1,
          visibleThroughSequence: null,
          openedAt: new Date("2026-09-12T12:00:00.000Z"),
          closedAt: null,
        },
      ],
    });
    await expect(member.validate()).resolves.toBeUndefined();
    expect(member.status).toBe("active");
  });
});
