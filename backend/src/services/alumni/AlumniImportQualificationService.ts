import {
  isValidDisplayText,
  normalizeDisplayText,
} from "@atcloud/shared-time/registration-profile";
import mongoose from "mongoose";
import {
  ALUMNI_IMPORT_BATCH_ACTIVE_STATUSES,
  ALUMNI_IMPORT_BATCH_STATUSES,
  ALUMNI_IMPORT_ROW_APPLICATION_STATUSES,
  ALUMNI_IMPORT_ROW_ELIGIBILITY_STATUSES,
  ALUMNI_IMPORT_ROW_MATCH_METHODS,
  ALUMNI_IMPORT_ROW_MATCH_STATUSES,
  SAFE_CODE_PATTERN,
  SAFE_SINGLE_LINE_PATTERN,
  SHA256_HEX_PATTERN,
  deriveAlumniAffiliationKey,
  deriveAlumniProgramAffiliationKey,
} from "../../contracts/alumniDirectoryData";
import AlumniAffiliation from "../../models/AlumniAffiliation";
import AlumniImportBatch, {
  type AlumniImportBatchCounts,
} from "../../models/AlumniImportBatch";
import IdempotencyRecord from "../../models/IdempotencyRecord";
import Program from "../../models/Program";
import User from "../../models/User";
import {
  MigrationReadinessService,
  migrationReadinessService,
} from "../migrations/MigrationReadinessService";
import {
  mongoTransactionService,
  type MongoTransactionService,
} from "../reliability/MongoTransactionService";
import { PERMISSIONS, hasPermission } from "../../utils/roleUtils";
import {
  ALUMNI_ROSTER_ROW_ISSUE_CODES,
  deriveAlumniRosterRowKey,
  parseAlumniRosterCsv,
  type ParsedAlumniRoster,
} from "./AlumniRosterCsvParser";

export const ALUMNI_IMPORT_QUALIFICATION_REPORT_VERSION = 1 as const;

export type AlumniImportQualificationIssueCode =
  | "SOURCE_CHECKSUM_MISMATCH"
  | "SOURCE_ROW_COUNT_MISMATCH"
  | "SOURCE_UNIQUE_CONTACT_COUNT_MISMATCH"
  | "BATCH_NOT_FOUND"
  | "BATCH_CHECKSUM_MISMATCH"
  | "BATCH_STATUS_INVALID"
  | "BATCH_METADATA_INVALID"
  | "RAW_HEADERS_MISMATCH"
  | "RAW_ROWS_MISMATCH"
  | "ROW_RESULTS_INVALID"
  | "ROW_ERROR_DISTRIBUTION_MISMATCH"
  | "ACCOUNT_MATCH_MISMATCH"
  | "COUNT_INVARIANT_FAILED"
  | "ROSTER_ROW_INVALID"
  | "AMBIGUOUS_MATCH_REQUIRES_REVIEW"
  | "PROGRAM_NOT_FOUND"
  | "PROGRAM_NAME_MISMATCH"
  | "AFFILIATION_FORMAT_ERROR"
  | "AFFILIATION_NAME_IDENTITY_MISMATCH"
  | "AFFILIATION_PROGRAM_IDENTITY_MISMATCH"
  | "AFFILIATION_DUPLICATE_IDENTITY";

export interface AlumniImportSourceExpectation {
  readonly checksum: string;
  readonly totalRows: number;
  readonly uniqueContacts: number;
}

export interface AlumniImportSourceInspectionReport {
  readonly schemaVersion: typeof ALUMNI_IMPORT_QUALIFICATION_REPORT_VERSION;
  readonly kind: "alumni_import_source_inspection";
  readonly status: "passed" | "failed";
  readonly source: {
    readonly checksum: string;
    readonly bytes: number;
    readonly totalRows: number;
    readonly uniqueContacts: number;
  };
  readonly rowIssues: readonly { readonly code: string; readonly count: number }[];
  readonly issues: readonly {
    readonly code: AlumniImportQualificationIssueCode;
    readonly count: number;
  }[];
}

export interface AlumniImportQualificationReport {
  readonly schemaVersion: typeof ALUMNI_IMPORT_QUALIFICATION_REPORT_VERSION;
  readonly kind: "alumni_import_qualification";
  readonly status: "passed" | "failed";
  readonly source: AlumniImportSourceInspectionReport["source"];
  readonly batch: {
    readonly id: string;
    readonly status: string;
    readonly revision: number;
    readonly checksum: string;
    readonly counts: AlumniImportBatchCounts;
  };
  readonly verification: {
    readonly sourceChecksumMatches: boolean;
    readonly sourceRowCountMatches: boolean;
    readonly sourceUniqueContactCountMatches: boolean;
    readonly batchChecksumMatches: boolean;
    readonly rawHeadersMatch: boolean;
    readonly rawRowsMatch: boolean;
    readonly rowKeysMatch: boolean;
    readonly countInvariantsHold: boolean;
    readonly accountMatchingMatches: boolean;
  };
  readonly programMapping: {
    readonly linkedRows: number;
    readonly externalRows: number;
    readonly missingProgramRows: number;
    readonly mismatchedProgramNameRows: number;
  };
  readonly affiliations: {
    readonly totalRecords: number;
    readonly formatErrorRecords: number;
    readonly affiliationKeyMismatchRecords: number;
    readonly programAffiliationKeyMismatchRecords: number;
    readonly duplicateIdentityGroups: number;
    readonly duplicateIdentityRecords: number;
  };
  readonly rowIssues: readonly { readonly code: string; readonly count: number }[];
  readonly issues: readonly {
    readonly code: AlumniImportQualificationIssueCode;
    readonly count: number;
  }[];
}

export class AlumniImportQualificationError extends Error {
  readonly name = "AlumniImportQualificationError";

  constructor(
    public readonly code:
      | "ALUMNI_IMPORT_SOURCE_EXPECTATION_INVALID"
      | "ALUMNI_IMPORT_SOURCE_EXPECTATION_MISMATCH"
      | "ALUMNI_IMPORT_ACTOR_UNAUTHORIZED"
      | "ALUMNI_IMPORT_REQUIRED_INDEX_MISSING",
  ) {
    super(code);
  }
}

interface QualificationDependencies {
  readonly migrationReadiness?: Pick<MigrationReadinessService, "assertReady">;
  readonly transactionService?: Pick<
    MongoTransactionService,
    "assertTopologyCapability"
  >;
}

