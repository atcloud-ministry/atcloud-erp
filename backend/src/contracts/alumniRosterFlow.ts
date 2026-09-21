import {
  ALUMNI_IMPORT_BATCH_STATUSES,
  ALUMNI_IMPORT_ROW_APPLICATION_STATUSES,
  ALUMNI_IMPORT_ROW_ELIGIBILITY_STATUSES,
  ALUMNI_IMPORT_ROW_MATCH_METHODS,
  ALUMNI_IMPORT_ROW_MATCH_STATUSES,
  ALUMNI_INVITATION_STATUSES,
  SAFE_CODE_PATTERN,
  SAFE_SINGLE_LINE_PATTERN,
  SHA256_HEX_PATTERN,
  type AlumniImportBatchStatus,
  type AlumniImportRowApplicationStatus,
  type AlumniImportRowEligibilityStatus,
  type AlumniImportRowMatchMethod,
  type AlumniImportRowMatchStatus,
  type AlumniInvitationStatus,
} from "./alumniDirectoryData";
import type { UserPickerDTO } from "./userReadContracts";

export const ALUMNI_IMPORT_LIST_DEFAULT_LIMIT = 20;
export const ALUMNI_IMPORT_LIST_MAX_LIMIT = 100;
export const ALUMNI_IMPORT_REVIEW_MAX_DECISIONS = 500;
const ALUMNI_LIST_MAX_PAGE = Math.floor(
  Number.MAX_SAFE_INTEGER / ALUMNI_IMPORT_LIST_MAX_LIMIT,
);

export const ALUMNI_INVITATION_LIST_DEFAULT_LIMIT = 20;
export const ALUMNI_INVITATION_LIST_MAX_LIMIT = 100;

const OBJECT_ID_PATTERN = /^[a-fA-F0-9]{24}$/;
const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface AlumniRosterFlowIssue {
  readonly path: string;
  readonly msg: string;
}

export class AlumniRosterFlowValidationError extends Error {
  readonly name = "AlumniRosterFlowValidationError";
  readonly code = "ALUMNI_ROSTER_FLOW_INPUT_INVALID";

  constructor(public readonly issues: readonly AlumniRosterFlowIssue[]) {
    super("Validation failed");
  }
}

export interface AlumniImportBatchCountsDTO {
  readonly totalRows: number;
  readonly validRows: number;
  readonly invalidRows: number;
  readonly matchedRows: number;
  readonly unmatchedRows: number;
  readonly ambiguousRows: number;
  readonly approvedRows: number;
  readonly rejectedRows: number;
  readonly appliedRows: number;
  readonly invitationsCreated: number;
  readonly affiliationsCreated: number;
}

export interface AlumniImportBatchSummaryInput {
  readonly id: string;
  readonly checksum: string;
  readonly status: AlumniImportBatchStatus;
  readonly counts: AlumniImportBatchCountsDTO;
  readonly createdById: string;
  readonly rerunOfBatchId?: string | null;
  readonly terminalAt?: Date | string | null;
  readonly rawDataAvailable: boolean;
  readonly revision: number;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
}

