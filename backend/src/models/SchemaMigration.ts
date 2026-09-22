import mongoose, { type Document, type Model, Schema } from "mongoose";
import { MIGRATION_LEDGER_COLLECTION_NAME } from "../migrations/constants";
import {
  MIGRATION_CHECKSUM_PATTERN,
  MIGRATION_FAILURE_CODES,
  MIGRATION_ID_PATTERN,
  SCHEMA_MIGRATION_DIRECTIONS,
  MIGRATION_ROLLBACK_REASON_CODES,
  SCHEMA_MIGRATION_STATUSES,
  cloneAndValidateMigrationCheckpoint,
  isMigrationCheckpoint,
  type MigrationCounts,
  type MigrationDirection,
  type MigrationFailureCode,
  type MigrationRollbackReasonCode,
  type SchemaMigrationStatus,
} from "../migrations/types";

export interface ISanitizedMigrationError {
  code: MigrationFailureCode;
  digest: string;
  recordedAt: Date;
}

export interface ISchemaMigration extends Document<string> {
  _id: string;
  migrationId: string;
  description: string;
  checksum: string;
  status: SchemaMigrationStatus;
  direction: MigrationDirection;
  // Runtime validation narrows this Mixed field to MigrationCheckpoint.
  applyCheckpoint?: unknown;
  rollbackCheckpoint?: unknown;
  counts: MigrationCounts;
  attempt: number;
  runId: string;
  operator: string;
  appVersion: string;
  runStartedAt: Date;
  runFinishedAt?: Date | null;
  lastHeartbeatAt: Date;
  appliedAt?: Date | null;
  rolledBackAt?: Date | null;
  rollbackReasonCode?: MigrationRollbackReasonCode | null;
  lastError?: ISanitizedMigrationError | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_SINGLE_LINE_PATTERN = /^[^\u0000-\u001f\u007f-\u009f]+$/u;

function cloneCheckpointForStorage(value: unknown): unknown {
  const result = cloneAndValidateMigrationCheckpoint(value);
  return "violation" in result ? value : result.checkpoint;
}

const migrationCountsSchema = new Schema<MigrationCounts>(
  {
    examined: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: Number.isSafeInteger,
    },
    matched: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: Number.isSafeInteger,
    },
    modified: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: Number.isSafeInteger,
    },
    skipped: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: Number.isSafeInteger,
    },
    errors: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: Number.isSafeInteger,
    },
  },
  { _id: false, strict: "throw", suppressReservedKeysWarning: true },
);

const sanitizedMigrationErrorSchema = new Schema<ISanitizedMigrationError>(
  {
    code: {
      type: String,
      required: true,
      trim: true,
      enum: MIGRATION_FAILURE_CODES,
    },
    digest: {
      type: String,
      required: true,
      lowercase: true,
      match: MIGRATION_CHECKSUM_PATTERN,
    },
    recordedAt: { type: Date, required: true },
  },
  { _id: false, strict: "throw" },
);

const schemaMigrationSchema = new Schema<ISchemaMigration>(
  {
    _id: {
      type: String,
      required: true,
      immutable: true,
      match: MIGRATION_ID_PATTERN,
    },
    migrationId: {
      type: String,
      required: true,
      immutable: true,
      match: MIGRATION_ID_PATTERN,
    },
    description: {
      type: String,
      required: true,
      immutable: true,
      trim: true,
      minlength: 1,
      maxlength: 240,
      match: SAFE_SINGLE_LINE_PATTERN,
    },
    checksum: {
      type: String,
      required: true,
      immutable: true,
      lowercase: true,
      match: MIGRATION_CHECKSUM_PATTERN,
    },
    status: {
      type: String,
      enum: SCHEMA_MIGRATION_STATUSES,
      required: true,
    },
    direction: {
      type: String,
      enum: SCHEMA_MIGRATION_DIRECTIONS,
      required: true,
    },
    applyCheckpoint: {
      type: Schema.Types.Mixed,
      default: null,
      set: cloneCheckpointForStorage,
      validate: {
        validator: isMigrationCheckpoint,
        message:
          "Migration apply checkpoint must be bounded JSON resumability metadata.",
      },
    },
    rollbackCheckpoint: {
      type: Schema.Types.Mixed,
      default: null,
      set: cloneCheckpointForStorage,
      validate: {
        validator: isMigrationCheckpoint,
        message:
          "Migration rollback checkpoint must be bounded JSON resumability metadata.",
      },
    },
    counts: {
      type: migrationCountsSchema,
      required: true,
      default: () => ({}),
    },
    attempt: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isSafeInteger,
    },
    runId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 64,
      match: UUID_PATTERN,
    },
    operator: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 128,
      match: SAFE_SINGLE_LINE_PATTERN,
    },
    appVersion: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 80,
      match: /^[A-Za-z0-9][A-Za-z0-9._+-]*$/,
    },
    runStartedAt: { type: Date, required: true },
    runFinishedAt: { type: Date, default: null },
    lastHeartbeatAt: { type: Date, required: true },
    appliedAt: { type: Date, default: null },
    rolledBackAt: { type: Date, default: null },
    rollbackReasonCode: {
      type: String,
      default: null,
      enum: [...MIGRATION_ROLLBACK_REASON_CODES, null],
    },
    lastError: {
      type: sanitizedMigrationErrorSchema,
      default: null,
    },
    revision: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: Number.isSafeInteger,
    },
  },
  {
    collection: MIGRATION_LEDGER_COLLECTION_NAME,
    timestamps: true,
    strict: "throw",
    minimize: false,
    versionKey: false,
  },
);

