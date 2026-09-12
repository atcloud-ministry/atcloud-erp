import mongoose, { type Document, type Model, Schema } from "mongoose";
import {
  ALUMNI_IMPORT_BATCH_STATUSES,
  ALUMNI_IMPORT_ROW_APPLICATION_STATUSES,
  ALUMNI_IMPORT_ROW_ELIGIBILITY_STATUSES,
  ALUMNI_IMPORT_ROW_MATCH_METHODS,
  ALUMNI_IMPORT_ROW_MATCH_STATUSES,
  IMPORT_RAW_DATA_RETENTION_DAYS,
  IMPORT_SUMMARY_RETENTION_MONTHS,
  SAFE_CODE_PATTERN,
  SAFE_SINGLE_LINE_PATTERN,
  SHA256_HEX_PATTERN,
  addFixedDays,
  addUtcCalendarMonths,
  datesEqual,
  isNonNegativeSafeInteger,
  isTerminalAlumniImportBatchStatus,
  type AlumniImportBatchStatus,
  type AlumniImportRowApplicationStatus,
  type AlumniImportRowEligibilityStatus,
  type AlumniImportRowMatchMethod,
  type AlumniImportRowMatchStatus,
} from "../contracts/alumniDirectoryData";

export const ALUMNI_IMPORT_BATCH_COLLECTION = "alumni_import_batches" as const;

const MAX_RAW_ROWS = 5_000;
const MAX_ROW_ERRORS = 10_000;
const MAX_COLUMNS = 64;
const MAX_HEADER_LENGTH = 100;
const MAX_RAW_VALUE_LENGTH = 2_000;
const MAX_RAW_DATA_BYTES = 8 * 1024 * 1024;

export interface AlumniImportBatchCounts {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  matchedRows: number;
  unmatchedRows: number;
  ambiguousRows: number;
  approvedRows: number;
  rejectedRows: number;
  appliedRows: number;
  invitationsCreated: number;
  affiliationsCreated: number;
}

export interface AlumniImportRawRow {
  rowNumber: number;
  values: string[];
}

export interface AlumniImportRowError {
  rowNumber: number;
  field?: string;
  code: string;
  message: string;
}

export interface AlumniImportRowResult {
  rowNumber: number;
  rowKey: string;
  matchStatus: AlumniImportRowMatchStatus;
  matchMethod: AlumniImportRowMatchMethod;
  matchedUserId?: mongoose.Types.ObjectId;
  candidateUserIds: mongoose.Types.ObjectId[];
  eligibilityStatus: AlumniImportRowEligibilityStatus;
  reviewedAt?: Date | null;
  reviewedBy?: mongoose.Types.ObjectId;
  reviewReasonCode?: string;
  applicationStatus: AlumniImportRowApplicationStatus;
  applicationUpdatedAt?: Date | null;
}

export interface IAlumniImportBatch extends Document {
  schemaVersion: number;
  checksum: string;
  status: AlumniImportBatchStatus;
  counts: AlumniImportBatchCounts;
  rawHeaders?: string[];
  rawRows?: AlumniImportRawRow[];
  rowErrors?: AlumniImportRowError[];
  rowResults?: AlumniImportRowResult[];
  createdBy: mongoose.Types.ObjectId;
  rerunOfBatchId?: mongoose.Types.ObjectId;
  terminalAt?: Date | null;
  rawDataPurgeAt?: Date | null;
  rawDataPurgedAt?: Date | null;
  purgeAt?: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

const safeCountField = {
  type: Number,
  required: true,
  default: 0,
  min: 0,
  validate: {
    validator: isNonNegativeSafeInteger,
    message: "Import counts must be non-negative safe integers.",
  },
} as const;

const importCountsSchema = new Schema<AlumniImportBatchCounts>(
  {
    totalRows: safeCountField,
    validRows: safeCountField,
    invalidRows: safeCountField,
    matchedRows: safeCountField,
    unmatchedRows: safeCountField,
    ambiguousRows: safeCountField,
    approvedRows: safeCountField,
    rejectedRows: safeCountField,
    appliedRows: safeCountField,
    invitationsCreated: safeCountField,
    affiliationsCreated: safeCountField,
  },
  { _id: false, strict: "throw", minimize: false },
);

const rawRowSchema = new Schema<AlumniImportRawRow>(
  {
    rowNumber: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: (value: unknown) =>
          Number.isSafeInteger(value) && Number(value) >= 1,
        message: "Import rowNumber must be a positive safe integer.",
      },
    },
    values: {
      type: [String],
      required: true,
      validate: {
        validator: (values: unknown) =>
          Array.isArray(values) &&
          values.length <= MAX_COLUMNS &&
          values.every(
            (value) =>
              typeof value === "string" &&
              value.length <= MAX_RAW_VALUE_LENGTH &&
              !value.includes("\u0000"),
          ),
        message: "Import row values must be bounded strings.",
      },
    },
  },
  { _id: false, strict: "throw" },
);

