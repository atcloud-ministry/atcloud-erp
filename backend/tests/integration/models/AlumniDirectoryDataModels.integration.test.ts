import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addFixedDays,
  addUtcCalendarMonths,
} from "../../../src/contracts/alumniDirectoryData";
import AlumniAffiliation from "../../../src/models/AlumniAffiliation";
import AlumniImportBatch from "../../../src/models/AlumniImportBatch";
import AlumniInvitation from "../../../src/models/AlumniInvitation";
import AlumniProfile from "../../../src/models/AlumniProfile";
import ConsentRecord from "../../../src/models/ConsentRecord";
import { initializeAlumniDataModels } from "../../../src/models/initializeAlumniDataModels";
import { ensureIntegrationDB } from "../setup/connect";

const hash = (character: string) => character.repeat(64);

function profileInput(userId: mongoose.Types.ObjectId) {
  return { userId };
}

function invitationInput(options: {
  email: string;
  contactHash: string;
  tokenHash: string;
}) {
  const issuedAt = new Date("2030-08-31T12:00:00.000Z");
  const batchId = new mongoose.Types.ObjectId();
  const reviewedBy = new mongoose.Types.ObjectId();
  return {
    sourceImportBatchIds: [batchId],
    contactEmail: options.email,
    contactLookupHash: options.contactHash,
    activeContactLookupHash: options.contactHash,
    affiliations: [
      {
        programName: "EMBA",
        cohortLabel: "2022",
        affiliationKey: hash("f"),
        sourceImportBatchId: batchId,
        sourceRowNumber: 2,
        reviewedAt: new Date("2030-08-30T12:00:00.000Z"),
        reviewedBy,
      },
    ],
    tokenHash: options.tokenHash,
    issuedAt,
    tokenExpiresAt: addFixedDays(issuedAt, 14),
    lastInvitationSentAt: issuedAt,
    contactPurgeAt: addUtcCalendarMonths(issuedAt, 6),
  };
}

function activeConsentInput(options: {
  subjectUserId: mongoose.Types.ObjectId;
  alumniProfileId: mongoose.Types.ObjectId;
  consentVersion: string;
}) {
  return {
    ...options,
    purpose: "alumni_profile_publication" as const,
    documentHash: hash("a"),
    acceptedAt: new Date("2030-01-01T00:00:00.000Z"),
  };
}

function expectSingleDuplicateResult(
  outcomes: PromiseSettledResult<unknown>[],
) {
  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(
    1,
  );
  const rejected = outcomes.find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
  );
  expect(rejected).toBeDefined();
  expect((rejected?.reason as { code?: number }).code).toBe(11000);
}

const models = [
  AlumniProfile,
  AlumniAffiliation,
  AlumniInvitation,
  AlumniImportBatch,
  ConsentRecord,
] as const;