export interface AlumniImportBatchSummaryDTO {
  readonly id: string;
  readonly checksum: string;
  readonly status: AlumniImportBatchStatus;
  readonly counts: AlumniImportBatchCountsDTO;
  readonly createdById: string;
  readonly rerunOfBatchId: string | null;
  readonly terminalAt: string | null;
  readonly rawDataAvailable: boolean;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AlumniImportAdminRowErrorDTO {
  readonly field: string | null;
  readonly code: string;
  readonly message: string;
}

export interface AlumniImportAdminRowInput {
  readonly rowNumber: number;
  readonly rowKey: string;
  readonly contactEmail: string | null;
  readonly contactFirstName: string | null;
  readonly contactLastName: string | null;
  readonly programName: string | null;
  readonly cohortLabel: string | null;
  readonly programId: string | null;
  readonly matchStatus: AlumniImportRowMatchStatus;
  readonly matchMethod: AlumniImportRowMatchMethod;
  readonly matchedUser?: UserPickerDTO | null;
  readonly candidateUsers?: readonly UserPickerDTO[];
  readonly eligibilityStatus: AlumniImportRowEligibilityStatus;
  readonly reviewedAt?: Date | string | null;
  readonly reviewedById?: string | null;
  readonly reviewReasonCode?: string | null;
  readonly applicationStatus: AlumniImportRowApplicationStatus;
  readonly applicationUpdatedAt?: Date | string | null;
  readonly errors?: readonly AlumniImportAdminRowErrorDTO[];
}

export interface AlumniImportAdminRowDTO {
  readonly rowNumber: number;
  readonly rowKey: string;
  readonly contactEmail: string | null;
  readonly contactFirstName: string | null;
  readonly contactLastName: string | null;
  readonly programName: string | null;
  readonly cohortLabel: string | null;
  readonly programId: string | null;
  readonly matchStatus: AlumniImportRowMatchStatus;
  readonly matchMethod: AlumniImportRowMatchMethod;
  readonly matchedUser: UserPickerDTO | null;
  readonly candidateUsers: readonly UserPickerDTO[];
  readonly eligibilityStatus: AlumniImportRowEligibilityStatus;
  readonly reviewedAt: string | null;
  readonly reviewedById: string | null;
  readonly reviewReasonCode: string | null;
  readonly applicationStatus: AlumniImportRowApplicationStatus;
  readonly applicationUpdatedAt: string | null;
  readonly errors: readonly AlumniImportAdminRowErrorDTO[];
}

export interface AlumniImportAdminRowsPageInput {
  readonly batchId: string;
  readonly batchRevision: number;
  readonly page: number;
  readonly limit: number;
  readonly totalRows: number;
  readonly rows: readonly AlumniImportAdminRowInput[];
}

export interface AlumniImportAdminRowsPageDTO {
  readonly batchId: string;
  readonly batchRevision: number;
  readonly rows: readonly AlumniImportAdminRowDTO[];
  readonly pagination: {
    readonly currentPage: number;
    readonly totalPages: number;
    readonly hasNext: boolean;
    readonly hasPrev: boolean;
    readonly totalRows: number;
  };
}

export interface AlumniImportBatchListQuery {
  readonly page: number;
  readonly limit: number;
  readonly status?: AlumniImportBatchStatus;
}

export interface AlumniImportRowListQuery {
  readonly page: number;
  readonly limit: number;
}

export type AlumniImportDryRunBody = Readonly<Record<string, never>>;

export type AlumniImportReviewResolution =
  | {
      readonly matchStatus: "matched";
      readonly matchedUserId: string;
    }
  | {
      readonly matchStatus: "unmatched";
    };

export interface AlumniImportReviewDecision {
  readonly rowNumber: number;
  readonly rowKey: string;
  readonly eligibilityStatus: "approved" | "rejected";
  readonly resolution?: AlumniImportReviewResolution;
  readonly reviewReasonCode?: string;
}

export interface AlumniImportReviewBody {
  readonly expectedRevision: number;
  readonly decisions: readonly AlumniImportReviewDecision[];
}

export interface AlumniImportApplyBody {
  readonly expectedRevision: number;
}

export interface AlumniImportRerunBody {
  readonly expectedRevision: number;
}

export const ALUMNI_IMPORT_CANCEL_REASON_CODES = [
  "data_validation_failed",
  "source_replaced",
  "operator_request",
] as const;

export type AlumniImportCancelReasonCode =
  (typeof ALUMNI_IMPORT_CANCEL_REASON_CODES)[number];

export interface AlumniInvitationReissueBody {
  readonly expectedRevision: number;
}

export interface AlumniInvitationListQuery {
  readonly page: number;
  readonly limit: number;
  readonly status?: AlumniInvitationStatus;
  readonly batchId?: string;
}

export interface AlumniInvitationAdminListItemInput {
  readonly id: string;
  readonly status: AlumniInvitationStatus;
  readonly contactEmail?: string | null;
  readonly contactFirstName?: string | null;
  readonly contactLastName?: string | null;
  readonly contactPurgeAt: Date | string;
  readonly contactPurgedAt?: Date | string | null;
  readonly issueCount: number;
  readonly tokenExpiresAt: Date | string;
  readonly lastInvitationSentAt: Date | string;
  readonly claimedAt?: Date | string | null;
  readonly revision: number;
}

export interface AlumniInvitationAdminListItemDTO {
  readonly id: string;
  readonly status: AlumniInvitationStatus;
  readonly contactEmail: string | null;
  readonly contactFirstName: string | null;
  readonly contactLastName: string | null;
  readonly issueCount: number;
  readonly tokenExpiresAt: string;
  readonly lastInvitationSentAt: string;
  readonly claimedAt: string | null;
  readonly revision: number;
}

export interface AlumniInvitationAdminListPageInput {
  readonly page: number;
  readonly limit: number;
  readonly totalInvitations: number;
  readonly invitations: readonly AlumniInvitationAdminListItemInput[];
}

export interface AlumniInvitationAdminListPageDTO {
  readonly invitations: readonly AlumniInvitationAdminListItemDTO[];
  readonly pagination: {
    readonly currentPage: number;
    readonly totalPages: number;
    readonly hasNext: boolean;
    readonly hasPrev: boolean;
    readonly totalInvitations: number;
  };
}

export interface AlumniInvitationClaimBody {
  readonly token: string;
}

export interface AlumniInvitationReissueResultInput {
  readonly invitationId: string;
  readonly issueCount: number;
  readonly tokenExpiresAt: Date | string;
  readonly lastInvitationSentAt: Date | string;
  readonly revision: number;
  readonly status: "active";
  readonly replayed: boolean;
}

export interface AlumniInvitationReissueResultDTO {
  readonly invitationId: string;
  readonly status: "active";
  readonly issueCount: number;
  readonly tokenExpiresAt: string;
  readonly lastInvitationSentAt: string;
  readonly revision: number;
  readonly replayed: boolean;
}

export interface AlumniInvitationClaimResultInput {
  readonly invitationId: string;
  readonly alumniProfileId: string;
  readonly affiliationIds: readonly string[];
  readonly claimedAt: Date | string;
  readonly status: "claimed";
  readonly replayed: boolean;
}

export interface AlumniInvitationClaimResultDTO {
  readonly invitationId: string;
  readonly status: "claimed";
  readonly alumniProfileId: string;
  readonly affiliationIds: readonly string[];
  readonly claimedAt: string;
  readonly replayed: boolean;
}

type StrictObject = Readonly<Record<string, unknown>>;

function fail(path: string, msg: string): never {
  throw new AlumniRosterFlowValidationError([Object.freeze({ path, msg })]);
}

function strictObject(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): StrictObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail(path, `${path} must be an object`);
  }

  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return fail(path, `${path} must be a plain data object`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(path, `${path} must be a plain data object`);
  }

  const allowed = new Set(allowedKeys);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) {
      return fail(
        typeof key === "string" ? `${path}.${key}` : path,
        "Unknown field",
      );
    }
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) {
      return fail(`${path}.${key}`, "Accessor fields are not allowed");
    }
    result[key] = descriptor.value;
  }
  return result;
}

