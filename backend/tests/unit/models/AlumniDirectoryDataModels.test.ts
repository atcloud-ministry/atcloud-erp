import mongoose from "mongoose";
import { describe, expect, it } from "vitest";
import {
  addFixedDays,
  addUtcCalendarMonths,
  deriveAlumniAffiliationKey,
  deriveAlumniProgramAffiliationKey,
} from "../../../src/contracts/alumniDirectoryData";
import AlumniAffiliation from "../../../src/models/AlumniAffiliation";
import AlumniImportBatch from "../../../src/models/AlumniImportBatch";
import AlumniInvitation from "../../../src/models/AlumniInvitation";
import AlumniProfile from "../../../src/models/AlumniProfile";
import ConsentRecord from "../../../src/models/ConsentRecord";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function emptySearchProjection() {
  return {
    searchText: "",
    displayNameKey: "",
    companyKey: "",
    occupationKey: "",
    industryKey: "",
    skillKeys: [],
    generalLocationKey: "",
    cohortKeys: [],
  };
}

function activeInvitation(overrides: Record<string, unknown> = {}) {
  const issuedAt = new Date("2023-08-31T12:30:00.000Z");
  const lastInvitationSentAt = new Date(issuedAt);
  const sourceImportBatchId = new mongoose.Types.ObjectId();
  return new AlumniInvitation({
    sourceImportBatchIds: [sourceImportBatchId],
    contactEmail: "  ALUMNA@example.com ",
    contactFirstName: " Amy ",
    contactLastName: " Chen ",
    contactLookupHash: HASH_A,
    activeContactLookupHash: HASH_A,
    affiliations: [
      {
        programName: " EMBA ",
        cohortLabel: " 2022 ",
        affiliationKey: HASH_B,
        sourceImportBatchId,
        sourceRowNumber: 2,
      },
    ],
    status: "active",
    tokenHash: HASH_C,
    issuedAt,
    tokenExpiresAt: addFixedDays(issuedAt, 14),
    lastInvitationSentAt,
    contactPurgeAt: addUtcCalendarMonths(lastInvitationSentAt, 6),
    ...overrides,
  });
}

function activeConsent(overrides: Record<string, unknown> = {}) {
  return new ConsentRecord({
    subjectUserId: new mongoose.Types.ObjectId(),
    alumniProfileId: new mongoose.Types.ObjectId(),
    purpose: "alumni_profile_publication",
    consentVersion: "directory-v1",
    documentHash: HASH_A,
    status: "active",
    acceptedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  });
}

describe("alumni data retention helpers", () => {
  it("uses fixed days for token and raw-data deadlines", () => {
    const start = new Date("2024-02-20T04:05:06.007Z");
    expect(addFixedDays(start, 14).toISOString()).toBe(
      "2024-03-05T04:05:06.007Z",
    );
    expect(addFixedDays(start, 30).toISOString()).toBe(
      "2024-03-21T04:05:06.007Z",
    );
  });

  it("uses clamped UTC calendar months for approved retention", () => {
    expect(
      addUtcCalendarMonths(
        new Date("2023-08-31T12:30:00.000Z"),
        6,
      ).toISOString(),
    ).toBe("2024-02-29T12:30:00.000Z");
    expect(
      addUtcCalendarMonths(
        new Date("2025-01-31T23:59:59.999Z"),
        1,
      ).toISOString(),
    ).toBe("2025-02-28T23:59:59.999Z");
  });

  it("derives the same logical affiliation key from normalized identity", () => {
    expect(
      deriveAlumniAffiliationKey({
        programName: " EMBA   Mentor Circles ",
        cohortLabel: " 2022 ",
      }),
    ).toBe(
      deriveAlumniAffiliationKey({
        programName: "emba mentor circles",
        cohortLabel: "2022",
      }),
    );
  });

  it("preserves meaningful punctuation in affiliation identity", () => {
    expect(
      deriveAlumniAffiliationKey({ programName: "C++", cohortLabel: "2022" }),
    ).not.toBe(
      deriveAlumniAffiliationKey({ programName: "C", cohortLabel: "2022" }),
    );
    expect(
      deriveAlumniAffiliationKey({ programName: "A/B", cohortLabel: "2022" }),
    ).not.toBe(
      deriveAlumniAffiliationKey({ programName: "A B", cohortLabel: "2022" }),
    );
  });

  it("derives a stable companion key for canonical Program identity", () => {
    const programId = new mongoose.Types.ObjectId().toString();
    expect(
      deriveAlumniProgramAffiliationKey({
        programId: programId.toUpperCase(),
        cohortLabel: " 2022 ",
      }),
    ).toBe(
      deriveAlumniProgramAffiliationKey({
        programId,
        cohortLabel: "2022",
      }),
    );
  });
});

