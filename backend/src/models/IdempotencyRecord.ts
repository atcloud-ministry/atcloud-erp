import mongoose, { type Document, type Model, Schema } from "mongoose";
import { findIdempotencyReplayResponseViolation } from "../services/reliability/IdempotencyResponseContract";

export type IdempotencyRecordState = "in_progress" | "completed";

export interface IdempotencyResourceReference {
  type: string;
  id: string;
}

export interface IIdempotencyRecord extends Document {
  hashVersion: number;
  scope: string;
  actorKeyHash: string;
  keyHash: string;
  requestHash: string;
  state: IdempotencyRecordState;
  httpStatus?: number;
  response?: unknown;
  resource?: IdempotencyResourceReference;
  completedAt?: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const sha256Pattern = /^[a-f0-9]{64}$/;

const resourceReferenceSchema = new Schema<IdempotencyResourceReference>(
  {
    type: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
      match: /^[A-Za-z][A-Za-z0-9_-]*$/,
    },
    id: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
      match: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    },
  },
  { _id: false },
);

const idempotencyRecordSchema = new Schema<IIdempotencyRecord>(
  {
    hashVersion: {
      type: Number,
      required: true,
      default: 1,
      immutable: true,
      enum: [1],
    },
    scope: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
      match: /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/,
    },
    actorKeyHash: {
      type: String,
      required: true,
      lowercase: true,
      immutable: true,
      match: sha256Pattern,
    },
    keyHash: {
      type: String,
      required: true,
      lowercase: true,
      immutable: true,
      match: sha256Pattern,
    },
    requestHash: {
      type: String,
      required: true,
      lowercase: true,
      immutable: true,
      match: sha256Pattern,
    },
    state: {
      type: String,
      enum: ["in_progress", "completed"],
      required: true,
      default: "in_progress",
    },
    httpStatus: {
      type: Number,
      min: 100,
      max: 599,
      validate: {
        validator: Number.isInteger,
        message: "httpStatus must be an integer.",
      },
    },
    response: {
      type: Schema.Types.Mixed,
      default: undefined,
      validate: {
        validator: (value: unknown) =>
          value === undefined ||
          findIdempotencyReplayResponseViolation(value) === undefined,
        message:
          "Idempotency response must be a minimal JSON DTO without secrets or human-authored content.",
      },
    },
    resource: {
      type: resourceReferenceSchema,
      default: undefined,
    },
    completedAt: Date,
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
    strict: "throw",
  },
);

idempotencyRecordSchema.pre("validate", function validateCompletedRecord(next) {
  if (this.state !== "completed") return next();
  if (!this.completedAt) {
    return next(new Error("Completed idempotency record requires completedAt."));
  }
  if (!this.httpStatus) {
    return next(new Error("Completed idempotency record requires httpStatus."));
  }
  if (this.response === undefined && !this.resource) {
    return next(
      new Error(
        "Completed idempotency record requires a response or resource reference.",
      ),
    );
  }
  return next();
});

idempotencyRecordSchema.index(
  { hashVersion: 1, scope: 1, actorKeyHash: 1, keyHash: 1 },
  { unique: true, name: "uniq_idempotency_scope_actor_key" },
);
idempotencyRecordSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: "ttl_idempotency_records" },
);
idempotencyRecordSchema.index({ state: 1, expiresAt: 1 });

const IdempotencyRecord: Model<IIdempotencyRecord> =
  (mongoose.models.IdempotencyRecord as Model<IIdempotencyRecord>) ||
  mongoose.model<IIdempotencyRecord>(
    "IdempotencyRecord",
    idempotencyRecordSchema,
  );

export default IdempotencyRecord;