interface RawBatchDocument {
  readonly _id?: unknown;
  readonly schemaVersion?: unknown;
  readonly checksum?: unknown;
  readonly status?: unknown;
  readonly revision?: unknown;
  readonly counts?: unknown;
  readonly rawHeaders?: unknown;
  readonly rawRows?: unknown;
  readonly rowErrors?: unknown;
  readonly rowResults?: unknown;
}

interface RawAffiliationDocument {
  readonly alumniProfileId?: unknown;
  readonly programId?: unknown;
  readonly programName?: unknown;
  readonly cohortLabel?: unknown;
  readonly affiliationKey?: unknown;
  readonly programAffiliationKey?: unknown;
}

const COUNT_FIELDS = [
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

const EXPECTED_ROW_ERROR_CODES = new Set<string>([
  ...ALUMNI_ROSTER_ROW_ISSUE_CODES,
  "program_not_found",
  "program_name_mismatch",
  "duplicate_affiliation",
]);

interface RequiredIndex {
  readonly model:
    | typeof AlumniAffiliation
    | typeof AlumniImportBatch
    | typeof IdempotencyRecord;
  readonly name: string;
  readonly keys: readonly (readonly [string, number])[];
  readonly unique?: true;
  readonly expireAfterSeconds?: number;
  readonly partialStringField?: string;
  readonly partialValuesField?: string;
  readonly partialValues?: readonly string[];
}

interface ForbiddenIndexKey {
  readonly model: RequiredIndex["model"];
  readonly keys: readonly (readonly [string, number])[];
}

const CANONICAL_AFFILIATION_INDEX = Object.freeze({
    model: AlumniAffiliation,
    name: "uniq_alumni_affiliation_profile_program_key",
    keys: Object.freeze([
      Object.freeze(["alumniProfileId", 1] as const),
      Object.freeze(["programAffiliationKey", 1] as const),
    ]),
    unique: true as const,
    partialStringField: "programAffiliationKey",
  });
const EXTERNAL_AFFILIATION_INDEX = Object.freeze({
    model: AlumniAffiliation,
    name: "uniq_alumni_affiliation_profile_external_key",
    keys: Object.freeze([
      Object.freeze(["alumniProfileId", 1] as const),
      Object.freeze(["programId", 1] as const),
      Object.freeze(["affiliationKey", 1] as const),
    ]),
    unique: true as const,
  });
const IDEMPOTENCY_INDEX = Object.freeze({
    model: IdempotencyRecord,
    name: "uniq_idempotency_scope_actor_key",
    keys: Object.freeze([
      Object.freeze(["hashVersion", 1] as const),
      Object.freeze(["scope", 1] as const),
      Object.freeze(["actorKeyHash", 1] as const),
      Object.freeze(["keyHash", 1] as const),
    ]),
    unique: true as const,
  });
const IMPORT_BATCH_TTL_INDEX = Object.freeze({
  model: AlumniImportBatch,
  name: "ttl_alumni_import_batch_purge_at",
  keys: Object.freeze([Object.freeze(["purgeAt", 1] as const)]),
  expireAfterSeconds: 0,
});
const IMPORT_BATCH_RAW_CLEANUP_INDEX = Object.freeze({
  model: AlumniImportBatch,
  name: "idx_alumni_import_batch_raw_cleanup",
  keys: Object.freeze([
    Object.freeze(["rawDataPurgedAt", 1] as const),
    Object.freeze(["rawDataPurgeAt", 1] as const),
  ]),
});
const IMPORT_BATCH_ACTIVE_CHECKSUM_INDEX = Object.freeze({
  model: AlumniImportBatch,
  name: "uniq_alumni_import_batch_active_checksum",
  keys: Object.freeze([Object.freeze(["checksum", 1] as const)]),
  unique: true as const,
  partialValuesField: "status",
  partialValues: ALUMNI_IMPORT_BATCH_ACTIVE_STATUSES,
});

const OPERATIONAL_REQUIRED_INDEXES: readonly RequiredIndex[] = Object.freeze([
  CANONICAL_AFFILIATION_INDEX,
  EXTERNAL_AFFILIATION_INDEX,
  IDEMPOTENCY_INDEX,
  IMPORT_BATCH_TTL_INDEX,
  IMPORT_BATCH_RAW_CLEANUP_INDEX,
  IMPORT_BATCH_ACTIVE_CHECKSUM_INDEX,
]);

const CANCELLATION_REQUIRED_INDEXES: readonly RequiredIndex[] = Object.freeze([
  IDEMPOTENCY_INDEX,
  IMPORT_BATCH_TTL_INDEX,
  IMPORT_BATCH_RAW_CLEANUP_INDEX,
]);

const OPERATIONAL_FORBIDDEN_INDEX_KEYS: readonly ForbiddenIndexKey[] =
  Object.freeze([
    Object.freeze({
      model: AlumniAffiliation,
      keys: Object.freeze([
        Object.freeze(["alumniProfileId", 1] as const),
        Object.freeze(["affiliationKey", 1] as const),
      ]),
    }),
  ]);

function safeCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : null;
}

function emptyCounts(): AlumniImportBatchCounts {
  return {
    totalRows: 0,
    validRows: 0,
    invalidRows: 0,
    matchedRows: 0,
    unmatchedRows: 0,
    ambiguousRows: 0,
    approvedRows: 0,
    rejectedRows: 0,
    appliedRows: 0,
    invitationsCreated: 0,
    affiliationsCreated: 0,
  };
}

function readCounts(value: unknown): {
  readonly counts: AlumniImportBatchCounts;
  readonly valid: boolean;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { counts: emptyCounts(), valid: false };
  }
  const record = value as Record<string, unknown>;
  const counts = emptyCounts();
  let valid = true;
  for (const field of COUNT_FIELDS) {
    const count = safeCount(record[field]);
    if (count === null) valid = false;
    else counts[field] = count;
  }
  return { counts, valid };
}

function uniqueContacts(parsed: ParsedAlumniRoster): number {
  return new Set(
    parsed.rows
      .map((row) => row.value?.email)
      .filter((value): value is string => Boolean(value)),
  ).size;
}

