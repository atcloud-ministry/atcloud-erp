import mongoose, { type ClientSession } from "mongoose";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import AuditLog from "../../../src/models/AuditLog";
import AlumniAffiliation from "../../../src/models/AlumniAffiliation";
import AlumniImportBatch from "../../../src/models/AlumniImportBatch";
import AlumniInvitation, {
  type IAlumniInvitation,
} from "../../../src/models/AlumniInvitation";
import AlumniProfile from "../../../src/models/AlumniProfile";
import IdempotencyRecord from "../../../src/models/IdempotencyRecord";
import NotificationOutbox from "../../../src/models/NotificationOutbox";
import User from "../../../src/models/User";
import {
  AlumniInvitationService,
  type AlumniFlowActor,
  type ApprovedRosterAffiliation,
} from "../../../src/services/alumni/AlumniInvitationService";
import {
  deriveAlumniInvitationToken,
  hashAlumniInvitationToken,
} from "../../../src/services/alumni/AlumniInvitationSecurity";
import { MongoTransactionService } from "../../../src/services/reliability/MongoTransactionService";
import { ensureIntegrationDB } from "../setup/connect";

const CONTACT_KEY = Buffer.alloc(32, 0x31).toString("base64url");
const TOKEN_KEY = Buffer.alloc(32, 0x72).toString("base64url");
const PRIVATE_INVITATION_FIELDS = [
  "+contactEmail",
  "+contactFirstName",
  "+contactLastName",
  "+contactLookupHash",
  "+activeContactLookupHash",
  "+matchedUserId",
  "+claimedByUserId",
  "+tokenHash",
].join(" ");

const previousSecurityEnvironment = {
  contactKey: process.env.ALUMNI_CONTACT_LOOKUP_KEY_V1,
  tokenKey: process.env.ALUMNI_INVITATION_TOKEN_KEY_V1,
};

const collections = [
  AuditLog,
  AlumniAffiliation,
  AlumniImportBatch,
  AlumniInvitation,
  AlumniProfile,
  IdempotencyRecord,
  NotificationOutbox,
  User,
] as const;

let nowValue: Date;
let service: AlumniInvitationService;
let transactions: MongoTransactionService;
let actor: AlumniFlowActor;

function restoreEnvironment(
  name: "ALUMNI_CONTACT_LOOKUP_KEY_V1" | "ALUMNI_INVITATION_TOKEN_KEY_V1",
  value: string | undefined,
) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function setNow(value: string): void {
  nowValue = new Date(value);
}

function advanceNow(milliseconds: number): void {
  nowValue = new Date(nowValue.getTime() + milliseconds);
}

async function runInTransaction<T>(
  operation: (session: ClientSession) => Promise<T>,
): Promise<T> {
  return transactions.run((session) => operation(session));
}

