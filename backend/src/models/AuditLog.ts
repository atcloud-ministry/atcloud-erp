import mongoose, { Schema, Document } from "mongoose";
import { addUtcCalendarMonths } from "../contracts/alumniDirectoryData";
import {
  AUDIT_ACTOR_TYPES,
  AUDIT_OUTCOMES,
  AUDIT_SOURCES,
  type AuditActorType,
  type AuditOutcome,
  type AuditSource,
} from "../contracts/auditLog";

export interface IAuditLog extends Document {
  action: string; // e.g., EventPublished, EventUnpublished, admin_profile_edit

  // Versioned format fields. Existing records may not contain these values.
  version?: number;
  actorType?: AuditActorType | null;
  actorKey?: string | null;
  source?: AuditSource | null;
  correlationId?: string | null;
  outcome?: AuditOutcome | null;
  reasonCode?: string | null;

  // Old format fields (for backward compatibility)
  actorId?: mongoose.Types.ObjectId | null; // user performing action
  eventId?: mongoose.Types.ObjectId | null;
  metadata?: Record<string, unknown> | null;

  // New format fields (for detailed audit trail)
  actor?: {
    id: mongoose.Types.ObjectId;
    role: string;
    email?: string;
  } | null;
  targetModel?: string | null; // e.g., "User", "Event"
  targetId?: string | null; // ID of the target resource
  details?: Record<string, unknown> | null; // Additional structured details

  // Privacy fields
  ipHash?: string | null; // truncated/hashed IP (future use)
  ipAddress?: string | null; // Raw IP address (for recent logs)
  emailHash?: string | null; // hashed email when needed
  userAgent?: string | null; // Browser/client info

  createdAt: Date;
}

// Interface for static methods
export interface IAuditLogModel extends mongoose.Model<IAuditLog> {
  purgeOldAuditLogs(
    retentionMonths?: number
  ): Promise<{ deletedCount: number }>;
  purgeOldAuditLogsBounded(
    limit: number,
    retentionMonths?: number,
  ): Promise<{ deletedCount: number; hasMore: boolean }>;
}

const auditLogSchema = new Schema<IAuditLog>(
  {
    action: { type: String, required: true, index: true },

    // Version 1 represents legacy writers. AuditLogService writes version 2.
    version: { type: Number, default: 1, min: 1 },
    actorType: {
      type: String,
      enum: AUDIT_ACTOR_TYPES,
      default: null,
    },
    actorKey: { type: String, default: null, maxlength: 200 },
    source: { type: String, enum: AUDIT_SOURCES, default: null },
    correlationId: { type: String, default: null, maxlength: 128 },
    outcome: { type: String, enum: AUDIT_OUTCOMES, default: null },
    reasonCode: { type: String, default: null, maxlength: 120 },

    // Old format fields (backward compatibility)
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Event",
      index: true,
    },
    metadata: { type: Schema.Types.Mixed, default: null },

    // New format fields
    actor: {
      type: {
        id: { type: mongoose.Schema.Types.ObjectId, required: true },
        role: { type: String, required: true },
        // Optional for privacy-safe version 2 records. Legacy records may retain it.
        email: { type: String, required: false },
      },
      default: null,
    },
    targetModel: { type: String, default: null, index: true },
    targetId: { type: String, default: null, index: true },
    details: { type: Schema.Types.Mixed, default: null },

    // Privacy fields
    ipHash: { type: String, default: null },
    ipAddress: { type: String, default: null },
    emailHash: { type: String, default: null },
    userAgent: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ actorType: 1, actorKey: 1, createdAt: -1 });
auditLogSchema.index({ targetModel: 1, targetId: 1, createdAt: -1 });

export const AUDIT_LOG_RETENTION_MONTHS = 12;
export const AUDIT_LOG_TTL_FALLBACK_DAYS = 365;

function retentionInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  const candidate = value ?? String(fallback);
  if (!/^[1-9]\d*$/u.test(candidate)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const parsed = Number(candidate);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return parsed;
}