function issueList(
  issues: ReadonlyMap<AlumniImportQualificationIssueCode, number>,
): AlumniImportQualificationReport["issues"] {
  return Object.freeze(
    [...issues.entries()]
      .filter(([, count]) => count > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([code, count]) => Object.freeze({ code, count })),
  );
}

function incrementIssue(
  issues: Map<AlumniImportQualificationIssueCode, number>,
  code: AlumniImportQualificationIssueCode,
  count = 1,
): void {
  if (count > 0) issues.set(code, (issues.get(code) ?? 0) + count);
}

function rowIssueHistogram(parsed: ParsedAlumniRoster) {
  const counts = new Map<string, number>();
  for (const row of parsed.rows) {
    for (const issue of row.issues) {
      counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
    }
  }
  return Object.freeze(
    [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([code, count]) => Object.freeze({ code, count })),
  );
}

function rowErrorIdentity(
  rowNumber: number,
  field: string | null,
  code: string,
): string {
  return JSON.stringify([rowNumber, field, code]);
}

function incrementStringCount(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sortedStringCounts(counts: ReadonlyMap<string, number>): string {
  return JSON.stringify(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function inspectStoredRowErrors(value: unknown): {
  readonly valid: boolean;
  readonly identities: ReadonlyMap<string, number>;
  readonly codeCounts: ReadonlyMap<string, number>;
} {
  const identities = new Map<string, number>();
  const codeCounts = new Map<string, number>();
  if (!Array.isArray(value)) return { valid: false, identities, codeCounts };
  let valid = true;
  const allowedKeys = new Set(["rowNumber", "field", "code", "message"]);
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      valid = false;
      continue;
    }
    const error = candidate as Record<string, unknown>;
    if (Object.keys(error).some((key) => !allowedKeys.has(key))) valid = false;
    const rowNumber = safeCount(error.rowNumber);
    const field = error.field;
    const code = error.code;
    const message = error.message;
    const fieldValid =
      field === undefined ||
      (typeof field === "string" &&
        field.length >= 1 &&
        field.length <= 100 &&
        SAFE_SINGLE_LINE_PATTERN.test(field));
    const codeValid =
      typeof code === "string" &&
      code.length <= 80 &&
      SAFE_CODE_PATTERN.test(code) &&
      EXPECTED_ROW_ERROR_CODES.has(code);
    const messageValid =
      typeof message === "string" &&
      message.length >= 1 &&
      message.length <= 240 &&
      SAFE_SINGLE_LINE_PATTERN.test(message);
    incrementStringCount(
      codeCounts,
      codeValid ? code : "invalid_error_code",
    );
    if (!rowNumber || !fieldValid || !codeValid || !messageValid) {
      valid = false;
      continue;
    }
    const identity = rowErrorIdentity(
      rowNumber,
      typeof field === "string" ? field : null,
      code,
    );
    incrementStringCount(identities, identity);
    if ((identities.get(identity) ?? 0) > 1) valid = false;
  }
  return { valid, identities, codeCounts };
}

function validateExpectation(expectation: AlumniImportSourceExpectation): void {
  if (
    !SHA256_HEX_PATTERN.test(expectation.checksum) ||
    !Number.isSafeInteger(expectation.totalRows) ||
    expectation.totalRows < 1 ||
    !Number.isSafeInteger(expectation.uniqueContacts) ||
    expectation.uniqueContacts < 0 ||
    expectation.uniqueContacts > expectation.totalRows
  ) {
    throw new AlumniImportQualificationError(
      "ALUMNI_IMPORT_SOURCE_EXPECTATION_INVALID",
    );
  }
}

function normalizeIdentityText(value: string): string {
  return normalizeDisplayText(value).normalize("NFKC").toLowerCase();
}

function plainRawRows(value: unknown): readonly unknown[] {
  return Array.isArray(value)
    ? value.map((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) return row;
        const source = row as { rowNumber?: unknown; values?: unknown };
        return {
          rowNumber: source.rowNumber,
          values: Array.isArray(source.values) ? [...source.values] : source.values,
        };
      })
    : [];
}

function exactIndexKey(
  value: unknown,
  expected: readonly (readonly [string, number])[],
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return (
    entries.length === expected.length &&
    entries.every(
      ([field, direction], index) =>
        field === expected[index]?.[0] && direction === expected[index]?.[1],
    )
  );
}

function exactPartialStringField(value: unknown, field?: string): boolean {
  if (!field) return value === undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length !== 1 || entries[0]?.[0] !== field) return false;
  const condition = entries[0]?.[1];
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
    return false;
  }
  const conditions = Object.entries(condition as Record<string, unknown>);
  return (
    conditions.length === 1 &&
    conditions[0]?.[0] === "$type" &&
    conditions[0]?.[1] === "string"
  );
}

function exactPartialValues(
  value: unknown,
  field?: string,
  expectedValues?: readonly string[],
): boolean {
  if (!field && !expectedValues) return value === undefined;
  if (!field || !expectedValues) return false;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length !== 1 || entries[0]?.[0] !== field) return false;
  const condition = entries[0]?.[1];
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
    return false;
  }
  const conditions = Object.entries(condition as Record<string, unknown>);
  const values = conditions[0]?.[1];
  return (
    conditions.length === 1 &&
    conditions[0]?.[0] === "$in" &&
    Array.isArray(values) &&
    values.length === expectedValues.length &&
    values.every((item, index) => item === expectedValues[index])
  );
}

function exactRequiredIndex(
  value: Record<string, unknown>,
  expected: RequiredIndex,
): boolean {
  return (
    value.name === expected.name &&
    exactIndexKey(value.key, expected.keys) &&
    (expected.unique === true
      ? value.unique === true
      : value.unique !== true) &&
    value.sparse !== true &&
    (expected.expireAfterSeconds === undefined
      ? value.expireAfterSeconds === undefined
      : value.expireAfterSeconds === expected.expireAfterSeconds) &&
    value.collation === undefined &&
    value.hidden !== true &&
    (expected.partialStringField
      ? exactPartialStringField(
          value.partialFilterExpression,
          expected.partialStringField,
        )
      : exactPartialValues(
          value.partialFilterExpression,
          expected.partialValuesField,
          expected.partialValues,
        ))
  );
}

interface ObservedRowCounts {
  readonly validRows: number;
  readonly invalidRows: number;
  readonly matchedRows: number;
  readonly unmatchedRows: number;
  readonly ambiguousRows: number;
  readonly approvedRows: number;
  readonly rejectedRows: number;
  readonly appliedRows: number;
}