function required(object: StrictObject, key: string, path: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(object, key)) {
    return fail(`${path}.${key}`, "Required field is missing");
  }
  return object[key];
}

function safeNonNegativeInteger(value: unknown, path: string): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0 ||
    Number(value) >= Number.MAX_SAFE_INTEGER
  ) {
    return fail(path, `${path} must be a non-negative safe integer`);
  }
  return Number(value);
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    return fail(path, `${path} must be a positive safe integer`);
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return fail(path, `${path} must be a non-negative safe integer`);
  }
  return Number(value);
}

function optionalNullableText(
  value: string | null,
  path: string,
  maximum: number,
): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    !SAFE_SINGLE_LINE_PATTERN.test(value)
  ) {
    return fail(path, `${path} must be a bounded single-line string or null`);
  }
  return value;
}

function isoDate(value: Date | string, path: string): string {
  const candidate = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(candidate.getTime())) {
    return fail(path, `${path} must be a valid date`);
  }
  return candidate.toISOString();
}

function nullableIsoDate(
  value: Date | string | null | undefined,
  path: string,
): string | null {
  return value == null ? null : isoDate(value, path);
}

function importStatus(value: unknown, path: string): AlumniImportBatchStatus {
  if (
    typeof value !== "string" ||
    !(ALUMNI_IMPORT_BATCH_STATUSES as readonly string[]).includes(value)
  ) {
    return fail(path, `${path} is invalid`);
  }
  return value as AlumniImportBatchStatus;
}