describe("AlumniProfile model", () => {
  it("normalizes profile display and derived search fields", async () => {
    const profile = new AlumniProfile({
      userId: new mongoose.Types.ObjectId(),
      professionalHeadline: "  Product   Manager ",
      industry: " Software ",
      skills: [" Product   Strategy "],
      searchProjection: {
        ...emptySearchProjection(),
        searchText: " José—Cloud ",
        displayNameKey: " José ",
      },
    });

    await expect(profile.validate()).resolves.toBeUndefined();
    expect(profile.professionalHeadline).toBe("Product Manager");
    expect(profile.skills).toEqual(["Product Strategy"]);
    expect(profile.searchProjection.searchText).toBe("jose cloud");
    expect(profile.searchProjection.displayNameKey).toBe("jose");
  });

  it("requires a consent pointer and timestamp only for published state", async () => {
    const invalid = new AlumniProfile({
      userId: new mongoose.Types.ObjectId(),
      publishStatus: "published",
      searchProjection: emptySearchProjection(),
    });
    await expect(invalid.validate()).rejects.toThrow("publishedAt");

    const valid = new AlumniProfile({
      userId: new mongoose.Types.ObjectId(),
      publishStatus: "published",
      currentPublicationConsentId: new mongoose.Types.ObjectId(),
      publishedAt: new Date("2026-09-11T00:00:00.000Z"),
      searchProjection: emptySearchProjection(),
    });
    await expect(valid.validate()).resolves.toBeUndefined();
  });

  it("enforces the account-deletion retention clock", async () => {
    const approvedAt = new Date("2026-01-01T00:00:00.000Z");
    const withinWindow = new AlumniProfile({
      userId: new mongoose.Types.ObjectId(),
      searchProjection: emptySearchProjection(),
      accountDeletionApprovedAt: approvedAt,
      purgeAt: addFixedDays(approvedAt, 29),
    });
    await expect(withinWindow.validate()).resolves.toBeUndefined();

    withinWindow.purgeAt = addFixedDays(approvedAt, 31);
    await expect(withinWindow.validate()).rejects.toThrow("within 30 days");
  });

  it("declares race-safe identity, directory, search, and TTL indexes", () => {
    expect(AlumniProfile.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { userId: 1 },
          expect.objectContaining({
            name: "uniq_alumni_profile_user",
            unique: true,
          }),
        ],
        [
          {
            publishStatus: 1,
            "searchProjection.displayNameKey": 1,
            _id: 1,
          },
          expect.objectContaining({ name: "idx_alumni_profile_directory" }),
        ],
        [
          { "searchProjection.searchText": "text" },
          expect.objectContaining({ name: "text_alumni_profile_search" }),
        ],
        [
          { purgeAt: 1 },
          expect.objectContaining({
            name: "ttl_alumni_profile_purge_at",
            expireAfterSeconds: 0,
          }),
        ],
      ]),
    );
  });

  it("keeps the search projection out of generic JSON", () => {
    const profile = new AlumniProfile({
      userId: new mongoose.Types.ObjectId(),
      searchProjection: emptySearchProjection(),
    }).toJSON();
    expect(profile).not.toHaveProperty("searchProjection");
    expect(profile).not.toHaveProperty("revision");
  });
});