interface ProgramMappingVerification {
  readonly report: AlumniImportQualificationReport["programMapping"];
  readonly invalidRowNumbers: ReadonlySet<number>;
  readonly expectedRowErrors: ReadonlyMap<string, number>;
}

function inspectRowResults(value: unknown, batchStatus: string): {
  readonly valid: boolean;
  readonly records: ReadonlyMap<number, Record<string, unknown>>;
  readonly counts: ObservedRowCounts;
} {
  const records = new Map<number, Record<string, unknown>>();
  const counts: Record<keyof ObservedRowCounts, number> = {
    validRows: 0,
    invalidRows: 0,
    matchedRows: 0,
    unmatchedRows: 0,
    ambiguousRows: 0,
    approvedRows: 0,
    rejectedRows: 0,
    appliedRows: 0,
  };
  if (!Array.isArray(value)) return { valid: false, records, counts };
  let valid = true;
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      valid = false;
      continue;
    }
    const row = candidate as Record<string, unknown>;
    const rowNumber = safeCount(row.rowNumber);
    if (!rowNumber || records.has(rowNumber)) valid = false;
    else records.set(rowNumber, row);

    const matchStatus = row.matchStatus;
    const matchMethod = row.matchMethod;
    const eligibilityStatus = row.eligibilityStatus;
    const applicationStatus = row.applicationStatus;
    if (
      typeof matchStatus !== "string" ||
      !(ALUMNI_IMPORT_ROW_MATCH_STATUSES as readonly string[]).includes(
        matchStatus,
      ) ||
      typeof matchMethod !== "string" ||
      !(ALUMNI_IMPORT_ROW_MATCH_METHODS as readonly string[]).includes(
        matchMethod,
      ) ||
      typeof eligibilityStatus !== "string" ||
      !(
        ALUMNI_IMPORT_ROW_ELIGIBILITY_STATUSES as readonly string[]
      ).includes(eligibilityStatus) ||
      typeof applicationStatus !== "string" ||
      !(ALUMNI_IMPORT_ROW_APPLICATION_STATUSES as readonly string[]).includes(
        applicationStatus,
      )
    ) {
      valid = false;
      continue;
    }

    if (matchStatus === "invalid") counts.invalidRows += 1;
    else counts.validRows += 1;
    if (matchStatus === "matched") counts.matchedRows += 1;
    if (matchStatus === "unmatched") counts.unmatchedRows += 1;
    if (matchStatus === "ambiguous") counts.ambiguousRows += 1;
    if (eligibilityStatus === "approved") counts.approvedRows += 1;
    if (eligibilityStatus === "rejected") counts.rejectedRows += 1;
    if (applicationStatus === "applied") counts.appliedRows += 1;

    const matchedUser = row.matchedUserId;
    const candidates = row.candidateUserIds;
    const candidateIdsValid =
      Array.isArray(candidates) &&
      candidates.length <= 10 &&
      candidates.every((id) => id instanceof mongoose.Types.ObjectId) &&
      new Set(candidates.map(String)).size === candidates.length;
    if (!candidateIdsValid) valid = false;
    if (
      matchStatus === "matched" &&
      (!(matchedUser instanceof mongoose.Types.ObjectId) ||
        !Array.isArray(candidates) ||
        candidates.length !== 0 ||
        !["exact_email", "manual"].includes(matchMethod))
    ) {
      valid = false;
    }
    if (
      matchStatus === "ambiguous" &&
      (matchedUser != null ||
        !Array.isArray(candidates) ||
        candidates.length === 0 ||
        matchMethod !== "none")
    ) {
      valid = false;
    }
    if (
      ["unmatched", "invalid"].includes(matchStatus) &&
      (matchedUser != null ||
        !Array.isArray(candidates) ||
        candidates.length !== 0)
    ) {
      valid = false;
    }
    if (
      matchStatus === "unmatched" &&
      !["none", "manual"].includes(matchMethod)
    ) {
      valid = false;
    }
    if (matchStatus === "invalid" && matchMethod !== "none") valid = false;

    const reviewedAt = row.reviewedAt;
    const reviewedBy = row.reviewedBy;
    const reviewReasonCode = row.reviewReasonCode;
    const reviewComplete = ["approved", "rejected"].includes(
      eligibilityStatus,
    );
    if (matchMethod === "manual" && !reviewComplete) valid = false;
    if (
      reviewComplete &&
      (!(reviewedAt instanceof Date) ||
        !(reviewedBy instanceof mongoose.Types.ObjectId))
    ) {
      valid = false;
    }
    if (
      !reviewComplete &&
      (reviewedAt != null || reviewedBy != null || reviewReasonCode != null)
    ) {
      valid = false;
    }
    if (
      (matchStatus === "invalid") !==
      (eligibilityStatus === "not_applicable")
    ) {
      valid = false;
    }
    if (matchStatus === "ambiguous" && eligibilityStatus === "approved") {
      valid = false;
    }

    const applicationUpdatedAt = row.applicationUpdatedAt;
    if (applicationStatus === "pending" && applicationUpdatedAt != null) {
      valid = false;
    }
    if (
      applicationStatus !== "pending" &&
      !(applicationUpdatedAt instanceof Date)
    ) {
      valid = false;
    }
    if (
      ["applied", "failed"].includes(applicationStatus) &&
      (eligibilityStatus !== "approved" ||
        !["matched", "unmatched"].includes(matchStatus))
    ) {
      valid = false;
    }
    if (batchStatus === "review_ready") {
      const phaseValid =
        (matchStatus === "invalid" &&
          eligibilityStatus === "not_applicable" &&
          applicationStatus === "skipped") ||
        (matchStatus !== "invalid" &&
          eligibilityStatus === "pending_review" &&
          applicationStatus === "pending") ||
        (matchStatus !== "invalid" &&
          eligibilityStatus === "approved" &&
          applicationStatus === "pending") ||
        (matchStatus !== "invalid" &&
          eligibilityStatus === "rejected" &&
          applicationStatus === "skipped");
      if (!phaseValid) valid = false;
    }
  }
  return { valid, records, counts };
}

export class AlumniImportQualificationService {
  private readonly migrationReadiness: Pick<
    MigrationReadinessService,
    "assertReady"
  >;
  private readonly transactionService: Pick<
    MongoTransactionService,
    "assertTopologyCapability"
  >;