function invitationStatus(
  value: unknown,
  path: string,
): AlumniInvitationStatus {
  if (
    typeof value !== "string" ||
    !(ALUMNI_INVITATION_STATUSES as readonly string[]).includes(value)
  ) {
    return fail(path, `${path} is invalid`);
  }
  return value as AlumniInvitationStatus;
}

function cloneCounts(
  counts: AlumniImportBatchCountsDTO,
): AlumniImportBatchCountsDTO {
  const fields = [
    "totalRows",
    "validRows",
    "invalidRows",
    "matchedRows",
    "unmatchedRows",
    "ambiguousRows",
    "approvedRows",
    "rejectedRows",
    "appliedRows",
    "invitationsCreated",
    "affiliationsCreated",
  ] as const;
  const result = {} as Record<(typeof fields)[number], number>;
  for (const field of fields) {
    result[field] = nonNegativeInteger(counts[field], `counts.${field}`);
  }
  return Object.freeze(result);
}

function cloneUserPicker(value: UserPickerDTO): UserPickerDTO {
  return Object.freeze({
    id: value.id,
    username: value.username,
    firstName: value.firstName,
    lastName: value.lastName,
    avatar: value.avatar,
    gender: value.gender,
    role: value.role,
    roleInAtCloud: value.roleInAtCloud,
  });
}

function cloneAdminRowError(
  value: AlumniImportAdminRowErrorDTO,
  index: number,
): AlumniImportAdminRowErrorDTO {
  const path = `errors[${index}]`;
  const field =
    value.field === null
      ? null
      : optionalNullableText(value.field, `${path}.field`, 100);
  if (
    typeof value.code !== "string" ||
    value.code.length > 80 ||
    !SAFE_CODE_PATTERN.test(value.code)
  ) {
    return fail(`${path}.code`, "Error code is invalid");
  }
  if (
    typeof value.message !== "string" ||
    value.message.length < 1 ||
    value.message.length > 240 ||
    !SAFE_SINGLE_LINE_PATTERN.test(value.message)
  ) {
    return fail(`${path}.message`, "Error message is invalid");
  }
  return Object.freeze({ field, code: value.code, message: value.message });
}

export function parseAlumniObjectId(
  value: unknown,
  path = "id",
): string {
  if (typeof value !== "string" || !OBJECT_ID_PATTERN.test(value)) {
    return fail(path, `${path} must be a 24-character ObjectId`);
  }
  return value.toLowerCase();
}

export function buildAlumniImportBatchSummaryDTO(
  input: AlumniImportBatchSummaryInput,
): AlumniImportBatchSummaryDTO {
  if (!SHA256_HEX_PATTERN.test(input.checksum)) {
    return fail("checksum", "checksum must be a lowercase SHA-256 digest");
  }
  if (typeof input.rawDataAvailable !== "boolean") {
    return fail("rawDataAvailable", "rawDataAvailable must be a boolean");
  }
  return Object.freeze({
    id: parseAlumniObjectId(input.id, "id"),
    checksum: input.checksum,
    status: importStatus(input.status, "status"),
    counts: cloneCounts(input.counts),
    createdById: parseAlumniObjectId(input.createdById, "createdById"),
    rerunOfBatchId:
      input.rerunOfBatchId == null
        ? null
        : parseAlumniObjectId(input.rerunOfBatchId, "rerunOfBatchId"),
    terminalAt: nullableIsoDate(input.terminalAt, "terminalAt"),
    rawDataAvailable: input.rawDataAvailable,
    revision: safeNonNegativeInteger(input.revision, "revision"),
    createdAt: isoDate(input.createdAt, "createdAt"),
    updatedAt: isoDate(input.updatedAt, "updatedAt"),
  });
}