describe("AlumniAffiliation model", () => {
  it("requires review provenance for verified affiliations", async () => {
    const affiliation = new AlumniAffiliation({
      alumniProfileId: new mongoose.Types.ObjectId(),
      programName: " EMBA   Mentor Circles ",
      cohortLabel: " 2022 ",
      affiliationKey: HASH_A,
      verificationStatus: "verified",
    });
    await expect(affiliation.validate()).rejects.toThrow("reviewedAt");

    affiliation.reviewedAt = new Date("2026-09-11T00:00:00.000Z");
    affiliation.reviewedBy = new mongoose.Types.ObjectId();
    await expect(affiliation.validate()).resolves.toBeUndefined();
    expect(affiliation.programName).toBe("EMBA Mentor Circles");
    expect(affiliation.affiliationKey).toBe(
      deriveAlumniAffiliationKey({
        programName: "EMBA Mentor Circles",
        cohortLabel: "2022",
      }),
    );
  });

  it("requires complete import provenance", async () => {
    const affiliation = new AlumniAffiliation({
      alumniProfileId: new mongoose.Types.ObjectId(),
      programName: "EMBA",
      affiliationKey: HASH_A,
      sourceRowNumber: 2,
    });
    await expect(affiliation.validate()).rejects.toThrow("batch and row");
  });

  it("derives both name and canonical Program identity keys", async () => {
    const programId = new mongoose.Types.ObjectId();
    const affiliation = new AlumniAffiliation({
      alumniProfileId: new mongoose.Types.ObjectId(),
      programId,
      programName: "EMBA",
      cohortLabel: "2022",
      affiliationKey: HASH_A,
    });

    await expect(affiliation.validate()).resolves.toBeUndefined();
    expect(affiliation.affiliationKey).toBe(
      deriveAlumniAffiliationKey({ programName: "EMBA", cohortLabel: "2022" }),
    );
    expect(affiliation.programAffiliationKey).toBe(
      deriveAlumniProgramAffiliationKey({
        programId: programId.toString(),
        cohortLabel: "2022",
      }),
    );
  });

  it("declares logical uniqueness and eligibility indexes", () => {
    expect(AlumniAffiliation.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { alumniProfileId: 1, affiliationKey: 1 },
          expect.objectContaining({
            name: "uniq_alumni_affiliation_profile_key",
            unique: true,
          }),
        ],
        [
          { alumniProfileId: 1, programAffiliationKey: 1 },
          expect.objectContaining({
            name: "uniq_alumni_affiliation_profile_program_key",
            unique: true,
          }),
        ],
        [
          { alumniProfileId: 1, verificationStatus: 1 },
          expect.objectContaining({
            name: "idx_alumni_affiliation_profile_verification",
          }),
        ],
        [
          { purgeAt: 1 },
          expect.objectContaining({ expireAfterSeconds: 0 }),
        ],
      ]),
    );
  });
});