  constructor(dependencies: QualificationDependencies = {}) {
    this.migrationReadiness =
      dependencies.migrationReadiness ?? migrationReadinessService;
    this.transactionService =
      dependencies.transactionService ?? mongoTransactionService;
  }

  inspectSource(
    csv: Buffer,
    expectation?: AlumniImportSourceExpectation,
  ): AlumniImportSourceInspectionReport {
    if (expectation) validateExpectation(expectation);
    const parsed = parseAlumniRosterCsv(csv);
    const contacts = uniqueContacts(parsed);
    const issues = new Map<AlumniImportQualificationIssueCode, number>();
    if (expectation?.checksum !== undefined && expectation.checksum !== parsed.checksum) {
      incrementIssue(issues, "SOURCE_CHECKSUM_MISMATCH");
    }
    if (expectation?.totalRows !== undefined && expectation.totalRows !== parsed.rows.length) {
      incrementIssue(issues, "SOURCE_ROW_COUNT_MISMATCH");
    }
    if (
      expectation?.uniqueContacts !== undefined &&
      expectation.uniqueContacts !== contacts
    ) {
      incrementIssue(issues, "SOURCE_UNIQUE_CONTACT_COUNT_MISMATCH");
    }
    const rowIssues = rowIssueHistogram(parsed);
    const invalidRows = parsed.rows.filter((row) => row.value === null).length;
    incrementIssue(issues, "ROSTER_ROW_INVALID", invalidRows);
    const projectedIssues = issueList(issues);
    return Object.freeze({
      schemaVersion: ALUMNI_IMPORT_QUALIFICATION_REPORT_VERSION,
      kind: "alumni_import_source_inspection",
      status: projectedIssues.length === 0 ? "passed" : "failed",
      source: Object.freeze({
        checksum: parsed.checksum,
        bytes: csv.length,
        totalRows: parsed.rows.length,
        uniqueContacts: contacts,
      }),
      rowIssues,
      issues: projectedIssues,
    });
  }

  assertExpectedSource(
    csv: Buffer,
    expectation: AlumniImportSourceExpectation,
  ): AlumniImportSourceInspectionReport {
    const report = this.inspectSource(csv, expectation);
    if (report.status !== "passed") {
      throw new AlumniImportQualificationError(
        "ALUMNI_IMPORT_SOURCE_EXPECTATION_MISMATCH",
      );
    }
    return report;
  }

  async assertOperatorActor(actorId: string): Promise<{ id: string; role: string }> {
    if (!mongoose.Types.ObjectId.isValid(actorId)) {
      throw new AlumniImportQualificationError(
        "ALUMNI_IMPORT_ACTOR_UNAUTHORIZED",
      );
    }
    const actor = await User.findOne({
      _id: new mongoose.Types.ObjectId(actorId),
      isActive: true,
      isVerified: true,
    })
      .select("_id role")
      .lean<{ _id: mongoose.Types.ObjectId; role: string }>();
    if (!actor || !hasPermission(actor.role, PERMISSIONS.MANAGE_USERS)) {
      throw new AlumniImportQualificationError(
        "ALUMNI_IMPORT_ACTOR_UNAUTHORIZED",
      );
    }
    return Object.freeze({ id: actor._id.toString(), role: actor.role });
  }

  async assertOperationalGates(): Promise<void> {
    await this.migrationReadiness.assertReady();
    await this.transactionService.assertTopologyCapability(true);
    await this.assertRequiredIndexes(
      OPERATIONAL_REQUIRED_INDEXES,
      OPERATIONAL_FORBIDDEN_INDEX_KEYS,
    );
  }

  async assertCancellationGates(): Promise<void> {
    await this.transactionService.assertTopologyCapability(true);
    await this.assertRequiredIndexes(CANCELLATION_REQUIRED_INDEXES);
  }

  private async assertRequiredIndexes(
    requiredIndexes: readonly RequiredIndex[],
    forbiddenIndexKeys: readonly ForbiddenIndexKey[] = [],
  ): Promise<void> {
    const observedByModel = new Map<
      RequiredIndex["model"],
      readonly Record<string, unknown>[]
    >();
    const models = new Set<RequiredIndex["model"]>([
      ...requiredIndexes.map((index) => index.model),
      ...forbiddenIndexKeys.map((index) => index.model),
    ]);
    for (const model of models) {
      try {
        const observed = (await model.collection
          .listIndexes()
          .toArray()) as Record<string, unknown>[];
        observedByModel.set(model, observed);
      } catch {
        throw new AlumniImportQualificationError(
          "ALUMNI_IMPORT_REQUIRED_INDEX_MISSING",
        );
      }
    }
    for (const expected of requiredIndexes) {
      const observed = observedByModel.get(expected.model) ?? [];
      const sameKey = observed.filter((index) =>
        exactIndexKey(index.key, expected.keys),
      );
      const sameName = observed.filter(
        (index) => index.name === expected.name,
      );
      if (
        sameKey.length !== 1 ||
        sameName.length !== 1 ||
        !exactRequiredIndex(sameKey[0]!, expected)
      ) {
        throw new AlumniImportQualificationError(
          "ALUMNI_IMPORT_REQUIRED_INDEX_MISSING",
        );
      }
    }
    for (const forbidden of forbiddenIndexKeys) {
      const observed = observedByModel.get(forbidden.model) ?? [];
      if (
        observed.some((index) => exactIndexKey(index.key, forbidden.keys))
      ) {
        throw new AlumniImportQualificationError(
          "ALUMNI_IMPORT_REQUIRED_INDEX_MISSING",
        );
      }
    }
  }