export function buildAlumniImportAdminRowDTO(
  input: AlumniImportAdminRowInput,
): AlumniImportAdminRowDTO {
  if (!SHA256_HEX_PATTERN.test(input.rowKey)) {
    return fail("rowKey", "rowKey must be a lowercase SHA-256 digest");
  }
  if (
    !(ALUMNI_IMPORT_ROW_MATCH_STATUSES as readonly string[]).includes(
      input.matchStatus,
    )
  ) {
    return fail("matchStatus", "matchStatus is invalid");
  }
  if (
    !(ALUMNI_IMPORT_ROW_MATCH_METHODS as readonly string[]).includes(
      input.matchMethod,
    )
  ) {
    return fail("matchMethod", "matchMethod is invalid");
  }
  if (
    !(
      ALUMNI_IMPORT_ROW_ELIGIBILITY_STATUSES as readonly string[]
    ).includes(input.eligibilityStatus)
  ) {
    return fail("eligibilityStatus", "eligibilityStatus is invalid");
  }
  if (
    !(
      ALUMNI_IMPORT_ROW_APPLICATION_STATUSES as readonly string[]
    ).includes(input.applicationStatus)
  ) {
    return fail("applicationStatus", "applicationStatus is invalid");
  }

  const candidates = input.candidateUsers ?? [];
  if (candidates.length > 10) {
    return fail("candidateUsers", "candidateUsers cannot contain more than 10 users");
  }
  const reviewedById =
    input.reviewedById == null
      ? null
      : parseAlumniObjectId(input.reviewedById, "reviewedById");
  const reviewReasonCode =
    input.reviewReasonCode == null ? null : input.reviewReasonCode;
  if (
    reviewReasonCode !== null &&
    (reviewReasonCode.length > 80 || !SAFE_CODE_PATTERN.test(reviewReasonCode))
  ) {
    return fail("reviewReasonCode", "reviewReasonCode is invalid");
  }

  return Object.freeze({
    rowNumber: positiveInteger(input.rowNumber, "rowNumber"),
    rowKey: input.rowKey,
    contactEmail: optionalNullableText(input.contactEmail, "contactEmail", 254),
    contactFirstName: optionalNullableText(
      input.contactFirstName,
      "contactFirstName",
      100,
    ),
    contactLastName: optionalNullableText(
      input.contactLastName,
      "contactLastName",
      100,
    ),
    programName: optionalNullableText(input.programName, "programName", 160),
    cohortLabel: optionalNullableText(input.cohortLabel, "cohortLabel", 100),
    programId:
      input.programId === null
        ? null
        : parseAlumniObjectId(input.programId, "programId"),
    matchStatus: input.matchStatus,
    matchMethod: input.matchMethod,
    matchedUser: input.matchedUser ? cloneUserPicker(input.matchedUser) : null,
    candidateUsers: Object.freeze(candidates.map(cloneUserPicker)),
    eligibilityStatus: input.eligibilityStatus,
    reviewedAt: nullableIsoDate(input.reviewedAt, "reviewedAt"),
    reviewedById,
    reviewReasonCode,
    applicationStatus: input.applicationStatus,
    applicationUpdatedAt: nullableIsoDate(
      input.applicationUpdatedAt,
      "applicationUpdatedAt",
    ),
    errors: Object.freeze((input.errors ?? []).map(cloneAdminRowError)),
  });
}

export function buildAlumniImportAdminRowsPageDTO(
  input: AlumniImportAdminRowsPageInput,
): AlumniImportAdminRowsPageDTO {
  const page = positiveInteger(input.page, "page");
  const limit = positiveInteger(input.limit, "limit");
  if (limit > ALUMNI_IMPORT_LIST_MAX_LIMIT) {
    return fail("limit", `limit cannot exceed ${ALUMNI_IMPORT_LIST_MAX_LIMIT}`);
  }
  const totalRows = nonNegativeInteger(input.totalRows, "totalRows");
  if (input.rows.length > limit) {
    return fail("rows", "rows cannot exceed the requested page limit");
  }
  const totalPages = Math.ceil(totalRows / limit);
  return Object.freeze({
    batchId: parseAlumniObjectId(input.batchId, "batchId"),
    batchRevision: safeNonNegativeInteger(
      input.batchRevision,
      "batchRevision",
    ),
    rows: Object.freeze(input.rows.map(buildAlumniImportAdminRowDTO)),
    pagination: Object.freeze({
      currentPage: page,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
      totalRows,
    }),
  });
}