async function insertUser(input: {
  readonly email: string;
  readonly active?: boolean;
  readonly verified?: boolean;
}): Promise<mongoose.Types.ObjectId> {
  const id = new mongoose.Types.ObjectId();
  const username = `u${id.toString().slice(-12)}`;
  await User.collection.insertOne({
    _id: id,
    username,
    usernameLower: username,
    email: input.email.toLowerCase(),
    password: "integration-test-only",
    isAtCloudLeader: false,
    role: "Participant",
    isActive: input.active ?? true,
    isVerified: input.verified ?? true,
    emailNotifications: true,
    loginAttempts: 0,
    hasReceivedWelcomeMessage: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

function affiliation(
  overrides: Partial<ApprovedRosterAffiliation> = {},
): ApprovedRosterAffiliation {
  return {
    programName: "EMBA Mentor Circles",
    cohortLabel: "2026",
    sourceImportBatchId: new mongoose.Types.ObjectId(),
    sourceRowNumber: 2,
    reviewedAt: new Date(nowValue.getTime() - 60_000),
    reviewedBy: new mongoose.Types.ObjectId(actor.id),
    ...overrides,
  };
}

async function issue(input: {
  readonly email: string;
  readonly matchedUserId?: mongoose.Types.ObjectId;
  readonly affiliations?: readonly ApprovedRosterAffiliation[];
  readonly issueActor?: AlumniFlowActor;
}) {
  return runInTransaction((session) =>
    service.issueForApprovedRoster({
      contactEmail: input.email,
      contactFirstName: "Amy",
      contactLastName: "Chen",
      ...(input.matchedUserId ? { matchedUserId: input.matchedUserId } : {}),
      affiliations: input.affiliations ?? [affiliation()],
      actor: input.issueActor ?? actor,
      correlationId: "m2-02-integration",
      session,
    }),
  );
}

async function loadPrivateInvitation(
  invitationId: string,
): Promise<IAlumniInvitation> {
  const invitation = await AlumniInvitation.findById(invitationId).select(
    PRIVATE_INVITATION_FIELDS,
  );
  expect(invitation).not.toBeNull();
  return invitation!;
}

function bearerFor(invitation: IAlumniInvitation): string {
  return deriveAlumniInvitationToken({
    invitationId: String(invitation._id),
    issueCount: invitation.issueCount,
    issuedAt: invitation.issuedAt,
    tokenVersion: invitation.tokenVersion,
  });
}

async function expectInvitationUnavailable(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({
    code: "ALUMNI_INVITATION_UNAVAILABLE",
    httpStatus: 404,
    message: "The alumni invitation is unavailable.",
  });
}

describe("M2-02 alumni invitation issue, reissue, and claim", () => {
  beforeAll(async () => {
    process.env.ALUMNI_CONTACT_LOOKUP_KEY_V1 = CONTACT_KEY;
    process.env.ALUMNI_INVITATION_TOKEN_KEY_V1 = TOKEN_KEY;
    await ensureIntegrationDB();
    await Promise.all(collections.map((model) => model.init()));
    const capability = await new MongoTransactionService(
      mongoose.connection,
    ).assertTopologyCapability(true);
    expect(capability.supported).toBe(true);
  });

  beforeEach(async () => {
    await Promise.all(collections.map((model) => model.deleteMany({})));
    setNow("2031-09-01T12:00:00.000Z");
    transactions = new MongoTransactionService(mongoose.connection);
    service = new AlumniInvitationService({ now: () => new Date(nowValue) });
    actor = {
      id: new mongoose.Types.ObjectId().toString(),
      role: "Administrator",
    };
  });

  afterAll(async () => {
    await Promise.all(collections.map((model) => model.deleteMany({})));
    restoreEnvironment(
      "ALUMNI_CONTACT_LOOKUP_KEY_V1",
      previousSecurityEnvironment.contactKey,
    );
    restoreEnvironment(
      "ALUMNI_INVITATION_TOKEN_KEY_V1",
      previousSecurityEnvironment.tokenKey,
    );
  });

  it("issues matched and unmatched invitations, merges affiliations, and keeps outbox payloads opaque", async () => {
    const matchedUserId = await insertUser({ email: "matched@example.org" });
    const matched = await issue({
      email: " Matched@Example.org ",
      matchedUserId,
    });
    const unmatchedFirstAffiliation = affiliation({
      programName: "EMBA",
      cohortLabel: "2025",
      sourceRowNumber: 3,
    });
    const unmatched = await issue({
      email: "unmatched@example.org",
      affiliations: [unmatchedFirstAffiliation],
    });

    advanceNow(1_000);
    const secondSourceBatchId = new mongoose.Types.ObjectId();
    const merged = await issue({
      email: "UNMATCHED@example.org",
      affiliations: [
        affiliation({
          programName: "Leadership Program",
          cohortLabel: "2026",
          sourceImportBatchId: secondSourceBatchId,
          sourceRowNumber: 4,
        }),
      ],
    });

    expect(matched).toMatchObject({ created: true, issueCount: 1 });
    expect(unmatched).toMatchObject({ created: true, issueCount: 1 });
    expect(merged).toMatchObject({
      invitationId: unmatched.invitationId,
      created: false,
      issueCount: 2,
    });

    const matchedDocument = await loadPrivateInvitation(matched.invitationId);
    const unmatchedDocument = await loadPrivateInvitation(
      unmatched.invitationId,
    );
    expect(matchedDocument.matchedUserId?.toString()).toBe(
      matchedUserId.toString(),
    );
    expect(unmatchedDocument.matchedUserId).toBeUndefined();
    expect(unmatchedDocument.affiliations).toHaveLength(2);
    expect(unmatchedDocument.sourceImportBatchIds.map(String)).toEqual(
      expect.arrayContaining([
        unmatchedFirstAffiliation.sourceImportBatchId.toString(),
        secondSourceBatchId.toString(),
      ]),
    );

    const outbox = await NotificationOutbox.find({})
      .sort({ createdAt: 1 })
      .lean();
    expect(outbox).toHaveLength(3);
    for (const event of outbox) {
      expect(event.topic).toBe("alumni.invitation.email");
      expect(Object.keys(event.payload).sort()).toEqual([
        "invitationId",
        "issueCount",
      ]);
      expect(event.payload).not.toHaveProperty("token");
      expect(event.payload).not.toHaveProperty("tokenHash");
      expect(event.payload).not.toHaveProperty("contactEmail");
    }
    const serializedOutbox = JSON.stringify(outbox);
    expect(serializedOutbox).not.toContain("matched@example.org");
    expect(serializedOutbox).not.toContain("unmatched@example.org");
    expect(serializedOutbox).not.toContain(bearerFor(unmatchedDocument));
  });

  it("maps active invitation affiliation and source-batch capacity overflow to 409", async () => {
    const sharedBatchId = new mongoose.Types.ObjectId();
    const affiliationFull = await issue({
      email: "affiliation-cap@example.org",
      affiliations: Array.from({ length: 50 }, (_, index) =>
        affiliation({
          programName: `Program ${index + 1}`,
          sourceImportBatchId: sharedBatchId,
          sourceRowNumber: index + 2,
        }),
      ),
    });
    await expect(
      issue({
        email: "affiliation-cap@example.org",
        affiliations: [
          affiliation({ programName: "Program 51", sourceRowNumber: 52 }),
        ],
      }),
    ).rejects.toMatchObject({
      code: "ALUMNI_IMPORT_APPLICATION_CONFLICT",
      httpStatus: 409,
    });

    const sourceAffiliations = Array.from({ length: 50 }, (_, index) =>
      affiliation({
        programName: `Source Program ${index + 1}`,
        sourceImportBatchId: new mongoose.Types.ObjectId(),
        sourceRowNumber: index + 2,
      }),
    );
    const sourceFull = await issue({
      email: "source-cap@example.org",
      affiliations: sourceAffiliations,
    });
    await expect(
      issue({
        email: "source-cap@example.org",
        affiliations: [
          affiliation({
            programName: sourceAffiliations[0]!.programName,
            cohortLabel: sourceAffiliations[0]!.cohortLabel,
            sourceImportBatchId: new mongoose.Types.ObjectId(),
            sourceRowNumber: 100,
          }),
        ],
      }),
    ).rejects.toMatchObject({
      code: "ALUMNI_IMPORT_APPLICATION_CONFLICT",
      httpStatus: 409,
    });

    expect((await loadPrivateInvitation(affiliationFull.invitationId))).toMatchObject({
      issueCount: 1,
      revision: 0,
    });
    expect((await loadPrivateInvitation(sourceFull.invitationId))).toMatchObject({
      issueCount: 1,
      revision: 0,
    });
    expect(await NotificationOutbox.countDocuments({})).toBe(2);
  });

  it("rejects a stale matched disposition but permits unmatched-to-matched upgrade", async () => {
    const matchedUserId = await insertUser({ email: "person@example.org" });
    const first = await issue({
      email: "person@example.org",
      matchedUserId,
    });

    await expect(
      issue({ email: "person@example.org" }),
    ).rejects.toMatchObject({
      code: "ALUMNI_IMPORT_APPLICATION_CONFLICT",
      httpStatus: 409,
    });
    expect((await loadPrivateInvitation(first.invitationId)).issueCount).toBe(1);
    expect(await NotificationOutbox.countDocuments({})).toBe(1);

    const upgradeUserId = await insertUser({ email: "upgrade@example.org" });
    const unmatched = await issue({ email: "upgrade@example.org" });
    advanceNow(1_000);
    const upgraded = await issue({
      email: "upgrade@example.org",
      matchedUserId: upgradeUserId,
    });
    expect(upgraded).toMatchObject({
      invitationId: unmatched.invitationId,
      issueCount: 2,
      created: false,
    });
    expect(
      (await loadPrivateInvitation(upgraded.invitationId)).matchedUserId?.toString(),
    ).toBe(upgradeUserId.toString());
  });

  it("reissues once, replays idempotently, and fences the prior bearer", async () => {
    const claimantId = await insertUser({ email: "rotate@example.org" });
    const issued = await issue({ email: "rotate@example.org" });
    const before = await loadPrivateInvitation(issued.invitationId);
    const oldBearer = bearerFor(before);
    expect(hashAlumniInvitationToken(oldBearer)).toBe(before.tokenHash);

    advanceNow(24 * 60 * 60 * 1_000);
    const reissueInput = {
      invitationId: issued.invitationId,
      expectedRevision: 0,
      actor,
      idempotencyKey: "10000000-0000-4000-8000-000000000001",
      correlationId: "reissue-integration",
    } as const;
    const first = await service.reissue(reissueInput);
    advanceNow(60_000);
    const replay = await service.reissue(reissueInput);

    expect(first).toMatchObject({
      replayed: false,
      invitationId: issued.invitationId,
      issueCount: 2,
      revision: 1,
      status: "active",
    });
    expect(replay).toEqual({ ...first, replayed: true });
    const after = await loadPrivateInvitation(issued.invitationId);
    const newBearer = bearerFor(after);
    expect(newBearer).not.toBe(oldBearer);
    expect(after.tokenHash).toBe(hashAlumniInvitationToken(newBearer));
    expect(await NotificationOutbox.countDocuments({})).toBe(2);
    expect(await IdempotencyRecord.countDocuments({})).toBe(1);

    await expect(
      service.reissue({
        ...reissueInput,
        idempotencyKey: "10000000-0000-4000-8000-000000000003",
      }),
    ).rejects.toMatchObject({
      code: "ALUMNI_INVITATION_REVISION_CONFLICT",
      httpStatus: 409,
    });
    expect(await NotificationOutbox.countDocuments({})).toBe(2);

    await expectInvitationUnavailable(
      service.claim({
        token: oldBearer,
        actor: { id: claimantId.toString(), role: "Participant" },
        idempotencyKey: "10000000-0000-4000-8000-000000000002",
      }),
    );
    expect((await loadPrivateInvitation(issued.invitationId)).status).toBe(
      "active",
    );
    expect(await AlumniProfile.countDocuments({})).toBe(0);
  });

  it("rejects reissue exactly at contact expiry without mutating delivery state", async () => {
    const issued = await issue({ email: "expired-reissue@example.org" });
    const invitation = await loadPrivateInvitation(issued.invitationId);
    setNow(invitation.contactPurgeAt.toISOString());

    await expectInvitationUnavailable(
      service.reissue({
        invitationId: issued.invitationId,
        expectedRevision: invitation.revision,
        actor,
        idempotencyKey: "10000000-0000-4000-8000-000000000004",
      }),
    );

    const unchanged = await loadPrivateInvitation(issued.invitationId);
    expect(unchanged).toMatchObject({
      status: "active",
      revision: invitation.revision,
      issueCount: invitation.issueCount,
    });
    expect(await NotificationOutbox.countDocuments({})).toBe(1);
    expect(await IdempotencyRecord.countDocuments({})).toBe(0);
  });

  it("purges a due active contact before creating a replacement invitation", async () => {
    const first = await issue({ email: "expired-issue@example.org" });
    const before = await loadPrivateInvitation(first.invitationId);
    setNow(before.contactPurgeAt.toISOString());

    const replacement = await issue({
      email: "expired-issue@example.org",
      affiliations: [affiliation({ sourceRowNumber: 3 })],
    });

    expect(replacement).toMatchObject({ created: true, issueCount: 1 });
    expect(replacement.invitationId).not.toBe(first.invitationId);
    const expired = await loadPrivateInvitation(first.invitationId);
    expect(expired).toMatchObject({
      status: "invalidated",
      contactPurgedAt: nowValue,
      revision: 1,
    });
    expect(expired.contactEmail).toBeUndefined();
    expect(expired.contactLookupHash).toBeUndefined();
    expect(expired.activeContactLookupHash).toBeUndefined();
    expect(expired.tokenHash).toBeUndefined();
    expect(await NotificationOutbox.countDocuments({})).toBe(2);
    expect(
      await AuditLog.countDocuments({
        action: "alumni_invitation.contact_retention_purged",
        targetId: first.invitationId,
      }),
    ).toBe(1);
  });

  it("enforces unmatched claim email identity and current active/verified state", async () => {
    const claimantId = await insertUser({
      email: "claimant@example.org",
      active: false,
      verified: true,
    });
    const wrongUserId = await insertUser({ email: "wrong@example.org" });
    const issued = await issue({ email: "claimant@example.org" });
    const bearer = bearerFor(await loadPrivateInvitation(issued.invitationId));

    await expectInvitationUnavailable(
      service.claim({
        token: bearer,
        actor: { id: wrongUserId.toString(), role: "Participant" },
        idempotencyKey: "20000000-0000-4000-8000-000000000001",
      }),
    );
    await expectInvitationUnavailable(
      service.claim({
        token: bearer,
        actor: { id: claimantId.toString(), role: "Participant" },
        idempotencyKey: "20000000-0000-4000-8000-000000000002",
      }),
    );

    await User.updateOne(
      { _id: claimantId },
      { $set: { isActive: true, isVerified: false } },
    );
    await expectInvitationUnavailable(
      service.claim({
        token: bearer,
        actor: { id: claimantId.toString(), role: "Participant" },
        idempotencyKey: "20000000-0000-4000-8000-000000000003",
      }),
    );
    expect(await AlumniProfile.countDocuments({})).toBe(0);

    await User.updateOne(
      { _id: claimantId },
      { $set: { isVerified: true } },
    );
    const result = await service.claim({
      token: bearer,
      actor: { id: claimantId.toString(), role: "Participant" },
      idempotencyKey: "20000000-0000-4000-8000-000000000004",
    });
    expect(result).toMatchObject({
      replayed: false,
      invitationId: issued.invitationId,
      status: "claimed",
    });
  });

  it("uses matched-user identity, creates a draft profile, and preserves verified review provenance", async () => {
    const matchedUserId = await insertUser({ email: "account@example.org" });
    const contactEmailUserId = await insertUser({
      email: "roster-contact@example.org",
    });
    const sourceBatchId = new mongoose.Types.ObjectId();
    const reviewerId = new mongoose.Types.ObjectId(actor.id);
    const reviewedAt = new Date(nowValue.getTime() - 120_000);
    const programId = new mongoose.Types.ObjectId();
    const issued = await issue({
      email: "roster-contact@example.org",
      matchedUserId,
      affiliations: [
        affiliation({
          programId,
          programName: "Executive Leadership",
          cohortLabel: "2030",
          sourceImportBatchId: sourceBatchId,
          sourceRowNumber: 17,
          reviewedAt,
          reviewedBy: reviewerId,
        }),
      ],
    });
    const bearer = bearerFor(await loadPrivateInvitation(issued.invitationId));

    await expectInvitationUnavailable(
      service.claim({
        token: bearer,
        actor: { id: contactEmailUserId.toString(), role: "Participant" },
        idempotencyKey: "30000000-0000-4000-8000-000000000001",
      }),
    );
    const claimInput = {
      token: bearer,
      actor: { id: matchedUserId.toString(), role: "Participant" },
      idempotencyKey: "30000000-0000-4000-8000-000000000002",
      correlationId: "claim-integration",
    } as const;
    const claimed = await service.claim(claimInput);
    const replay = await service.claim(claimInput);

    expect(claimed).toMatchObject({
      replayed: false,
      invitationId: issued.invitationId,
      status: "claimed",
    });
    expect(replay).toEqual({ ...claimed, replayed: true });
    const profile = await AlumniProfile.findOne({ userId: matchedUserId }).lean();
    expect(profile).toMatchObject({
      publishStatus: "draft",
      helpOfferings: {
        careerAdvice: false,
        warmIntroduction: false,
        formalEmployeeReferral: false,
      },
    });
    expect(String(profile?._id)).toBe(claimed.alumniProfileId);

    const verified = await AlumniAffiliation.findOne({
      alumniProfileId: profile?._id,
    })
      .select("+programAffiliationKey")
      .lean();
    expect(verified).toMatchObject({
      programId,
      programName: "Executive Leadership",
      cohortLabel: "2030",
      verificationStatus: "verified",
      reviewedAt,
      reviewedBy: reviewerId,
      sourceImportBatchId: sourceBatchId,
      sourceRowNumber: 17,
    });
    expect(claimed.affiliationIds).toEqual([String(verified?._id)]);

    const invitation = await loadPrivateInvitation(issued.invitationId);
    expect(invitation.status).toBe("claimed");
    expect(invitation.claimedByUserId?.toString()).toBe(matchedUserId.toString());
    expect(invitation.claimedAt?.toISOString()).toBe(claimed.claimedAt);
    expect(invitation.contactPurgedAt?.toISOString()).toBe(claimed.claimedAt);
    expect(invitation.contactEmail).toBeUndefined();
    expect(invitation.contactLookupHash).toBeUndefined();
    expect(invitation.activeContactLookupHash).toBeUndefined();
    expect(invitation.matchedUserId).toBeUndefined();
    expect(invitation.tokenHash).toBeUndefined();

    expect(
      await AuditLog.countDocuments({ action: "alumni_invitation.claimed" }),
    ).toBe(1);
    expect(await AlumniProfile.countDocuments({})).toBe(1);
    expect(await AlumniAffiliation.countDocuments({})).toBe(1);
  });

  it("claims same-title affiliations for distinct canonical Programs", async () => {
    const claimantId = await insertUser({ email: "two-programs@example.org" });
    const firstProgramId = new mongoose.Types.ObjectId();
    const secondProgramId = new mongoose.Types.ObjectId();
    const issued = await issue({
      email: "two-programs@example.org",
      affiliations: [
        affiliation({
          programId: firstProgramId,
          programName: "Shared Program Title",
          cohortLabel: "2030",
          sourceRowNumber: 2,
        }),
        affiliation({
          programId: secondProgramId,
          programName: "Shared Program Title",
          cohortLabel: "2030",
          sourceRowNumber: 3,
        }),
        affiliation({
          programName: "Shared Program Title",
          cohortLabel: "2030",
          sourceRowNumber: 4,
        }),
      ],
    });
    const bearer = bearerFor(await loadPrivateInvitation(issued.invitationId));

    const claimed = await service.claim({
      token: bearer,
      actor: { id: claimantId.toString(), role: "Participant" },
      idempotencyKey: "30000000-0000-4000-8000-000000000003",
    });

    expect(claimed.affiliationIds).toHaveLength(3);
    const affiliations = await AlumniAffiliation.find({
      alumniProfileId: claimed.alumniProfileId,
    })
      .select("+programAffiliationKey")
      .sort({ programId: 1 })
      .lean();
    expect(affiliations).toHaveLength(3);
    expect(
      affiliations
        .filter((value) => value.programId)
        .map((value) => String(value.programId)),
    ).toEqual(
      expect.arrayContaining([
        firstProgramId.toString(),
        secondProgramId.toString(),
      ]),
    );
    expect(affiliations.filter((value) => !value.programId)).toHaveLength(1);
    expect(
      new Set(
        affiliations
          .map((value) => value.programAffiliationKey)
          .filter(Boolean),
      ).size,
    ).toBe(
      2,
    );
  });

  it("allows only one concurrent claim and replays the winning request", async () => {
    const claimantId = await insertUser({ email: "concurrent@example.org" });
    const issued = await issue({ email: "concurrent@example.org" });
    const bearer = bearerFor(await loadPrivateInvitation(issued.invitationId));
    const inputs = [
      {
        token: bearer,
        actor: { id: claimantId.toString(), role: "Participant" },
        idempotencyKey: "40000000-0000-4000-8000-000000000001",
      },
      {
        token: bearer,
        actor: { id: claimantId.toString(), role: "Participant" },
        idempotencyKey: "40000000-0000-4000-8000-000000000002",
      },
    ] as const;

    const outcomes = await Promise.allSettled(inputs.map((input) => service.claim(input)));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const loser = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    expect(loser?.reason).toMatchObject({
      code: "ALUMNI_INVITATION_UNAVAILABLE",
    });
    const winnerIndex = outcomes.findIndex(
      (outcome) => outcome.status === "fulfilled",
    );
    expect(winnerIndex).toBeGreaterThanOrEqual(0);
    const replay = await service.claim(inputs[winnerIndex]!);
    expect(replay.replayed).toBe(true);

    expect(await AlumniProfile.countDocuments({ userId: claimantId })).toBe(1);
    expect(await AlumniAffiliation.countDocuments({})).toBe(1);
    expect(
      await AuditLog.countDocuments({ action: "alumni_invitation.claimed" }),
    ).toBe(1);
    expect(
      await IdempotencyRecord.countDocuments({
        scope: "alumni.invitation.claim",
        state: "completed",
      }),
    ).toBe(1);
  });

  it("claims two distinct matched invitations concurrently for one user", async () => {
    const claimantId = await insertUser({ email: "shared-user@example.org" });
    const sharedProgramId = new mongoose.Types.ObjectId();
    const first = await issue({
      email: "first-contact@example.org",
      matchedUserId: claimantId,
      affiliations: [
        affiliation({
          programId: sharedProgramId,
          sourceImportBatchId: new mongoose.Types.ObjectId(),
          sourceRowNumber: 2,
        }),
      ],
    });
    const second = await issue({
      email: "second-contact@example.org",
      matchedUserId: claimantId,
      affiliations: [
        affiliation({
          programId: sharedProgramId,
          sourceImportBatchId: new mongoose.Types.ObjectId(),
          sourceRowNumber: 3,
        }),
      ],
    });
    const firstBearer = bearerFor(
      await loadPrivateInvitation(first.invitationId),
    );
    const secondBearer = bearerFor(
      await loadPrivateInvitation(second.invitationId),
    );

    const results = await Promise.all([
      service.claim({
        token: firstBearer,
        actor: { id: claimantId.toString(), role: "Participant" },
        idempotencyKey: "40000000-0000-4000-8000-000000000003",
      }),
      service.claim({
        token: secondBearer,
        actor: { id: claimantId.toString(), role: "Participant" },
        idempotencyKey: "40000000-0000-4000-8000-000000000004",
      }),
    ]);

    expect(results).toHaveLength(2);
    expect(new Set(results.map((result) => result.alumniProfileId)).size).toBe(
      1,
    );
    expect(new Set(results.flatMap((result) => result.affiliationIds)).size).toBe(
      1,
    );
    expect(await AlumniProfile.countDocuments({ userId: claimantId })).toBe(1);
    expect(await AlumniAffiliation.countDocuments({})).toBe(1);
    expect(
      await AlumniInvitation.countDocuments({ status: "claimed" }),
    ).toBe(2);
  });

  it("lists invitations by batch and status while hiding logically expired contact", async () => {
    const targetBatchId = new mongoose.Types.ObjectId();
    const otherBatchId = new mongoose.Types.ObjectId();
    await issue({
      email: "expired-contact@example.org",
      affiliations: [affiliation({ sourceImportBatchId: targetBatchId })],
    });

    setNow("2032-03-02T12:00:00.000Z");
    const current = await issue({
      email: "current-contact@example.org",
      affiliations: [
        affiliation({
          sourceImportBatchId: targetBatchId,
          sourceRowNumber: 3,
        }),
      ],
    });
    await issue({
      email: "other-batch@example.org",
      affiliations: [affiliation({ sourceImportBatchId: otherBatchId })],
    });

    const result = await service.listInvitations({
      page: 1,
      limit: 10,
      status: "active",
      batchId: targetBatchId.toString(),
    });

    expect(result.pagination).toEqual({
      currentPage: 1,
      totalPages: 1,
      hasNext: false,
      hasPrev: false,
      totalInvitations: 2,
    });
    expect(result.invitations).toHaveLength(2);
    expect(result.invitations[0]).toMatchObject({
      id: current.invitationId,
      contactEmail: "current-contact@example.org",
      contactFirstName: "Amy",
      contactLastName: "Chen",
      status: "active",
    });
    expect(result.invitations[1]).toMatchObject({
      contactEmail: null,
      contactFirstName: null,
      contactLastName: null,
      status: "active",
    });
    expect(JSON.stringify(result)).not.toContain("tokenHash");
    expect(JSON.stringify(result)).not.toContain("sourceImportBatchIds");
  });

  it("rolls back invitation, profile, affiliation, audit, outbox, and receipt on a late audit failure", async () => {
    await expect(
      issue({
        email: "failed-issue@example.org",
        issueActor: { id: actor.id, role: "invalid/role" },
      }),
    ).rejects.toThrow("Invalid audit actor role.");
    expect(await AlumniInvitation.countDocuments({})).toBe(0);
    expect(await NotificationOutbox.countDocuments({})).toBe(0);
    expect(await AuditLog.countDocuments({})).toBe(0);

    const claimantId = await insertUser({ email: "rollback@example.org" });
    const issued = await issue({ email: "rollback@example.org" });
    const before = await loadPrivateInvitation(issued.invitationId);
    const bearer = bearerFor(before);
    const issuedAuditCount = await AuditLog.countDocuments({});
    const outboxCount = await NotificationOutbox.countDocuments({});

    await expect(
      service.claim({
        token: bearer,
        actor: { id: claimantId.toString(), role: "invalid/role" },
        idempotencyKey: "50000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toThrow("Invalid audit actor role.");

    const after = await loadPrivateInvitation(issued.invitationId);
    expect(after.status).toBe("active");
    expect(after.revision).toBe(before.revision);
    expect(after.tokenHash).toBe(before.tokenHash);
    expect(after.contactEmail).toBe("rollback@example.org");
    expect(await AlumniProfile.countDocuments({})).toBe(0);
    expect(await AlumniAffiliation.countDocuments({})).toBe(0);
    expect(await IdempotencyRecord.countDocuments({})).toBe(0);
    expect(await AuditLog.countDocuments({})).toBe(issuedAuditCount);
    expect(await NotificationOutbox.countDocuments({})).toBe(outboxCount);
  });
});