const rowErrorSchema = new Schema<AlumniImportRowError>(
  {
    rowNumber: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: (value: unknown) =>
          Number.isSafeInteger(value) && Number(value) >= 1,
        message: "Error rowNumber must be a positive safe integer.",
      },
    },
    field: {
      type: String,
      trim: true,
      maxlength: MAX_HEADER_LENGTH,
      match: SAFE_SINGLE_LINE_PATTERN,
    },
    code: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
      match: SAFE_CODE_PATTERN,
    },
    message: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 240,
      match: SAFE_SINGLE_LINE_PATTERN,
    },
  },
  { _id: false, strict: "throw" },
);

const rowResultSchema = new Schema<AlumniImportRowResult>(
  {
    rowNumber: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: (value: unknown) =>
          Number.isSafeInteger(value) && Number(value) >= 1,
        message: "Result rowNumber must be a positive safe integer.",
      },
    },
    rowKey: {
      type: String,
      required: true,
      lowercase: true,
      match: SHA256_HEX_PATTERN,
    },
    matchStatus: {
      type: String,
      enum: ALUMNI_IMPORT_ROW_MATCH_STATUSES,
      required: true,
    },
    matchMethod: {
      type: String,
      enum: ALUMNI_IMPORT_ROW_MATCH_METHODS,
      required: true,
    },
    matchedUserId: { type: Schema.Types.ObjectId, ref: "User" },
    candidateUserIds: {
      type: [Schema.Types.ObjectId],
      ref: "User",
      required: true,
      default: [],
      validate: {
        validator: (values: unknown) =>
          Array.isArray(values) &&
          values.length <= 10 &&
          new Set(values.map(String)).size === values.length,
        message: "candidateUserIds must contain at most 10 unique users.",
      },
    },
    eligibilityStatus: {
      type: String,
      enum: ALUMNI_IMPORT_ROW_ELIGIBILITY_STATUSES,
      required: true,
    },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
    reviewReasonCode: {
      type: String,
      trim: true,
      maxlength: 80,
      match: SAFE_CODE_PATTERN,
    },
    applicationStatus: {
      type: String,
      enum: ALUMNI_IMPORT_ROW_APPLICATION_STATUSES,
      required: true,
      default: "pending",
    },
    applicationUpdatedAt: { type: Date, default: null },
  },
  { _id: false, strict: "throw", minimize: false },
);

