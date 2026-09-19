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
import {
  ALUMNI_HELP_CONSENT_REGISTRY,
  ALUMNI_HELP_DISCLAIMER_REGISTRY,
  ALUMNI_HELP_TERMS,
} from "../../../src/config/alumniHelpTerms";
import { ALUMNI_PROFILE_PUBLICATION_CONSENT } from "../../../src/config/alumniProfilePublicationConsent";
import {
  ALUMNI_HELP_OUTCOMES_BY_TYPE,
  ALUMNI_HELP_OUTCOME_CONFIRMATION_HOURS,
  acceptedHelpRequestPurgeAt,
  type AlumniHelpOutcomeCode,
  type AlumniHelpType,
} from "../../../src/contracts/alumniHelpFlow";
import {
  deriveAlumniAffiliationKey,
  MILLISECONDS_PER_DAY,
} from "../../../src/contracts/alumniDirectoryData";
import { conversationPurgeAt } from "../../../src/contracts/chatRooms";
import AlumniAffiliation from "../../../src/models/AlumniAffiliation";
import AlumniHelpOutcomeSubmission from "../../../src/models/AlumniHelpOutcomeSubmission";
import AlumniHelpRequest from "../../../src/models/AlumniHelpRequest";
import AlumniProfile from "../../../src/models/AlumniProfile";
import AuditLog from "../../../src/models/AuditLog";
import ConsentRecord from "../../../src/models/ConsentRecord";
import Conversation from "../../../src/models/Conversation";
import ConversationMember from "../../../src/models/ConversationMember";
import IdempotencyRecord from "../../../src/models/IdempotencyRecord";
import NotificationOutbox from "../../../src/models/NotificationOutbox";
import User from "../../../src/models/User";
import { ALUMNI_HELP_EXTERNAL_NOTIFICATION_TOPIC } from "../../../src/services/alumni/AlumniHelpExternalNotification";
import { AlumniHelpRequestService } from "../../../src/services/alumni/AlumniHelpRequestService";
import { ALUMNI_HELP_WORKFLOW_TOPIC } from "../../../src/services/alumni/AlumniHelpWorkflowDeliveryHandler";
import { AlumniOutcomeDeadlineService } from "../../../src/services/alumni/AlumniOutcomeDeadlineService";
import {
  WORKER_RUN_TRIGGERS,
  WORKER_SERVICE_KEYS,
  workerAuthorizationService,
} from "../../../src/services/authorization/WorkerAuthorizationService";
import { MongoTransactionService } from "../../../src/services/reliability/MongoTransactionService";
import { ensureIntegrationDB } from "../setup/connect";

const collections = [
  AuditLog,
  AlumniAffiliation,
  AlumniHelpOutcomeSubmission,
  AlumniHelpRequest,
  AlumniProfile,
  ConsentRecord,
  Conversation,
  ConversationMember,
  IdempotencyRecord,
  NotificationOutbox,
  User,
] as const;

const PRIVATE_PHONE = "+12065550199";
const OUTCOME_CASES = Object.entries(ALUMNI_HELP_OUTCOMES_BY_TYPE).flatMap(
  ([helpType, codes]) =>
    codes.map((outcomeCode) => ({
      helpType: helpType as AlumniHelpType,
      outcomeCode: outcomeCode as AlumniHelpOutcomeCode,
    })),
);

let nowValue: Date;
let service: AlumniHelpRequestService;
let providerId: mongoose.Types.ObjectId;
let profileId: mongoose.Types.ObjectId;

function actor(id: mongoose.Types.ObjectId) {
  return { id: id.toString(), role: "Participant" } as const;
}

function setNow(value: Date | string): void {
  nowValue = new Date(value);
}

