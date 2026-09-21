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
  ALUMNI_PROFILE_PUBLICATION_CONSENT,
  ALUMNI_PROFILE_PUBLICATION_CONSENT_REGISTRY,
} from "../../../src/config/alumniProfilePublicationConsent";
import { addUtcCalendarMonths } from "../../../src/contracts/alumniDirectoryData";
import AuditLog from "../../../src/models/AuditLog";
import AlumniAffiliation from "../../../src/models/AlumniAffiliation";
import AlumniProfile from "../../../src/models/AlumniProfile";
import ConsentRecord from "../../../src/models/ConsentRecord";
import IdempotencyRecord from "../../../src/models/IdempotencyRecord";
import User from "../../../src/models/User";
import {
  synchronizeExistingAlumniProfileProjection,
} from "../../../src/services/alumni/AlumniProfileProjectionSyncService";
import { AlumniProfileService } from "../../../src/services/alumni/AlumniProfileService";
import { MongoTransactionService } from "../../../src/services/reliability/MongoTransactionService";
import { ensureIntegrationDB } from "../setup/connect";

const collections = [
  AuditLog,
  AlumniAffiliation,
  AlumniProfile,
  ConsentRecord,
  IdempotencyRecord,
  User,
] as const;

let nowValue: Date;
let service: AlumniProfileService;

function setNow(value: string): void {
  nowValue = new Date(value);
}

function actor(userId: mongoose.Types.ObjectId) {
  return { id: userId.toString(), role: "Participant" } as const;
}

async function createUser(complete = true): Promise<mongoose.Types.ObjectId> {
  const id = new mongoose.Types.ObjectId();
  const username = `u${id.toString().slice(-12)}`;
  await User.collection.insertOne({
    _id: id,
    username,
    usernameLower: username,
    email: `${username}@example.org`,
    password: "integration-test-only",
    firstName: "Élodie",
    lastName: "Nguyễn",
    avatar: "https://example.org/avatar.png",
    isAtCloudLeader: false,
    role: "Participant",
    isActive: true,
    isVerified: true,
    emailNotifications: true,
    loginAttempts: 0,
    hasReceivedWelcomeMessage: false,
    ...(complete
      ? {
          phone: "+12065550101",
          birthYear: 1988,
          residenceCity: "Seattle",
          residenceRegion: "US-WA",
          residenceCountryCode: "US",
          employmentStatus: "employed",
          company: "Café Cloud",
          occupation: "Product Manager",
        }
      : {
          residenceCity: "Seattle",
          residenceRegion: "US-WA",
          residenceCountryCode: "US",
          employmentStatus: "employed",
          company: "Café Cloud",
          occupation: "Product Manager",
        }),
    createdAt: nowValue,
    updatedAt: nowValue,
  });
  return id;
}

async function createProfileFixture(input: {
  readonly complete?: boolean;
  readonly withVerifiedAffiliation?: boolean;
  readonly withPendingAffiliation?: boolean;
} = {}) {
  const userId = await createUser(input.complete ?? true);
  const profile = await AlumniProfile.create({
    userId,
    publishStatus: "draft",
    helpOfferings: {
      careerAdvice: false,
      warmIntroduction: false,
      formalEmployeeReferral: false,
    },
    searchProjection: {},
    revision: 0,
  });
  const profileObjectId = new mongoose.Types.ObjectId(String(profile._id));

  if (input.withVerifiedAffiliation ?? true) {
    await AlumniAffiliation.create({
      alumniProfileId: profileObjectId,
      programName: "EMBA Mentor Circles",
      cohortLabel: "2026",
      verificationStatus: "verified",
      reviewedAt: nowValue,
      reviewedBy: userId,
      revision: 0,
    });
  }
  if (input.withPendingAffiliation) {
    await AlumniAffiliation.create({
      alumniProfileId: profileObjectId,
      programName: "Pending Leadership Program",
      cohortLabel: "2030",
      verificationStatus: "pending_review",
      revision: 0,
    });
  }
  return { userId, profileId: profileObjectId };
}

