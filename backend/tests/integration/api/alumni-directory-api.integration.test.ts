import mongoose from "mongoose";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import app from "../../../src/app";
import { ALUMNI_PROFILE_PUBLICATION_CONSENT } from "../../../src/config/alumniProfilePublicationConsent";
import { deriveAlumniAffiliationKey } from "../../../src/contracts/alumniDirectoryData";
import { TokenService } from "../../../src/middleware/auth";
import AlumniAffiliation from "../../../src/models/AlumniAffiliation";
import AlumniProfile from "../../../src/models/AlumniProfile";
import AuditLog from "../../../src/models/AuditLog";
import ConsentRecord from "../../../src/models/ConsentRecord";
import FeatureControl, {
  FEATURE_CONTROL_SINGLETON_ID,
} from "../../../src/models/FeatureControl";
import User, { type IUser } from "../../../src/models/User";
import {
  authorizationService,
} from "../../../src/services/authorization/AuthorizationService";
import { buildAlumniProfileSearchProjection } from "../../../src/services/alumni/AlumniProfileProjectionService";
import { ensureIntegrationDB } from "../setup/connect";

const NOW = new Date("2032-09-12T12:00:00.000Z");
const PRIVATE_PHONE = "+14155550198";
const PRIVATE_EMAIL = "published-private@example.org";
const previousReleaseCeiling = process.env.ALUMNI_NETWORK_RELEASE_AVAILABLE;

const collections = [
  AlumniAffiliation,
  AlumniProfile,
  AuditLog,
  ConsentRecord,
  FeatureControl,
  User,
] as const;