schemaMigrationSchema.pre("validate", function enforceMigrationInvariants(next) {
  if (String(this._id) !== this.migrationId) {
    this.invalidate("migrationId", "migrationId must equal the document _id.");
  }

  if (this.counts.matched > this.counts.examined) {
    this.invalidate("counts.matched", "matched cannot exceed examined.");
  }
  if (this.counts.modified > this.counts.matched) {
    this.invalidate("counts.modified", "modified cannot exceed matched.");
  }
  if (this.counts.skipped > this.counts.examined) {
    this.invalidate("counts.skipped", "skipped cannot exceed examined.");
  }
  if (this.counts.errors !== 0) {
    this.invalidate(
      "counts.errors",
      "Committed migration batches cannot retain row errors.",
    );
  }

  const isUpStatus = ["applying", "applied", "apply_failed"].includes(
    this.status,
  );
  if (this.direction !== (isUpStatus ? "up" : "down")) {
    this.invalidate("direction", `Status ${this.status} has an invalid direction.`);
  }
  if (this.direction === "down" && !this.rollbackReasonCode) {
    this.invalidate(
      "rollbackReasonCode",
      "A rollback migration requires a reason code.",
    );
  }
  if (this.direction === "up" && this.rollbackReasonCode) {
    this.invalidate(
      "rollbackReasonCode",
      "An apply migration cannot retain a rollback reason code.",
    );
  }
  if (this.direction === "up" && this.rollbackCheckpoint != null) {
    this.invalidate(
      "rollbackCheckpoint",
      "An apply migration cannot retain rollback progress.",
    );
  }

  const isActive = ["applying", "rolling_back"].includes(this.status);
  const isFailure = ["apply_failed", "rollback_failed"].includes(this.status);
  if (isActive && this.runFinishedAt) {
    this.invalidate(
      "runFinishedAt",
      "An active migration cannot have runFinishedAt.",
    );
  }
  if (!isActive && !this.runFinishedAt) {
    this.invalidate(
      "runFinishedAt",
      "A terminal migration requires runFinishedAt.",
    );
  }
  if (isFailure && !this.lastError) {
    this.invalidate("lastError", "A failed migration requires lastError.");
  }
  if (!isFailure && this.lastError) {
    this.invalidate("lastError", "Only a failed migration may retain lastError.");
  }
  if (this.status === "applied" && !this.appliedAt) {
    this.invalidate("appliedAt", "An applied migration requires appliedAt.");
  }
  if (this.status === "rolled_back" && !this.rolledBackAt) {
    this.invalidate(
      "rolledBackAt",
      "A rolled-back migration requires rolledBackAt.",
    );
  }
  if (this.status !== "rolled_back" && this.rolledBackAt) {
    this.invalidate(
      "rolledBackAt",
      "Only a rolled-back migration may retain rolledBackAt.",
    );
  }
  if (this.lastHeartbeatAt < this.runStartedAt) {
    this.invalidate(
      "lastHeartbeatAt",
      "lastHeartbeatAt cannot precede runStartedAt.",
    );
  }
  if (this.runFinishedAt && this.runFinishedAt < this.runStartedAt) {
    this.invalidate(
      "runFinishedAt",
      "runFinishedAt cannot precede runStartedAt.",
    );
  }
  if (this.runFinishedAt && this.lastHeartbeatAt > this.runFinishedAt) {
    this.invalidate(
      "runFinishedAt",
      "runFinishedAt cannot precede lastHeartbeatAt.",
    );
  }
  if (this.direction === "up") {
    if (this.status !== "applied" && this.appliedAt) {
      this.invalidate(
        "appliedAt",
        "Only an applied forward migration may retain appliedAt.",
      );
    }
    if (
      this.status === "applied" &&
      this.appliedAt &&
      (this.appliedAt < this.runStartedAt ||
        (this.runFinishedAt && this.appliedAt > this.runFinishedAt))
    ) {
      this.invalidate(
        "appliedAt",
        "appliedAt must fall within the completed apply run.",
      );
    }
  } else if (this.appliedAt && this.appliedAt > this.runStartedAt) {
    this.invalidate(
      "appliedAt",
      "A rollback cannot precede the retained appliedAt timestamp.",
    );
  }
  if (
    this.rolledBackAt &&
    (this.rolledBackAt < this.runStartedAt ||
      (this.runFinishedAt && this.rolledBackAt > this.runFinishedAt))
  ) {
    this.invalidate(
      "rolledBackAt",
      "rolledBackAt must fall within the completed rollback run.",
    );
  }
  if (
    this.lastError?.recordedAt &&
    (this.lastError.recordedAt < this.runStartedAt ||
      (this.runFinishedAt && this.lastError.recordedAt > this.runFinishedAt))
  ) {
    this.invalidate(
      "lastError.recordedAt",
      "lastError.recordedAt must fall within the failed run.",
    );
  }

  next();
});

schemaMigrationSchema.index(
  { migrationId: 1 },
  { unique: true, name: "uniq_schema_migration_id" },
);
schemaMigrationSchema.index({ status: 1, migrationId: 1 });
schemaMigrationSchema.index({ runId: 1, migrationId: 1 });
schemaMigrationSchema.index({ status: 1, lastHeartbeatAt: 1 });

const SchemaMigration: Model<ISchemaMigration> =
  (mongoose.models.SchemaMigration as Model<ISchemaMigration>) ||
  mongoose.model<ISchemaMigration>("SchemaMigration", schemaMigrationSchema);

export default SchemaMigration;
