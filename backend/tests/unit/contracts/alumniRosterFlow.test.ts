import { describe, expect, it } from "vitest";
import type { UserPickerDTO } from "../../../src/contracts/userReadContracts";
import {
  ALUMNI_IMPORT_REVIEW_MAX_DECISIONS,
  AlumniRosterFlowValidationError,
  buildAlumniImportAdminRowDTO,
  buildAlumniImportAdminRowsPageDTO,
  buildAlumniImportBatchSummaryDTO,
  buildAlumniInvitationAdminListPageDTO,
  buildAlumniInvitationClaimResultDTO,
  buildAlumniInvitationReissueResultDTO,
  parseAlumniImportApplyBody,
  parseAlumniImportBatchListQuery,
  parseAlumniImportDryRunBody,
  parseAlumniImportRerunBody,
  parseAlumniImportReviewBody,
  parseAlumniImportRowListQuery,
  parseAlumniInvitationClaimBody,
  parseAlumniInvitationListQuery,
  parseAlumniInvitationReissueBody,
  parseAlumniObjectId,
  type AlumniImportAdminRowInput,
  type AlumniImportBatchSummaryInput,
  type AlumniInvitationAdminListItemInput,
} from "../../../src/contracts/alumniRosterFlow";

const BATCH_ID = "507f191e810c19729de860ea";
const ACTOR_ID = "507f1f77bcf86cd799439011";
const USER_ID = "507f191e810c19729de860eb";
const PROFILE_ID = "507f191e810c19729de860ec";
const AFFILIATION_ID = "507f191e810c19729de860ed";
const ROW_KEY = "a".repeat(64);
const CHECKSUM = "b".repeat(64);
const TOKEN = "A".repeat(42) + "_";

const COUNTS = Object.freeze({
  totalRows: 2,
  validRows: 1,
  invalidRows: 1,
  matchedRows: 1,
  unmatchedRows: 0,
  ambiguousRows: 0,
  approvedRows: 1,
  rejectedRows: 0,
  appliedRows: 0,
  invitationsCreated: 0,
  affiliationsCreated: 0,
});

const SUMMARY_INPUT: AlumniImportBatchSummaryInput = Object.freeze({
  id: BATCH_ID,
  checksum: CHECKSUM,
  status: "review_ready",
  counts: COUNTS,
  createdById: ACTOR_ID,
  rerunOfBatchId: null,
  terminalAt: null,
  rawDataAvailable: true,
  revision: 3,
  createdAt: new Date("2026-09-12T01:00:00.000Z"),
  updatedAt: "2026-09-12T02:00:00.000Z",
});

const PICKER: UserPickerDTO = Object.freeze({
  id: USER_ID,
  username: "alumni_user",
  firstName: "Amy",
  lastName: "Chen",
  avatar: null,
  gender: "female",
  role: "Participant",
  roleInAtCloud: null,
});

const ROW_INPUT: AlumniImportAdminRowInput = Object.freeze({
  rowNumber: 2,
  rowKey: ROW_KEY,
  contactEmail: "amy@example.com",
  contactFirstName: "Amy",
  contactLastName: "Chen",
  programName: "EMBA Mentor Circles",
  cohortLabel: "2022",
  programId: null,
  matchStatus: "matched",
  matchMethod: "exact_email",
  matchedUser: PICKER,
  candidateUsers: [],
  eligibilityStatus: "approved",
  reviewedAt: new Date("2026-09-12T02:30:00.000Z"),
  reviewedById: ACTOR_ID,
  applicationStatus: "pending",
  applicationUpdatedAt: null,
  errors: [],
});

function expectValidationError(operation: () => unknown): void {
  expect(operation).toThrow(AlumniRosterFlowValidationError);
}