describe("AlumniInvitation model", () => {
  it("accepts only hashed claim credentials and approved deadlines", async () => {
    const invitation = activeInvitation();
    await expect(invitation.validate()).resolves.toBeUndefined();
    expect(invitation.contactEmail).toBe("alumna@example.com");
    expect(invitation.tokenExpiresAt.toISOString()).toBe(
      "2023-09-14T12:30:00.000Z",
    );
    expect(invitation.contactPurgeAt.toISOString()).toBe(
      "2024-02-29T12:30:00.000Z",
    );
    expect(AlumniInvitation.schema.path("token")).toBeUndefined();
  });

  it("reports missing timestamps as validation errors instead of throwing raw errors", async () => {
    const invitation = activeInvitation({ issuedAt: undefined });
    await expect(invitation.validate()).rejects.toMatchObject({
      name: "ValidationError",
    });
  });

  it("keeps the contact lookup schema version fixed after creation", async () => {
    const invitation = activeInvitation();
    invitation.$isNew = false;
    invitation.contactLookupVersion = 2;
    await expect(invitation.validate()).rejects.toThrow(
      "contactLookupVersion cannot change",
    );
  });

  it("requires claim to clear token and contact data immediately", async () => {
    const claimedAt = new Date("2023-09-01T00:00:00.000Z");
    const invalid = activeInvitation({
      status: "claimed",
      claimedAt,
      claimedByUserId: new mongoose.Types.ObjectId(),
      contactPurgedAt: claimedAt,
    });
    await expect(invalid.validate()).rejects.toThrow("clear token and contact");

    const valid = activeInvitation({
      status: "claimed",
      claimedAt,
      claimedByUserId: new mongoose.Types.ObjectId(),
      contactPurgedAt: claimedAt,
      contactEmail: undefined,
      contactFirstName: undefined,
      contactLastName: undefined,
      contactLookupHash: undefined,
      activeContactLookupHash: undefined,
      tokenHash: undefined,
    });
    await expect(valid.validate()).resolves.toBeUndefined();
  });

  it("rejects claims at or after token expiry", async () => {
    const claimedAt = new Date("2023-09-14T12:30:00.000Z");
    const invitation = activeInvitation({
      status: "claimed",
      claimedAt,
      claimedByUserId: new mongoose.Types.ObjectId(),
      contactPurgedAt: claimedAt,
      contactEmail: undefined,
      contactFirstName: undefined,
      contactLastName: undefined,
      contactLookupHash: undefined,
      activeContactLookupHash: undefined,
      tokenHash: undefined,
    });
    await expect(invitation.validate()).rejects.toThrow("before token expiry");
  });

  it("allows matched invitations to be claimed only by the matched user", async () => {
    const claimedAt = new Date("2023-09-01T00:00:00.000Z");
    const invitation = activeInvitation({
      status: "claimed",
      matchedUserId: new mongoose.Types.ObjectId(),
      claimedAt,
      claimedByUserId: new mongoose.Types.ObjectId(),
      contactPurgedAt: claimedAt,
      contactEmail: undefined,
      contactFirstName: undefined,
      contactLastName: undefined,
      contactLookupHash: undefined,
      activeContactLookupHash: undefined,
      tokenHash: undefined,
    });

    await expect(invitation.validate()).rejects.toThrow("matched user");
    invitation.claimedByUserId = invitation.matchedUserId;
    await expect(invitation.validate()).resolves.toBeUndefined();
  });

  it("derives invitation affiliation keys and rejects logical duplicates", async () => {
    const invitation = activeInvitation();
    const first = invitation.affiliations[0];
    invitation.affiliations.push({
      programName: "emba",
      cohortLabel: "2022",
      affiliationKey: HASH_C,
      sourceImportBatchId: first.sourceImportBatchId,
      sourceRowNumber: 3,
    });
    await expect(invitation.validate()).rejects.toThrow("must be unique");
  });

  it("defaults contact and token fields to excluded and removes them from JSON", () => {
    for (const path of [
      "contactEmail",
      "contactFirstName",
      "contactLastName",
      "contactLookupHash",
      "activeContactLookupHash",
      "claimedByUserId",
      "tokenHash",
    ]) {
      expect(AlumniInvitation.schema.path(path).options.select).toBe(false);
    }

    const json = activeInvitation().toJSON();
    expect(json).not.toHaveProperty("contactEmail");
    expect(json).not.toHaveProperty("contactLookupHash");
    expect(json).not.toHaveProperty("tokenHash");
    expect(json).not.toHaveProperty("affiliations");
  });

  it("uses partial unique claim indexes without destructive TTL indexes", () => {
    const indexes = AlumniInvitation.schema.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        [
          { tokenHash: 1 },
          expect.objectContaining({
            name: "uniq_alumni_invitation_token_hash",
            unique: true,
            partialFilterExpression: { tokenHash: { $type: "string" } },
          }),
        ],
        [
          { activeContactLookupHash: 1 },
          expect.objectContaining({
            name: "uniq_alumni_invitation_active_contact",
            unique: true,
          }),
        ],
      ]),
    );
    expect(
      indexes.some(([, options]) => options.expireAfterSeconds !== undefined),
    ).toBe(false);
  });
});