async function insertUser(label: string): Promise<mongoose.Types.ObjectId> {
  const id = new mongoose.Types.ObjectId();
  const username = `h${label}${id.toString().slice(-8)}`.toLowerCase();
  await User.collection.insertOne({
    _id: id,
    username,
    usernameLower: username,
    email: `${username}@private.example.org`,
    phone: PRIVATE_PHONE,
    birthYear: 1988,
    password: "integration-test-only",
    firstName: label,
    lastName: "Member",
    avatar: `https://example.org/${label}.png`,
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
  return id;
}

async function insertPublishedProvider(): Promise<{
  userId: mongoose.Types.ObjectId;
  profileId: mongoose.Types.ObjectId;
}> {
  const userId = await insertUser("Provider");
  const createdProfileId = new mongoose.Types.ObjectId();
  const consentId = new mongoose.Types.ObjectId();
  await AlumniProfile.collection.insertOne({
    _id: createdProfileId,
    userId,
    professionalHeadline: "Product mentor",
    industry: "Technology",
    skills: ["Mentoring"],
    bio: "Published biography",
    helpOfferings: {
      careerAdvice: true,
      warmIntroduction: true,
      formalEmployeeReferral: true,
    },
    publishStatus: "published",
    currentPublicationConsentId: consentId,
    searchProjection: {},
    publishedAt: nowValue,
    withdrawnAt: null,
    accountDeletionApprovedAt: null,
    purgeAt: null,
    revision: 1,
    createdAt: nowValue,
    updatedAt: nowValue,
  });
  await ConsentRecord.collection.insertOne({
    _id: consentId,
    subjectUserId: userId,
    alumniProfileId: createdProfileId,
    purpose: "alumni_profile_publication",
    consentVersion: ALUMNI_PROFILE_PUBLICATION_CONSENT.version,
    documentHash: ALUMNI_PROFILE_PUBLICATION_CONSENT.documentHash,
    status: "active",
    acceptedAt: nowValue,
    revision: 0,
    createdAt: nowValue,
    updatedAt: nowValue,
  });
  await AlumniAffiliation.collection.insertOne({
    _id: new mongoose.Types.ObjectId(),
    alumniProfileId: createdProfileId,
    programName: "EMBA Mentor Circles",
    cohortLabel: "2032",
    affiliationKey: deriveAlumniAffiliationKey({
      programName: "EMBA Mentor Circles",
      cohortLabel: "2032",
    }),
    verificationStatus: "verified",
    reviewedAt: nowValue,
    reviewedBy: userId,
    accountDeletionApprovedAt: null,
    purgeAt: null,
    revision: 0,
    createdAt: nowValue,
    updatedAt: nowValue,
  });
  return { userId, profileId: createdProfileId };
}

async function createRequest(
  requesterId: mongoose.Types.ObjectId,
  helpType: AlumniHelpType,
  openingNote = "Please help with my next career step.",
) {
  return service.create({
    alumniProfileId: profileId.toString(),
    requestedHelpType: helpType,
    openingNote,
    consentVersion: ALUMNI_HELP_TERMS.consent.version,
    consentAccepted: true,
    disclaimerVersion: ALUMNI_HELP_TERMS.disclaimer.version,
    disclaimerAccepted: true,
    actor: actor(requesterId),
    idempotencyKey: randomUUID(),
  });
}

async function acceptRequest(requestId: string, revision = 0) {
  return service.transition({
    requestId,
    action: "accept",
    expectedRevision: revision,
    actor: actor(providerId),
    idempotencyKey: randomUUID(),
  });
}

async function submitOutcome(
  requesterId: mongoose.Types.ObjectId,
  requestId: string,
  requestRevision: number,
  outcomeCode: AlumniHelpOutcomeCode,
) {
  return service.submitOutcome({
    requestId,
    expectedRevision: requestRevision,
    outcomeCode,
    actor: actor(requesterId),
    idempotencyKey: randomUUID(),
  });
}

describe("M3 Alumni Help service integration", () => {
  beforeAll(async () => {
    await ensureIntegrationDB();
    await Promise.all(collections.map((model) => model.init()));
    const capability = await new MongoTransactionService(
      mongoose.connection,
    ).assertTopologyCapability(true);
    expect(capability.supported).toBe(true);
  });

  beforeEach(async () => {
    await Promise.all(collections.map((model) => model.deleteMany({})));
    setNow("2032-09-12T12:00:00.000Z");
    service = new AlumniHelpRequestService({ now: () => new Date(nowValue) });
    ({ userId: providerId, profileId } = await insertPublishedProvider());
  });

  afterAll(async () => {
    await Promise.all(collections.map((model) => model.deleteMany({})));
  });

  it("conceals non-participants, enforces active uniqueness, and provisions one exact two-person room", async () => {
    const requesterId = await insertUser("Requester");
    const outsiderId = await insertUser("Outsider");
    const privateNote = "PRIVATE-CONTEXT-DO-NOT-NOTIFY";
    const created = await createRequest(
      requesterId,
      "career_advice",
      privateNote,
    );
    const requestId = created.request.id;

    expect(created.request).toMatchObject({
      id: requestId,
      status: "requested",
      viewerRole: "requester",
      actionRequiredForViewer: false,
      openingNote: privateNote,
      revision: 0,
    });
    expect(await service.actionRequiredCount(providerId.toString())).toEqual({
      helpActionRequiredCount: 1,
    });
    expect(
      await service.list(providerId.toString(), {
        view: "action_required",
        page: 1,
        limit: 20,
      }),
    ).toMatchObject({
      requests: [{ id: requestId, viewerRole: "provider" }],
      helpActionRequiredCount: 1,
    });
    expect(
      await service.list(outsiderId.toString(), {
        view: "received",
        page: 1,
        limit: 20,
      }),
    ).toMatchObject({ requests: [], helpActionRequiredCount: 0 });
    await expect(
      service.get(outsiderId.toString(), requestId),
    ).rejects.toMatchObject({
      code: "ALUMNI_HELP_REQUEST_NOT_FOUND",
      httpStatus: 404,
    });

    await expect(
      createRequest(requesterId, "career_advice"),
    ).rejects.toMatchObject({
      code: "ALUMNI_HELP_REQUEST_DUPLICATE",
      httpStatus: 409,
    });

    const idempotencyKey = randomUUID();
    const acceptance = {
      requestId,
      action: "accept" as const,
      expectedRevision: 0,
      actor: actor(providerId),
      idempotencyKey,
    };
    const accepted = await service.transition(acceptance);
    const replayed = await service.transition(acceptance);
    expect(accepted.request).toMatchObject({
      status: "accepted",
      agreedHelpType: "career_advice",
      revision: 1,
    });
    expect(replayed.request.conversationId).toBe(
      accepted.request.conversationId,
    );
    expect(await Conversation.countDocuments({ helpRequestId: requestId })).toBe(1);
    const members = await ConversationMember.find({
      conversationId: accepted.request.conversationId,
    })
      .sort({ role: 1 })
      .lean();
    expect(members).toHaveLength(2);
    expect(
      members.map((member) => ({
        userId: String(member.userId),
        role: member.role,
        status: member.status,
      })),
    ).toEqual([
      { userId: providerId.toString(), role: "provider", status: "active" },
      { userId: requesterId.toString(), role: "requester", status: "active" },
    ]);
    expect(
      await AuditLog.countDocuments({
        action: "alumni_help.accept",
        targetId: requestId,
      }),
    ).toBe(1);
    expect(
      await NotificationOutbox.countDocuments({
        topic: ALUMNI_HELP_WORKFLOW_TOPIC,
      }),
    ).toBe(4);
    expect(
      await NotificationOutbox.countDocuments({
        topic: ALUMNI_HELP_EXTERNAL_NOTIFICATION_TOPIC,
      }),
    ).toBe(2);
    const persistedSideEffects = JSON.stringify({
      audit: await AuditLog.find({}).lean(),
      outbox: await NotificationOutbox.find({}).lean(),
    });
    expect(persistedSideEffects).not.toContain(privateNote);
    expect(persistedSideEffects).not.toContain(PRIVATE_PHONE);
    expect(persistedSideEffects).not.toContain("@private.example.org");
  });

  it("accepts a known untampered archived terms version and exposes its exact text", async () => {
    const requesterId = await insertUser("ArchivedTerms");
    const created = await createRequest(requesterId, "career_advice");
    const consent = ALUMNI_HELP_CONSENT_REGISTRY[0]!;
    const disclaimer = ALUMNI_HELP_DISCLAIMER_REGISTRY[0]!;
    await AlumniHelpRequest.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(created.request.id) },
      {
        $set: {
          consentVersion: consent.version,
          consentDocumentHash: consent.documentHash,
          disclaimerVersion: disclaimer.version,
          disclaimerDocumentHash: disclaimer.documentHash,
        },
      },
    );

    const archived = await service.get(
      requesterId.toString(),
      created.request.id,
    );
    expect(archived.request).toMatchObject({
      termsAcceptedAt: created.request.termsAcceptedAt,
      acceptedTerms: {
        consent: {
          version: consent.version,
          text: consent.text,
          effectiveAt: consent.effectiveAt,
        },
        disclaimer: {
          version: disclaimer.version,
          text: disclaimer.text,
          effectiveAt: disclaimer.effectiveAt,
        },
      },
    });

    await expect(acceptRequest(created.request.id)).resolves.toMatchObject({
      request: { status: "accepted" },
    });

    const tamperedRequesterId = await insertUser("TamperedTerms");
    const tampered = await createRequest(
      tamperedRequesterId,
      "warm_introduction",
    );
    await AlumniHelpRequest.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(tampered.request.id) },
      { $set: { consentDocumentHash: "0".repeat(64) } },
    );
    await expect(acceptRequest(tampered.request.id)).rejects.toMatchObject({
      code: "ALUMNI_HELP_TERMS_VERSION_INVALID",
      httpStatus: 409,
    });
  });

  it("enforces the actor transition matrix and permits only one concurrent CAS transition", async () => {
    const requesterId = await insertUser("Lifecycle");
    const created = await createRequest(requesterId, "warm_introduction");
    const requestId = created.request.id;

    const needsInformation = await service.transition({
      requestId,
      action: "request_information",
      expectedRevision: 0,
      note: "Please share the relevant context.",
      actor: actor(providerId),
      idempotencyKey: randomUUID(),
    });
    expect(needsInformation.request.status).toBe("needs_information");
    expect(needsInformation.helpActionRequiredCount).toBe(0);
    expect(await service.actionRequiredCount(requesterId.toString())).toEqual({
      helpActionRequiredCount: 1,
    });
    await expect(
      service.transition({
        requestId,
        action: "accept",
        expectedRevision: 1,
        actor: actor(requesterId),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "ALUMNI_HELP_REQUEST_STATE_CONFLICT" });

    await service.transition({
      requestId,
      action: "provide_information",
      expectedRevision: 1,
      note: "Here is the requested context.",
      actor: actor(requesterId),
      idempotencyKey: randomUUID(),
    });
    const alternatives = await service.get(providerId.toString(), requestId);
    expect(alternatives.request.availableAlternativeHelpTypes).toEqual([
      "career_advice",
      "formal_employee_referral",
    ]);
    await service.transition({
      requestId,
      action: "propose_alternative",
      proposedHelpType: "formal_employee_referral",
      expectedRevision: 2,
      actor: actor(providerId),
      idempotencyKey: randomUUID(),
    });
    const accepted = await service.transition({
      requestId,
      action: "confirm_alternative",
      expectedRevision: 3,
      actor: actor(requesterId),
      idempotencyKey: randomUUID(),
    });
    expect(accepted.request).toMatchObject({
      requestedHelpType: "warm_introduction",
      proposedHelpType: "formal_employee_referral",
      agreedHelpType: "formal_employee_referral",
      status: "accepted",
      revision: 4,
    });

    const [start, complete] = await Promise.allSettled([
      service.transition({
        requestId,
        action: "start",
        expectedRevision: 4,
        actor: actor(providerId),
        idempotencyKey: randomUUID(),
      }),
      service.transition({
        requestId,
        action: "complete",
        expectedRevision: 4,
        actor: actor(providerId),
        idempotencyKey: randomUUID(),
      }),
    ]);
    expect([start, complete].filter((result) => result.status === "fulfilled"))
      .toHaveLength(1);
    const rejected = [start, complete].find(
      (result) => result.status === "rejected",
    );
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        code: "ALUMNI_HELP_REQUEST_REVISION_CONFLICT",
      }),
    });
    const stored = await AlumniHelpRequest.findById(requestId);
    expect(stored?.revision).toBe(5);
    expect(stored?.lifecycleTimeline).toHaveLength(6);
    expect(await Conversation.countDocuments({ helpRequestId: requestId })).toBe(1);
    expect(await ConversationMember.countDocuments({})).toBe(2);
  });

  it("normalizes acceptance and pending-outcome uniqueness races to CAS conflicts", async () => {
    const requesterId = await insertUser("UniquenessRace");
    const created = await createRequest(requesterId, "career_advice");

    const acceptResults = await Promise.allSettled([
      service.transition({
        requestId: created.request.id,
        action: "accept",
        expectedRevision: 0,
        actor: actor(providerId),
        idempotencyKey: randomUUID(),
      }),
      service.transition({
        requestId: created.request.id,
        action: "accept",
        expectedRevision: 0,
        actor: actor(providerId),
        idempotencyKey: randomUUID(),
      }),
    ]);
    expect(acceptResults.filter((result) => result.status === "fulfilled"))
      .toHaveLength(1);
    expect(
      acceptResults.find((result) => result.status === "rejected"),
    ).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        code: "ALUMNI_HELP_REQUEST_REVISION_CONFLICT",
        httpStatus: 409,
      }),
    });
    expect(
      await Conversation.countDocuments({ helpRequestId: created.request.id }),
    ).toBe(1);
    expect(await ConversationMember.countDocuments({})).toBe(2);

    const outcomeResults = await Promise.allSettled([
      submitOutcome(requesterId, created.request.id, 1, "completed"),
      submitOutcome(requesterId, created.request.id, 1, "not_fulfilled"),
    ]);
    expect(outcomeResults.filter((result) => result.status === "fulfilled"))
      .toHaveLength(1);
    expect(
      outcomeResults.find((result) => result.status === "rejected"),
    ).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        code: "ALUMNI_HELP_REQUEST_REVISION_CONFLICT",
        httpStatus: 409,
      }),
    });
    expect(
      await AlumniHelpOutcomeSubmission.countDocuments({
        helpRequestId: created.request.id,
        status: "pending",
      }),
    ).toBe(1);
    expect(await AlumniHelpRequest.findById(created.request.id).lean()).toMatchObject({
      revision: 2,
      latestOutcomeRevisionNumber: 1,
      latestOutcomeStatus: "pending",
    });
    expect(
      await NotificationOutbox.countDocuments({
        topic: ALUMNI_HELP_WORKFLOW_TOPIC,
        "payload.eventType": "outcome_submit",
        "payload.requestId": created.request.id,
      }),
    ).toBe(2);
    expect(
      await NotificationOutbox.countDocuments({
        topic: ALUMNI_HELP_EXTERNAL_NOTIFICATION_TOPIC,
        "payload.eventType": "outcome_submit",
        "payload.requestId": created.request.id,
      }),
    ).toBe(1);
  });

  it("accepts all seven approved help outcome combinations with fixed 480-hour deadlines", async () => {
    expect(OUTCOME_CASES).toHaveLength(7);
    const privateNote = "PRIVATE-SEVEN-OUTCOME-CONTEXT";
    for (const [index, outcomeCase] of OUTCOME_CASES.entries()) {
      const requesterId = await insertUser(`Outcome${index}`);
      const created = await createRequest(
        requesterId,
        outcomeCase.helpType,
        privateNote,
      );
      const accepted = await acceptRequest(created.request.id);
      const submitted = await submitOutcome(
        requesterId,
        created.request.id,
        accepted.request.revision,
        outcomeCase.outcomeCode,
      );
      expect(submitted.request.latestOutcome).toMatchObject({
        revisionNumber: 1,
        agreedHelpType: outcomeCase.helpType,
        outcomeCode: outcomeCase.outcomeCode,
        status: "pending",
        confirmationMethod: null,
      });
      expect(
        new Date(submitted.request.latestOutcome!.dueAt).getTime() -
          new Date(submitted.request.latestOutcome!.submittedAt).getTime(),
      ).toBe(
        ALUMNI_HELP_OUTCOME_CONFIRMATION_HOURS *
          (MILLISECONDS_PER_DAY / 24),
      );
    }
    expect(await AlumniHelpOutcomeSubmission.countDocuments({})).toBe(7);
    expect(await service.actionRequiredCount(providerId.toString())).toEqual({
      helpActionRequiredCount: 7,
    });
    expect(JSON.stringify(await NotificationOutbox.find({}).lean())).not.toContain(
      privateNote,
    );
  });

  it("keeps denied revisions immutable, resets the resubmission deadline, and preserves closed retention", async () => {
    const requesterId = await insertUser("Resubmission");
    const created = await createRequest(requesterId, "formal_employee_referral");
    const accepted = await acceptRequest(created.request.id);
    const first = await submitOutcome(
      requesterId,
      created.request.id,
      accepted.request.revision,
      "interview_not_hired",
    );
    const firstOutcomeId = first.request.latestOutcome!.id;
    const denied = await service.decideOutcome({
      requestId: created.request.id,
      outcomeId: firstOutcomeId,
      expectedRevision: 0,
      decision: "deny",
      actor: actor(providerId),
      idempotencyKey: randomUUID(),
    });
    expect(denied.request.latestOutcome).toMatchObject({
      id: firstOutcomeId,
      status: "denied",
      outcomeCode: "interview_not_hired",
      revision: 1,
    });
    expect(await service.actionRequiredCount(requesterId.toString())).toEqual({
      helpActionRequiredCount: 1,
    });

    setNow(new Date(nowValue.getTime() + MILLISECONDS_PER_DAY));
    const resubmitted = await submitOutcome(
      requesterId,
      created.request.id,
      denied.request.revision,
      "hired_after_interview",
    );
    const latest = resubmitted.request.latestOutcome!;
    expect(latest).toMatchObject({
      revisionNumber: 2,
      previousSubmissionId: firstOutcomeId,
      status: "pending",
      outcomeCode: "hired_after_interview",
    });
    expect(new Date(latest.submittedAt)).toEqual(nowValue);
    expect(new Date(latest.dueAt).getTime()).toBe(
      nowValue.getTime() +
        ALUMNI_HELP_OUTCOME_CONFIRMATION_HOURS * (MILLISECONDS_PER_DAY / 24),
    );

    const closedAt = new Date(nowValue);
    const closed = await service.transition({
      requestId: created.request.id,
      action: "close",
      expectedRevision: resubmitted.request.revision,
      actor: actor(requesterId),
      idempotencyKey: randomUUID(),
    });
    const expectedPurgeAt = acceptedHelpRequestPurgeAt(
      closedAt,
      new Date(latest.dueAt),
    );
    expect(closed.request).toMatchObject({ status: "closed" });
    const archivedRoom = await Conversation.findById(
      closed.request.conversationId,
    )
      .lean()
      .orFail();
    const expectedRoomPurgeAt = conversationPurgeAt(closedAt, null);
    expect(archivedRoom).toMatchObject({
      status: "archived",
      lastSequence: 0,
      archivedAt: closedAt,
      purgeAt: expectedRoomPurgeAt,
    });
    const archivedMembers = await ConversationMember.find({
      conversationId: archivedRoom._id,
    })
      .sort({ _id: 1 })
      .lean();
    expect(archivedMembers).toHaveLength(2);
    for (const archivedMember of archivedMembers) {
      expect(archivedMember).toMatchObject({
        status: "history_only",
        unreadCount: 0,
        purgeAt: expectedRoomPurgeAt,
        accessWindows: [
          expect.objectContaining({
            visibleFromSequence: 1,
            visibleThroughSequence: 0,
            closedAt,
          }),
        ],
      });
    }
    const retainedOutcomes = await AlumniHelpOutcomeSubmission.find({
      helpRequestId: created.request.id,
    })
      .sort({ revisionNumber: 1 })
      .lean();
    expect(retainedOutcomes).toHaveLength(2);
    expect(retainedOutcomes.map((outcome) => outcome.purgeAt)).toEqual([
      expectedPurgeAt,
      expectedPurgeAt,
    ]);
    expect(retainedOutcomes[0]).toMatchObject({
      _id: new mongoose.Types.ObjectId(firstOutcomeId),
      outcomeCode: "interview_not_hired",
      status: "denied",
    });

    setNow(new Date(latest.dueAt));
    const worker = new AlumniOutcomeDeadlineService({
      now: () => new Date(nowValue),
      runtimeWritable: async () => true,
    });
    expect(
      await worker.runBounded(
        workerAuthorizationService.createRunContext(
          WORKER_SERVICE_KEYS.ALUMNI_OUTCOME,
          WORKER_RUN_TRIGGERS.RECOVERY,
        ),
      ),
    ).toMatchObject({ automaticallyConfirmed: 1, remainingOverdue: 0 });
    expect(await AlumniHelpRequest.findById(created.request.id).lean()).toMatchObject({
      status: "closed",
      latestOutcomeStatus: "confirmed",
      purgeAt: expectedPurgeAt,
    });
  });

  it("gives the exact deadline to the worker and resolves provider/worker races exactly once", async () => {
    const requesterId = await insertUser("Deadline");
    const created = await createRequest(requesterId, "career_advice");
    const accepted = await acceptRequest(created.request.id);
    const submitted = await submitOutcome(
      requesterId,
      created.request.id,
      accepted.request.revision,
      "completed",
    );
    const outcomeId = submitted.request.latestOutcome!.id;
    const dueAt = new Date(submitted.request.latestOutcome!.dueAt);
    setNow(dueAt);

    await expect(
      service.decideOutcome({
        requestId: created.request.id,
        outcomeId,
        expectedRevision: 0,
        decision: "confirm",
        actor: actor(providerId),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "ALUMNI_HELP_OUTCOME_DEADLINE_PASSED" });

    const deadlineService = new AlumniOutcomeDeadlineService({
      now: () => new Date(nowValue),
      runtimeWritable: async () => true,
    });
    const firstRun = await deadlineService.runBounded(
      workerAuthorizationService.createRunContext(
        WORKER_SERVICE_KEYS.ALUMNI_OUTCOME,
        WORKER_RUN_TRIGGERS.RECOVERY,
      ),
    );
    expect(firstRun).toMatchObject({
      candidatesScanned: 1,
      automaticallyConfirmed: 1,
      racedOrUnavailable: 0,
      remainingOverdue: 0,
      paused: false,
    });
    const automaticallyConfirmed = await AlumniHelpOutcomeSubmission.findById(
      outcomeId,
    );
    expect(automaticallyConfirmed).toMatchObject({
      status: "confirmed",
      confirmationMethod: "automatic_20_day",
      decidedBy: null,
      revision: 1,
    });
    expect(
      await deadlineService.runBounded(
        workerAuthorizationService.createRunContext(
          WORKER_SERVICE_KEYS.ALUMNI_OUTCOME,
          WORKER_RUN_TRIGGERS.RECOVERY,
        ),
      ),
    ).toMatchObject({ candidatesScanned: 0, automaticallyConfirmed: 0 });
    expect(
      await AuditLog.countDocuments({
        action: "alumni_help.outcome_auto_confirm",
        targetId: outcomeId,
      }),
    ).toBe(1);
    expect(
      await NotificationOutbox.countDocuments({
        "payload.eventType": "outcome_auto_confirm",
        "payload.outcomeSubmissionId": outcomeId,
      }),
    ).toBe(2);

    const raceRequesterId = await insertUser("Race");
    const raceCreated = await createRequest(raceRequesterId, "career_advice");
    const raceAccepted = await acceptRequest(raceCreated.request.id);
    const raceSubmitted = await submitOutcome(
      raceRequesterId,
      raceCreated.request.id,
      raceAccepted.request.revision,
      "completed",
    );
    const raceOutcomeId = raceSubmitted.request.latestOutcome!.id;
    const raceDueAt = new Date(raceSubmitted.request.latestOutcome!.dueAt);
    setNow(new Date(raceDueAt.getTime() - 1));
    const raceWorker = new AlumniOutcomeDeadlineService({
      now: () => new Date(raceDueAt),
      runtimeWritable: async () => true,
    });
    const [, raceWorkerResult] = await Promise.allSettled([
      service.decideOutcome({
        requestId: raceCreated.request.id,
        outcomeId: raceOutcomeId,
        expectedRevision: 0,
        decision: "confirm",
        actor: actor(providerId),
        idempotencyKey: randomUUID(),
      }),
      raceWorker.runBounded(
        workerAuthorizationService.createRunContext(
          WORKER_SERVICE_KEYS.ALUMNI_OUTCOME,
          WORKER_RUN_TRIGGERS.RECOVERY,
        ),
      ),
    ]);
    expect(raceWorkerResult.status).toBe("fulfilled");
    const raceOutcome = await AlumniHelpOutcomeSubmission.findById(
      raceOutcomeId,
    );
    expect(raceOutcome).toMatchObject({ status: "confirmed", revision: 1 });
    expect(["provider", "automatic_20_day"]).toContain(
      raceOutcome?.confirmationMethod,
    );
    expect(
      await AuditLog.countDocuments({
        action: {
          $in: [
            "alumni_help.outcome_confirm",
            "alumni_help.outcome_auto_confirm",
          ],
        },
        targetId: raceOutcomeId,
      }),
    ).toBe(1);
    expect(
      await NotificationOutbox.countDocuments({
        "payload.outcomeSubmissionId": raceOutcomeId,
        "payload.eventType": {
          $in: ["outcome_confirm", "outcome_auto_confirm"],
        },
      }),
    ).toBe(2);
  });
});
