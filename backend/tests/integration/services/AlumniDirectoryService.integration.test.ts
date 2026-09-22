import { performance } from "node:perf_hooks";
import mongoose from "mongoose";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { ALUMNI_PROFILE_PUBLICATION_CONSENT } from "../../../src/config/alumniProfilePublicationConsent";
import {
  deriveAlumniAffiliationKey,
  type AlumniAffiliationVerificationStatus,
  type AlumniProfilePublishStatus,
  type ConsentRecordStatus,
} from "../../../src/contracts/alumniDirectoryData";
import {
  parseAlumniDirectoryQuery,
  type AlumniDirectoryQuery,
} from "../../../src/contracts/alumniDirectoryFlow";
import AlumniAffiliation from "../../../src/models/AlumniAffiliation";
import AlumniImportBatch from "../../../src/models/AlumniImportBatch";
import AlumniInvitation from "../../../src/models/AlumniInvitation";
import AlumniProfile from "../../../src/models/AlumniProfile";
import AuditLog from "../../../src/models/AuditLog";
import ConsentRecord from "../../../src/models/ConsentRecord";
import IdempotencyRecord from "../../../src/models/IdempotencyRecord";
import NotificationOutbox from "../../../src/models/NotificationOutbox";
import User from "../../../src/models/User";
import { AlumniDirectoryService } from "../../../src/services/alumni/AlumniDirectoryService";
import { AlumniImportService } from "../../../src/services/alumni/AlumniImportService";
import { AlumniInvitationService } from "../../../src/services/alumni/AlumniInvitationService";
import { deriveAlumniInvitationToken } from "../../../src/services/alumni/AlumniInvitationSecurity";
import { AlumniProfileService } from "../../../src/services/alumni/AlumniProfileService";
import { buildAlumniProfileSearchProjection } from "../../../src/services/alumni/AlumniProfileProjectionService";
import { IdempotencyService } from "../../../src/services/reliability/IdempotencyService";
import { MongoTransactionService } from "../../../src/services/reliability/MongoTransactionService";
import { ensureIntegrationDB } from "../setup/connect";

const CONTACT_KEY = Buffer.alloc(32, 0x43).toString("base64url");
const TOKEN_KEY = Buffer.alloc(32, 0x54).toString("base64url");
const NOW = new Date("2032-09-12T12:00:00.000Z");
const PRIVATE_PHONE = "+14155550199";
const PRIVATE_EMAIL_DOMAIN = "directory-private.example.org";
const REVIEWER_ID = new mongoose.Types.ObjectId();
const ADMIN_ACTOR = {
  id: REVIEWER_ID.toString(),
  role: "Administrator",
} as const;

const previousSecurityEnvironment = {
  contactKey: process.env.ALUMNI_CONTACT_LOOKUP_KEY_V1,
  tokenKey: process.env.ALUMNI_INVITATION_TOKEN_KEY_V1,
};

const collections = [
  AlumniAffiliation,
  AlumniImportBatch,
  AlumniInvitation,
  AlumniProfile,
  AuditLog,
  ConsentRecord,
  IdempotencyRecord,
  NotificationOutbox,
  User,
] as const;

const directory = new AlumniDirectoryService();

interface PublishedFixtureOptions {
  readonly label: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly company?: string;
  readonly occupation?: string;
  readonly city?: string;
  readonly region?: string;
  readonly industry?: string;
  readonly skills?: readonly string[];
  readonly headline?: string;
  readonly programName?: string;
  readonly cohortLabel?: string;
  readonly userActive?: boolean;
  readonly userVerified?: boolean;
  readonly publishStatus?: AlumniProfilePublishStatus;
  readonly consentStatus?: ConsentRecordStatus;
  readonly consentVersion?: string;
  readonly consentDocumentHash?: string;
  readonly affiliationStatus?: AlumniAffiliationVerificationStatus;
  readonly omitAffiliation?: boolean;
  readonly offerings?: {
    readonly careerAdvice: boolean;
    readonly warmIntroduction: boolean;
    readonly formalEmployeeReferral: boolean;
  };
  readonly extraPendingAffiliation?: boolean;
}

