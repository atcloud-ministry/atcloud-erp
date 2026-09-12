import { createHash } from "crypto";
import { normalizeDisplayText } from "@atcloud/shared-time/registration-profile";
import mongoose, { type ClientSession } from "mongoose";
import {
  ALUMNI_IMPORT_BATCH_TERMINAL_STATUSES,
  ALUMNI_IMPORT_BATCH_STATUSES,
  IMPORT_RAW_DATA_RETENTION_DAYS,
  IMPORT_SUMMARY_RETENTION_MONTHS,
  SAFE_CODE_PATTERN,
  SAFE_SINGLE_LINE_PATTERN,
  addFixedDays,
  addUtcCalendarMonths,
  deriveAlumniAffiliationKey,
  deriveAlumniProgramAffiliationKey,
  type AlumniImportBatchStatus,
} from "../../contracts/alumniDirectoryData";
import {
  ALUMNI_IMPORT_LIST_MAX_LIMIT,
  buildAlumniImportAdminRowsPageDTO,
  buildAlumniImportBatchSummaryDTO,
  type AlumniImportAdminRowsPageDTO,
  type AlumniImportBatchSummaryDTO,
  type AlumniImportReviewDecision,
} from "../../contracts/alumniRosterFlow";
import AlumniImportBatch, {
  type AlumniImportBatchCounts,
  type AlumniImportRowError,
  type AlumniImportRowResult,
  type IAlumniImportBatch,
} from "../../models/AlumniImportBatch";
import Program from "../../models/Program";
import User from "../../models/User";
import {
  USER_PICKER_PROJECTION,
  serializeUserPicker,
} from "../../serializers/userReadSerializers";
import { AuditLogService } from "../AuditLogService";
import type { IdempotencyReplayResponseDto } from "../reliability/IdempotencyResponseContract";
import {
  IdempotencyService,
  idempotencyService,
} from "../reliability/IdempotencyService";
import {
  AlumniFlowError,
  alumniInputError,
} from "./AlumniFlowErrors";
import {
  AlumniInvitationService,
  alumniInvitationService,
  type AlumniFlowActor,
} from "./AlumniInvitationService";
import {
  parseAlumniRosterCsv,
  parseRetainedAlumniRoster,
  type CanonicalAlumniRosterRow,
  type ParsedAlumniRoster,
  type ParsedAlumniRosterRow,
} from "./AlumniRosterCsvParser";

const BATCH_PRIVATE_SELECTION =
  "+rawHeaders +rawRows +rowErrors +rowResults";
const APPLY_ROW_LIMIT = 100;
const INVITATION_AFFILIATION_LIMIT = 50;
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;

export interface ListAlumniImportBatchesInput {
  readonly page: number;
  readonly limit: number;
  readonly status?: AlumniImportBatchStatus;
}

export interface ListAlumniImportBatchesResult {
  readonly batches: readonly AlumniImportBatchSummaryDTO[];
  readonly pagination: {
    readonly currentPage: number;
    readonly totalPages: number;
    readonly hasNext: boolean;
    readonly hasPrev: boolean;
    readonly totalBatches: number;
  };
}

export interface ListAlumniImportRowsInput {
  readonly batchId: string;
  readonly page: number;
  readonly limit: number;
}

export interface DryRunAlumniImportInput {
  readonly csv: Buffer;
  readonly actor: AlumniFlowActor;
  readonly idempotencyKey: string;
  readonly correlationId?: string;
}

export interface ReviewAlumniImportInput {
  readonly batchId: string;
  readonly expectedRevision: number;
  readonly decisions: readonly AlumniImportReviewDecision[];
  readonly actor: AlumniFlowActor;
  readonly idempotencyKey: string;
  readonly correlationId?: string;
}

export interface ApplyAlumniImportInput {
  readonly batchId: string;
  readonly expectedRevision: number;
  readonly actor: AlumniFlowActor;
  readonly idempotencyKey: string;
  readonly correlationId?: string;
}

export interface RerunAlumniImportInput {
  readonly batchId: string;
  readonly expectedRevision: number;
  readonly actor: AlumniFlowActor;
  readonly idempotencyKey: string;
  readonly correlationId?: string;
}

interface DryRunResponse extends IdempotencyReplayResponseDto {
  readonly batchId: string;
  readonly status: "review_ready";
  readonly revision: number;
  readonly totalRows: number;
  readonly validRows: number;
  readonly invalidRows: number;
  readonly matchedRows: number;
  readonly unmatchedRows: number;
  readonly ambiguousRows: number;
}

interface ReviewResponse extends IdempotencyReplayResponseDto {
  readonly batchId: string;
  readonly status: "review_ready";
  readonly revision: number;
  readonly approvedRows: number;
  readonly rejectedRows: number;
  readonly pendingReviewRows: number;
}

interface ApplyResponse extends IdempotencyReplayResponseDto {
  readonly batchId: string;
  readonly status: "applying" | "completed";
  readonly revision: number;
  readonly appliedRows: number;
  readonly invitationsCreated: number;
  readonly remainingRows: number;
}

interface RerunResponse extends IdempotencyReplayResponseDto {
  readonly sourceBatchId: string;
  readonly sourceRevision: number;
  readonly batchId: string;
  readonly status: "review_ready";
  readonly revision: number;
  readonly totalRows: number;
  readonly validRows: number;
  readonly invalidRows: number;
  readonly matchedRows: number;
  readonly unmatchedRows: number;
  readonly ambiguousRows: number;
}

interface AlumniImportServiceDependencies {
  readonly now?: () => Date;
  readonly idempotency?: IdempotencyService;
  readonly invitations?: Pick<
    AlumniInvitationService,
    "issueForApprovedRoster"
  >;
}

interface EvaluatedRoster {
  readonly rowResults: AlumniImportRowResult[];
  readonly rowErrors: AlumniImportRowError[];
  readonly counts: AlumniImportBatchCounts;
}

interface ProgramRecord {
  readonly _id: mongoose.Types.ObjectId;
  readonly title: string;
}

interface UserMatchRecord {
  readonly _id: mongoose.Types.ObjectId;
  readonly email: string;
}

function importNotFound(): AlumniFlowError {
  return new AlumniFlowError(
    "ALUMNI_IMPORT_NOT_FOUND",
    404,
    "The alumni import batch was not found.",
  );
}