describe("AlumniImportBatch model", () => {
  it("accepts bounded raw rows and non-negative progress counts", async () => {
    const batch = new AlumniImportBatch({
      checksum: HASH_A,
      createdBy: new mongoose.Types.ObjectId(),
      rawHeaders: ["email", "program"],
      rawRows: [
        { rowNumber: 2, values: ["amy@example.com", "EMBA"] },
        { rowNumber: 3, values: ["invalid", "EMBA"] },
      ],
      rowErrors: [
        {
          rowNumber: 3,
          field: "email",
          code: "invalid_email",
          message: "Email is invalid.",
        },
      ],
      rowResults: [
        {
          rowNumber: 2,
          rowKey: HASH_B,
          matchStatus: "ambiguous",
          candidateUserIds: [new mongoose.Types.ObjectId()],
          eligibilityStatus: "pending_review",
          applicationStatus: "pending",
        },
        {
          rowNumber: 3,
          rowKey: HASH_C,
          matchStatus: "invalid",
          eligibilityStatus: "not_applicable",
          applicationStatus: "pending",
        },
      ],
      counts: {
        totalRows: 2,
        validRows: 1,
        invalidRows: 1,
        ambiguousRows: 1,
      },
    });
    await expect(batch.validate()).resolves.toBeUndefined();
  });

  it("keeps the import schema version fixed after creation", async () => {
    const batch = new AlumniImportBatch({
      checksum: HASH_A,
      createdBy: new mongoose.Types.ObjectId(),
    });
    batch.$isNew = false;
    batch.schemaVersion = 2;
    await expect(batch.validate()).rejects.toThrow(
      "schemaVersion cannot change",
    );
  });

  it("requires durable reviewer provenance before applying a row", async () => {
    const batch = new AlumniImportBatch({
      checksum: HASH_A,
      createdBy: new mongoose.Types.ObjectId(),
      rawRows: [{ rowNumber: 2, values: ["amy@example.com"] }],
      rowResults: [
        {
          rowNumber: 2,
          rowKey: HASH_B,
          matchStatus: "unmatched",
          eligibilityStatus: "approved",
          applicationStatus: "applied",
          applicationUpdatedAt: new Date("2026-09-11T00:00:00.000Z"),
        },
      ],
      counts: {
        totalRows: 1,
        validRows: 1,
        unmatchedRows: 1,
        approvedRows: 1,
        appliedRows: 1,
      },
    });
    await expect(batch.validate()).rejects.toThrow("reviewer provenance");

    batch.rowResults![0].reviewedAt = new Date("2026-09-10T00:00:00.000Z");
    batch.rowResults![0].reviewedBy = new mongoose.Types.ObjectId();
    await expect(batch.validate()).resolves.toBeUndefined();
  });

  it("enforces separate 30-day raw and six-month summary clocks", async () => {
    const terminalAt = new Date("2026-01-31T08:00:00.000Z");
    const valid = new AlumniImportBatch({
      checksum: HASH_A,
      createdBy: new mongoose.Types.ObjectId(),
      status: "completed",
      rawRows: [],
      rowResults: [],
      terminalAt,
      rawDataPurgeAt: addFixedDays(terminalAt, 30),
      purgeAt: addUtcCalendarMonths(terminalAt, 6),
    });
    await expect(valid.validate()).resolves.toBeUndefined();

    valid.rawDataPurgeAt = addFixedDays(terminalAt, 29);
    await expect(valid.validate()).rejects.toThrow("30 days");
  });

  it("requires every completed row to have a closed business disposition", async () => {
    const terminalAt = new Date("2026-01-31T08:00:00.000Z");
    const reviewedAt = new Date("2026-01-30T08:00:00.000Z");
    const appliedAt = new Date("2026-01-31T07:00:00.000Z");
    const reviewedBy = new mongoose.Types.ObjectId();
    const matchedUserId = new mongoose.Types.ObjectId();
    const candidateUserId = new mongoose.Types.ObjectId();
    const batch = new AlumniImportBatch({
      checksum: HASH_A,
      createdBy: new mongoose.Types.ObjectId(),
      status: "completed",
      rawRows: [
        { rowNumber: 2, values: ["matched"] },
        { rowNumber: 3, values: ["unmatched"] },
        { rowNumber: 4, values: ["ambiguous"] },
        { rowNumber: 5, values: ["invalid"] },
      ],
      rowResults: [
        {
          rowNumber: 2,
          rowKey: HASH_A,
          matchStatus: "matched",
          matchedUserId,
          eligibilityStatus: "approved",
          reviewedAt,
          reviewedBy,
          applicationStatus: "applied",
          applicationUpdatedAt: appliedAt,
        },
        {
          rowNumber: 3,
          rowKey: HASH_B,
          matchStatus: "unmatched",
          eligibilityStatus: "approved",
          reviewedAt,
          reviewedBy,
          applicationStatus: "skipped",
          applicationUpdatedAt: appliedAt,
        },
        {
          rowNumber: 4,
          rowKey: HASH_C,
          matchStatus: "ambiguous",
          candidateUserIds: [candidateUserId],
          eligibilityStatus: "rejected",
          reviewedAt,
          reviewedBy,
          applicationStatus: "skipped",
          applicationUpdatedAt: appliedAt,
        },
        {
          rowNumber: 5,
          rowKey: "d".repeat(64),
          matchStatus: "invalid",
          eligibilityStatus: "not_applicable",
          applicationStatus: "skipped",
          applicationUpdatedAt: appliedAt,
        },
      ],
      counts: {
        totalRows: 4,
        validRows: 3,
        invalidRows: 1,
        matchedRows: 1,
        unmatchedRows: 1,
        ambiguousRows: 1,
        approvedRows: 2,
        rejectedRows: 1,
        appliedRows: 1,
      },
      terminalAt,
      rawDataPurgeAt: addFixedDays(terminalAt, 30),
      purgeAt: addUtcCalendarMonths(terminalAt, 6),
    });

    await expect(batch.validate()).resolves.toBeUndefined();

    batch.rowResults![2].eligibilityStatus = "approved";
    batch.counts.approvedRows = 3;
    batch.counts.rejectedRows = 0;
    await expect(batch.validate()).rejects.toThrow(
      "Ambiguous rows must be resolved",
    );
  });

  it("keeps completed summary counts closed after raw-data cleanup", async () => {
    const terminalAt = new Date("2026-01-31T08:00:00.000Z");
    const rawDataPurgeAt = addFixedDays(terminalAt, 30);
    const batch = new AlumniImportBatch({
      checksum: HASH_A,
      createdBy: new mongoose.Types.ObjectId(),
      status: "completed",
      counts: { totalRows: 1 },
      terminalAt,
      rawDataPurgeAt,
      rawDataPurgedAt: rawDataPurgeAt,
      purgeAt: addUtcCalendarMonths(terminalAt, 6),
    });

    await expect(batch.validate()).rejects.toThrow(
      "classify every row",
    );
  });

  it("does not allow import raw data to be purged before its deadline", async () => {
    const terminalAt = new Date("2026-01-31T08:00:00.000Z");
    const rawDataPurgeAt = addFixedDays(terminalAt, 30);
    const batch = new AlumniImportBatch({
      checksum: HASH_A,
      createdBy: new mongoose.Types.ObjectId(),
      status: "completed",
      rawDataPurgedAt: addFixedDays(rawDataPurgeAt, -1),
      terminalAt,
      rawDataPurgeAt,
      purgeAt: addUtcCalendarMonths(terminalAt, 6),
    });

    await expect(batch.validate()).rejects.toThrow(
      "before rawDataPurgeAt",
    );
  });

  it("keeps raw-data cleanup non-TTL and summary deletion TTL-based", () => {
    expect(AlumniImportBatch.schema.path("rawRows").options.select).toBe(false);
    expect(AlumniImportBatch.schema.path("rowErrors").options.select).toBe(false);
    expect(AlumniImportBatch.schema.path("rowResults").options.select).toBe(false);
    expect(AlumniImportBatch.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { checksum: 1, createdAt: -1 },
          expect.not.objectContaining({ unique: true }),
        ],
        [
          { rawDataPurgedAt: 1, rawDataPurgeAt: 1 },
          expect.not.objectContaining({ expireAfterSeconds: expect.anything() }),
        ],
        [
          { purgeAt: 1 },
          expect.objectContaining({
            name: "ttl_alumni_import_batch_purge_at",
            expireAfterSeconds: 0,
          }),
        ],
      ]),
    );
  });
});

