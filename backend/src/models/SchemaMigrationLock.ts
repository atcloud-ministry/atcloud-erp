import mongoose, { type Document, type Model, Schema } from "mongoose";
import {
  MIGRATION_GLOBAL_LOCK_ID,
  MIGRATION_LEASE_COLLECTION_NAME,
} from "../migrations/constants";
import { MIGRATION_ID_PATTERN } from "../migrations/types";

export const SCHEMA_MIGRATION_GLOBAL_LOCK_ID =
  MIGRATION_GLOBAL_LOCK_ID;

export interface ISchemaMigrationLock extends Document<string> {
  _id: typeof SCHEMA_MIGRATION_GLOBAL_LOCK_ID;
  runId?: string | null;
  token?: string | null;
  owner?: string | null;
  currentMigrationId?: string | null;
  acquiredAt: Date;
  heartbeatAt: Date;
  expiresAt: Date;
  releasedAt?: Date | null;
  fence: number;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_SINGLE_LINE_PATTERN = /^[^\u0000-\u001f\u007f-\u009f]+$/u;

const schemaMigrationLockSchema = new Schema<ISchemaMigrationLock>(
  {
    _id: {
      type: String,
      required: true,
      immutable: true,
      enum: [SCHEMA_MIGRATION_GLOBAL_LOCK_ID],
      default: SCHEMA_MIGRATION_GLOBAL_LOCK_ID,
    },
    runId: {
      type: String,
      trim: true,
      maxlength: 64,
      match: UUID_PATTERN,
    },
    token: {
      type: String,
      trim: true,
      maxlength: 64,
      match: UUID_PATTERN,
    },
    owner: {
      type: String,
      trim: true,
      minlength: 1,
      maxlength: 128,
      match: SAFE_SINGLE_LINE_PATTERN,
    },
    currentMigrationId: {
      type: String,
      default: null,
      validate: {
        validator: (value: unknown) =>
          value === null ||
          value === undefined ||
          (typeof value === "string" && MIGRATION_ID_PATTERN.test(value)),
        message: "currentMigrationId must be a valid migration id.",
      },
    },
    acquiredAt: { type: Date, required: true },
    heartbeatAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    releasedAt: { type: Date, default: null },
    fence: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isSafeInteger,
    },
    revision: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isSafeInteger,
    },
  },
  {
    collection: MIGRATION_LEASE_COLLECTION_NAME,
    timestamps: true,
    strict: "throw",
    versionKey: false,
  },
);

schemaMigrationLockSchema.pre(
  "validate",
  function enforceMigrationLockInvariants(next) {
    if (String(this._id) !== SCHEMA_MIGRATION_GLOBAL_LOCK_ID) {
      this.invalidate("_id", "Schema migration lock _id must be global.");
    }
    if (this.heartbeatAt < this.acquiredAt) {
      this.invalidate(
        "heartbeatAt",
        "heartbeatAt cannot precede acquiredAt.",
      );
    }
    if (this.expiresAt < this.acquiredAt) {
      this.invalidate("expiresAt", "expiresAt cannot precede acquiredAt.");
    }

    const identityFields = [this.owner, this.runId, this.token];
    const hasCompleteIdentity = identityFields.every(
      (value) => typeof value === "string" && value.length > 0,
    );
    const hasAnyIdentity = identityFields.some(
      (value) => typeof value === "string" && value.length > 0,
    );
    if (this.releasedAt) {
      if (hasAnyIdentity || this.currentMigrationId) {
        this.invalidate(
          "releasedAt",
          "A released migration lock cannot retain lease identity fields.",
        );
      }
      if (this.releasedAt < this.acquiredAt) {
        this.invalidate(
          "releasedAt",
          "releasedAt cannot precede acquiredAt.",
        );
      }
      if (this.releasedAt < this.heartbeatAt) {
        this.invalidate(
          "releasedAt",
          "releasedAt cannot precede heartbeatAt.",
        );
      }
      if (this.expiresAt > this.releasedAt) {
        this.invalidate(
          "expiresAt",
          "A released migration lock cannot remain unexpired.",
        );
      }
    } else {
      if (!hasCompleteIdentity) {
        this.invalidate(
          "runId",
          "An active migration lock requires owner, runId, and token.",
        );
      }
      if (this.expiresAt <= this.heartbeatAt) {
        this.invalidate("expiresAt", "expiresAt must follow heartbeatAt.");
      }
    }
    next();
  },
);

schemaMigrationLockSchema.index({ expiresAt: 1 });

const SchemaMigrationLock: Model<ISchemaMigrationLock> =
  (mongoose.models.SchemaMigrationLock as Model<ISchemaMigrationLock>) ||
  mongoose.model<ISchemaMigrationLock>(
    "SchemaMigrationLock",
    schemaMigrationLockSchema,
  );

export default SchemaMigrationLock;