const alumniImportBatchSchema = new Schema<IAlumniImportBatch>(
  {
    schemaVersion: {
      type: Number,
      required: true,
      default: 1,
      enum: [1],
    },
    checksum: {
      type: String,
      required: true,
      immutable: true,
      lowercase: true,
      match: SHA256_HEX_PATTERN,
    },
    status: {
      type: String,
      enum: ALUMNI_IMPORT_BATCH_STATUSES,
      required: true,
      default: "pending",
    },
    counts: {
      type: importCountsSchema,
      required: true,
      default: () => ({}),
    },
    rawHeaders: {
      type: [String],
      default: undefined,
      select: false,
      validate: {
        validator: (values: unknown) =>
          values === undefined ||
          (Array.isArray(values) &&
            values.length <= MAX_COLUMNS &&
            values.every(
              (value) =>
                typeof value === "string" &&
                value.length >= 1 &&
                value.length <= MAX_HEADER_LENGTH &&
                SAFE_SINGLE_LINE_PATTERN.test(value),
            )),
        message: "Import headers must be bounded, single-line strings.",
      },
    },
    rawRows: {
      type: [rawRowSchema],
      default: undefined,
      select: false,
      validate: {
        validator: (values: unknown) =>
          values === undefined ||
          (Array.isArray(values) && values.length <= MAX_RAW_ROWS),
        message: "Import batch cannot contain more than 5000 raw rows.",
      },
    },
    rowErrors: {
      type: [rowErrorSchema],
      default: undefined,
      select: false,
      validate: {
        validator: (values: unknown) =>
          values === undefined ||
          (Array.isArray(values) && values.length <= MAX_ROW_ERRORS),
        message: "Import batch cannot contain more than 10000 row errors.",
      },
    },
    rowResults: {
      type: [rowResultSchema],
      default: undefined,
      select: false,
      validate: {
        validator: (values: unknown) =>
          values === undefined ||
          (Array.isArray(values) && values.length <= MAX_RAW_ROWS),
        message: "Import batch cannot contain more than 5000 row results.",
      },
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    rerunOfBatchId: {
      type: Schema.Types.ObjectId,
      ref: "AlumniImportBatch",
      immutable: true,
    },
    terminalAt: { type: Date, default: null },
    rawDataPurgeAt: { type: Date, default: null },
    rawDataPurgedAt: { type: Date, default: null },
    purgeAt: { type: Date, default: null },
    revision: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: {
        validator: isNonNegativeSafeInteger,
        message: "AlumniImportBatch revision must be a non-negative safe integer.",
      },
    },
  },
  {
    collection: ALUMNI_IMPORT_BATCH_COLLECTION,
    timestamps: true,
    strict: "throw",
    minimize: false,
    versionKey: false,
  },
);