  async verifyBatch(input: {
    readonly batchId: string;
    readonly csv: Buffer;
    readonly expectation: AlumniImportSourceExpectation;
  }): Promise<AlumniImportQualificationReport> {
    validateExpectation(input.expectation);
    if (!mongoose.Types.ObjectId.isValid(input.batchId)) {
      throw new AlumniImportQualificationError(
        "ALUMNI_IMPORT_SOURCE_EXPECTATION_INVALID",
      );
    }
    const parsed = parseAlumniRosterCsv(input.csv);
    const sourceInspection = this.inspectSource(input.csv, input.expectation);
    const issues = new Map<AlumniImportQualificationIssueCode, number>();
    sourceInspection.issues
      .filter((issue) => issue.code !== "ROSTER_ROW_INVALID")
      .forEach((issue) => incrementIssue(issues, issue.code, issue.count));
    const batch = (await AlumniImportBatch.collection.findOne({
      _id: new mongoose.Types.ObjectId(input.batchId),
    })) as RawBatchDocument | null;
    if (!batch) {
      incrementIssue(issues, "BATCH_NOT_FOUND");
      incrementIssue(
        issues,
        "ROSTER_ROW_INVALID",
        parsed.rows.filter((row) => row.value === null).length,
      );
      const affiliations = await this.auditAffiliations(issues);
      const projectedIssues = issueList(issues);
      return Object.freeze({
        schemaVersion: ALUMNI_IMPORT_QUALIFICATION_REPORT_VERSION,
        kind: "alumni_import_qualification",
        status: "failed",
        source: sourceInspection.source,
        batch: Object.freeze({
          id: input.batchId.toLowerCase(),
          status: "not_found",
          revision: 0,
          checksum: input.expectation.checksum,
          counts: emptyCounts(),
        }),
        verification: Object.freeze({
          sourceChecksumMatches: sourceInspection.source.checksum === input.expectation.checksum,
          sourceRowCountMatches: sourceInspection.source.totalRows === input.expectation.totalRows,
          sourceUniqueContactCountMatches:
            sourceInspection.source.uniqueContacts === input.expectation.uniqueContacts,
          batchChecksumMatches: false,
          rawHeadersMatch: false,
          rawRowsMatch: false,
          rowKeysMatch: false,
          countInvariantsHold: false,
          accountMatchingMatches: false,
        }),
        programMapping: Object.freeze({
          linkedRows: 0,
          externalRows: 0,
          missingProgramRows: 0,
          mismatchedProgramNameRows: 0,
        }),
        affiliations,
        rowIssues: sourceInspection.rowIssues,
        issues: projectedIssues,
      });
    }

    const storedChecksumValid =
      typeof batch.checksum === "string" &&
      SHA256_HEX_PATTERN.test(batch.checksum);
    const checksum = storedChecksumValid ? batch.checksum as string : "invalid";
    const status =
      typeof batch.status === "string" &&
      (ALUMNI_IMPORT_BATCH_STATUSES as readonly string[]).includes(batch.status)
        ? batch.status
        : "invalid";
    const schemaVersionValid = batch.schemaVersion === 1;
    const storedRevision = safeCount(batch.revision);
    const revision = storedRevision ?? 0;
    const invalidMetadataFields =
      Number(!schemaVersionValid) + Number(storedRevision === null);
    incrementIssue(
      issues,
      "BATCH_METADATA_INVALID",
      invalidMetadataFields,
    );
    const read = readCounts(batch.counts);
    const counts = read.counts;
    const batchChecksumMatches = storedChecksumValid && checksum === parsed.checksum;
    if (!batchChecksumMatches) incrementIssue(issues, "BATCH_CHECKSUM_MISMATCH");
    if (status !== "review_ready") incrementIssue(issues, "BATCH_STATUS_INVALID");

    const rawHeadersMatch =
      Array.isArray(batch.rawHeaders) &&
      JSON.stringify(batch.rawHeaders) === JSON.stringify(parsed.rawHeaders);
    const rawRowsMatch =
      Array.isArray(batch.rawRows) &&
      JSON.stringify(plainRawRows(batch.rawRows)) === JSON.stringify(parsed.rawRows);
    if (!rawHeadersMatch) incrementIssue(issues, "RAW_HEADERS_MISMATCH");
    if (!rawRowsMatch) incrementIssue(issues, "RAW_ROWS_MISMATCH");

    const inspectedResults = inspectRowResults(batch.rowResults, status);
    let rowResultsValid =
      inspectedResults.valid &&
      inspectedResults.records.size === parsed.rows.length;
    try {
      await new AlumniImportBatch(batch).validate();
    } catch {
      rowResultsValid = false;
    }
    const rowKeysMatch = parsed.rows.every(
      (row) =>
        inspectedResults.records.get(row.rowNumber)?.rowKey ===
        deriveAlumniRosterRowKey(parsed.checksum, row.rowNumber),
    );
    if (!rowResultsValid || !rowKeysMatch) {
      incrementIssue(issues, "ROW_RESULTS_INVALID");
    }

    const observed = inspectedResults.counts;
    const countInvariantsHold =
      read.valid &&
      rowResultsValid &&
      counts.totalRows === parsed.rows.length &&
      counts.validRows + counts.invalidRows === counts.totalRows &&
      counts.matchedRows + counts.unmatchedRows + counts.ambiguousRows === counts.validRows &&
      (status !== "review_ready" ||
        (counts.appliedRows === 0 &&
          counts.invitationsCreated === 0 &&
          counts.affiliationsCreated === 0)) &&
      Object.entries(observed).every(
        ([field, value]) => counts[field as keyof typeof observed] === value,
      );
    if (!countInvariantsHold) incrementIssue(issues, "COUNT_INVARIANT_FAILED");
    const ambiguousPendingReviewRows = [
      ...inspectedResults.records.values(),
    ].filter(
      (row) =>
        row.matchStatus === "ambiguous" &&
        row.eligibilityStatus === "pending_review",
    ).length;
    incrementIssue(
      issues,
      "AMBIGUOUS_MATCH_REQUIRES_REVIEW",
      ambiguousPendingReviewRows,
    );

    const storedRowErrors = inspectStoredRowErrors(batch.rowErrors);
    const rowIssues = Object.freeze(
      [...storedRowErrors.codeCounts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([code, count]) => Object.freeze({ code, count })),
    );
    const programVerification = await this.verifyProgramMapping(parsed, issues);
    incrementIssue(
      issues,
      "ROSTER_ROW_INVALID",
      programVerification.invalidRowNumbers.size,
    );
    if (
      !storedRowErrors.valid ||
      sortedStringCounts(storedRowErrors.identities) !==
        sortedStringCounts(programVerification.expectedRowErrors)
    ) {
      incrementIssue(issues, "ROW_ERROR_DISTRIBUTION_MISMATCH");
    }
    const accountMismatchRows = await this.accountMatchMismatchCount(
      parsed,
      programVerification.invalidRowNumbers,
      inspectedResults.records,
    );
    incrementIssue(issues, "ACCOUNT_MATCH_MISMATCH", accountMismatchRows);
    const accountMatchingMatches = accountMismatchRows === 0;
    const affiliations = await this.auditAffiliations(issues);
    const projectedIssues = issueList(issues);
    return Object.freeze({
      schemaVersion: ALUMNI_IMPORT_QUALIFICATION_REPORT_VERSION,
      kind: "alumni_import_qualification",
      status: projectedIssues.length === 0 ? "passed" : "failed",
      source: sourceInspection.source,
      batch: Object.freeze({
        id: input.batchId.toLowerCase(),
        status,
        revision,
        checksum,
        counts,
      }),
      verification: Object.freeze({
        sourceChecksumMatches:
          sourceInspection.source.checksum === input.expectation.checksum,
        sourceRowCountMatches:
          sourceInspection.source.totalRows === input.expectation.totalRows,
        sourceUniqueContactCountMatches:
          sourceInspection.source.uniqueContacts ===
          input.expectation.uniqueContacts,
        batchChecksumMatches,
        rawHeadersMatch,
        rawRowsMatch,
        rowKeysMatch,
        countInvariantsHold,
        accountMatchingMatches,
      }),
      programMapping: programVerification.report,
      affiliations,
      rowIssues,
      issues: projectedIssues,
    });
  }

