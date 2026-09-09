import mongoose, { Schema, Document } from "mongoose";
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

// Optional TTL index as fallback safety mechanism (24 months = 730 days)
// This acts as a hard limit to prevent indefinite accumulation
const TTL_FALLBACK_DAYS = parseInt(
  process.env.AUDIT_LOG_TTL_FALLBACK_DAYS || "730",
  10
);
auditLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: TTL_FALLBACK_DAYS * 24 * 60 * 60 }
);

// Static method for bulk deletion of old audit logs
auditLogSchema.statics.purgeOldAuditLogs = async function (
  retentionMonths?: number
): Promise<{ deletedCount: number }> {
  const months =
    retentionMonths ??
    parseInt(process.env.AUDIT_LOG_RETENTION_MONTHS || "12", 10);
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - months);

  const result = await this.deleteMany({
    createdAt: { $lt: cutoffDate },
  });

  return { deletedCount: result.deletedCount || 0 };
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