describe("alumni roster list and id contracts", () => {
  it("parses batch-list defaults and an indexed status filter", () => {
    expect(parseAlumniImportBatchListQuery({})).toEqual({
      page: 1,
      limit: 20,
    });
    expect(
      parseAlumniImportBatchListQuery({
        page: "2",
        limit: "100",
        status: "review_ready",
      }),
    ).toEqual({ page: 2, limit: 100, status: "review_ready" });
  });

  it("keeps the private-row list query pagination-only", () => {
    expect(parseAlumniImportRowListQuery({ page: "3", limit: "25" })).toEqual(
      { page: 3, limit: 25 },
    );
    expectValidationError(() =>
      parseAlumniImportRowListQuery({ page: "1", status: "matched" }),
    );
  });

  it("parses strict invitation list pagination and indexed filters", () => {
    expect(parseAlumniInvitationListQuery({})).toEqual({ page: 1, limit: 20 });
    expect(
      parseAlumniInvitationListQuery({
        page: "2",
        limit: "50",
        status: "active",
        batchId: BATCH_ID.toUpperCase(),
      }),
    ).toEqual({
      page: 2,
      limit: 50,
      status: "active",
      batchId: BATCH_ID,
    });
    expectValidationError(() =>
      parseAlumniInvitationListQuery({ status: "expired" }),
    );
    expectValidationError(() =>
      parseAlumniInvitationListQuery({ batchId: "not-an-id" }),
    );
    expectValidationError(() =>
      parseAlumniInvitationListQuery({ page: ["1", "2"] }),
    );
    expectValidationError(() =>
      parseAlumniInvitationListQuery({ search: "amy@example.com" }),
    );
  });

  it("rejects arrays, unknown query keys, and excessive limits", () => {
    expectValidationError(() =>
      parseAlumniImportBatchListQuery({ page: ["1", "2"] }),
    );
    expectValidationError(() =>
      parseAlumniImportBatchListQuery({ search: "private" }),
    );
    expectValidationError(() =>
      parseAlumniImportBatchListQuery({ limit: "101" }),
    );
    expectValidationError(() =>
      parseAlumniImportBatchListQuery({
        page: String(Number.MAX_SAFE_INTEGER),
      }),
    );
  });

  it("normalizes a valid ObjectId and rejects Mongoose-style loose values", () => {
    expect(parseAlumniObjectId(BATCH_ID.toUpperCase())).toBe(BATCH_ID);
    expectValidationError(() => parseAlumniObjectId(123));
    expectValidationError(() => parseAlumniObjectId("abcdefghijkl"));
  });
});

describe("alumni roster mutation request bodies", () => {
  it("accepts only an empty dry-run body", () => {
    expect(parseAlumniImportDryRunBody(undefined)).toEqual({});
    expect(parseAlumniImportDryRunBody(Object.create(null))).toEqual({});
    expectValidationError(() =>
      parseAlumniImportDryRunBody({ originalFilename: "roster.csv" }),
    );
  });

  it("requires a numeric expectedRevision for apply, rerun, and reissue", () => {
    expect(parseAlumniImportApplyBody({ expectedRevision: 0 })).toEqual({
      expectedRevision: 0,
    });
    expect(parseAlumniImportRerunBody({ expectedRevision: 4 })).toEqual({
      expectedRevision: 4,
    });
    expect(parseAlumniInvitationReissueBody({ expectedRevision: 2 })).toEqual({
      expectedRevision: 2,
    });

    expectValidationError(() => parseAlumniImportApplyBody({}));
    expectValidationError(() =>
      parseAlumniImportRerunBody({ expectedRevision: "4" }),
    );
    expectValidationError(() =>
      parseAlumniInvitationReissueBody({
        expectedRevision: 2,
        invitationId: BATCH_ID,
      }),
    );
  });

  it("parses matched and unmatched review resolutions", () => {
    const parsed = parseAlumniImportReviewBody({
      expectedRevision: 7,
      decisions: [
        {
          rowNumber: 2,
          rowKey: ROW_KEY,
          eligibilityStatus: "approved",
          resolution: { matchStatus: "matched", matchedUserId: USER_ID },
        },
        {
          rowNumber: 3,
          rowKey: "c".repeat(64),
          eligibilityStatus: "rejected",
          resolution: { matchStatus: "unmatched" },
          reviewReasonCode: "not_eligible",
        },
      ],
    });

    expect(parsed).toEqual({
      expectedRevision: 7,
      decisions: [
        {
          rowNumber: 2,
          rowKey: ROW_KEY,
          eligibilityStatus: "approved",
          resolution: { matchStatus: "matched", matchedUserId: USER_ID },
        },
        {
          rowNumber: 3,
          rowKey: "c".repeat(64),
          eligibilityStatus: "rejected",
          resolution: { matchStatus: "unmatched" },
          reviewReasonCode: "not_eligible",
        },
      ],
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.decisions)).toBe(true);
    expect(Object.isFrozen(parsed.decisions[0].resolution)).toBe(true);
  });

  it("requires row identity and rejects duplicate decisions", () => {
    expectValidationError(() =>
      parseAlumniImportReviewBody({
        expectedRevision: 0,
        decisions: [
          { rowNumber: 1, eligibilityStatus: "approved" },
        ],
      }),
    );
    expectValidationError(() =>
      parseAlumniImportReviewBody({
        expectedRevision: 0,
        decisions: [
          { rowNumber: 1, rowKey: ROW_KEY, eligibilityStatus: "approved" },
          { rowNumber: 1, rowKey: "c".repeat(64), eligibilityStatus: "rejected" },
        ],
      }),
    );
  });

  it("bounds review batches at 500 decisions", () => {
    const decisions = Array.from(
      { length: ALUMNI_IMPORT_REVIEW_MAX_DECISIONS + 1 },
      (_, index) => ({
        rowNumber: index + 1,
        rowKey: index.toString(16).padStart(64, "0"),
        eligibilityStatus: "approved",
      }),
    );
    expectValidationError(() =>
      parseAlumniImportReviewBody({ expectedRevision: 0, decisions }),
    );
  });

  it("rejects malformed resolutions, unknown keys, and accessor input", () => {
    expectValidationError(() =>
      parseAlumniImportReviewBody({
        expectedRevision: 0,
        decisions: [
          {
            rowNumber: 1,
            rowKey: ROW_KEY,
            eligibilityStatus: "approved",
            resolution: {
              matchStatus: "unmatched",
              matchedUserId: USER_ID,
            },
          },
        ],
      }),
    );

    const accessor: Record<string, unknown> = { decisions: [] };
    Object.defineProperty(accessor, "expectedRevision", {
      enumerable: true,
      get: () => 0,
    });
    expectValidationError(() => parseAlumniImportReviewBody(accessor));
  });

  it("accepts only an exact 43-character base64url claim token", () => {
    expect(parseAlumniInvitationClaimBody({ token: TOKEN })).toEqual({
      token: TOKEN,
    });
    expectValidationError(() =>
      parseAlumniInvitationClaimBody({ token: `${TOKEN}=` }),
    );
    expectValidationError(() =>
      parseAlumniInvitationClaimBody({ token: "-".repeat(42) }),
    );
    expectValidationError(() =>
      parseAlumniInvitationClaimBody({ token: TOKEN, expectedRevision: 0 }),
    );
  });
});