export function buildAlumniInvitationAdminListItemDTO(
  input: AlumniInvitationAdminListItemInput,
  now: Date = new Date(),
): AlumniInvitationAdminListItemDTO {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return fail("now", "now must be a valid date");
  }
  const contactPurgeAt = new Date(isoDate(input.contactPurgeAt, "contactPurgeAt"));
  const contactPurgedAt = nullableIsoDate(
    input.contactPurgedAt,
    "contactPurgedAt",
  );
  const contactAvailable =
    contactPurgedAt === null && contactPurgeAt.getTime() > now.getTime();

  return Object.freeze({
    id: parseAlumniObjectId(input.id, "id"),
    status: invitationStatus(input.status, "status"),
    contactEmail: contactAvailable
      ? optionalNullableText(input.contactEmail ?? null, "contactEmail", 254)
      : null,
    contactFirstName: contactAvailable
      ? optionalNullableText(
          input.contactFirstName ?? null,
          "contactFirstName",
          100,
        )
      : null,
    contactLastName: contactAvailable
      ? optionalNullableText(input.contactLastName ?? null, "contactLastName", 100)
      : null,
    issueCount: positiveInteger(input.issueCount, "issueCount"),
    tokenExpiresAt: isoDate(input.tokenExpiresAt, "tokenExpiresAt"),
    lastInvitationSentAt: isoDate(
      input.lastInvitationSentAt,
      "lastInvitationSentAt",
    ),
    claimedAt: nullableIsoDate(input.claimedAt, "claimedAt"),
    revision: safeNonNegativeInteger(input.revision, "revision"),
  });
}

export function buildAlumniInvitationAdminListPageDTO(
  input: AlumniInvitationAdminListPageInput,
  now: Date = new Date(),
): AlumniInvitationAdminListPageDTO {
  const page = positiveInteger(input.page, "page");
  const limit = positiveInteger(input.limit, "limit");
  if (limit > ALUMNI_INVITATION_LIST_MAX_LIMIT) {
    return fail(
      "limit",
      `limit cannot exceed ${ALUMNI_INVITATION_LIST_MAX_LIMIT}`,
    );
  }
  const totalInvitations = nonNegativeInteger(
    input.totalInvitations,
    "totalInvitations",
  );
  if (input.invitations.length > limit) {
    return fail(
      "invitations",
      "invitations cannot exceed the requested page limit",
    );
  }
  const totalPages = Math.ceil(totalInvitations / limit);
  return Object.freeze({
    invitations: Object.freeze(
      input.invitations.map((invitation) =>
        buildAlumniInvitationAdminListItemDTO(invitation, now),
      ),
    ),
    pagination: Object.freeze({
      currentPage: page,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
      totalInvitations,
    }),
  });
}

function queryInteger(
  object: StrictObject,
  key: string,
  defaultValue: number,
): number {
  const value = object[key];
  if (value === undefined || value === "") return defaultValue;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return fail(key, `${key} must be a positive integer`);
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed >
      (key === "limit" ? ALUMNI_IMPORT_LIST_MAX_LIMIT : ALUMNI_LIST_MAX_PAGE)
  ) {
    return fail(key, `${key} is outside the allowed range`);
  }
  return parsed;
}

export function parseAlumniImportBatchListQuery(
  value: unknown,
): AlumniImportBatchListQuery {
  const object = strictObject(value, "query", ["page", "limit", "status"]);
  const statusValue = object.status;
  const status =
    statusValue === undefined || statusValue === ""
      ? undefined
      : importStatus(statusValue, "status");
  return Object.freeze({
    page: queryInteger(object, "page", 1),
    limit: queryInteger(object, "limit", ALUMNI_IMPORT_LIST_DEFAULT_LIMIT),
    ...(status ? { status } : {}),
  });
}