  private async verifyProgramMapping(
    parsed: ParsedAlumniRoster,
    issues: Map<AlumniImportQualificationIssueCode, number>,
  ): Promise<ProgramMappingVerification> {
    const linked = parsed.rows.filter((row) => Boolean(row.value?.programId));
    const externalRows = parsed.rows.filter(
      (row) => row.value !== null && !row.value.programId,
    ).length;
    const ids = [...new Set(linked.map((row) => row.value!.programId!))];
    const programs = ids.length
      ? await Program.find({ _id: { $in: ids } }).select("_id title").lean()
      : [];
    const titles = new Map(
      programs.map((program) => [String(program._id), String(program.title)]),
    );
    const expectedRowErrors = new Map<string, number>();
    const invalidRowNumbers = new Set<number>();
    const addExpectedError = (
      rowNumber: number,
      field: string | null,
      code: string,
    ): void => {
      incrementStringCount(
        expectedRowErrors,
        rowErrorIdentity(rowNumber, field, code),
      );
    };
    let missingProgramRows = 0;
    let mismatchedProgramNameRows = 0;
    const seenIdentities = new Set<string>();
    for (const row of [...parsed.rows].sort(
      (left, right) => left.rowNumber - right.rowNumber,
    )) {
      row.issues.forEach((issue) =>
        addExpectedError(row.rowNumber, issue.field, issue.code),
      );
      if (!row.value) {
        invalidRowNumbers.add(row.rowNumber);
        continue;
      }
      let rowValid = true;
      if (row.value.programId) {
        const title = titles.get(row.value.programId);
        if (!title) {
          missingProgramRows += 1;
          addExpectedError(row.rowNumber, "programId", "program_not_found");
          rowValid = false;
        } else if (
          normalizeIdentityText(title) !==
          normalizeIdentityText(row.value.programName)
        ) {
          mismatchedProgramNameRows += 1;
          addExpectedError(
            row.rowNumber,
            "programName",
            "program_name_mismatch",
          );
          rowValid = false;
        }
      }
      if (!rowValid) {
        invalidRowNumbers.add(row.rowNumber);
        continue;
      }
      const affiliationIdentity = row.value.programId
        ? `program:${deriveAlumniProgramAffiliationKey({
            programId: row.value.programId,
            cohortLabel: row.value.cohortLabel,
          })}`
        : `external:${deriveAlumniAffiliationKey({
            programName: row.value.programName,
            cohortLabel: row.value.cohortLabel,
          })}`;
      const identity = `${row.value.email}\0${affiliationIdentity}`;
      if (seenIdentities.has(identity)) {
        addExpectedError(
          row.rowNumber,
          "programName",
          "duplicate_affiliation",
        );
        invalidRowNumbers.add(row.rowNumber);
      } else {
        seenIdentities.add(identity);
      }
    }
    incrementIssue(issues, "PROGRAM_NOT_FOUND", missingProgramRows);
    incrementIssue(
      issues,
      "PROGRAM_NAME_MISMATCH",
      mismatchedProgramNameRows,
    );
    return Object.freeze({
      report: Object.freeze({
        linkedRows: linked.length,
        externalRows,
        missingProgramRows,
        mismatchedProgramNameRows,
      }),
      invalidRowNumbers,
      expectedRowErrors,
    });
  }