async function createUser(input: {
  readonly label: string;
  readonly active?: boolean;
  readonly verified?: boolean;
}) {
  const id = new mongoose.Types.ObjectId();
  const username = `dir${input.label}${id.toString().slice(-5)}`.slice(0, 20);
  await User.collection.insertOne({
    _id: id,
    username,
    usernameLower: username,
    email: `${username}@example.org`,
    phone: "+14155550197",
    birthYear: 1990,
    password: "integration-test-only",
    firstName: "Directory",
    lastName: input.label,
    residenceCity: "Seattle",
    residenceRegion: "US-WA",
    residenceCountryCode: "US",
    employmentStatus: "employed",
    company: "Caller Company",
    occupation: "Engineer",
    isAtCloudLeader: false,
    role: "Participant",
    isActive: input.active ?? true,
    isVerified: input.verified ?? true,
    emailNotifications: true,
    loginAttempts: 0,
    hasReceivedWelcomeMessage: false,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const user = await User.findById(id);
  expect(user).not.toBeNull();
  return user!;
}

function accessToken(user: IUser): string {
  return TokenService.generateTokenPair(user).accessToken;
}

async function enableDirectory(changedBy: mongoose.Types.ObjectId) {
  await FeatureControl.create({
    _id: FEATURE_CONTROL_SINGLETON_ID,
    mode: "read_only",
    revision: 1,
    changedBy: changedBy.toString(),
  });
}

async function createPublishedProfile() {
  const userId = new mongoose.Types.ObjectId();
  const profileId = new mongoose.Types.ObjectId();
  const consentId = new mongoose.Types.ObjectId();
  const affiliationId = new mongoose.Types.ObjectId();
  const user = {
    username: `published${userId.toString().slice(-8)}`,
    firstName: "Published",
    lastName: "Alumni",
    company: "Public Company",
    occupation: "Product Manager",
    residenceCity: "Seattle",
    residenceRegion: "US-WA",
    residenceCountryCode: "US",
  };
  const profile = {
    professionalHeadline: "Public headline",
    industry: "Technology",
    skills: ["Mentoring"],
  };
  const affiliation = {
    programName: "EMBA Mentor Circles",
    cohortLabel: "2032",
  };
  await User.collection.insertOne({
    _id: userId,
    ...user,
    usernameLower: user.username,
    email: PRIVATE_EMAIL,
    phone: PRIVATE_PHONE,
    birthYear: 1987,
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
  await AlumniProfile.collection.insertOne({
    _id: profileId,
    userId,
    ...profile,
    bio: "Public biography",
    helpOfferings: {
      careerAdvice: true,
      warmIntroduction: true,
      formalEmployeeReferral: false,
    },
    publishStatus: "published",
    currentPublicationConsentId: consentId,
    searchProjection: buildAlumniProfileSearchProjection({
      user,
      profile,
      affiliations: [affiliation],
    }),
    publishedAt: NOW,
    withdrawnAt: null,
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
    consentVersion: ALUMNI_PROFILE_PUBLICATION_CONSENT.version,
    documentHash: ALUMNI_PROFILE_PUBLICATION_CONSENT.documentHash,
    status: "active",
    acceptedAt: NOW,
    revision: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await AlumniAffiliation.collection.insertOne({
    _id: affiliationId,
    alumniProfileId: profileId,
    ...affiliation,
    affiliationKey: deriveAlumniAffiliationKey(affiliation),
    verificationStatus: "verified",
    reviewedAt: NOW,
    reviewedBy: userId,
    accountDeletionApprovedAt: null,
    purgeAt: null,
    revision: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return profileId;
}

describe("M2-06 Alumni Directory HTTP authorization and DTO boundary", () => {
  beforeAll(async () => {
    process.env.ALUMNI_NETWORK_RELEASE_AVAILABLE = "true";
    await ensureIntegrationDB();
    await Promise.all(collections.map((model) => model.init()));
  });

  beforeEach(async () => {
    await Promise.all(collections.map((model) => model.deleteMany({})));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await Promise.all(collections.map((model) => model.deleteMany({})));
    if (previousReleaseCeiling === undefined) {
      delete process.env.ALUMNI_NETWORK_RELEASE_AVAILABLE;
    } else {
      process.env.ALUMNI_NETWORK_RELEASE_AVAILABLE = previousReleaseCeiling;
    }
  });

  it("rejects unauthenticated, unverified, inactive, and denied callers", async () => {
    const caller = await createUser({ label: "caller" });
    await enableDirectory(caller._id);

    await request(app).get("/api/directory").expect(401);

    const unverified = await createUser({
      label: "unverified",
      verified: false,
    });
    await request(app)
      .get("/api/directory")
      .set("Authorization", `Bearer ${accessToken(unverified)}`)
      .expect(403);

    const inactive = await createUser({ label: "inactive", active: false });
    await request(app)
      .get("/api/directory")
      .set("Authorization", `Bearer ${accessToken(inactive)}`)
      .expect(401);

    vi.spyOn(authorizationService, "authorize").mockResolvedValue({
      allowed: false,
      reasonCode: "insufficient_permission",
      concealExistence: false,
    });
    const denied = await request(app)
      .get("/api/directory")
      .set("Authorization", `Bearer ${accessToken(caller)}`)
      .expect(403);
    expect(denied.body).toMatchObject({
      success: false,
      error: "Insufficient permissions.",
    });
  });

  it("fails closed when Directory reads are disabled", async () => {
    const caller = await createUser({ label: "off" });
    await FeatureControl.create({
      _id: FEATURE_CONTROL_SINGLETON_ID,
      mode: "off",
      revision: 1,
      changedBy: caller._id.toString(),
    });

    const response = await request(app)
      .get("/api/directory")
      .set("Authorization", `Bearer ${accessToken(caller)}`)
      .expect(503);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toMatchObject({
      success: false,
      code: "ALUMNI_NETWORK_READ_UNAVAILABLE",
    });
  });

  it("returns exact list and detail HTTP DTOs without private User fields", async () => {
    const caller = await createUser({ label: "reader" });
    await enableDirectory(caller._id);
    const profileId = await createPublishedProfile();
    const authorization = `Bearer ${accessToken(caller)}`;

    const list = await request(app)
      .get("/api/directory")
      .set("Authorization", authorization)
      .expect(200);
    const detail = await request(app)
      .get(`/api/directory/${profileId}`)
      .set("Authorization", authorization)
      .expect(200);

    expect(list.headers["cache-control"]).toBe("no-store");
    expect(detail.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(list.body.data).sort()).toEqual([
      "pagination",
      "profiles",
    ]);
    expect(Object.keys(list.body.data.profiles[0]).sort()).toEqual(
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
    expect(Object.keys(detail.body.data.profile).sort()).toEqual(
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
    const serialized = JSON.stringify({ list: list.body, detail: detail.body });
    expect(serialized).not.toContain(PRIVATE_PHONE);
    expect(serialized).not.toContain(PRIVATE_EMAIL);
    for (const key of ["phone", "birthYear", "email"]) {
      expect(serialized).not.toContain(`\"${key}\"`);
    }
  });
});