export function parseAlumniImportRowListQuery(
  value: unknown,
): AlumniImportRowListQuery {
  const object = strictObject(value, "query", ["page", "limit"]);
  return Object.freeze({
    page: queryInteger(object, "page", 1),
    limit: queryInteger(object, "limit", ALUMNI_IMPORT_LIST_DEFAULT_LIMIT),
  });
}

export function parseAlumniInvitationListQuery(
  value: unknown,
): AlumniInvitationListQuery {
  const object = strictObject(value, "query", [
    "page",
    "limit",
    "status",
    "batchId",
  ]);
  const statusValue = object.status;
  const status =
    statusValue === undefined || statusValue === ""
      ? undefined
      : invitationStatus(statusValue, "status");
  const batchIdValue = object.batchId;
  const batchId =
    batchIdValue === undefined || batchIdValue === ""
      ? undefined
      : parseAlumniObjectId(batchIdValue, "batchId");
  return Object.freeze({
    page: queryInteger(object, "page", 1),
    limit: queryInteger(
      object,
      "limit",
      ALUMNI_INVITATION_LIST_DEFAULT_LIMIT,
    ),
    ...(status ? { status } : {}),
    ...(batchId ? { batchId } : {}),
  });
}

export function parseAlumniImportDryRunBody(
  value: unknown,
): AlumniImportDryRunBody {
  if (value === undefined) return Object.freeze({});
  strictObject(value, "body", []);
  return Object.freeze({});
}

function parseResolution(
  value: unknown,
  path: string,
): AlumniImportReviewResolution {
  const object = strictObject(value, path, ["matchStatus", "matchedUserId"]);
  const matchStatus = required(object, "matchStatus", path);
  if (matchStatus === "unmatched") {
    if (Object.prototype.hasOwnProperty.call(object, "matchedUserId")) {
      return fail(
        `${path}.matchedUserId`,
        "Unmatched resolution cannot include matchedUserId",
      );
    }
    return Object.freeze({ matchStatus });
  }
  if (matchStatus !== "matched") {
    return fail(`${path}.matchStatus`, "Resolution matchStatus is invalid");
  }
  return Object.freeze({
    matchStatus,
    matchedUserId: parseAlumniObjectId(
      required(object, "matchedUserId", path),
      `${path}.matchedUserId`,
    ),
  });
}

function parseReviewDecision(
  value: unknown,
  index: number,
): AlumniImportReviewDecision {
  const path = `body.decisions[${index}]`;
  const object = strictObject(value, path, [
    "rowNumber",
    "rowKey",
    "eligibilityStatus",
    "resolution",
    "reviewReasonCode",
  ]);
  const rowKey = required(object, "rowKey", path);
  if (typeof rowKey !== "string" || !SHA256_HEX_PATTERN.test(rowKey)) {
    return fail(`${path}.rowKey`, "rowKey must be a lowercase SHA-256 digest");
  }
  const eligibilityStatus = required(object, "eligibilityStatus", path);
  if (eligibilityStatus !== "approved" && eligibilityStatus !== "rejected") {
    return fail(
      `${path}.eligibilityStatus`,
      "eligibilityStatus must be approved or rejected",
    );
  }
  const reasonValue = object.reviewReasonCode;
  if (
    reasonValue !== undefined &&
    (typeof reasonValue !== "string" ||
      reasonValue.length > 80 ||
      !SAFE_CODE_PATTERN.test(reasonValue))
  ) {
    return fail(`${path}.reviewReasonCode`, "reviewReasonCode is invalid");
  }
  const resolution = Object.prototype.hasOwnProperty.call(object, "resolution")
    ? parseResolution(object.resolution, `${path}.resolution`)
    : undefined;
  return Object.freeze({
    rowNumber: positiveInteger(
      required(object, "rowNumber", path),
      `${path}.rowNumber`,
    ),
    rowKey,
    eligibilityStatus,
    ...(resolution ? { resolution } : {}),
    ...(typeof reasonValue === "string"
      ? { reviewReasonCode: reasonValue }
      : {}),
  });
}

