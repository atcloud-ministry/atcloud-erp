import mongoose, { type Document, type Model, Schema } from "mongoose";

export const REFRESH_SESSION_COLLECTION = "refreshsessions" as const;

export const REFRESH_SESSION_REVOCATION_REASONS = [
  "logout",
  "password_changed",
  "password_reset",
  "token_reuse",
  "account_deactivated",
  "account_deleted",
] as const;

export type RefreshSessionRevocationReason =
  (typeof REFRESH_SESSION_REVOCATION_REASONS)[number];

export interface IRefreshSession extends Document {
  familyId: string;
  userId: mongoose.Types.ObjectId;
  currentJtiHash: string;
  refreshLifetimeMs: number;
  revision: number;
  expiresAt: Date;
  revokedAt?: Date | null;
  revocationReason?: RefreshSessionRevocationReason | null;
  createdAt: Date;
  updatedAt: Date;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const refreshSessionSchema = new Schema<IRefreshSession>(
  {
    familyId: {
      type: String,
      required: true,
      immutable: true,
      match: UUID_PATTERN,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    currentJtiHash: {
      type: String,
      required: true,
      select: false,
      match: SHA256_PATTERN,
    },
    refreshLifetimeMs: {
      type: Number,
      required: true,
      min: 1_000,
      validate: Number.isSafeInteger,
    },
    revision: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: Number.isSafeInteger,
    },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revocationReason: {
      type: String,
      enum: REFRESH_SESSION_REVOCATION_REASONS,
      default: null,
    },
  },
  {
    collection: REFRESH_SESSION_COLLECTION,
    timestamps: true,
    strict: "throw",
  },
);

refreshSessionSchema.index(
  { familyId: 1 },
  { unique: true, name: "uniq_refresh_session_family" },
);
refreshSessionSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: "ttl_refresh_session_expiry" },
);
refreshSessionSchema.index(
  { userId: 1, revokedAt: 1, expiresAt: 1 },
  { name: "refresh_session_user_active" },
);

refreshSessionSchema.set("toJSON", {
  transform: (_doc, raw) => {
    const value = raw as unknown as Record<string, unknown>;
    delete value.currentJtiHash;
    delete value.__v;
    return value;
  },
});

const RefreshSession: Model<IRefreshSession> =
  (mongoose.models.RefreshSession as Model<IRefreshSession>) ||
  mongoose.model<IRefreshSession>("RefreshSession", refreshSessionSchema);

export default RefreshSession;