// A 365-day TTL is a hard fallback. Hourly application cleanup enforces the
// authoritative 12 UTC-calendar-month contract first.
const TTL_FALLBACK_DAYS = retentionInteger(
  process.env.AUDIT_LOG_TTL_FALLBACK_DAYS,
  AUDIT_LOG_TTL_FALLBACK_DAYS,
  "AUDIT_LOG_TTL_FALLBACK_DAYS",
);
auditLogSchema.index(
  { createdAt: 1 },
  {
    name: "createdAt_1",
    expireAfterSeconds: TTL_FALLBACK_DAYS * 24 * 60 * 60,
  },
);

// Static method for bulk deletion of old audit logs
auditLogSchema.statics.purgeOldAuditLogs = async function (
  retentionMonths?: number
): Promise<{ deletedCount: number }> {
  const months =
    retentionMonths ??
    retentionInteger(
      process.env.AUDIT_LOG_RETENTION_MONTHS,
      AUDIT_LOG_RETENTION_MONTHS,
      "AUDIT_LOG_RETENTION_MONTHS",
    );
  if (!Number.isSafeInteger(months) || months < 1) {
    throw new Error("Audit log retention months must be a positive safe integer.");
  }
  const cutoffDate = addUtcCalendarMonths(new Date(), -months);

  const result = await this.deleteMany({
    createdAt: { $lt: cutoffDate },
  });

  return { deletedCount: result.deletedCount || 0 };
};

/**
 * Uses the same calendar-month policy as the scheduler while retaining a
 * deterministic upper bound for an isolated restore-recovery pass.
 */
auditLogSchema.statics.purgeOldAuditLogsBounded = async function (
  limit: number,
  retentionMonths?: number,
): Promise<{ deletedCount: number; hasMore: boolean }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Audit log bounded purge limit must be an integer from 1 to 500.");
  }
  const months =
    retentionMonths ??
    retentionInteger(
      process.env.AUDIT_LOG_RETENTION_MONTHS,
      AUDIT_LOG_RETENTION_MONTHS,
      "AUDIT_LOG_RETENTION_MONTHS",
    );
  if (!Number.isSafeInteger(months) || months < 1) {
    throw new Error("Audit log retention months must be a positive safe integer.");
  }
  const cutoffDate = addUtcCalendarMonths(new Date(), -months);
  const candidates = await this.find(
    { createdAt: { $lt: cutoffDate } },
    { _id: 1 },
  )
    // The `createdAt_1` retention index supports this filter/order pair.
    // Avoid a secondary sort that could force a broad in-memory sort in a
    // bounded restore-recovery pass.
    .sort({ createdAt: 1 })
    .limit(limit + 1)
    .maxTimeMS(5_000)
    .lean()
    .exec();
  const selected = candidates
    .slice(0, limit)
    .map((candidate: { readonly _id: mongoose.Types.ObjectId }) => candidate._id);
  if (selected.length === 0) {
    return { deletedCount: 0, hasMore: false };
  }
  const result = await this.deleteMany({
    _id: { $in: selected },
    createdAt: { $lt: cutoffDate },
  });
  return {
    deletedCount: result.deletedCount || 0,
    hasMore: candidates.length > limit || (result.deletedCount || 0) < selected.length,
  };
};

interface MutableAuditLogJSON {
  _id?: unknown;
  id?: unknown;
  __v?: unknown;
  [key: string]: unknown;
}

auditLogSchema.set("toJSON", {
  transform: (_doc, ret: IAuditLog & { _id: unknown; __v?: number }) => {
    const mutable = ret as unknown as MutableAuditLogJSON;
    if (mutable._id) {
      mutable.id = mutable._id;
      delete mutable._id;
    }
    if ("__v" in mutable) {
      delete mutable.__v;
    }
    return mutable;
  },
});

export default (mongoose.models.AuditLog ||
  mongoose.model<IAuditLog>("AuditLog", auditLogSchema)) as IAuditLogModel;