export function parseAlumniImportReviewBody(
  value: unknown,
): AlumniImportReviewBody {
  const object = strictObject(value, "body", ["expectedRevision", "decisions"]);
  const decisionValues = required(object, "decisions", "body");
  if (
    !Array.isArray(decisionValues) ||
    decisionValues.length < 1 ||
    decisionValues.length > ALUMNI_IMPORT_REVIEW_MAX_DECISIONS
  ) {
    return fail(
      "body.decisions",
      `decisions must contain 1-${ALUMNI_IMPORT_REVIEW_MAX_DECISIONS} items`,
    );
  }
  const decisions = decisionValues.map(parseReviewDecision);
  const rowNumbers = new Set<number>();
  const rowKeys = new Set<string>();
  for (const decision of decisions) {
    if (rowNumbers.has(decision.rowNumber)) {
      return fail("body.decisions", "decisions cannot repeat a rowNumber");
    }
    if (rowKeys.has(decision.rowKey)) {
      return fail("body.decisions", "decisions cannot repeat a rowKey");
    }
    rowNumbers.add(decision.rowNumber);
    rowKeys.add(decision.rowKey);
  }
  return Object.freeze({
    expectedRevision: safeNonNegativeInteger(
      required(object, "expectedRevision", "body"),
      "body.expectedRevision",
    ),
    decisions: Object.freeze(decisions),
  });
}

function parseRevisionOnlyBody(value: unknown): number {
  const object = strictObject(value, "body", ["expectedRevision"]);
  return safeNonNegativeInteger(
    required(object, "expectedRevision", "body"),
    "body.expectedRevision",
  );
}

export function parseAlumniImportApplyBody(
  value: unknown,
): AlumniImportApplyBody {
  return Object.freeze({ expectedRevision: parseRevisionOnlyBody(value) });
}

export function parseAlumniImportRerunBody(
  value: unknown,
): AlumniImportRerunBody {
  return Object.freeze({ expectedRevision: parseRevisionOnlyBody(value) });
}

export function parseAlumniInvitationReissueBody(
  value: unknown,
): AlumniInvitationReissueBody {
  return Object.freeze({ expectedRevision: parseRevisionOnlyBody(value) });
}

export function parseAlumniInvitationClaimBody(
  value: unknown,
): AlumniInvitationClaimBody {
  const object = strictObject(value, "body", ["token"]);
  const token = required(object, "token", "body");
  if (typeof token !== "string" || !INVITATION_TOKEN_PATTERN.test(token)) {
    return fail(
      "body.token",
      "token must be exactly 43 base64url characters",
    );
  }
  return Object.freeze({ token });
}

export function buildAlumniInvitationReissueResultDTO(
  input: AlumniInvitationReissueResultInput,
): AlumniInvitationReissueResultDTO {
  if (input.status !== "active" || typeof input.replayed !== "boolean") {
    return fail("status", "Invitation reissue result is invalid");
  }
  return Object.freeze({
    invitationId: parseAlumniObjectId(input.invitationId, "invitationId"),
    status: "active" as const,
    issueCount: positiveInteger(input.issueCount, "issueCount"),
    tokenExpiresAt: isoDate(input.tokenExpiresAt, "tokenExpiresAt"),
    lastInvitationSentAt: isoDate(
      input.lastInvitationSentAt,
      "lastInvitationSentAt",
    ),
    revision: safeNonNegativeInteger(input.revision, "revision"),
    replayed: input.replayed,
  });
}

export function buildAlumniInvitationClaimResultDTO(
  input: AlumniInvitationClaimResultInput,
): AlumniInvitationClaimResultDTO {
  if (input.status !== "claimed" || typeof input.replayed !== "boolean") {
    return fail("status", "Invitation claim result is invalid");
  }
  return Object.freeze({
    invitationId: parseAlumniObjectId(input.invitationId, "invitationId"),
    status: "claimed" as const,
    alumniProfileId: parseAlumniObjectId(
      input.alumniProfileId,
      "alumniProfileId",
    ),
    affiliationIds: Object.freeze(
      input.affiliationIds.map((id, index) =>
        parseAlumniObjectId(id, `affiliationIds[${index}]`),
      ),
    ),
    claimedAt: isoDate(input.claimedAt, "claimedAt"),
    replayed: input.replayed,
  });
}