describe("M2 alumni data model indexes", () => {
  beforeAll(async () => {
    await ensureIntegrationDB();
    await initializeAlumniDataModels();
  });

  beforeEach(async () => {
    await Promise.all(models.map((model) => model.deleteMany({})));
  });

  afterAll(async () => {
    await Promise.all(models.map((model) => model.deleteMany({})));
  });

  it("creates all stable unique, query, cleanup, search, and TTL indexes", async () => {
    const [profile, affiliation, invitation, batch, consent] = await Promise.all(
      models.map((model) => model.collection.indexes()),
    );

    expect(profile).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "uniq_alumni_profile_user",
          key: { userId: 1 },
          unique: true,
        }),
        expect.objectContaining({
          name: "text_alumni_profile_search",
          key: { _fts: "text", _ftsx: 1 },
        }),
        expect.objectContaining({
          name: "ttl_alumni_profile_purge_at",
          key: { purgeAt: 1 },
          expireAfterSeconds: 0,
        }),
      ]),
    );
    expect(affiliation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "uniq_alumni_affiliation_profile_external_key",
          unique: true,
        }),
        expect.objectContaining({
          name: "uniq_alumni_affiliation_profile_program_key",
          unique: true,
        }),
        expect.objectContaining({
          name: "ttl_alumni_affiliation_purge_at",
          expireAfterSeconds: 0,
        }),
        expect.objectContaining({
          name: "idx_alumni_affiliation_source",
        }),
      ]),
    );
    expect(invitation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "uniq_alumni_invitation_token_hash",
          unique: true,
          partialFilterExpression: { tokenHash: { $type: "string" } },
        }),
        expect.objectContaining({
          name: "uniq_alumni_invitation_active_contact",
          unique: true,
        }),
        expect.objectContaining({
          name: "idx_alumni_invitation_contact_cleanup",
        }),
      ]),
    );
    expect(batch).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "idx_alumni_import_batch_checksum",
        }),
        expect.objectContaining({
          name: "idx_alumni_import_batch_raw_cleanup",
        }),
        expect.objectContaining({
          name: "ttl_alumni_import_batch_purge_at",
          expireAfterSeconds: 0,
        }),
      ]),
    );
    expect(consent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "uniq_consent_record_active_user_purpose",
          unique: true,
          partialFilterExpression: { status: "active" },
        }),
        expect.objectContaining({
          name: "uniq_consent_record_active_profile_purpose",
          unique: true,
        }),
        expect.objectContaining({
          name: "ttl_consent_record_purge_at",
          expireAfterSeconds: 0,
        }),
      ]),
    );

    expect(
      invitation.some(
        (index) =>
          index.expireAfterSeconds !== undefined &&
          ("tokenExpiresAt" in index.key || "contactPurgeAt" in index.key),
      ),
    ).toBe(false);
    expect(
      batch.some(
        (index) =>
          index.expireAfterSeconds !== undefined &&
          "rawDataPurgeAt" in index.key,
      ),
    ).toBe(false);
  });

  it("allows only one profile per User under concurrent inserts", async () => {
    const userId = new mongoose.Types.ObjectId();
    const outcomes = await Promise.allSettled([
      AlumniProfile.create(profileInput(userId)),
      AlumniProfile.create(profileInput(userId)),
    ]);
    expectSingleDuplicateResult(outcomes);
  });

  it("allows only one external name-based affiliation per profile", async () => {
    const alumniProfileId = new mongoose.Types.ObjectId();
    const outcomes = await Promise.allSettled([
      AlumniAffiliation.create({
        alumniProfileId,
        programName: " EMBA   Mentor Circles ",
        cohortLabel: " 2022 ",
        affiliationKey: hash("a"),
      }),
      AlumniAffiliation.create({
        alumniProfileId,
        programName: "emba mentor circles",
        cohortLabel: "2022",
        affiliationKey: hash("b"),
      }),
    ]);
    expectSingleDuplicateResult(outcomes);
  });

  it("keeps same-title linked Programs and an external affiliation distinct", async () => {
    const alumniProfileId = new mongoose.Types.ObjectId();
    const outcomes = await Promise.allSettled([
      AlumniAffiliation.create({
        alumniProfileId,
        programId: new mongoose.Types.ObjectId(),
        programName: "EMBA Mentor Circles",
        cohortLabel: "2022",
        affiliationKey: hash("a"),
      }),
      AlumniAffiliation.create({
        alumniProfileId,
        programId: new mongoose.Types.ObjectId(),
        programName: "EMBA Mentor Circles",
        cohortLabel: "2022",
        affiliationKey: hash("b"),
      }),
      AlumniAffiliation.create({
        alumniProfileId,
        programName: "EMBA Mentor Circles",
        cohortLabel: "2022",
        affiliationKey: hash("c"),
      }),
    ]);

    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(
      true,
    );
  });

  it("deduplicates renamed affiliations linked to the same Program", async () => {
    const alumniProfileId = new mongoose.Types.ObjectId();
    const programId = new mongoose.Types.ObjectId();
    const outcomes = await Promise.allSettled([
      AlumniAffiliation.create({
        alumniProfileId,
        programId,
        programName: "EMBA Legacy Name",
        cohortLabel: "2022",
        affiliationKey: hash("a"),
      }),
      AlumniAffiliation.create({
        alumniProfileId,
        programId,
        programName: "EMBA Current Name",
        cohortLabel: "2022",
        affiliationKey: hash("b"),
      }),
    ]);
    expectSingleDuplicateResult(outcomes);
  });

  it("prevents duplicate active contacts and duplicate token hashes", async () => {
    const duplicateContact = await Promise.allSettled([
      AlumniInvitation.create(
        invitationInput({
          email: "one@example.com",
          contactHash: hash("a"),
          tokenHash: hash("b"),
        }),
      ),
      AlumniInvitation.create(
        invitationInput({
          email: "one@example.com",
          contactHash: hash("a"),
          tokenHash: hash("c"),
        }),
      ),
    ]);
    expectSingleDuplicateResult(duplicateContact);

    await AlumniInvitation.deleteMany({});
    const duplicateToken = await Promise.allSettled([
      AlumniInvitation.create(
        invitationInput({
          email: "one@example.com",
          contactHash: hash("a"),
          tokenHash: hash("d"),
        }),
      ),
      AlumniInvitation.create(
        invitationInput({
          email: "two@example.com",
          contactHash: hash("e"),
          tokenHash: hash("d"),
        }),
      ),
    ]);
    expectSingleDuplicateResult(duplicateToken);
  });

  it("allows only one active publication consent while retaining history", async () => {
    const subjectUserId = new mongoose.Types.ObjectId();
    const alumniProfileId = new mongoose.Types.ObjectId();
    const outcomes = await Promise.allSettled([
      ConsentRecord.create(
        activeConsentInput({
          subjectUserId,
          alumniProfileId,
          consentVersion: "v1",
        }),
      ),
      ConsentRecord.create(
        activeConsentInput({
          subjectUserId,
          alumniProfileId,
          consentVersion: "v2",
        }),
      ),
    ]);
    expectSingleDuplicateResult(outcomes);

    await ConsentRecord.deleteMany({});
    const withdrawnAt = new Date("2030-02-01T00:00:00.000Z");
    await expect(
      ConsentRecord.create([
        {
          ...activeConsentInput({
            subjectUserId,
            alumniProfileId,
            consentVersion: "v1",
          }),
          status: "withdrawn",
          withdrawnAt,
          purgeAt: addUtcCalendarMonths(withdrawnAt, 12),
        },
        {
          ...activeConsentInput({
            subjectUserId,
            alumniProfileId,
            consentVersion: "v2",
          }),
          status: "withdrawn",
          withdrawnAt,
          purgeAt: addUtcCalendarMonths(withdrawnAt, 12),
        },
      ]),
    ).resolves.toHaveLength(2);
  });

  it("allows import reruns with the same checksum", async () => {
    const createdBy = new mongoose.Types.ObjectId();
    await expect(
      AlumniImportBatch.create([
        { checksum: hash("a"), createdBy },
        {
          checksum: hash("a"),
          createdBy,
          rerunOfBatchId: new mongoose.Types.ObjectId(),
        },
      ]),
    ).resolves.toHaveLength(2);
  });

  it("excludes invitation contact, lookup, and token hashes by default", async () => {
    const created = await AlumniInvitation.create(
      invitationInput({
        email: "private@example.com",
        contactHash: hash("a"),
        tokenHash: hash("b"),
      }),
    );

    const defaultResult = await AlumniInvitation.findById(created._id).lean();
    expect(defaultResult).not.toHaveProperty("contactEmail");
    expect(defaultResult).not.toHaveProperty("contactLookupHash");
    expect(defaultResult).not.toHaveProperty("activeContactLookupHash");
    expect(defaultResult).not.toHaveProperty("tokenHash");
    expect(defaultResult).not.toHaveProperty("matchedUserId");

    const explicitResult = await AlumniInvitation.findById(created._id)
      .select(
        "+contactEmail +contactLookupHash +activeContactLookupHash +tokenHash",
      )
      .lean();
    expect(explicitResult?.contactEmail).toBe("private@example.com");
    expect(explicitResult?.tokenHash).toBe(hash("b"));

    const raw = await AlumniInvitation.collection.findOne({ _id: created._id });
    expect(raw).not.toHaveProperty("token");
    expect(raw?.tokenHash).toBe(hash("b"));
  });

  it("refuses document lifecycle changes when private invitation state was not loaded", async () => {
    const created = await AlumniInvitation.create(
      invitationInput({
        email: "claim@example.com",
        contactHash: hash("a"),
        tokenHash: hash("b"),
      }),
    );
    const partial = await AlumniInvitation.findById(created._id);
    expect(partial).not.toBeNull();
    partial!.status = "claimed";
    partial!.claimedAt = new Date("2030-09-01T00:00:00.000Z");
    partial!.claimedByUserId = new mongoose.Types.ObjectId();
    partial!.contactPurgedAt = partial!.claimedAt;

    await expect(partial!.validate()).rejects.toThrow(
      "explicitly load all private fields",
    );

    const raw = await AlumniInvitation.collection.findOne({ _id: created._id });
    expect(raw?.contactEmail).toBe("claim@example.com");
    expect(raw?.tokenHash).toBe(hash("b"));
    expect(raw?.status).toBe("active");
  });

  it("allows a fully loaded invitation document to be safely saved", async () => {
    const created = await AlumniInvitation.create(
      invitationInput({
        email: "save@example.com",
        contactHash: hash("a"),
        tokenHash: hash("b"),
      }),
    );
    const complete = await AlumniInvitation.findById(created._id).select(
      "+contactEmail +contactFirstName +contactLastName +contactLookupHash " +
        "+activeContactLookupHash +matchedUserId +claimedByUserId +tokenHash",
    );
    expect(complete).not.toBeNull();
    complete!.revision = 1;

    await expect(complete!.save()).resolves.toMatchObject({ revision: 1 });
  });

  it("excludes import raw rows and errors by default", async () => {
    const created = await AlumniImportBatch.create({
      checksum: hash("a"),
      createdBy: new mongoose.Types.ObjectId(),
      rawHeaders: ["email"],
      rawRows: [{ rowNumber: 2, values: ["private@example.com"] }],
      rowErrors: [
        {
          rowNumber: 2,
          field: "email",
          code: "review_required",
          message: "Review is required.",
        },
      ],
      rowResults: [
        {
          rowNumber: 2,
          rowKey: hash("b"),
          matchStatus: "unmatched",
          matchMethod: "none",
          eligibilityStatus: "pending_review",
          applicationStatus: "pending",
        },
      ],
      counts: { totalRows: 1, validRows: 1, unmatchedRows: 1 },
    });

    const result = await AlumniImportBatch.findById(created._id).lean();
    expect(result).not.toHaveProperty("rawHeaders");
    expect(result).not.toHaveProperty("rawRows");
    expect(result).not.toHaveProperty("rowErrors");
    expect(result).not.toHaveProperty("rowResults");
  });

  it("requires an explicit, due raw-data purge and verifies physical removal", async () => {
    const terminalAt = new Date("2030-01-01T00:00:00.000Z");
    const rawDataPurgeAt = addFixedDays(terminalAt, 30);
    const reviewedBy = new mongoose.Types.ObjectId();
    const created = await AlumniImportBatch.create({
      checksum: hash("a"),
      createdBy: new mongoose.Types.ObjectId(),
      status: "completed",
      rawHeaders: ["email"],
      rawRows: [{ rowNumber: 2, values: ["private@example.com"] }],
      rowErrors: [],
      rowResults: [
        {
          rowNumber: 2,
          rowKey: hash("b"),
          matchStatus: "unmatched",
          matchMethod: "none",
          eligibilityStatus: "approved",
          reviewedAt: terminalAt,
          reviewedBy,
          applicationStatus: "applied",
          applicationUpdatedAt: terminalAt,
        },
      ],
      counts: {
        totalRows: 1,
        validRows: 1,
        unmatchedRows: 1,
        approvedRows: 1,
        appliedRows: 1,
      },
      terminalAt,
      rawDataPurgeAt,
      purgeAt: addUtcCalendarMonths(terminalAt, 6),
    });

    const partial = await AlumniImportBatch.findById(created._id);
    expect(partial).not.toBeNull();
    partial!.rawDataPurgedAt = rawDataPurgeAt;
    await expect(partial!.save()).rejects.toThrow(
      "explicitly load every private row field",
    );

    const retained = await AlumniImportBatch.collection.findOne({
      _id: created._id,
    });
    expect(retained).toHaveProperty("rawHeaders");
    expect(retained).toHaveProperty("rawRows");
    expect(retained).toHaveProperty("rowErrors");
    expect(retained).toHaveProperty("rowResults");
    expect(retained?.rawDataPurgedAt).toBeNull();

    const complete = await AlumniImportBatch.findById(created._id).select(
      "+rawHeaders +rawRows +rowErrors +rowResults",
    );
    expect(complete).not.toBeNull();
    complete!.rawHeaders = undefined;
    complete!.rawRows = undefined;
    complete!.rowErrors = undefined;
    complete!.rowResults = undefined;
    complete!.rawDataPurgedAt = rawDataPurgeAt;
    await complete!.save();

    const purged = await AlumniImportBatch.collection.findOne({
      _id: created._id,
    });
    expect(purged).not.toHaveProperty("rawHeaders");
    expect(purged).not.toHaveProperty("rawRows");
    expect(purged).not.toHaveProperty("rowErrors");
    expect(purged).not.toHaveProperty("rowResults");
    expect(purged?.rawDataPurgedAt).toEqual(rawDataPurgeAt);
  });
});