alumniImportBatchSchema.pre(
  "validate",
  function enforceImportBatchInvariants(next) {
    if (!this.isNew && this.isModified("schemaVersion")) {
      this.invalidate(
        "schemaVersion",
        "Import batch schemaVersion cannot change after creation.",
      );
    }
    if (
      !this.isNew &&
      this.isModified("rawDataPurgedAt") &&
      ["rawHeaders", "rawRows", "rowErrors", "rowResults"].some(
        (path) => !this.isSelected(path),
      )
    ) {
      this.invalidate(
        "rawDataPurgedAt",
        "Raw-data purge changes must explicitly load every private row field.",
      );
    }

    const classifiedRows = this.counts.validRows + this.counts.invalidRows;
    const matchedRows =
      this.counts.matchedRows +
      this.counts.unmatchedRows +
      this.counts.ambiguousRows;
    if (classifiedRows > this.counts.totalRows) {
      this.invalidate(
        "counts",
        "Valid and invalid row counts cannot exceed totalRows.",
      );
    }
    if (matchedRows > this.counts.validRows) {
      this.invalidate(
        "counts",
        "Match disposition counts cannot exceed validRows.",
      );
    }
    if (this.counts.appliedRows > this.counts.validRows) {
      this.invalidate("counts.appliedRows", "appliedRows cannot exceed validRows.");
    }
    if (
      this.counts.approvedRows + this.counts.rejectedRows >
      this.counts.validRows
    ) {
      this.invalidate(
        "counts",
        "Eligibility decision counts cannot exceed validRows.",
      );
    }
    if (this.counts.appliedRows > this.counts.approvedRows) {
      this.invalidate(
        "counts.appliedRows",
        "appliedRows cannot exceed approvedRows.",
      );
    }

    if (this.rawRows) {
      const rawRowNumbers = new Set(this.rawRows.map((row) => row.rowNumber));
      if (rawRowNumbers.size !== this.rawRows.length) {
        this.invalidate("rawRows", "Import raw row numbers must be unique.");
      }
      if (this.rawRows.length !== this.counts.totalRows) {
        this.invalidate(
          "counts.totalRows",
          "totalRows must match the retained raw row count.",
        );
      }
      if (
        this.rawHeaders &&
        this.rawRows.some((row) => row.values.length !== this.rawHeaders!.length)
      ) {
        this.invalidate(
          "rawRows",
          "Every raw row must match the retained header width.",
        );
      }
    }

    const resultRowNumbers = new Set<number>();
    const resultRowKeys = new Set<string>();
    for (const result of this.rowResults ?? []) {
      if (
        resultRowNumbers.has(result.rowNumber) ||
        resultRowKeys.has(result.rowKey)
      ) {
        this.invalidate(
          "rowResults",
          "Import row results must have unique row numbers and row keys.",
        );
      }
      resultRowNumbers.add(result.rowNumber);
      resultRowKeys.add(result.rowKey);

      if (
        result.matchStatus === "matched" &&
        (!result.matchedUserId || result.candidateUserIds.length > 0)
      ) {
        this.invalidate(
          "rowResults",
          "Matched rows require exactly one matched user.",
        );
      }
      if (
        result.matchStatus === "ambiguous" &&
        (result.matchedUserId || result.candidateUserIds.length === 0)
      ) {
        this.invalidate(
          "rowResults",
          "Ambiguous rows need candidate users and no matched user.",
        );
      }
      if (
        ["unmatched", "invalid"].includes(result.matchStatus) &&
        (result.matchedUserId || result.candidateUserIds.length > 0)
      ) {
        this.invalidate(
          "rowResults",
          "Unmatched and invalid rows cannot reference matching users.",
        );
      }
      if (
        result.matchStatus === "matched" &&
        !["exact_email", "manual"].includes(result.matchMethod)
      ) {
        this.invalidate(
          "rowResults",
          "Matched rows require exact-email or manual match provenance.",
        );
      }
      if (
        result.matchStatus === "unmatched" &&
        !["none", "manual"].includes(result.matchMethod)
      ) {
        this.invalidate(
          "rowResults",
          "Unmatched rows require none or manual match provenance.",
        );
      }
      if (
        ["ambiguous", "invalid"].includes(result.matchStatus) &&
        result.matchMethod !== "none"
      ) {
        this.invalidate(
          "rowResults",
          "Ambiguous and invalid rows cannot contain match provenance.",
        );
      }

      const hasAnyReviewMetadata = Boolean(
        result.reviewedAt || result.reviewedBy || result.reviewReasonCode,
      );
      const reviewComplete = ["approved", "rejected"].includes(
        result.eligibilityStatus,
      );
      if (reviewComplete && (!result.reviewedAt || !result.reviewedBy)) {
        this.invalidate(
          "rowResults",
          "Eligibility decisions require reviewer provenance.",
        );
      }
      if (!reviewComplete && hasAnyReviewMetadata) {
        this.invalidate(
          "rowResults",
          "Rows without an eligibility decision cannot contain review metadata.",
        );
      }
      if (
        result.matchStatus === "invalid" &&
        result.eligibilityStatus !== "not_applicable"
      ) {
        this.invalidate(
          "rowResults",
          "Invalid rows must use not_applicable eligibility.",
        );
      }
      if (
        result.matchStatus !== "invalid" &&
        result.eligibilityStatus === "not_applicable"
      ) {
        this.invalidate(
          "rowResults",
          "Valid rows require an eligibility review state.",
        );
      }

      if (
        result.applicationStatus === "pending" &&
        result.applicationUpdatedAt
      ) {
        this.invalidate(
          "rowResults",
          "Pending row applications cannot have applicationUpdatedAt.",
        );
      }
      if (
        result.applicationStatus !== "pending" &&
        !result.applicationUpdatedAt
      ) {
        this.invalidate(
          "rowResults",
          "Finished row applications require applicationUpdatedAt.",
        );
      }
      if (
        ["applied", "failed"].includes(result.applicationStatus) &&
        result.eligibilityStatus !== "approved"
      ) {
        this.invalidate(
          "rowResults",
          "Only approved rows may be applied or record an application failure.",
        );
      }
      if (
        ["applied", "failed"].includes(result.applicationStatus) &&
        !["matched", "unmatched"].includes(result.matchStatus)
      ) {
        this.invalidate(
          "rowResults",
          "Only resolved matched or unmatched rows may be applied or fail application.",
        );
      }
      if (
        result.matchStatus === "ambiguous" &&
        result.eligibilityStatus === "approved"
      ) {
        this.invalidate(
          "rowResults",
          "Ambiguous rows must be resolved before approval.",
        );
      }
    }

    if (this.rowResults) {
      if (this.rowResults.length > this.counts.totalRows) {
        this.invalidate(
          "rowResults",
          "Durable row results cannot exceed totalRows.",
        );
      }
      const observed = {
        validRows: this.rowResults.filter(
          (result) => result.matchStatus !== "invalid",
        ).length,
        invalidRows: this.rowResults.filter(
          (result) => result.matchStatus === "invalid",
        ).length,
        matchedRows: this.rowResults.filter(
          (result) => result.matchStatus === "matched",
        ).length,
        unmatchedRows: this.rowResults.filter(
          (result) => result.matchStatus === "unmatched",
        ).length,
        ambiguousRows: this.rowResults.filter(
          (result) => result.matchStatus === "ambiguous",
        ).length,
        approvedRows: this.rowResults.filter(
          (result) => result.eligibilityStatus === "approved",
        ).length,
        rejectedRows: this.rowResults.filter(
          (result) => result.eligibilityStatus === "rejected",
        ).length,
        appliedRows: this.rowResults.filter(
          (result) => result.applicationStatus === "applied",
        ).length,
      };
      for (const [field, value] of Object.entries(observed)) {
        if (this.counts[field as keyof typeof observed] !== value) {
          this.invalidate(
            `counts.${field}`,
            `${field} must match the durable row results.`,
          );
        }
      }
    }

    if (this.rawRows && this.rowResults) {
      const rawRowNumbers = new Set(this.rawRows.map((row) => row.rowNumber));
      if (
        this.rowResults.some((result) => !rawRowNumbers.has(result.rowNumber))
      ) {
        this.invalidate(
          "rowResults",
          "Every row result must reference a retained raw row.",
        );
      }
    }

    const rawDataBytes = Buffer.byteLength(
      JSON.stringify({
        headers: this.rawHeaders,
        rows: this.rawRows,
        errors: this.rowErrors,
        results: this.rowResults,
      }),
      "utf8",
    );
    if (rawDataBytes > MAX_RAW_DATA_BYTES) {
      this.invalidate(
        "rawRows",
        "Import raw data cannot exceed 8 MiB per batch.",
      );
    }

    const isTerminal = isTerminalAlumniImportBatchStatus(this.status);
    const hasAnyTerminalTime = Boolean(
      this.terminalAt || this.rawDataPurgeAt || this.purgeAt,
    );
    const hasCompleteTerminalTimes = Boolean(
      this.terminalAt && this.rawDataPurgeAt && this.purgeAt,
    );
    if (isTerminal && !hasCompleteTerminalTimes) {
      this.invalidate(
        "terminalAt",
        "Terminal import batches require all retention timestamps.",
      );
    }
    if (!isTerminal && (hasAnyTerminalTime || this.rawDataPurgedAt)) {
      this.invalidate(
        "terminalAt",
        "Non-terminal import batches cannot contain retention timestamps.",
      );
    }
    if (this.status === "completed") {
      if (classifiedRows !== this.counts.totalRows) {
        this.invalidate(
          "counts",
          "Completed batches must classify every row as valid or invalid.",
        );
      }
      if (matchedRows !== this.counts.validRows) {
        this.invalidate(
          "counts",
          "Completed batches must resolve every valid row match.",
        );
      }
      if (
        this.counts.approvedRows + this.counts.rejectedRows !==
        this.counts.validRows
      ) {
        this.invalidate(
          "counts",
          "Completed batches must decide eligibility for every valid row.",
        );
      }
      if (
        !this.rawDataPurgedAt &&
        (!this.rawRows ||
          this.rawRows.length !== this.counts.totalRows ||
          !this.rowResults ||
          this.rowResults.length !== this.counts.totalRows)
      ) {
        this.invalidate(
          "rowResults",
          "Completed batches must retain one raw row and result per row until raw-data cleanup.",
        );
      }
      for (const result of this.rowResults ?? []) {
        const isApprovedFinal =
          result.eligibilityStatus === "approved" &&
          ["applied", "skipped"].includes(result.applicationStatus) &&
          ["matched", "unmatched"].includes(result.matchStatus);
        const isRejectedSkipped =
          result.eligibilityStatus === "rejected" &&
          result.applicationStatus === "skipped";
        const isInvalidSkipped =
          result.matchStatus === "invalid" &&
          result.eligibilityStatus === "not_applicable" &&
          result.applicationStatus === "skipped";
        if (!isApprovedFinal && !isRejectedSkipped && !isInvalidSkipped) {
          this.invalidate(
            "rowResults",
            "Completed batches require a terminal disposition for every row.",
          );
        }
      }
    }
    if (
      this.terminalAt &&
      this.rawDataPurgeAt &&
      !datesEqual(
        this.rawDataPurgeAt,
        addFixedDays(this.terminalAt, IMPORT_RAW_DATA_RETENTION_DAYS),
      )
    ) {
      this.invalidate(
        "rawDataPurgeAt",
        "rawDataPurgeAt must be 30 days after batch termination.",
      );
    }
    if (
      this.terminalAt &&
      this.purgeAt &&
      !datesEqual(
        this.purgeAt,
        addUtcCalendarMonths(
          this.terminalAt,
          IMPORT_SUMMARY_RETENTION_MONTHS,
        ),
      )
    ) {
      this.invalidate(
        "purgeAt",
        "Import batch purgeAt must be six UTC calendar months after termination.",
      );
    }
    if (this.rawDataPurgedAt) {
      if (!isTerminal || !this.terminalAt) {
        this.invalidate(
          "rawDataPurgedAt",
          "Only terminal import batches may purge raw data.",
        );
      }
      if (
        this.rawHeaders !== undefined ||
        this.rawRows !== undefined ||
        this.rowErrors !== undefined ||
        this.rowResults !== undefined
      ) {
        this.invalidate(
          "rawDataPurgedAt",
          "Purged import batches must unset raw rows, errors, and row results.",
        );
      }
      if (this.rawDataPurgeAt && this.rawDataPurgedAt < this.rawDataPurgeAt) {
        this.invalidate(
          "rawDataPurgedAt",
          "Import raw data cannot be purged before rawDataPurgeAt.",
        );
      }
    }

    next();
  },
);