function restoreEnvironment(
  name: "ALUMNI_CONTACT_LOOKUP_KEY_V1" | "ALUMNI_INVITATION_TOKEN_KEY_V1",
  value: string | undefined,
) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function baseQuery(
  overrides: Partial<AlumniDirectoryQuery> = {},
): AlumniDirectoryQuery {
  return { page: 1, limit: 100, ...overrides };
}

function expectNoPrivateDirectoryKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(expectNoPrivateDirectoryKeys);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of ["email", "phone", "birthYear"]) {
    expect(record).not.toHaveProperty(key);
  }
  Object.values(record).forEach(expectNoPrivateDirectoryKeys);
}

async function createPublishedFixture(options: PublishedFixtureOptions) {
  const userId = new mongoose.Types.ObjectId();
  const profileId = new mongoose.Types.ObjectId();
  const consentId = new mongoose.Types.ObjectId();
  const affiliationId = new mongoose.Types.ObjectId();
  const firstName = options.firstName ?? `Alumni ${options.label}`;
  const lastName = options.lastName ?? "Member";
  const company = options.company ?? `Company ${options.label}`;
  const occupation = options.occupation ?? "Product Manager";
  const city = options.city ?? "Seattle";
  const region = options.region ?? "US-WA";
  const industry = options.industry ?? "Technology";
  const skills = options.skills ?? ["Mentoring"];
  const headline = options.headline ?? `Headline ${options.label}`;
  const programName = options.programName ?? "EMBA Mentor Circles";
  const cohortLabel = options.cohortLabel ?? "2032";
  const offerings = options.offerings ?? {
    careerAdvice: true,
    warmIntroduction: false,
    formalEmployeeReferral: false,
  };
  const username = `al${userId.toString().slice(-12)}`;
  const userSource = {
    username,
    firstName,
    lastName,
    company,
    occupation,
    residenceCity: city,
    residenceRegion: region,
    residenceCountryCode: "US",
  };
  const profileSource = {
    professionalHeadline: headline,
    industry,
    skills,
  };
  const affiliationSource = { programName, cohortLabel };

  await User.collection.insertOne({
    _id: userId,
    ...userSource,
    usernameLower: username,
    email: `${username}@${PRIVATE_EMAIL_DOMAIN}`,
    phone: PRIVATE_PHONE,
    birthYear: 1988,
    password: "integration-test-only",
    employmentStatus: "employed",
    isAtCloudLeader: false,
    role: "Participant",
    isActive: options.userActive ?? true,
    isVerified: options.userVerified ?? true,
    emailNotifications: true,
    loginAttempts: 0,
    hasReceivedWelcomeMessage: false,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await AlumniProfile.collection.insertOne({
    _id: profileId,
    userId,
    ...profileSource,
    bio: `Biography ${options.label}`,
    helpOfferings: offerings,
    publishStatus: options.publishStatus ?? "published",
    currentPublicationConsentId: consentId,
    searchProjection: buildAlumniProfileSearchProjection({
      user: userSource,
      profile: profileSource,
      affiliations: [affiliationSource],
    }),
    publishedAt: NOW,
    withdrawnAt:
      options.publishStatus === "withdrawn" ? NOW : null,
    accountDeletionApprovedAt: null,
    purgeAt: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await ConsentRecord.collection.insertOne({
    _id: consentId,
    subjectUserId: userId,
    alumniProfileId: profileId,
    purpose: "alumni_profile_publication",
    consentVersion:
      options.consentVersion ?? ALUMNI_PROFILE_PUBLICATION_CONSENT.version,
    documentHash:
      options.consentDocumentHash ??
      ALUMNI_PROFILE_PUBLICATION_CONSENT.documentHash,
    status: options.consentStatus ?? "active",
    acceptedAt: NOW,
    revision: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
  if (!options.omitAffiliation) await AlumniAffiliation.collection.insertOne({
    _id: affiliationId,
    alumniProfileId: profileId,
    programName,
    cohortLabel,
    affiliationKey: deriveAlumniAffiliationKey({ programName, cohortLabel }),
    verificationStatus: options.affiliationStatus ?? "verified",
    ...((options.affiliationStatus ?? "verified") === "pending_review"
      ? {}
      : { reviewedAt: NOW, reviewedBy: REVIEWER_ID }),
    accountDeletionApprovedAt: null,
    purgeAt: null,
    revision: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
  if (options.extraPendingAffiliation) {
    const pendingProgram = "Private Pending Program";
    const pendingCohort = "2099";
    await AlumniAffiliation.collection.insertOne({
      _id: new mongoose.Types.ObjectId(),
      alumniProfileId: profileId,
      programName: pendingProgram,
      cohortLabel: pendingCohort,
      affiliationKey: deriveAlumniAffiliationKey({
        programName: pendingProgram,
        cohortLabel: pendingCohort,
      }),
      verificationStatus: "pending_review",
      accountDeletionApprovedAt: null,
      purgeAt: null,
      revision: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  return { userId, profileId, consentId, affiliationId, username };
}

async function insertPublishedBatch(count: number) {
  const users: Record<string, unknown>[] = [];
  const profiles: Record<string, unknown>[] = [];
  const consents: Record<string, unknown>[] = [];
  const affiliations: Record<string, unknown>[] = [];
  const profileIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const userId = new mongoose.Types.ObjectId();
    const profileId = new mongoose.Types.ObjectId();
    const consentId = new mongoose.Types.ObjectId();
    const affiliationId = new mongoose.Types.ObjectId();
    const suffix = String(index).padStart(4, "0");
    const username = `p${suffix}${userId.toString().slice(-6)}`;
    const userSource = {
      username,
      firstName: "Performance",
      lastName: `Alumni ${suffix}`,
      company: `Company ${index % 10}`,
      occupation: "Engineer",
      residenceCity: index % 2 === 0 ? "Seattle" : "Bellevue",
      residenceRegion: "US-WA",
      residenceCountryCode: "US",
    };
    const profileSource = {
      professionalHeadline: `Cloud builder ${suffix}`,
      industry: index % 2 === 0 ? "Technology" : "Education",
      skills: [index % 2 === 0 ? "Cloud Architecture" : "Teaching"],
    };
    const affiliationSource = {
      programName: "EMBA Mentor Circles",
      cohortLabel: String(2030 + (index % 5)),
    };
    users.push({
      _id: userId,
      ...userSource,
      usernameLower: username,
      email: `${username}@${PRIVATE_EMAIL_DOMAIN}`,
      phone: PRIVATE_PHONE,
      birthYear: 1980 + (index % 30),
      password: "integration-test-only",
      employmentStatus: "employed",
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
    profiles.push({
      _id: profileId,
      userId,
      ...profileSource,
      bio: null,
      helpOfferings: {
        careerAdvice: true,
        warmIntroduction: index % 3 === 0,
        formalEmployeeReferral: index % 5 === 0,
      },
      publishStatus: "published",
      currentPublicationConsentId: consentId,
      searchProjection: buildAlumniProfileSearchProjection({
        user: userSource,
        profile: profileSource,
        affiliations: [affiliationSource],
      }),
      publishedAt: NOW,
      withdrawnAt: null,
      accountDeletionApprovedAt: null,
      purgeAt: null,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    consents.push({
      _id: consentId,
      subjectUserId: userId,
      alumniProfileId: profileId,
      purpose: "alumni_profile_publication",
      consentVersion: ALUMNI_PROFILE_PUBLICATION_CONSENT.version,
      documentHash: ALUMNI_PROFILE_PUBLICATION_CONSENT.documentHash,
      status: "active",
      acceptedAt: NOW,
      revision: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
    affiliations.push({
      _id: affiliationId,
      alumniProfileId: profileId,
      ...affiliationSource,
      affiliationKey: deriveAlumniAffiliationKey(affiliationSource),
      verificationStatus: "verified",
      reviewedAt: NOW,
      reviewedBy: REVIEWER_ID,
      accountDeletionApprovedAt: null,
      purgeAt: null,
      revision: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
    profileIds.push(profileId.toString());
  }
  await Promise.all([
    User.collection.insertMany(users),
    AlumniProfile.collection.insertMany(profiles),
    ConsentRecord.collection.insertMany(consents),
    AlumniAffiliation.collection.insertMany(affiliations),
  ]);
  return profileIds;
}

describe("M2-06 Alumni Directory Mongo qualification", () => {
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

  it("flows from import through claim and owner publication into Directory visibility", async () => {
    const userId = new mongoose.Types.ObjectId();
    const username = `flow${userId.toString().slice(-8)}`;
    await User.collection.insertOne({
      _id: userId,
      username,
      usernameLower: username,
      email: `flow@${PRIVATE_EMAIL_DOMAIN}`,
      phone: PRIVATE_PHONE,
      birthYear: 1988,
      password: "integration-test-only",
      firstName: "Élodie",
      lastName: "Nguyễn",
      residenceCity: "Seattle",
      residenceRegion: "US-WA",
      residenceCountryCode: "US",
      employmentStatus: "employed",
      company: "Café Cloud",
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

    const transactions = new MongoTransactionService(mongoose.connection);
    const invitations = new AlumniInvitationService({
      now: () => new Date(NOW),
      idempotency: new IdempotencyService(transactions),
    });
    const imports = new AlumniImportService({
      now: () => new Date(NOW),
      idempotency: new IdempotencyService(transactions),
      invitations,
    });
    const profiles = new AlumniProfileService({
      now: () => new Date(NOW),
      idempotency: new IdempotencyService(transactions),
    });
    const csv = Buffer.from(
      [
        "email,firstName,lastName,programName,cohortLabel",
        `FLOW@${PRIVATE_EMAIL_DOMAIN},Élodie,Nguyễn,EMBA [Cloud]+,2032-A`,
      ].join("\n"),
      "utf8",
    );

    const dryRun = await imports.dryRun({
      csv,
      actor: ADMIN_ACTOR,
      idempotencyKey: "61000000-0000-4000-8000-000000000001",
    });
    const rows = await imports.listRows({
      batchId: dryRun.batchId,
      page: 1,
      limit: 20,
    });
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      matchStatus: "matched",
      matchedUser: { id: userId.toString() },
    });
    const review = await imports.review({
      batchId: dryRun.batchId,
      expectedRevision: dryRun.revision,
      decisions: [
        {
          rowNumber: rows.rows[0]!.rowNumber,
          rowKey: rows.rows[0]!.rowKey,
          eligibilityStatus: "approved",
        },
      ],
      actor: ADMIN_ACTOR,
      idempotencyKey: "61000000-0000-4000-8000-000000000002",
    });
    await imports.apply({
      batchId: dryRun.batchId,
      expectedRevision: review.revision,
      actor: ADMIN_ACTOR,
      idempotencyKey: "61000000-0000-4000-8000-000000000003",
    });

    const invitation = await AlumniInvitation.findOne({ status: "active" });
    expect(invitation).not.toBeNull();
    const token = deriveAlumniInvitationToken({
      invitationId: String(invitation!._id),
      issueCount: invitation!.issueCount,
      issuedAt: invitation!.issuedAt,
      tokenVersion: invitation!.tokenVersion,
    });
    const claimed = await invitations.claim({
      token,
      actor: { id: userId.toString(), role: "Participant" },
      idempotencyKey: "61000000-0000-4000-8000-000000000004",
    });
    expect((await directory.list(baseQuery())).profiles).toEqual([]);
    const claimedOwner = await profiles.getOwn(userId.toString());
    expect(claimedOwner.publishStatus).toBe("draft");

    const updated = await profiles.updateOwn({
      expectedRevision: claimedOwner.revision,
      professionalHeadline: "Product & Community Builder",
      industry: "Technology / Education",
      skills: ["C++", "Product Strategy"],
      bio: "Published professional biography.",
      helpOfferings: {
        careerAdvice: true,
        warmIntroduction: true,
        formalEmployeeReferral: false,
      },
      actor: { id: userId.toString(), role: "Participant" },
      idempotencyKey: "61000000-0000-4000-8000-000000000005",
    });
    await profiles.publishOwn({
      expectedRevision: updated.revision,
      consentVersion: ALUMNI_PROFILE_PUBLICATION_CONSENT.version,
      consentAccepted: true,
      actor: { id: userId.toString(), role: "Participant" },
      idempotencyKey: "61000000-0000-4000-8000-000000000006",
    });

    const listed = await directory.list(
      baseQuery({ q: "elodie nguyen", offering: "warm_introduction" }),
    );
    expect(listed.profiles).toHaveLength(1);
    expect(listed.profiles[0]).toMatchObject({
      id: claimed.alumniProfileId,
      displayName: "Élodie Nguyễn",
      company: "Café Cloud",
      generalLocation: "Seattle",
      professionalHeadline: "Product & Community Builder",
      affiliations: [
        expect.objectContaining({
          programName: "EMBA [Cloud]+",
          cohortLabel: "2032-A",
        }),
      ],
      helpOfferings: {
        careerAdvice: true,
        warmIntroduction: true,
        formalEmployeeReferral: false,
      },
    });
    expectNoPrivateDirectoryKeys(listed);
  });

  it("requires every current eligibility condition and conceals ineligible details", async () => {
    const eligible = await createPublishedFixture({
      label: "eligible",
      extraPendingAffiliation: true,
    });
    const noAffiliation = await createPublishedFixture({
      label: "no-affiliation",
      omitAffiliation: true,
    });
    const pendingAffiliation = await createPublishedFixture({
      label: "pending-affiliation",
      affiliationStatus: "pending_review",
    });
    const ineligible = await Promise.all([
      createPublishedFixture({ label: "draft", publishStatus: "draft" }),
      createPublishedFixture({
        label: "withdrawn-profile",
        publishStatus: "withdrawn",
      }),
      createPublishedFixture({
        label: "withdrawn-consent",
        consentStatus: "withdrawn",
      }),
      createPublishedFixture({
        label: "stale-consent-version",
        consentVersion: "directory-old",
      }),
      createPublishedFixture({
        label: "stale-consent-hash",
        consentDocumentHash: "a".repeat(64),
      }),
      createPublishedFixture({ label: "inactive-user", userActive: false }),
      createPublishedFixture({
        label: "unverified-user",
        userVerified: false,
      }),
    ]);

    const listed = await directory.list(baseQuery());
    expect(listed.profiles.map((profile) => profile.id).sort()).toEqual([
      eligible.profileId.toString(),
      noAffiliation.profileId.toString(),
      pendingAffiliation.profileId.toString(),
    ].sort());
    expect(listed.profiles.find((profile) => profile.id === eligible.profileId.toString())?.affiliations).toHaveLength(1);
    expect(listed.profiles.find((profile) => profile.id === noAffiliation.profileId.toString())?.affiliations).toEqual([]);
    expect(listed.profiles.find((profile) => profile.id === pendingAffiliation.profileId.toString())?.affiliations).toEqual([]);
    expect(JSON.stringify(listed)).not.toContain("Private Pending Program");
    expect((await directory.get(noAffiliation.profileId.toString())).affiliations).toEqual([]);

    for (const fixture of ineligible) {
      await expect(
        directory.get(fixture.profileId.toString()),
      ).rejects.toMatchObject({
        code: "ALUMNI_PROFILE_NOT_FOUND",
        httpStatus: 404,
      });
    }
  });

  it("searches literal special characters, normalized accents, and every filter", async () => {
    const target = await createPublishedFixture({
      label: "search-target",
      firstName: "Joséphine",
      lastName: "O'Neil [Cloud]+",
      company: "R&D (West)",
      occupation: "C++ Engineer",
      city: "Montréal",
      region: "CA-QC",
      industry: "Santé Technology",
      skills: ["C++", "Défense Modeling"],
      headline: "Literal .* mentor",
      programName: "EMBA [Cloud]+",
      cohortLabel: "2032 (A)",
      offerings: {
        careerAdvice: false,
        warmIntroduction: false,
        formalEmployeeReferral: true,
      },
    });
    await createPublishedFixture({
      label: "search-distractor",
      firstName: "Plain",
      lastName: "Member",
      company: "Ordinary Company",
      city: "Boston",
      industry: "Finance",
      skills: ["Accounting", "C"],
      programName: "General Program",
      cohortLabel: "2020",
    });

    const cases: readonly Partial<AlumniDirectoryQuery>[] = [
      { q: "josephine o'neil" },
      { q: "C++" },
      { company: "r&d (west)" },
      { industry: "sante technology" },
      { skill: "defense modeling" },
      { skill: "C++" },
      { location: "Montreal" },
      { cohort: "EMBA [Cloud]+ 2032 (A)" },
      { offering: "formal_employee_referral" },
      {
        company: "R&D (West)",
        industry: "Sante Technology",
        skill: "C++",
        location: "Montreal",
        cohort: "2032 (A)",
        offering: "formal_employee_referral",
      },
    ];
    for (const query of cases) {
      const result = await directory.list(baseQuery(query));
      expect(result.profiles.map((profile) => profile.id)).toEqual([
        target.profileId.toString(),
      ]);
    }

    for (const hiddenValue of [
      ".*",
      "C++ Engineer",
      "Literal .* mentor",
      "CA-QC",
      target.username,
    ]) {
      expect((await directory.list(baseQuery({ q: hiddenValue }))).profiles).toEqual(
        [],
      );
    }
    expect(
      (await directory.list(baseQuery({ location: "CA-QC" }))).profiles,
    ).toEqual([]);
  });

  it("returns and cohort-filters the 51st verified affiliation", async () => {
    const target = await createPublishedFixture({ label: "many-affiliations" });
    const additional = Array.from({ length: 50 }, (_, offset) => {
      const number = offset + 1;
      const programName =
        number === 50 ? "Final Élite Program" : `Additional Program ${number}`;
      const cohortLabel =
        number === 50 ? "Final Cohort" : `Additional Cohort ${number}`;
      return {
        _id: new mongoose.Types.ObjectId(),
        alumniProfileId: target.profileId,
        programName,
        cohortLabel,
        affiliationKey: deriveAlumniAffiliationKey({
          programName,
          cohortLabel,
        }),
        verificationStatus: "verified",
        reviewedAt: NOW,
        reviewedBy: REVIEWER_ID,
        accountDeletionApprovedAt: null,
        purgeAt: null,
        revision: 0,
        createdAt: NOW,
        updatedAt: NOW,
      };
    });
    await AlumniAffiliation.collection.insertMany(additional);

    const [user, profile, affiliations] = await Promise.all([
      User.findById(target.userId).lean(),
      AlumniProfile.findById(target.profileId).select("+searchProjection"),
      AlumniAffiliation.find({ alumniProfileId: target.profileId })
        .sort({ programName: 1, cohortLabel: 1, _id: 1 })
        .lean(),
    ]);
    expect(user).not.toBeNull();
    expect(profile).not.toBeNull();
    profile!.searchProjection = buildAlumniProfileSearchProjection({
      user: user!,
      profile: profile!,
      affiliations,
    });
    await profile!.save();

    const result = await directory.list(
      baseQuery({ cohort: "final elite program final cohort" }),
    );
    expect(result.profiles.map((entry) => entry.id)).toEqual([
      target.profileId.toString(),
    ]);
    expect((await directory.get(target.profileId.toString())).affiliations).toHaveLength(
      51,
    );
  });

  it("uses default 24, accepts 100 maximum, and paginates stably by name and id", async () => {
    expect(parseAlumniDirectoryQuery({})).toMatchObject({ page: 1, limit: 24 });
    expect(parseAlumniDirectoryQuery({ limit: "100" })).toMatchObject({
      page: 1,
      limit: 100,
    });
    expect(() => parseAlumniDirectoryQuery({ limit: "101" })).toThrow();

    const ids = await insertPublishedBatch(30);
    const first = await directory.list({ page: 1, limit: 24 });
    const firstReplay = await directory.list({ page: 1, limit: 24 });
    const second = await directory.list({ page: 2, limit: 24 });
    const maximum = await directory.list({ page: 1, limit: 100 });

    expect(first.profiles).toEqual(firstReplay.profiles);
    expect(first.profiles).toHaveLength(24);
    expect(second.profiles).toHaveLength(6);
    expect(maximum.profiles).toHaveLength(30);
    expect(first.pagination).toEqual({
      currentPage: 1,
      totalPages: 2,
      totalProfiles: 30,
      hasNext: true,
      hasPrev: false,
    });
    expect(second.pagination).toEqual({
      currentPage: 2,
      totalPages: 2,
      totalProfiles: 30,
      hasNext: false,
      hasPrev: true,
    });
    const expectedOrder = [...ids].sort();
    expect(
      [...first.profiles, ...second.profiles].map((profile) => profile.id),
    ).toEqual(expectedOrder);
  });

  it("returns strict list/detail DTOs without account or registration PII", async () => {
    const fixture = await createPublishedFixture({ label: "dto" });
    const list = await directory.list(baseQuery());
    const detail = await directory.get(fixture.profileId.toString());

    expect(Object.keys(list).sort()).toEqual(["pagination", "profiles"]);
    expect(Object.keys(list.profiles[0]!).sort()).toEqual(
      [
        "affiliations",
        "avatar",
        "company",
        "displayName",
        "generalLocation",
        "helpOfferings",
        "id",
        "occupation",
        "professionalHeadline",
      ].sort(),
    );
    expect(Object.keys(detail).sort()).toEqual(
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
    expect(Object.keys(detail.affiliations[0]!).sort()).toEqual([
      "cohortLabel",
      "id",
      "programName",
    ]);
    expectNoPrivateDirectoryKeys({ list, detail });
    const serialized = JSON.stringify({ list, detail });
    expect(serialized).not.toContain(PRIVATE_PHONE);
    expect(serialized).not.toContain(PRIVATE_EMAIL_DOMAIN);
    expect(serialized).not.toContain("1988");
  });

  it("keeps Directory query p95 within 1000 ms at 500 published profiles", async () => {
    await insertPublishedBatch(500);
    const queries: readonly AlumniDirectoryQuery[] = [
      { page: 1, limit: 24 },
      { page: 10, limit: 24, q: "Performance Alumni 0499" },
      { page: 1, limit: 100, company: "Company 5" },
      { page: 1, limit: 100, cohort: "2034" },
      { page: 1, limit: 100, offering: "formal_employee_referral" },
    ];

    for (const query of queries) await directory.list(query);
    const samples: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const startedAt = performance.now();
      await directory.list(queries[index % queries.length]!);
      samples.push(performance.now() - startedAt);
    }
    const sorted = [...samples].sort((left, right) => left - right);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;

    expect(
      p95,
      `Directory p95 ${p95.toFixed(1)} ms; samples=${samples
        .map((sample) => sample.toFixed(1))
        .join(",")}`,
    ).toBeLessThanOrEqual(1_000);
  });
});