  private async accountMatchMismatchCount(
    parsed: ParsedAlumniRoster,
    invalidRowNumbers: ReadonlySet<number>,
    rowResults: ReadonlyMap<number, Record<string, unknown>>,
  ): Promise<number> {
    const validRows = parsed.rows.filter(
      (row) => row.value !== null && !invalidRowNumbers.has(row.rowNumber),
    );
    const emails = [
      ...new Set(validRows.map((row) => row.value!.email.toLowerCase())),
    ];
    const manualMatchedIds = [
      ...new Set(
        validRows
          .map((row) => rowResults.get(row.rowNumber))
          .filter((result) => result?.matchMethod === "manual")
          .map((result) => result?.matchedUserId)
          .filter(
            (value): value is mongoose.Types.ObjectId =>
              value instanceof mongoose.Types.ObjectId,
          )
          .map(String),
      ),
    ];
    const userFilters = [
      ...(emails.length > 0 ? [{ email: { $in: emails } }] : []),
      ...(manualMatchedIds.length > 0
        ? [{ _id: { $in: manualMatchedIds } }]
        : []),
    ];
    const users = userFilters.length
      ? await User.find({ $or: userFilters })
          .select("_id email")
          .sort({ _id: 1 })
          .lean<{ _id: mongoose.Types.ObjectId; email: string }[]>()
      : [];
    const existingIds = new Set(users.map((user) => user._id.toString()));
    const usersByEmail = new Map<string, string[]>();
    for (const user of users) {
      const email = user.email.trim().toLowerCase();
      const ids = usersByEmail.get(email) ?? [];
      ids.push(user._id.toString());
      usersByEmail.set(email, ids);
    }

    let mismatches = 0;
    for (const row of parsed.rows) {
      const result = rowResults.get(row.rowNumber);
      const candidateIds = Array.isArray(result?.candidateUserIds)
        ? result.candidateUserIds.map(String)
        : [];
      const matchedUserId =
        result?.matchedUserId instanceof mongoose.Types.ObjectId
          ? result.matchedUserId.toString()
          : null;
      let matches = Boolean(result);
      if (!row.value || invalidRowNumbers.has(row.rowNumber)) {
        matches =
          matches &&
          result?.matchStatus === "invalid" &&
          result.matchMethod === "none" &&
          matchedUserId === null &&
          candidateIds.length === 0;
      } else if (result?.matchMethod === "manual") {
        matches =
          matches &&
          ((result.matchStatus === "matched" &&
            matchedUserId !== null &&
            existingIds.has(matchedUserId) &&
            candidateIds.length === 0) ||
            (result.matchStatus === "unmatched" &&
              matchedUserId === null &&
              candidateIds.length === 0));
      } else {
        const expectedIds = usersByEmail.get(row.value.email) ?? [];
        if (expectedIds.length === 1) {
          matches =
            matches &&
            result?.matchStatus === "matched" &&
            result.matchMethod === "exact_email" &&
            matchedUserId === expectedIds[0] &&
            candidateIds.length === 0;
        } else if (expectedIds.length === 0) {
          matches =
            matches &&
            result?.matchStatus === "unmatched" &&
            result.matchMethod === "none" &&
            matchedUserId === null &&
            candidateIds.length === 0;
        } else {
          const expectedCandidates = expectedIds.slice(0, 10);
          matches =
            matches &&
            result?.matchStatus === "ambiguous" &&
            result.matchMethod === "none" &&
            matchedUserId === null &&
            JSON.stringify(candidateIds) === JSON.stringify(expectedCandidates);
        }
      }
      if (!matches) mismatches += 1;
    }
    return mismatches;
  }

  private async auditAffiliations(
    issues: Map<AlumniImportQualificationIssueCode, number>,
  ): Promise<AlumniImportQualificationReport["affiliations"]> {
    const identities = new Map<string, number>();
    let totalRecords = 0;
    let formatErrorRecords = 0;
    let affiliationKeyMismatchRecords = 0;
    let programAffiliationKeyMismatchRecords = 0;
    const cursor = AlumniAffiliation.collection.find(
      {},
      {
        projection: {
          alumniProfileId: 1,
          programId: 1,
          programName: 1,
          cohortLabel: 1,
          affiliationKey: 1,
          programAffiliationKey: 1,
        },
      },
    );
    for await (const raw of cursor) {
      totalRecords += 1;
      const row = raw as RawAffiliationDocument;
      const hasProgramId = Object.prototype.hasOwnProperty.call(
        row,
        "programId",
      );
      const hasProgramAffiliationKey = Object.prototype.hasOwnProperty.call(
        row,
        "programAffiliationKey",
      );
      const profileId =
        row.alumniProfileId instanceof mongoose.Types.ObjectId
          ? row.alumniProfileId.toString()
          : null;
      const programId =
        !hasProgramId
          ? null
          : row.programId instanceof mongoose.Types.ObjectId
            ? row.programId.toString()
            : "invalid";
      const programName =
        typeof row.programName === "string" &&
        isValidDisplayText(row.programName, 1, 160) &&
        row.programName === normalizeDisplayText(row.programName)
          ? row.programName
          : null;
      const cohort =
        row.cohortLabel == null
          ? null
          : typeof row.cohortLabel === "string" &&
              isValidDisplayText(row.cohortLabel, 1, 100) &&
              row.cohortLabel === normalizeDisplayText(row.cohortLabel)
            ? row.cohortLabel
            : undefined;
      const affiliationKey =
        typeof row.affiliationKey === "string" &&
        SHA256_HEX_PATTERN.test(row.affiliationKey)
          ? row.affiliationKey
          : null;
      const programKey =
        !hasProgramAffiliationKey
          ? null
          : typeof row.programAffiliationKey === "string" &&
              SHA256_HEX_PATTERN.test(row.programAffiliationKey)
            ? row.programAffiliationKey
            : "invalid";
      const formatInvalid =
        !profileId ||
        !programName ||
        cohort === undefined ||
        programId === "invalid" ||
        !affiliationKey ||
        programKey === "invalid" ||
        (programId !== null && programKey === null) ||
        (programId === null && programKey !== null);
      if (formatInvalid) {
        formatErrorRecords += 1;
        continue;
      }
      const expectedNameKey = deriveAlumniAffiliationKey({
        programName,
        cohortLabel: cohort,
      });
      if (affiliationKey !== expectedNameKey) {
        affiliationKeyMismatchRecords += 1;
      }
      let identity: string;
      if (programId) {
        const expectedProgramKey = deriveAlumniProgramAffiliationKey({
          programId,
          cohortLabel: cohort,
        });
        if (programKey !== expectedProgramKey) {
          programAffiliationKeyMismatchRecords += 1;
        }
        identity = `${profileId}\0program:${expectedProgramKey}`;
      } else {
        identity = `${profileId}\0external:${expectedNameKey}`;
      }
      identities.set(identity, (identities.get(identity) ?? 0) + 1);
    }
    const duplicateCounts = [...identities.values()].filter((count) => count > 1);
    const duplicateIdentityGroups = duplicateCounts.length;
    const duplicateIdentityRecords = duplicateCounts.reduce(
      (sum, count) => sum + count - 1,
      0,
    );
    incrementIssue(issues, "AFFILIATION_FORMAT_ERROR", formatErrorRecords);
    incrementIssue(
      issues,
      "AFFILIATION_NAME_IDENTITY_MISMATCH",
      affiliationKeyMismatchRecords,
    );
    incrementIssue(
      issues,
      "AFFILIATION_PROGRAM_IDENTITY_MISMATCH",
      programAffiliationKeyMismatchRecords,
    );
    incrementIssue(
      issues,
      "AFFILIATION_DUPLICATE_IDENTITY",
      duplicateIdentityRecords,
    );
    return Object.freeze({
      totalRecords,
      formatErrorRecords,
      affiliationKeyMismatchRecords,
      programAffiliationKeyMismatchRecords,
      duplicateIdentityGroups,
      duplicateIdentityRecords,
    });
  }
}

export const alumniImportQualificationService =
  new AlumniImportQualificationService();
