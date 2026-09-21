import mongoose, { Document, Schema } from "mongoose";
import { normalizeOutboxPayload } from "../services/reliability/OutboxPayload";

export const NOTIFICATION_OUTBOX_STATUSES = [
  "pending",
  "processing",
  "delivered",
  "dead",
] as const;

export type NotificationOutboxStatus =
  (typeof NOTIFICATION_OUTBOX_STATUSES)[number];

export const NOTIFICATION_OUTBOX_DELIVERED_RETENTION_DAYS = 30;
export const NOTIFICATION_OUTBOX_DEAD_RETENTION_DAYS = 90;
const FIXED_DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

export function notificationOutboxTerminalPurgeAt(
  status: "delivered" | "dead",
  terminalAt: Date,
): Date {
  const retentionDays =
    status === "delivered"
      ? NOTIFICATION_OUTBOX_DELIVERED_RETENTION_DAYS
      : NOTIFICATION_OUTBOX_DEAD_RETENTION_DAYS;
  return new Date(terminalAt.getTime() + retentionDays * FIXED_DAY_MILLISECONDS);
}

export interface INotificationOutbox extends Document {
  eventId: string;
  topic: string;
  dedupeKeyHash: string;
  payloadVersion: number;
  payload: Record<string, unknown>;
  payloadHash: string;
  status: NotificationOutboxStatus;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt?: Date | null;
  leaseToken?: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: Date | null;
  lastHeartbeatAt?: Date | null;
  unsupportedSince?: Date | null;
  lastAttemptAt?: Date | null;
  deliveredAt?: Date | null;
  deadAt?: Date | null;
  purgeAt?: Date | null;
  lastErrorCode?: string | null;
  lastErrorDigest?: string | null;
  lastErrorAt?: Date | null;
  correlationId?: string | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TOPIC_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const notificationOutboxSchema = new Schema<INotificationOutbox>(
  {
    eventId: {
      type: String,
      required: true,
      immutable: true,
      unique: true,
      index: true,
      maxlength: 64,
      match: UUID_PATTERN,
    },
    topic: {
      type: String,
      required: true,
      immutable: true,
      minlength: 1,
      maxlength: 120,
      match: TOPIC_PATTERN,
    },
    dedupeKeyHash: {
      type: String,
      required: true,
      immutable: true,
      match: SHA256_PATTERN,
    },
    payloadVersion: {
      type: Number,
      required: true,
      immutable: true,
      min: 1,
      max: 1_000,
      validate: Number.isInteger,
    },
    payload: {
      type: Schema.Types.Mixed,
      required: true,
      immutable: true,
      validate: {
        validator(value: unknown): boolean {
          try {
            normalizeOutboxPayload(value);
            return true;
          } catch {
            return false;
          }
        },
        message: "Outbox payload must be bounded JSON",
      },
    },
    payloadHash: {
      type: String,
      required: true,
      immutable: true,
      match: SHA256_PATTERN,
    },
    status: {
      type: String,
      enum: NOTIFICATION_OUTBOX_STATUSES,
      required: true,
      default: "pending",
    },
    attemptCount: { type: Number, required: true, default: 0, min: 0 },
    maxAttempts: {
      type: Number,
      required: true,
      immutable: true,
      default: 8,
      min: 1,
      max: 100,
      validate: Number.isInteger,
    },
    nextAttemptAt: { type: Date, default: Date.now },
    leaseToken: {
      type: String,
      default: null,
      maxlength: 64,
      match: UUID_PATTERN,
    },
    leaseOwner: { type: String, default: null, maxlength: 128 },
    leaseExpiresAt: { type: Date, default: null },
    lastHeartbeatAt: { type: Date, default: null },
    unsupportedSince: { type: Date, default: null },
    lastAttemptAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    deadAt: { type: Date, default: null },
    purgeAt: { type: Date, default: null },
    lastErrorCode: { type: String, default: null, maxlength: 80 },
    lastErrorDigest: {
      type: String,
      default: null,
      validate: {
        validator(value: unknown): boolean {
          return value == null || (typeof value === "string" && SHA256_PATTERN.test(value));
        },
        message: "lastErrorDigest must be a SHA-256 value",
      },
    },
    lastErrorAt: { type: Date, default: null },
    correlationId: { type: String, default: null, maxlength: 128 },
    revision: { type: Number, required: true, default: 0, min: 0 },
  },
  {
    timestamps: true,
    strict: "throw",
    minimize: false,
  },
);

notificationOutboxSchema.index(
  { topic: 1, dedupeKeyHash: 1 },
  { unique: true },
);
notificationOutboxSchema.index({
  status: 1,
  nextAttemptAt: 1,
  topic: 1,
  payloadVersion: 1,
  createdAt: 1,
  _id: 1,
});
notificationOutboxSchema.index({ status: 1, leaseExpiresAt: 1, _id: 1 });
notificationOutboxSchema.index({ status: 1, attemptCount: 1, _id: 1 });
notificationOutboxSchema.index({ status: 1, unsupportedSince: 1, _id: 1 });
notificationOutboxSchema.index(
  { purgeAt: 1 },
  {
    name: "purgeAt_1",
    expireAfterSeconds: 0,
  },
);

notificationOutboxSchema.pre("validate", function enforceStateInvariants(next) {
  const hasAnyLeaseField = Boolean(
    this.leaseToken || this.leaseOwner || this.leaseExpiresAt,
  );
  const hasCompleteLease = Boolean(
    this.leaseToken && this.leaseOwner && this.leaseExpiresAt,
  );
  if (this.status === "processing" && !hasCompleteLease) {
    this.invalidate("leaseToken", "Processing outbox events require a complete lease");
  }
  if (this.status !== "processing" && hasAnyLeaseField) {
    this.invalidate("leaseToken", "Only processing outbox events may hold a lease");
  }
  if (this.status === "pending" && !this.nextAttemptAt) {
    this.invalidate("nextAttemptAt", "Pending outbox events require nextAttemptAt");
  }
  if (this.status === "delivered" && !this.deliveredAt) {
    this.invalidate("deliveredAt", "Delivered outbox events require deliveredAt");
  }
  if (this.status === "dead" && !this.deadAt) {
    this.invalidate("deadAt", "Dead outbox events require deadAt");
  }
  if (this.status === "delivered" && this.deliveredAt) {
    const expected = notificationOutboxTerminalPurgeAt(
      "delivered",
      this.deliveredAt,
    );
    if (!this.purgeAt || this.purgeAt.getTime() !== expected.getTime()) {
      this.invalidate(
        "purgeAt",
        "Delivered outbox events require purgeAt exactly 30 fixed days after deliveredAt",
      );
    }
  }
  if (this.status === "dead" && this.deadAt) {
    const expected = notificationOutboxTerminalPurgeAt("dead", this.deadAt);
    if (!this.purgeAt || this.purgeAt.getTime() !== expected.getTime()) {
      this.invalidate(
        "purgeAt",
        "Dead outbox events require purgeAt exactly 90 fixed days after deadAt",
      );
    }
  }
  if (
    (this.status === "pending" || this.status === "processing") &&
    this.purgeAt != null
  ) {
    this.invalidate(
      "purgeAt",
      "Non-terminal outbox events cannot have purgeAt",
    );
  }
  next();
});

export default (mongoose.models.NotificationOutbox ||
  mongoose.model<INotificationOutbox>(
    "NotificationOutbox",
    notificationOutboxSchema,
  )) as mongoose.Model<INotificationOutbox>;