alumniImportBatchSchema.index(
  { status: 1, createdAt: -1, _id: -1 },
  { name: "idx_alumni_import_batch_status_created" },
);
alumniImportBatchSchema.index(
  { checksum: 1, createdAt: -1 },
  { name: "idx_alumni_import_batch_checksum" },
);
alumniImportBatchSchema.index(
  { rawDataPurgedAt: 1, rawDataPurgeAt: 1 },
  { name: "idx_alumni_import_batch_raw_cleanup" },
);
alumniImportBatchSchema.index(
  { purgeAt: 1 },
  { expireAfterSeconds: 0, name: "ttl_alumni_import_batch_purge_at" },
);

function removePrivateImportBatchFields(
  _document: unknown,
  value: IAlumniImportBatch & { _id?: unknown; __v?: number },
) {
  const mutable = value as unknown as Record<string, unknown>;
  if (mutable._id) mutable.id = mutable._id;
  delete mutable._id;
  delete mutable.rawHeaders;
  delete mutable.rawRows;
  delete mutable.rowErrors;
  delete mutable.rowResults;
  delete mutable.rawDataPurgeAt;
  delete mutable.rawDataPurgedAt;
  delete mutable.purgeAt;
  delete mutable.revision;
  delete mutable.__v;
  return mutable;
}

alumniImportBatchSchema.set("toJSON", {
  transform: removePrivateImportBatchFields,
});
alumniImportBatchSchema.set("toObject", {
  transform: removePrivateImportBatchFields,
});

const AlumniImportBatch: Model<IAlumniImportBatch> =
  (mongoose.models.AlumniImportBatch as
    | Model<IAlumniImportBatch>
    | undefined) ||
  mongoose.model<IAlumniImportBatch>(
    "AlumniImportBatch",
    alumniImportBatchSchema,
  );

export default AlumniImportBatch;