describe("alumni roster explicit response DTOs", () => {
  it("builds a frozen import summary without private raw-data fields", () => {
    const dto = buildAlumniImportBatchSummaryDTO({
      ...SUMMARY_INPUT,
      rawRows: [{ email: "not-in-contract@example.com" }],
    } as AlumniImportBatchSummaryInput & { rawRows: unknown });

    expect(dto).toEqual({
      id: BATCH_ID,
      checksum: CHECKSUM,
      status: "review_ready",
      counts: COUNTS,
      createdById: ACTOR_ID,
      rerunOfBatchId: null,
      terminalAt: null,
      rawDataAvailable: true,
      revision: 3,
      createdAt: "2026-09-12T01:00:00.000Z",
      updatedAt: "2026-09-12T02:00:00.000Z",
    });
    expect(dto).not.toHaveProperty("rawRows");
    expect(Object.isFrozen(dto)).toBe(true);
    expect(Object.isFrozen(dto.counts)).toBe(true);
  });

  it("builds an explicit admin row and strips extra picker fields", () => {
    const dto = buildAlumniImportAdminRowDTO({
      ...ROW_INPUT,
      matchedUser: {
        ...PICKER,
        email: "account@example.com",
        password: "not-a-real-secret",
      } as UserPickerDTO,
      errors: [
        { field: "email", code: "email_mismatch", message: "Review email." },
      ],
    });

    expect(dto).toMatchObject({
      rowNumber: 2,
      contactEmail: "amy@example.com",
      matchStatus: "matched",
      matchMethod: "exact_email",
      matchedUser: PICKER,
      eligibilityStatus: "approved",
      reviewedAt: "2026-09-12T02:30:00.000Z",
    });
    expect(dto.matchedUser).not.toHaveProperty("email");
    expect(dto.matchedUser).not.toHaveProperty("password");
    expect(Object.isFrozen(dto)).toBe(true);
    expect(Object.isFrozen(dto.candidateUsers)).toBe(true);
    expect(Object.isFrozen(dto.errors)).toBe(true);
  });

  it("builds stable pagination metadata for private review rows", () => {
    const dto = buildAlumniImportAdminRowsPageDTO({
      batchId: BATCH_ID,
      batchRevision: 3,
      page: 2,
      limit: 1,
      totalRows: 2,
      rows: [ROW_INPUT],
    });

    expect(dto.batchId).toBe(BATCH_ID);
    expect(dto.pagination).toEqual({
      currentPage: 2,
      totalPages: 2,
      hasNext: false,
      hasPrev: true,
      totalRows: 2,
    });
    expect(Object.isFrozen(dto.rows)).toBe(true);
    expect(Object.isFrozen(dto.pagination)).toBe(true);
  });

  it("rejects invalid identifiers, dates, and oversized pages", () => {
    expectValidationError(() =>
      buildAlumniImportBatchSummaryDTO({ ...SUMMARY_INPUT, id: "bad" }),
    );
    expectValidationError(() =>
      buildAlumniImportBatchSummaryDTO({
        ...SUMMARY_INPUT,
        createdAt: "not-a-date",
      }),
    );
    expectValidationError(() =>
      buildAlumniImportAdminRowsPageDTO({
        batchId: BATCH_ID,
        batchRevision: 0,
        page: 1,
        limit: 1,
        totalRows: 2,
        rows: [ROW_INPUT, ROW_INPUT],
      }),
    );
  });

  it("builds token-free reissue and claim result DTOs", () => {
    const reissued = buildAlumniInvitationReissueResultDTO({
      invitationId: BATCH_ID,
      issueCount: 2,
      tokenExpiresAt: "2026-09-26T12:00:00.000Z",
      lastInvitationSentAt: "2026-09-12T12:00:00.000Z",
      revision: 4,
      status: "active",
      replayed: false,
    });
    const claimed = buildAlumniInvitationClaimResultDTO({
      invitationId: BATCH_ID,
      alumniProfileId: PROFILE_ID,
      affiliationIds: [AFFILIATION_ID],
      claimedAt: "2026-09-12T12:00:00.000Z",
      status: "claimed",
      replayed: true,
    });

    expect(reissued).toMatchObject({ status: "active", issueCount: 2 });
    expect(reissued).not.toHaveProperty("token");
    expect(claimed).toEqual({
      invitationId: BATCH_ID,
      status: "claimed",
      alumniProfileId: PROFILE_ID,
      affiliationIds: [AFFILIATION_ID],
      claimedAt: "2026-09-12T12:00:00.000Z",
      replayed: true,
    });
    expect(claimed).not.toHaveProperty("token");
    expect(Object.isFrozen(claimed)).toBe(true);
  });

  it("builds a paged invitation DTO and logically hides expired contact", () => {
    const invitation: AlumniInvitationAdminListItemInput = {
      id: BATCH_ID,
      status: "active",
      contactEmail: "amy@example.com",
      contactFirstName: "Amy",
      contactLastName: "Chen",
      contactPurgeAt: "2027-03-12T12:00:00.000Z",
      contactPurgedAt: null,
      issueCount: 2,
      tokenExpiresAt: "2026-09-26T12:00:00.000Z",
      lastInvitationSentAt: "2026-09-12T12:00:00.000Z",
      claimedAt: null,
      revision: 1,
    };
    const visible = buildAlumniInvitationAdminListPageDTO(
      {
        page: 1,
        limit: 20,
        totalInvitations: 1,
        invitations: [
          { ...invitation, tokenHash: "secret" } as typeof invitation,
        ],
      },
      new Date("2027-03-12T11:59:59.999Z"),
    );
    expect(visible.invitations[0]).toEqual({
      id: BATCH_ID,
      status: "active",
      contactEmail: "amy@example.com",
      contactFirstName: "Amy",
      contactLastName: "Chen",
      issueCount: 2,
      tokenExpiresAt: "2026-09-26T12:00:00.000Z",
      lastInvitationSentAt: "2026-09-12T12:00:00.000Z",
      claimedAt: null,
      revision: 1,
    });
    expect(visible.invitations[0]).not.toHaveProperty("tokenHash");
    expect(visible.pagination).toEqual({
      currentPage: 1,
      totalPages: 1,
      hasNext: false,
      hasPrev: false,
      totalInvitations: 1,
    });

    const expired = buildAlumniInvitationAdminListPageDTO(
      {
        page: 1,
        limit: 20,
        totalInvitations: 1,
        invitations: [invitation],
      },
      new Date("2027-03-12T12:00:00.000Z"),
    );
    expect(expired.invitations[0]).toMatchObject({
      contactEmail: null,
      contactFirstName: null,
      contactLastName: null,
    });
    expect(Object.isFrozen(expired.invitations)).toBe(true);
    expect(Object.isFrozen(expired.pagination)).toBe(true);
  });
});