function rawDataUnavailable(): AlumniFlowError {
  return new AlumniFlowError(
    "ALUMNI_IMPORT_RAW_DATA_UNAVAILABLE",
    410,
    "The retained alumni roster data is no longer available.",
  );
}

function revisionConflict(): AlumniFlowError {
  return new AlumniFlowError(
    "ALUMNI_IMPORT_REVISION_CONFLICT",
    409,
    "The alumni import batch revision has changed.",
  );
}

function stateConflict(message = "The alumni import batch is not in the required state.") {
  return new AlumniFlowError("ALUMNI_IMPORT_STATE_CONFLICT", 409, message);
}

function applicationConflict(message: string): AlumniFlowError {
  return new AlumniFlowError(
    "ALUMNI_IMPORT_APPLICATION_CONFLICT",
    409,
    message,
  );
}

function isMongoDuplicateKeyError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === 11000
  );
}

function reviewIncomplete(): AlumniFlowError {
  return new AlumniFlowError(
    "ALUMNI_IMPORT_REVIEW_INCOMPLETE",
    409,
    "Every valid roster row must be approved or rejected before applying.",
  );
}

function requireObjectId(value: string): mongoose.Types.ObjectId {
  if (typeof value !== "string" || !OBJECT_ID_PATTERN.test(value)) {
    throw alumniInputError();
  }
  return new mongoose.Types.ObjectId(value);
}

function requireRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw alumniInputError();
  return value;
}

function requirePage(value: number, field: "page" | "limit"): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    (field === "limit" && value > ALUMNI_IMPORT_LIST_MAX_LIMIT)
  ) {
    throw alumniInputError();
  }
  return value;
}

function requireActor(actor: AlumniFlowActor): mongoose.Types.ObjectId {
  if (
    !actor ||
    typeof actor.role !== "string" ||
    actor.role.length < 1 ||
    actor.role.length > 80
  ) {
    throw alumniInputError();
  }
  return requireObjectId(actor.id);
}

function normalizedIdentityText(value: string): string {
  return normalizeDisplayText(value).normalize("NFKC").toLowerCase();
}

function cloneDate(value: Date | null | undefined): Date | null {
  return value instanceof Date ? new Date(value) : null;
}

function cloneRowResult(result: AlumniImportRowResult): AlumniImportRowResult {
  return {
    rowNumber: result.rowNumber,
    rowKey: result.rowKey,
    matchStatus: result.matchStatus,
    matchMethod: result.matchMethod,
    ...(result.matchedUserId
      ? { matchedUserId: new mongoose.Types.ObjectId(result.matchedUserId) }
      : {}),
    candidateUserIds: result.candidateUserIds.map(
      (id) => new mongoose.Types.ObjectId(id),
    ),
    eligibilityStatus: result.eligibilityStatus,
    reviewedAt: cloneDate(result.reviewedAt),
    ...(result.reviewedBy
      ? { reviewedBy: new mongoose.Types.ObjectId(result.reviewedBy) }
      : {}),
    ...(result.reviewReasonCode
      ? { reviewReasonCode: result.reviewReasonCode }
      : {}),
    applicationStatus: result.applicationStatus,
    applicationUpdatedAt: cloneDate(result.applicationUpdatedAt),
  };
}

function countsFor(
  rowResults: readonly AlumniImportRowResult[],
  invitationsCreated = 0,
  affiliationsCreated = 0,
): AlumniImportBatchCounts {
  return {
    totalRows: rowResults.length,
    validRows: rowResults.filter((row) => row.matchStatus !== "invalid").length,
    invalidRows: rowResults.filter((row) => row.matchStatus === "invalid").length,
    matchedRows: rowResults.filter((row) => row.matchStatus === "matched").length,
    unmatchedRows: rowResults.filter((row) => row.matchStatus === "unmatched").length,
    ambiguousRows: rowResults.filter((row) => row.matchStatus === "ambiguous").length,
    approvedRows: rowResults.filter(
      (row) => row.eligibilityStatus === "approved",
    ).length,
    rejectedRows: rowResults.filter(
      (row) => row.eligibilityStatus === "rejected",
    ).length,
    appliedRows: rowResults.filter(
      (row) => row.applicationStatus === "applied",
    ).length,
    invitationsCreated,
    affiliationsCreated,
  };
}

function serviceRowError(
  rowNumber: number,
  field: string,
  code: string,
  message: string,
): AlumniImportRowError {
  return { rowNumber, field, code, message };
}

function duplicateIdentity(row: CanonicalAlumniRosterRow): string {
  return row.programId
    ? `${row.email}\0program:${deriveAlumniProgramAffiliationKey({
        programId: row.programId,
        cohortLabel: row.cohortLabel,
      })}`
    : `${row.email}\0external:${deriveAlumniAffiliationKey({
        programName: row.programName,
        cohortLabel: row.cohortLabel,
      })}`;
}