describe("M2-03 alumni profile lifecycle", () => {
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
    setNow("2031-09-01T12:00:00.000Z");
    service = new AlumniProfileService({ now: () => new Date(nowValue) });
  });

  afterAll(async () => {
    await Promise.all(collections.map((model) => model.deleteMany({})));
  });

  it("returns exact owner and preview DTOs with verified affiliations only", async () => {
    const { userId, profileId } = await createProfileFixture({
      withPendingAffiliation: true,
    });

    const own = await service.getOwn(userId.toString());
    const preview = await service.previewOwn(userId.toString());

    expect(own).toMatchObject({
      id: profileId.toString(),
      displayName: "Élodie Nguyễn",
      company: "Café Cloud",
      occupation: "Product Manager",
      generalLocation: "Seattle",
      publishStatus: "draft",
      consentVersion: null,
      hasCurrentPublicationConsent: false,
      publishReadiness: { ready: true, issues: [] },
      revision: 0,
    });
    expect(own.affiliations).toHaveLength(1);
    expect(own.affiliations[0]).toMatchObject({
      programName: "EMBA Mentor Circles",
      cohortLabel: "2026",
    });
    expect(own).not.toHaveProperty("email");
    expect(own).not.toHaveProperty("phone");
    expect(own).not.toHaveProperty("birthYear");
    expect(Object.keys(preview).sort()).toEqual(
      [
        "affiliations",
        "avatar",
        "bio",
        "company",
        "displayName",
        "generalLocation",
        "helpOfferings",
        "id",
        "industry",
        "occupation",
        "professionalHeadline",
        "skills",
      ].sort(),
    );
    const serialized = JSON.stringify({ own, preview });
    expect(serialized).not.toContain("+12065550101");
    expect(serialized).not.toContain("birthYear");
    expect(serialized).not.toContain("pending_review");
    expect(serialized).not.toContain("Pending Leadership Program");
    expect(serialized).not.toContain("searchProjection");
    expect(serialized).not.toContain("documentHash");
  });

  it("updates with CAS, rebuilds search projection, audits, and replays once", async () => {
    const { userId, profileId } = await createProfileFixture();
    const input = {
      expectedRevision: 0,
      professionalHeadline: "Product Leader",
      industry: "Technology",
      skills: ["Product Strategy", "Mentoring"],
      bio: "private biography value",
      helpOfferings: {
        careerAdvice: true,
        warmIntroduction: true,
        formalEmployeeReferral: false,
      },
      actor: actor(userId),
      idempotencyKey: "10000000-0000-4000-8000-000000000001",
      correlationId: "m2-03-update",
    } as const;

    const updated = await service.updateOwn(input);
    const replay = await service.updateOwn(input);

    expect(updated).toEqual({
      replayed: false,
      profileId: profileId.toString(),
      publishStatus: "draft",
      revision: 1,
    });
    expect(replay).toEqual({ ...updated, replayed: true });
    const stored = await AlumniProfile.findById(profileId)
      .select("+searchProjection")
      .lean();
    expect(stored).toMatchObject({
      professionalHeadline: "Product Leader",
      industry: "Technology",
      skills: ["Product Strategy", "Mentoring"],
      bio: "private biography value",
      helpOfferings: {
        careerAdvice: true,
        warmIntroduction: true,
        formalEmployeeReferral: false,
      },
      revision: 1,
      searchProjection: {
        displayNameKey: "elodie nguyen",
        companyKey: "cafe cloud",
        generalLocationKey: "seattle",
        cohortKeys: [
          "emba mentor circles",
          "2026",
          "emba mentor circles 2026",
        ],
      },
    });
    expect(stored?.searchProjection.searchText).toContain("product strategy");
    expect(stored?.searchProjection.searchText).toContain("emba mentor circles");
    expect(await IdempotencyRecord.countDocuments({})).toBe(1);
    expect(
      await AuditLog.countDocuments({
        action: "alumni_profile.updated",
        targetId: profileId.toString(),
      }),
    ).toBe(1);
    expect(JSON.stringify(await AuditLog.find({}).lean())).not.toContain(
      "private biography value",
    );

    await expect(
      service.updateOwn({
        ...input,
        idempotencyKey: "10000000-0000-4000-8000-000000000002",
      }),
    ).rejects.toMatchObject({
      code: "ALUMNI_PROFILE_REVISION_CONFLICT",
      httpStatus: 409,
    });
  });

  it("requires publish readiness and persists immutable current-version consent", async () => {
    const incomplete = await createProfileFixture({ complete: false });
    await expect(
      service.publishOwn({
        expectedRevision: 0,
        consentVersion: ALUMNI_PROFILE_PUBLICATION_CONSENT.version,
        consentAccepted: true,
        actor: actor(incomplete.userId),
        idempotencyKey: "20000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toMatchObject({
      code: "ALUMNI_PROFILE_NOT_PUBLISHABLE",
      httpStatus: 422,
      issues: expect.arrayContaining([
        expect.objectContaining({ field: "phone" }),
        expect.objectContaining({ field: "birthYear" }),
      ]),
    });
    expect(await IdempotencyRecord.countDocuments({})).toBe(0);
    expect(await ConsentRecord.countDocuments({})).toBe(0);

    const { userId, profileId } = await createProfileFixture();
    const input = {
      expectedRevision: 0,
      consentVersion: ALUMNI_PROFILE_PUBLICATION_CONSENT.version,
      consentAccepted: true,
      actor: actor(userId),
      idempotencyKey: "20000000-0000-4000-8000-000000000002",
      correlationId: "m2-03-publish",
    } as const;
    const published = await service.publishOwn(input);
    const replay = await service.publishOwn(input);

    expect(published).toEqual({
      replayed: false,
      profileId: profileId.toString(),
      publishStatus: "published",
      revision: 1,
    });
    expect(replay).toEqual({ ...published, replayed: true });
    const consent = await ConsentRecord.findOne({ alumniProfileId: profileId });
    expect(consent).toMatchObject({
      subjectUserId: userId,
      purpose: "alumni_profile_publication",
      consentVersion: ALUMNI_PROFILE_PUBLICATION_CONSENT.version,
      documentHash: ALUMNI_PROFILE_PUBLICATION_CONSENT.documentHash,
      status: "active",
      acceptedAt: nowValue,
      revision: 0,
    });
    const profile = await AlumniProfile.findById(profileId).lean();
    expect(profile).toMatchObject({
      publishStatus: "published",
      currentPublicationConsentId: consent?._id,
      publishedAt: nowValue,
      withdrawnAt: null,
      revision: 1,
    });
    expect(await ConsentRecord.countDocuments({})).toBe(1);
    expect(
      await AuditLog.countDocuments({ action: "alumni_profile.published" }),
    ).toBe(1);
    expect(await service.getOwn(userId.toString())).toMatchObject({
      consentVersion: ALUMNI_PROFILE_PUBLICATION_CONSENT.version,
      hasCurrentPublicationConsent: true,
    });

    await expect(
      service.publishOwn({
        ...input,
        expectedRevision: 1,
        consentVersion: "directory-old",
        idempotencyKey: "20000000-0000-4000-8000-000000000003",
      }),
    ).rejects.toMatchObject({
      code: "ALUMNI_PROFILE_CONSENT_VERSION_INVALID",
      httpStatus: 409,
    });

    const invalidEvidenceFixture = await createProfileFixture();
    const invalidConsent = await ConsentRecord.create({
      subjectUserId: invalidEvidenceFixture.userId,
      alumniProfileId: invalidEvidenceFixture.profileId,
      purpose: "alumni_profile_publication",
      consentVersion: "directory-v0",
      documentHash: "b".repeat(64),
      status: "active",
      acceptedAt: new Date("2030-09-01T12:00:00.000Z"),
      revision: 0,
    });
    await AlumniProfile.collection.updateOne(
      { _id: invalidEvidenceFixture.profileId },
      {
        $set: {
          publishStatus: "published",
          currentPublicationConsentId: invalidConsent._id,
          publishedAt: new Date("2030-09-01T12:00:00.000Z"),
        },
      },
    );
    await expect(
      service.getOwn(invalidEvidenceFixture.userId.toString()),
    ).rejects.toMatchObject({
      code: "ALUMNI_PROFILE_CONSENT_EVIDENCE_INVALID",
      httpStatus: 500,
    });

    const priorVersionFixture = await createProfileFixture();
    const priorDocument = ALUMNI_PROFILE_PUBLICATION_CONSENT_REGISTRY[0];
    const oldConsent = await ConsentRecord.create({
      subjectUserId: priorVersionFixture.userId,
      alumniProfileId: priorVersionFixture.profileId,
      purpose: "alumni_profile_publication",
      consentVersion: priorDocument.version,
      documentHash: priorDocument.documentHash,
      status: "active",
      acceptedAt: new Date("2030-09-01T12:00:00.000Z"),
      revision: 0,
    });
    await AlumniProfile.collection.updateOne(
      { _id: priorVersionFixture.profileId },
      {
        $set: {
          publishStatus: "published",
          currentPublicationConsentId: oldConsent._id,
          publishedAt: new Date("2030-09-01T12:00:00.000Z"),
        },
      },
    );
    expect(await service.getOwn(priorVersionFixture.userId.toString())).toMatchObject({
      publishStatus: "published",
      consentVersion: priorDocument.version,
      hasCurrentPublicationConsent: false,
      acceptedPublicationConsent: {
        version: priorDocument.version,
        text: priorDocument.text,
        documentHash: priorDocument.documentHash,
        effectiveAt: priorDocument.effectiveAt,
        acceptedAt: "2030-09-01T12:00:00.000Z",
      },
    });
    await service.publishOwn({
      expectedRevision: 0,
      consentVersion: ALUMNI_PROFILE_PUBLICATION_CONSENT.version,
      consentAccepted: true,
      actor: actor(priorVersionFixture.userId),
      idempotencyKey: "20000000-0000-4000-8000-000000000004",
    });

    const superseded = await ConsentRecord.findById(oldConsent._id);
    expect(superseded).toMatchObject({
      status: "superseded",
      supersededAt: nowValue,
      purgeAt: addUtcCalendarMonths(nowValue, 12),
      revision: 1,
    });
    expect(superseded?.supersededByConsentId).toBeDefined();
    expect(
      await ConsentRecord.countDocuments({
        alumniProfileId: priorVersionFixture.profileId,
        status: "active",
        consentVersion: ALUMNI_PROFILE_PUBLICATION_CONSENT.version,
        documentHash: ALUMNI_PROFILE_PUBLICATION_CONSENT.documentHash,
      }),
    ).toBe(1);
    expect(await service.getOwn(priorVersionFixture.userId.toString())).toMatchObject({
      publishStatus: "published",
      consentVersion: ALUMNI_PROFILE_PUBLICATION_CONSENT.version,
      hasCurrentPublicationConsent: true,
    });
  });

  it("withdraws immediately, retains terminal consent for 12 calendar months, and replays", async () => {
    const { userId, profileId } = await createProfileFixture();
    await service.publishOwn({
      expectedRevision: 0,
      consentVersion: ALUMNI_PROFILE_PUBLICATION_CONSENT.version,
      consentAccepted: true,
      actor: actor(userId),
      idempotencyKey: "30000000-0000-4000-8000-000000000001",
    });
    setNow("2031-10-31T12:00:00.000Z");
    const input = {
      expectedRevision: 1,
      actor: actor(userId),
      idempotencyKey: "30000000-0000-4000-8000-000000000002",
      correlationId: "m2-03-withdraw",
    } as const;

    const withdrawn = await service.withdrawOwn(input);
    const replay = await service.withdrawOwn(input);

    expect(withdrawn).toEqual({
      replayed: false,
      profileId: profileId.toString(),
      publishStatus: "withdrawn",
      revision: 2,
    });
    expect(replay).toEqual({ ...withdrawn, replayed: true });
    const profile = await AlumniProfile.findById(profileId).lean();
    expect(profile).toMatchObject({
      publishStatus: "withdrawn",
      withdrawnAt: nowValue,
      revision: 2,
    });
    expect(profile).not.toHaveProperty("currentPublicationConsentId");
    const consent = await ConsentRecord.findOne({ alumniProfileId: profileId });
    expect(consent).toMatchObject({
      status: "withdrawn",
      withdrawnAt: nowValue,
      purgeAt: addUtcCalendarMonths(nowValue, 12),
      revision: 1,
    });
    expect(
      await AuditLog.countDocuments({ action: "alumni_profile.withdrawn" }),
    ).toBe(1);
    expect((await service.getOwn(userId.toString())).consentVersion).toBeNull();
  });

  it("allows only one of two concurrent publish CAS operations to commit", async () => {
    const { userId, profileId } = await createProfileFixture();
    const common = {
      expectedRevision: 0,
      consentVersion: ALUMNI_PROFILE_PUBLICATION_CONSENT.version,
      consentAccepted: true,
      actor: actor(userId),
    } as const;

    const results = await Promise.allSettled([
      service.publishOwn({
        ...common,
        idempotencyKey: "40000000-0000-4000-8000-000000000001",
      }),
      service.publishOwn({
        ...common,
        idempotencyKey: "40000000-0000-4000-8000-000000000002",
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
      1,
    );
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: {
        code: "ALUMNI_PROFILE_REVISION_CONFLICT",
        httpStatus: 409,
      },
    });
    expect(
      await ConsentRecord.countDocuments({
        alumniProfileId: profileId,
        status: "active",
      }),
    ).toBe(1);
    expect(await AlumniProfile.countDocuments({ _id: profileId, revision: 1 })).toBe(
      1,
    );
    expect(
      await AuditLog.countDocuments({ action: "alumni_profile.published" }),
    ).toBe(1);
  });

  it.each(["draft", "published"] as const)(
    "synchronizes canonical User changes into an existing %s profile atomically",
    async (publishStatus) => {
      const { userId, profileId } = await createProfileFixture();
      if (publishStatus === "published") {
        await AlumniProfile.collection.updateOne(
          { _id: profileId },
          {
            $set: {
              publishStatus,
              publishedAt: nowValue,
              currentPublicationConsentId: new mongoose.Types.ObjectId(),
            },
          },
        );
      }

      const transactions = new MongoTransactionService(mongoose.connection);
      const changed = await transactions.run(async (session) => {
        const user = await User.findById(userId)
          .select("+birthYear")
          .session(session);
        expect(user).not.toBeNull();
        user!.set({
          firstName: "Zoë",
          lastName: "Brontë",
          company: "Société Nouvelle",
          residenceCity: "Montréal",
        });
        await user!.save({ session });
        return synchronizeExistingAlumniProfileProjection(user!, session);
      });

      expect(changed).toBe(true);
      const profile = await AlumniProfile.findById(profileId)
        .select("+searchProjection")
        .lean();
      expect(profile).toMatchObject({
        publishStatus,
        revision: 1,
        searchProjection: {
          displayNameKey: "zoe bronte",
          companyKey: "societe nouvelle",
          generalLocationKey: "montreal",
        },
      });
    },
  );
});