describe("ConsentRecord model", () => {
  it("accepts minimal immutable publication consent evidence", async () => {
    await expect(activeConsent().validate()).resolves.toBeUndefined();
  });

  it("requires a single termination reason and twelve-month purge clock", async () => {
    const withdrawnAt = new Date("2024-01-31T12:00:00.000Z");
    const consent = activeConsent({
      acceptedAt: new Date("2023-01-01T00:00:00.000Z"),
      status: "withdrawn",
      withdrawnAt,
      purgeAt: addUtcCalendarMonths(withdrawnAt, 12),
    });
    await expect(consent.validate()).resolves.toBeUndefined();

    consent.purgeAt = addFixedDays(withdrawnAt, 365);
    await expect(consent.validate()).rejects.toThrow("twelve UTC calendar months");
  });

  it("declares active-consent uniqueness and terminal-record TTL", () => {
    expect(ConsentRecord.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { subjectUserId: 1, purpose: 1 },
          expect.objectContaining({
            unique: true,
            partialFilterExpression: { status: "active" },
          }),
        ],
        [
          { alumniProfileId: 1, purpose: 1 },
          expect.objectContaining({
            unique: true,
            partialFilterExpression: { status: "active" },
          }),
        ],
        [
          { purgeAt: 1 },
          expect.objectContaining({ expireAfterSeconds: 0 }),
        ],
      ]),
    );
  });
});

describe("alumni model strictness", () => {
  it("rejects unknown root and nested fields", async () => {
    expect(
      () =>
        new AlumniProfile({
          userId: new mongoose.Types.ObjectId(),
          searchProjection: emptySearchProjection(),
          unexpected: true,
        }),
    ).toThrow();
    const nested = new AlumniImportBatch({
      checksum: HASH_A,
      createdBy: new mongoose.Types.ObjectId(),
      counts: { totalRows: 0, unexpected: 1 },
    });
    await expect(nested.validate()).rejects.toThrow();
  });
});