async function evaluateRoster(
  parsed: ParsedAlumniRoster,
  session: ClientSession,
  now: Date,
): Promise<EvaluatedRoster> {
  const programIds = [
    ...new Set(
      parsed.rows
        .map((row) => row.value?.programId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const programs = programIds.length
    ? ((await Program.find({ _id: { $in: programIds } })
        .select("_id title")
        .session(session)
        .lean()) as unknown as ProgramRecord[])
    : [];
  const programById = new Map(
    programs.map((program) => [program._id.toString(), program]),
  );

  const emails = [
    ...new Set(
      parsed.rows
        .map((row) => row.value?.email)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const users = emails.length
    ? ((await User.find({ email: { $in: emails } })
        .select("_id email")
        .sort({ _id: 1 })
        .session(session)
        .lean()) as unknown as UserMatchRecord[])
    : [];
  const usersByEmail = new Map<string, mongoose.Types.ObjectId[]>();
  for (const user of users) {
    const values = usersByEmail.get(user.email) ?? [];
    values.push(user._id);
    usersByEmail.set(user.email, values);
  }

  const rowResults: AlumniImportRowResult[] = [];
  const rowErrors: AlumniImportRowError[] = [];
  const seenAffiliations = new Set<string>();
  const orderedRows = [...parsed.rows].sort(
    (left, right) => left.rowNumber - right.rowNumber,
  );
  for (const row of orderedRows) {
    for (const issue of row.issues) {
      rowErrors.push({
        rowNumber: row.rowNumber,
        field: issue.field,
        code: issue.code,
        message: issue.message,
      });
    }
    if (!row.value) {
      rowResults.push({
        rowNumber: row.rowNumber,
        rowKey: row.rowKey,
        matchStatus: "invalid",
        matchMethod: "none",
        candidateUserIds: [],
        eligibilityStatus: "not_applicable",
        reviewedAt: null,
        applicationStatus: "skipped",
        applicationUpdatedAt: new Date(now),
      });
      continue;
    }

    let rowIsValid = true;
    if (row.value.programId) {
      const program = programById.get(row.value.programId);
      if (!program) {
        rowIsValid = false;
        rowErrors.push(
          serviceRowError(
            row.rowNumber,
            "programId",
            "program_not_found",
            "The specified Program does not exist.",
          ),
        );
      } else if (
        normalizedIdentityText(program.title) !==
        normalizedIdentityText(row.value.programName)
      ) {
        rowIsValid = false;
        rowErrors.push(
          serviceRowError(
            row.rowNumber,
            "programName",
            "program_name_mismatch",
            "Program name does not match the specified Program.",
          ),
        );
      }
    }

    const identity = duplicateIdentity(row.value);
    if (rowIsValid && seenAffiliations.has(identity)) {
      rowIsValid = false;
      rowErrors.push(
        serviceRowError(
          row.rowNumber,
          "programName",
          "duplicate_affiliation",
          "This contact and alumni affiliation repeat an earlier roster row.",
        ),
      );
    }
    if (rowIsValid) {
      seenAffiliations.add(identity);
    }

    if (!rowIsValid) {
      rowResults.push({
        rowNumber: row.rowNumber,
        rowKey: row.rowKey,
        matchStatus: "invalid",
        matchMethod: "none",
        candidateUserIds: [],
        eligibilityStatus: "not_applicable",
        reviewedAt: null,
        applicationStatus: "skipped",
        applicationUpdatedAt: new Date(now),
      });
      continue;
    }

    const matchingUsers = usersByEmail.get(row.value.email) ?? [];
    if (matchingUsers.length === 1) {
      rowResults.push({
        rowNumber: row.rowNumber,
        rowKey: row.rowKey,
        matchStatus: "matched",
        matchMethod: "exact_email",
        matchedUserId: matchingUsers[0],
        candidateUserIds: [],
        eligibilityStatus: "pending_review",
        reviewedAt: null,
        applicationStatus: "pending",
        applicationUpdatedAt: null,
      });
    } else if (matchingUsers.length === 0) {
      rowResults.push({
        rowNumber: row.rowNumber,
        rowKey: row.rowKey,
        matchStatus: "unmatched",
        matchMethod: "none",
        candidateUserIds: [],
        eligibilityStatus: "pending_review",
        reviewedAt: null,
        applicationStatus: "pending",
        applicationUpdatedAt: null,
      });
    } else {
      rowResults.push({
        rowNumber: row.rowNumber,
        rowKey: row.rowKey,
        matchStatus: "ambiguous",
        matchMethod: "none",
        candidateUserIds: matchingUsers.slice(0, 10),
        eligibilityStatus: "pending_review",
        reviewedAt: null,
        applicationStatus: "pending",
        applicationUpdatedAt: null,
      });
    }
  }

  return {
    rowResults,
    rowErrors,
    counts: countsFor(rowResults),
  };
}

function rawDataIsLogicallyAvailable(
  batch: IAlumniImportBatch,
  now: Date,
): boolean {
  return Boolean(
    !batch.rawDataPurgedAt &&
      (!batch.rawDataPurgeAt || batch.rawDataPurgeAt.getTime() > now.getTime()),
  );
}

function toBatchSummary(
  batch: IAlumniImportBatch,
  now: Date,
): AlumniImportBatchSummaryDTO {
  return buildAlumniImportBatchSummaryDTO({
    id: String(batch._id),
    checksum: batch.checksum,
    status: batch.status,
    counts: batch.counts,
    createdById: batch.createdBy.toString(),
    rerunOfBatchId: batch.rerunOfBatchId?.toString() ?? null,
    terminalAt: batch.terminalAt ?? null,
    rawDataAvailable: rawDataIsLogicallyAvailable(batch, now),
    revision: batch.revision,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
  });
}

function retainedRoster(
  batch: IAlumniImportBatch,
  now: Date,
): ParsedAlumniRoster {
  if (
    !rawDataIsLogicallyAvailable(batch, now) ||
    batch.rawHeaders === undefined ||
    batch.rawRows === undefined ||
    batch.rowResults === undefined ||
    batch.rowErrors === undefined
  ) {
    throw rawDataUnavailable();
  }
  return parseRetainedAlumniRoster(
    [...batch.rawHeaders],
    batch.rawRows.map((row) => ({
      rowNumber: row.rowNumber,
      values: [...row.values],
    })),
    batch.checksum,
  );
}

function safeDisplayCell(value: string | undefined, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length >= 1 &&
    normalized.length <= maximum &&
    SAFE_SINGLE_LINE_PATTERN.test(normalized)
    ? normalized
    : null;
}

function displayValuesForRow(
  parsed: ParsedAlumniRoster,
  row: ParsedAlumniRosterRow,
): {
  contactEmail: string | null;
  contactFirstName: string | null;
  contactLastName: string | null;
  programName: string | null;
  cohortLabel: string | null;
  programId: string | null;
} {
  if (row.value) {
    return {
      contactEmail: row.value.email,
      contactFirstName: row.value.firstName,
      contactLastName: row.value.lastName,
      programName: row.value.programName,
      cohortLabel: row.value.cohortLabel,
      programId: row.value.programId,
    };
  }
  const raw = parsed.rawRows.find(
    (candidate) => candidate.rowNumber === row.rowNumber,
  );
  const values = new Map<string, string>();
  parsed.canonicalHeaders.forEach((header, index) => {
    values.set(header, raw?.values[index] ?? "");
  });
  const rawProgramId = safeDisplayCell(values.get("programId"), 24);
  return {
    contactEmail: safeDisplayCell(values.get("email")?.toLowerCase(), 254),
    contactFirstName: safeDisplayCell(values.get("firstName"), 100),
    contactLastName: safeDisplayCell(values.get("lastName"), 100),
    programName: safeDisplayCell(values.get("programName"), 160),
    cohortLabel: safeDisplayCell(values.get("cohortLabel"), 100),
    programId:
      rawProgramId && OBJECT_ID_PATTERN.test(rawProgramId)
        ? rawProgramId.toLowerCase()
        : null,
  };
}

function reviewDecisionsDigest(
  decisions: readonly AlumniImportReviewDecision[],
): string {
  const canonical = [...decisions]
    .sort((left, right) => left.rowNumber - right.rowNumber)
    .map((decision) => ({
      rowNumber: decision.rowNumber,
      rowKey: decision.rowKey,
      eligibilityStatus: decision.eligibilityStatus,
      resolution: decision.resolution
        ? decision.resolution.matchStatus === "matched"
          ? {
              matchStatus: "matched",
              matchedUserId: decision.resolution.matchedUserId,
            }
          : { matchStatus: "unmatched" }
        : null,
      reviewReasonCode: decision.reviewReasonCode ?? null,
    }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function pendingReviewRows(rows: readonly AlumniImportRowResult[]): number {
  return rows.filter(
    (row) =>
      row.matchStatus !== "invalid" &&
      row.eligibilityStatus === "pending_review",
  ).length;
}

async function saveNewBatch(
  batch: IAlumniImportBatch,
  session: ClientSession,
): Promise<void> {
  try {
    await batch.save({ session });
  } catch (error) {
    if (error instanceof mongoose.Error.ValidationError) {
      throw alumniInputError(
        "The roster data and review results cannot fit within one import batch.",
      );
    }
    throw error;
  }
}

export class AlumniImportService {
  private readonly now: () => Date;
  private readonly idempotency: IdempotencyService;
  private readonly invitations: Pick<
    AlumniInvitationService,
    "issueForApprovedRoster"
  >;

  constructor(dependencies: AlumniImportServiceDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.idempotency = dependencies.idempotency ?? idempotencyService;
    this.invitations = dependencies.invitations ?? alumniInvitationService;
  }

  async listBatches(
    input: ListAlumniImportBatchesInput,
  ): Promise<ListAlumniImportBatchesResult> {
    const page = requirePage(input.page, "page");
    const limit = requirePage(input.limit, "limit");
    if (
      input.status !== undefined &&
      !(ALUMNI_IMPORT_BATCH_STATUSES as readonly string[]).includes(input.status)
    ) {
      throw alumniInputError();
    }
    const filter = input.status ? { status: input.status } : {};
    const [batches, totalBatches] = await Promise.all([
      AlumniImportBatch.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      AlumniImportBatch.countDocuments(filter),
    ]);
    const totalPages = Math.ceil(totalBatches / limit);
    const now = this.now();
    return Object.freeze({
      batches: Object.freeze(batches.map((batch) => toBatchSummary(batch, now))),
      pagination: Object.freeze({
        currentPage: page,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
        totalBatches,
      }),
    });
  }

  async getBatch(batchId: string): Promise<AlumniImportBatchSummaryDTO> {
    const id = requireObjectId(batchId);
    const batch = await AlumniImportBatch.findById(id);
    if (!batch) throw importNotFound();
    return toBatchSummary(batch, this.now());
  }

  async listRows(
    input: ListAlumniImportRowsInput,
  ): Promise<AlumniImportAdminRowsPageDTO> {
    const batchId = requireObjectId(input.batchId);
    const page = requirePage(input.page, "page");
    const limit = requirePage(input.limit, "limit");
    const batch = await AlumniImportBatch.findById(batchId).select(
      BATCH_PRIVATE_SELECTION,
    );
    if (!batch) throw importNotFound();
    const parsed = retainedRoster(batch, this.now());
    const results = [...batch.rowResults!].sort(
      (left, right) => left.rowNumber - right.rowNumber,
    );
    const pageResults = results.slice((page - 1) * limit, page * limit);
    const userIds = new Set<string>();
    for (const result of pageResults) {
      if (result.matchedUserId) userIds.add(result.matchedUserId.toString());
      result.candidateUserIds.forEach((id) => userIds.add(id.toString()));
    }
    const users = userIds.size
      ? await User.find({ _id: { $in: [...userIds] } })
          .select(USER_PICKER_PROJECTION)
          .lean()
      : [];
    const userById = new Map(
      users.map((user) => [String(user._id), serializeUserPicker(user)]),
    );
    const parsedByRow = new Map(
      parsed.rows.map((row) => [row.rowNumber, row]),
    );
    const errorsByRow = new Map<number, AlumniImportRowError[]>();
    for (const error of batch.rowErrors!) {
      const errors = errorsByRow.get(error.rowNumber) ?? [];
      errors.push(error);
      errorsByRow.set(error.rowNumber, errors);
    }

    return buildAlumniImportAdminRowsPageDTO({
      batchId: String(batch._id),
      batchRevision: batch.revision,
      page,
      limit,
      totalRows: batch.counts.totalRows,
      rows: pageResults.map((result) => {
        const parsedRow = parsedByRow.get(result.rowNumber);
        if (!parsedRow) {
          throw new AlumniFlowError(
            "ALUMNI_OPERATION_UNAVAILABLE",
            503,
            "The retained alumni roster is inconsistent.",
          );
        }
        const display = displayValuesForRow(parsed, parsedRow);
        return {
          rowNumber: result.rowNumber,
          rowKey: result.rowKey,
          ...display,
          matchStatus: result.matchStatus,
          matchMethod: result.matchMethod,
          matchedUser: result.matchedUserId
            ? userById.get(result.matchedUserId.toString()) ?? null
            : null,
          candidateUsers: result.candidateUserIds
            .map((id) => userById.get(id.toString()))
            .filter((value): value is NonNullable<typeof value> => Boolean(value)),
          eligibilityStatus: result.eligibilityStatus,
          reviewedAt: result.reviewedAt ?? null,
          reviewedById: result.reviewedBy?.toString() ?? null,
          reviewReasonCode: result.reviewReasonCode ?? null,
          applicationStatus: result.applicationStatus,
          applicationUpdatedAt: result.applicationUpdatedAt ?? null,
          errors: (errorsByRow.get(result.rowNumber) ?? []).map((error) => ({
            field: error.field ?? null,
            code: error.code,
            message: error.message,
          })),
        };
      }),
    });
  }

  async dryRun(input: DryRunAlumniImportInput) {
    const actorId = requireActor(input.actor);
    const parsed = parseAlumniRosterCsv(input.csv);
    if (parsed.rows.length === 0) {
      throw alumniInputError("Roster CSV must contain at least one data row.");
    }
    const execution = await this.idempotency.execute<DryRunResponse>({
      scope: "alumni.import.dry-run",
      actorKey: actorId.toString(),
      key: input.idempotencyKey,
      requestPayload: { checksum: parsed.checksum },
      execute: async (session) => {
        const evaluated = await evaluateRoster(parsed, session, this.now());
        const batch = new AlumniImportBatch({
          checksum: parsed.checksum,
          status: "review_ready",
          counts: evaluated.counts,
          rawHeaders: [...parsed.rawHeaders],
          rawRows: parsed.rawRows.map((row) => ({
            rowNumber: row.rowNumber,
            values: [...row.values],
          })),
          rowErrors: evaluated.rowErrors,
          rowResults: evaluated.rowResults,
          createdBy: actorId,
          revision: 0,
        });
        await saveNewBatch(batch, session);
        await AuditLogService.recordRequiredInTransaction(
          {
            action: "alumni_import.dry_run_created",
            actor: {
              type: "user",
              id: actorId.toString(),
              role: input.actor.role,
            },
            source: "http",
            outcome: "success",
            target: {
              model: "AlumniImportBatch",
              id: String(batch._id),
            },
            correlationId: input.correlationId,
            details: {
              totalRows: evaluated.counts.totalRows,
              validRows: evaluated.counts.validRows,
              invalidRows: evaluated.counts.invalidRows,
              matchedRows: evaluated.counts.matchedRows,
              unmatchedRows: evaluated.counts.unmatchedRows,
              ambiguousRows: evaluated.counts.ambiguousRows,
            },
          },
          session,
        );
        return {
          httpStatus: 201,
          response: {
            batchId: String(batch._id),
            status: "review_ready",
            revision: batch.revision,
            totalRows: evaluated.counts.totalRows,
            validRows: evaluated.counts.validRows,
            invalidRows: evaluated.counts.invalidRows,
            matchedRows: evaluated.counts.matchedRows,
            unmatchedRows: evaluated.counts.unmatchedRows,
            ambiguousRows: evaluated.counts.ambiguousRows,
          },
          resource: {
            type: "AlumniImportBatch",
            id: String(batch._id),
          },
        };
      },
    });
    return Object.freeze({ replayed: execution.replayed, ...execution.response! });
  }

  async review(input: ReviewAlumniImportInput) {
    const actorId = requireActor(input.actor);
    const batchId = requireObjectId(input.batchId);
    const expectedRevision = requireRevision(input.expectedRevision);
    this.validateReviewDecisions(input.decisions);
    const decisionsDigest = reviewDecisionsDigest(input.decisions);
    const execution = await this.idempotency.execute<ReviewResponse>({
      scope: "alumni.import.review",
      actorKey: actorId.toString(),
      key: input.idempotencyKey,
      requestPayload: {
        batchId: batchId.toString(),
        expectedRevision,
        decisionsDigest,
        decisionCount: input.decisions.length,
      },
      execute: async (session) => {
        const batch = await AlumniImportBatch.findById(batchId)
          .select(BATCH_PRIVATE_SELECTION)
          .session(session);
        if (!batch) throw importNotFound();
        if (batch.revision !== expectedRevision) throw revisionConflict();
        if (batch.status !== "review_ready") throw stateConflict();
        const reviewedAt = this.now();
        retainedRoster(batch, reviewedAt);

        const manuallyMatchedIds = input.decisions
          .map((decision) =>
            decision.resolution?.matchStatus === "matched"
              ? decision.resolution.matchedUserId
              : undefined,
          )
          .filter((value): value is string => Boolean(value));
        const manualObjectIds = manuallyMatchedIds.map(requireObjectId);
        if (manualObjectIds.length > 0) {
          const existingUsers = await User.find({
            _id: { $in: manualObjectIds },
          })
            .select("_id")
            .session(session)
            .lean();
          const existingIds = new Set(existingUsers.map((user) => String(user._id)));
          if (
            manualObjectIds.some((id) => !existingIds.has(id.toString()))
          ) {
            throw applicationConflict(
              "A manually selected roster user no longer exists.",
            );
          }
        }

        const nextResults = batch.rowResults!.map(cloneRowResult);
        const resultByNumber = new Map(
          nextResults.map((result) => [result.rowNumber, result]),
        );
        for (const decision of input.decisions) {
          const result = resultByNumber.get(decision.rowNumber);
          if (!result || result.rowKey !== decision.rowKey) {
            throw revisionConflict();
          }
          if (result.matchStatus === "invalid") {
            throw stateConflict("Invalid roster rows cannot be reviewed.");
          }
          if (decision.resolution?.matchStatus === "matched") {
            result.matchStatus = "matched";
            result.matchMethod = "manual";
            result.matchedUserId = requireObjectId(
              decision.resolution.matchedUserId,
            );
            result.candidateUserIds = [];
          } else if (decision.resolution?.matchStatus === "unmatched") {
            result.matchStatus = "unmatched";
            result.matchMethod = "manual";
            delete result.matchedUserId;
            result.candidateUserIds = [];
          }
          if (
            decision.eligibilityStatus === "approved" &&
            result.matchStatus === "ambiguous"
          ) {
            throw stateConflict(
              "Ambiguous roster matches must be resolved before approval.",
            );
          }
          result.eligibilityStatus = decision.eligibilityStatus;
          result.reviewedAt = new Date(reviewedAt);
          result.reviewedBy = actorId;
          if (decision.reviewReasonCode) {
            result.reviewReasonCode = decision.reviewReasonCode;
          } else {
            delete result.reviewReasonCode;
          }
          if (decision.eligibilityStatus === "approved") {
            result.applicationStatus = "pending";
            result.applicationUpdatedAt = null;
          } else {
            result.applicationStatus = "skipped";
            result.applicationUpdatedAt = new Date(reviewedAt);
          }
        }

        const counts = countsFor(
          nextResults,
          batch.counts.invitationsCreated,
          batch.counts.affiliationsCreated,
        );
        batch.set({
          rowResults: nextResults,
          counts,
          revision: expectedRevision + 1,
        });
        await batch.validate();
        const updated = await AlumniImportBatch.findOneAndUpdate(
          {
            _id: batchId,
            revision: expectedRevision,
            status: "review_ready",
          },
          {
            $set: {
              rowResults: nextResults,
              counts,
              revision: expectedRevision + 1,
            },
          },
          { new: true, session, runValidators: false },
        ).select(BATCH_PRIVATE_SELECTION);
        if (!updated) throw revisionConflict();
        await updated.validate();

        await AuditLogService.recordRequiredInTransaction(
          {
            action: "alumni_import.review_updated",
            actor: {
              type: "user",
              id: actorId.toString(),
              role: input.actor.role,
            },
            source: "http",
            outcome: "success",
            target: {
              model: "AlumniImportBatch",
              id: batchId.toString(),
            },
            correlationId: input.correlationId,
            details: {
              decisionCount: input.decisions.length,
              approvedRows: counts.approvedRows,
              rejectedRows: counts.rejectedRows,
              pendingReviewRows: pendingReviewRows(nextResults),
              fromRevision: expectedRevision,
              toRevision: expectedRevision + 1,
            },
          },
          session,
        );
        return {
          httpStatus: 200,
          response: {
            batchId: batchId.toString(),
            status: "review_ready",
            revision: expectedRevision + 1,
            approvedRows: counts.approvedRows,
            rejectedRows: counts.rejectedRows,
            pendingReviewRows: pendingReviewRows(nextResults),
          },
          resource: {
            type: "AlumniImportBatch",
            id: batchId.toString(),
          },
        };
      },
    });
    return Object.freeze({ replayed: execution.replayed, ...execution.response! });
  }

  async apply(input: ApplyAlumniImportInput) {
    const actorId = requireActor(input.actor);
    const batchId = requireObjectId(input.batchId);
    const expectedRevision = requireRevision(input.expectedRevision);
    const execution = await this.idempotency.execute<ApplyResponse>({
      scope: "alumni.import.apply",
      actorKey: actorId.toString(),
      key: input.idempotencyKey,
      requestPayload: { batchId: batchId.toString(), expectedRevision },
      execute: async (session) => {
        const batch = await AlumniImportBatch.findById(batchId)
          .select(BATCH_PRIVATE_SELECTION)
          .session(session);
        if (!batch) throw importNotFound();
        if (batch.revision !== expectedRevision) throw revisionConflict();
        if (batch.status !== "review_ready" && batch.status !== "applying") {
          throw stateConflict();
        }
        const currentStatus = batch.status;
        const now = this.now();
        const parsed = retainedRoster(batch, now);
        const nextResults = batch.rowResults!.map(cloneRowResult);
        if (pendingReviewRows(nextResults) > 0) throw reviewIncomplete();
        if (
          nextResults.some(
            (row) =>
              row.matchStatus !== "invalid" &&
              row.eligibilityStatus !== "approved" &&
              row.eligibilityStatus !== "rejected",
          )
        ) {
          throw reviewIncomplete();
        }

        for (const result of nextResults) {
          if (
            (result.matchStatus === "invalid" ||
              result.eligibilityStatus === "rejected") &&
            result.applicationStatus === "pending"
          ) {
            result.applicationStatus = "skipped";
            result.applicationUpdatedAt = new Date(now);
          }
        }
        const parsedByNumber = new Map(
          parsed.rows.map((row) => [row.rowNumber, row]),
        );
        const pendingApproved = nextResults.filter(
          (row) =>
            row.eligibilityStatus === "approved" &&
            row.applicationStatus === "pending",
        );
        const canonicalPending = pendingApproved.map((result) => {
          if (
            result.matchStatus !== "matched" &&
            result.matchStatus !== "unmatched"
          ) {
            throw applicationConflict(
              "Approved roster rows require a resolved exact-email match.",
            );
          }
          const parsedRow = parsedByNumber.get(result.rowNumber);
          if (!parsedRow?.value) {
            throw applicationConflict(
              "An approved roster row no longer has valid retained data.",
            );
          }
          return { result, value: parsedRow.value };
        });
        await this.validateProgramsAtApply(
          canonicalPending.map((entry) => entry.value),
          session,
        );
        await this.validateAccountMatchesAtApply(canonicalPending, session);

        const groups = new Map<string, typeof canonicalPending>();
        for (const entry of canonicalPending) {
          const group = groups.get(entry.value.email) ?? [];
          group.push(entry);
          groups.set(entry.value.email, group);
        }
        for (const group of groups.values()) {
          if (group.length > INVITATION_AFFILIATION_LIMIT) {
            throw applicationConflict(
              "One roster contact exceeds the invitation affiliation limit.",
            );
          }
          const identities = new Set(
            group.map((entry) =>
              entry.result.matchStatus === "matched"
                ? `matched:${entry.result.matchedUserId?.toString() ?? ""}`
                : "unmatched",
            ),
          );
          if (identities.size !== 1 || identities.has("matched:")) {
            throw applicationConflict(
              "Rows for the same roster contact have conflicting match resolutions.",
            );
          }
        }
        const selectedGroups: (typeof canonicalPending)[] = [];
        let selectedRowCount = 0;
        for (const group of groups.values()) {
          if (selectedRowCount + group.length > APPLY_ROW_LIMIT) break;
          selectedGroups.push(group);
          selectedRowCount += group.length;
        }
        if (pendingApproved.length > 0 && selectedGroups.length === 0) {
          throw applicationConflict(
            "A roster contact group cannot fit within one apply chunk.",
          );
        }

        let invitationsCreated = 0;
        const appliedRowNumbers = new Set<number>();
        for (const group of selectedGroups) {
          const first = group[0]!;
          const matchedUserId =
            first.result.matchStatus === "matched"
              ? first.result.matchedUserId
              : undefined;
          const contactFirstName = group.find(
            (entry) => entry.value.firstName !== null,
          )?.value.firstName;
          const contactLastName = group.find(
            (entry) => entry.value.lastName !== null,
          )?.value.lastName;
          const issued = await this.invitations
            .issueForApprovedRoster({
              contactEmail: first.value.email,
              ...(contactFirstName ? { contactFirstName } : {}),
              ...(contactLastName ? { contactLastName } : {}),
              ...(matchedUserId ? { matchedUserId } : {}),
              affiliations: group.map(({ result, value }) => {
                if (!result.reviewedAt || !result.reviewedBy) {
                  throw applicationConflict(
                    "Approved roster rows require reviewer provenance.",
                  );
                }
                return {
                  ...(value.programId
                    ? { programId: new mongoose.Types.ObjectId(value.programId) }
                    : {}),
                  programName: value.programName,
                  cohortLabel: value.cohortLabel,
                  sourceImportBatchId: batchId,
                  sourceRowNumber: result.rowNumber,
                  reviewedAt: new Date(result.reviewedAt),
                  reviewedBy: new mongoose.Types.ObjectId(result.reviewedBy),
                };
              }),
              actor: input.actor,
              correlationId: input.correlationId,
              session,
            })
            .catch((error: unknown) => {
              if (isMongoDuplicateKeyError(error)) {
                throw applicationConflict(
                  "A concurrent alumni invitation write conflicted; refresh and apply again.",
                );
              }
              throw error;
            });
          if (issued.created) invitationsCreated += 1;
          group.forEach(({ result }) => appliedRowNumbers.add(result.rowNumber));
        }
        for (const result of nextResults) {
          if (appliedRowNumbers.has(result.rowNumber)) {
            result.applicationStatus = "applied";
            result.applicationUpdatedAt = new Date(now);
          }
        }

        const remainingRows = nextResults.filter(
          (row) =>
            row.eligibilityStatus === "approved" &&
            row.applicationStatus === "pending",
        ).length;
        const status: "applying" | "completed" =
          remainingRows > 0 ? "applying" : "completed";
        const counts = countsFor(
          nextResults,
          batch.counts.invitationsCreated + invitationsCreated,
          batch.counts.affiliationsCreated,
        );
        const terminalFields =
          status === "completed"
            ? {
                terminalAt: now,
                rawDataPurgeAt: addFixedDays(
                  now,
                  IMPORT_RAW_DATA_RETENTION_DAYS,
                ),
                purgeAt: addUtcCalendarMonths(
                  now,
                  IMPORT_SUMMARY_RETENTION_MONTHS,
                ),
              }
            : {
                terminalAt: null,
                rawDataPurgeAt: null,
                purgeAt: null,
              };
        batch.set({
          status,
          rowResults: nextResults,
          counts,
          ...terminalFields,
          revision: expectedRevision + 1,
        });
        await batch.validate();
        const updated = await AlumniImportBatch.findOneAndUpdate(
          {
            _id: batchId,
            revision: expectedRevision,
            status: currentStatus,
          },
          {
            $set: {
              status,
              rowResults: nextResults,
              counts,
              ...terminalFields,
              revision: expectedRevision + 1,
            },
          },
          { new: true, session, runValidators: false },
        ).select(BATCH_PRIVATE_SELECTION);
        if (!updated) throw revisionConflict();
        await updated.validate();

        await AuditLogService.recordRequiredInTransaction(
          {
            action:
              status === "completed"
                ? "alumni_import.completed"
                : "alumni_import.apply_chunk",
            actor: {
              type: "user",
              id: actorId.toString(),
              role: input.actor.role,
            },
            source: "http",
            outcome: "success",
            target: {
              model: "AlumniImportBatch",
              id: batchId.toString(),
            },
            correlationId: input.correlationId,
            details: {
              appliedInChunk: appliedRowNumbers.size,
              invitationsCreatedInChunk: invitationsCreated,
              appliedRows: counts.appliedRows,
              invitationsCreated: counts.invitationsCreated,
              remainingRows,
              fromRevision: expectedRevision,
              toRevision: expectedRevision + 1,
            },
          },
          session,
        );
        return {
          httpStatus: 200,
          response: {
            batchId: batchId.toString(),
            status,
            revision: expectedRevision + 1,
            appliedRows: counts.appliedRows,
            invitationsCreated: counts.invitationsCreated,
            remainingRows,
          },
          resource: {
            type: "AlumniImportBatch",
            id: batchId.toString(),
          },
        };
      },
    });
    return Object.freeze({ replayed: execution.replayed, ...execution.response! });
  }

  async rerun(input: RerunAlumniImportInput) {
    const actorId = requireActor(input.actor);
    const sourceBatchId = requireObjectId(input.batchId);
    const expectedRevision = requireRevision(input.expectedRevision);
    const execution = await this.idempotency.execute<RerunResponse>({
      scope: "alumni.import.rerun",
      actorKey: actorId.toString(),
      key: input.idempotencyKey,
      requestPayload: {
        sourceBatchId: sourceBatchId.toString(),
        expectedRevision,
      },
      execute: async (session) => {
        const source = await AlumniImportBatch.findById(sourceBatchId)
          .select(BATCH_PRIVATE_SELECTION)
          .session(session);
        if (!source) throw importNotFound();
        if (source.revision !== expectedRevision) throw revisionConflict();
        const now = this.now();
        const parsed = retainedRoster(source, now);
        if (parsed.rows.length === 0) {
          throw alumniInputError("Roster CSV must contain at least one data row.");
        }
        const evaluated = await evaluateRoster(parsed, session, now);
        const sourceWasTerminal = (
          ALUMNI_IMPORT_BATCH_TERMINAL_STATUSES as readonly string[]
        ).includes(source.status);
        const sourceLifecycleFields = sourceWasTerminal
          ? {}
          : {
              status: "cancelled" as const,
              terminalAt: now,
              rawDataPurgeAt: addFixedDays(
                now,
                IMPORT_RAW_DATA_RETENTION_DAYS,
              ),
              purgeAt: addUtcCalendarMonths(
                now,
                IMPORT_SUMMARY_RETENTION_MONTHS,
              ),
            };
        const sourceCas = await AlumniImportBatch.updateOne(
          {
            _id: sourceBatchId,
            revision: expectedRevision,
            status: source.status,
          },
          {
            $set: {
              ...sourceLifecycleFields,
              revision: expectedRevision + 1,
            },
          },
          { session, runValidators: false },
        );
        if (sourceCas.matchedCount !== 1) throw revisionConflict();

        if (!sourceWasTerminal) {
          await AuditLogService.recordRequiredInTransaction(
            {
              action: "alumni_import.cancelled_for_rerun",
              actor: {
                type: "user",
                id: actorId.toString(),
                role: input.actor.role,
              },
              source: "http",
              outcome: "success",
              target: {
                model: "AlumniImportBatch",
                id: sourceBatchId.toString(),
              },
              correlationId: input.correlationId,
              details: {
                previousStatus: source.status,
                resultingStatus: "cancelled",
                fromRevision: expectedRevision,
                toRevision: expectedRevision + 1,
              },
            },
            session,
          );
        }

        const batch = new AlumniImportBatch({
          checksum: parsed.checksum,
          status: "review_ready",
          counts: evaluated.counts,
          rawHeaders: [...parsed.rawHeaders],
          rawRows: parsed.rawRows.map((row) => ({
            rowNumber: row.rowNumber,
            values: [...row.values],
          })),
          rowErrors: evaluated.rowErrors,
          rowResults: evaluated.rowResults,
          createdBy: actorId,
          rerunOfBatchId: sourceBatchId,
          revision: 0,
        });
        await saveNewBatch(batch, session);
        await AuditLogService.recordRequiredInTransaction(
          {
            action: "alumni_import.rerun_created",
            actor: {
              type: "user",
              id: actorId.toString(),
              role: input.actor.role,
            },
            source: "http",
            outcome: "success",
            target: {
              model: "AlumniImportBatch",
              id: String(batch._id),
            },
            correlationId: input.correlationId,
            details: {
              sourceBatchId: sourceBatchId.toString(),
              sourceRevision: expectedRevision + 1,
              sourcePreviousStatus: source.status,
              sourceResultingStatus: sourceWasTerminal
                ? source.status
                : "cancelled",
              totalRows: evaluated.counts.totalRows,
              validRows: evaluated.counts.validRows,
              invalidRows: evaluated.counts.invalidRows,
              matchedRows: evaluated.counts.matchedRows,
              unmatchedRows: evaluated.counts.unmatchedRows,
              ambiguousRows: evaluated.counts.ambiguousRows,
            },
          },
          session,
        );
        return {
          httpStatus: 201,
          response: {
            sourceBatchId: sourceBatchId.toString(),
            sourceRevision: expectedRevision + 1,
            batchId: String(batch._id),
            status: "review_ready",
            revision: batch.revision,
            totalRows: evaluated.counts.totalRows,
            validRows: evaluated.counts.validRows,
            invalidRows: evaluated.counts.invalidRows,
            matchedRows: evaluated.counts.matchedRows,
            unmatchedRows: evaluated.counts.unmatchedRows,
            ambiguousRows: evaluated.counts.ambiguousRows,
          },
          resource: {
            type: "AlumniImportBatch",
            id: String(batch._id),
          },
        };
      },
    });
    return Object.freeze({ replayed: execution.replayed, ...execution.response! });
  }

  private validateReviewDecisions(
    decisions: readonly AlumniImportReviewDecision[],
  ): void {
    if (!Array.isArray(decisions) || decisions.length < 1 || decisions.length > 500) {
      throw alumniInputError();
    }
    const rowNumbers = new Set<number>();
    const rowKeys = new Set<string>();
    for (const decision of decisions) {
      if (
        !Number.isSafeInteger(decision.rowNumber) ||
        decision.rowNumber < 1 ||
        !/^[a-f0-9]{64}$/.test(decision.rowKey) ||
        (decision.eligibilityStatus !== "approved" &&
          decision.eligibilityStatus !== "rejected") ||
        rowNumbers.has(decision.rowNumber) ||
        rowKeys.has(decision.rowKey) ||
        (decision.reviewReasonCode !== undefined &&
          (decision.reviewReasonCode.length > 80 ||
            !SAFE_CODE_PATTERN.test(decision.reviewReasonCode)))
      ) {
        throw alumniInputError();
      }
      rowNumbers.add(decision.rowNumber);
      rowKeys.add(decision.rowKey);
      if (decision.resolution?.matchStatus === "matched") {
        requireObjectId(decision.resolution.matchedUserId);
      } else if (
        decision.resolution &&
        decision.resolution.matchStatus !== "unmatched"
      ) {
        throw alumniInputError();
      }
    }
  }

  private async validateProgramsAtApply(
    rows: readonly CanonicalAlumniRosterRow[],
    session: ClientSession,
  ): Promise<void> {
    const ids = [
      ...new Set(
        rows
          .map((row) => row.programId)
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    if (ids.length === 0) return;
    const programs = (await Program.find({ _id: { $in: ids } })
      .select("_id title")
      .session(session)
      .lean()) as unknown as ProgramRecord[];
    const byId = new Map(
      programs.map((program) => [program._id.toString(), program.title]),
    );
    for (const row of rows) {
      if (!row.programId) continue;
      const title = byId.get(row.programId);
      if (
        !title ||
        normalizedIdentityText(title) !== normalizedIdentityText(row.programName)
      ) {
        throw applicationConflict(
          "A linked Program changed after roster review; rerun review before applying.",
        );
      }
    }
  }

  private async validateAccountMatchesAtApply(
    rows: readonly {
      readonly result: AlumniImportRowResult;
      readonly value: CanonicalAlumniRosterRow;
    }[],
    session: ClientSession,
  ): Promise<void> {
    const matchedUserIds = [
      ...new Set(
        rows
          .filter((row) => row.result.matchStatus === "matched")
          .map((row) => row.result.matchedUserId?.toString())
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    if (matchedUserIds.length === 0) return;

    const users = (await User.find({ _id: { $in: matchedUserIds } })
      .select("_id email")
      .session(session)
      .lean()) as unknown as UserMatchRecord[];
    const usersById = new Map(
      users.map((user) => [user._id.toString(), user]),
    );
    for (const row of rows) {
      if (row.result.matchStatus !== "matched") continue;
      const matchedUserId = row.result.matchedUserId?.toString();
      const user = matchedUserId ? usersById.get(matchedUserId) : undefined;
      if (!user) {
        throw applicationConflict(
          "A reviewed roster account no longer exists; rerun review before applying.",
        );
      }
      if (
        row.result.matchMethod === "exact_email" &&
        user.email.trim().toLowerCase() !== row.value.email
      ) {
        throw applicationConflict(
          "An exact-email roster match changed after review; rerun review before applying.",
        );
      }
      if (
        row.result.matchMethod !== "exact_email" &&
        row.result.matchMethod !== "manual"
      ) {
        throw applicationConflict(
          "A reviewed roster match is missing durable provenance.",
        );
      }
    }
  }
}

export const alumniImportService = new AlumniImportService();
