import mongoose, { type Document, type Model, Schema } from "mongoose";
import {
  CONSENT_RECORD_PURPOSES,
  CONSENT_RECORD_RETENTION_MONTHS,
  CONSENT_RECORD_STATUSES,
  SHA256_HEX_PATTERN,
  addUtcCalendarMonths,
  datesEqual,
  isNonNegativeSafeInteger,
  type ConsentRecordPurpose,
  type ConsentRecordStatus,
} from "../contracts/alumniDirectoryData";

export const CONSENT_RECORD_COLLECTION = "consent_records" as const;

const CONSENT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export interface IConsentRecord extends Document {
  subjectUserId: mongoose.Types.ObjectId;
  alumniProfileId: mongoose.Types.ObjectId;
  purpose: ConsentRecordPurpose;
  consentVersion: string;
  documentHash: string;
  status: ConsentRecordStatus;
  acceptedAt: Date;
  supersededAt?: Date | null;
  supersededByConsentId?: mongoose.Types.ObjectId;
  withdrawnAt?: Date | null;
  accountDeletionApprovedAt?: Date | null;
  purgeAt?: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

const consentRecordSchema = new Schema<IConsentRecord>(
  {
    subjectUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    alumniProfileId: {
      type: Schema.Types.ObjectId,
      ref: "AlumniProfile",
      required: true,
      immutable: true,
    },
    purpose: {
      type: String,
      enum: CONSENT_RECORD_PURPOSES,
      required: true,
      immutable: true,
    },
    consentVersion: {
      type: String,
      required: true,
      immutable: true,
      match: CONSENT_VERSION_PATTERN,
    },
    documentHash: {
      type: String,
      required: true,
      immutable: true,
      lowercase: true,
      match: SHA256_HEX_PATTERN,
    },
    status: {
      type: String,
      enum: CONSENT_RECORD_STATUSES,
      required: true,
      default: "active",
    },
    acceptedAt: { type: Date, required: true, immutable: true },
    supersededAt: { type: Date, default: null },
    supersededByConsentId: { type: Schema.Types.ObjectId, ref: "ConsentRecord" },
    withdrawnAt: { type: Date, default: null },
    accountDeletionApprovedAt: { type: Date, default: null },
    purgeAt: { type: Date, default: null },
    revision: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: {
        validator: isNonNegativeSafeInteger,
        message: "ConsentRecord revision must be a non-negative safe integer.",
      },
    },
  },
  {
    collection: CONSENT_RECORD_COLLECTION,
    timestamps: true,
    strict: "throw",
    minimize: false,
    versionKey: false,
  },
);

consentRecordSchema.pre("validate", function enforceConsentInvariants(next) {
  const terminalFields = [
    this.supersededAt,
    this.supersededByConsentId,
    this.withdrawnAt,
    this.accountDeletionApprovedAt,
  ].filter(Boolean);

  if (this.status === "active") {
    if (terminalFields.length > 0 || this.purgeAt) {
      this.invalidate(
        "status",
        "Active consent cannot contain terminal metadata or purgeAt.",
      );
    }
    return next();
  }

  let endedAt: Date | null | undefined;
  if (this.status === "superseded") {
    endedAt = this.supersededAt;
    if (!this.supersededAt || !this.supersededByConsentId) {
      this.invalidate(
        "supersededAt",
        "Superseded consent requires supersededAt and its replacement id.",
      );
    }
    if (this.withdrawnAt || this.accountDeletionApprovedAt) {
      this.invalidate(
        "status",
        "Superseded consent cannot contain another termination reason.",
      );
    }
  } else if (this.status === "withdrawn") {
    endedAt = this.withdrawnAt;
    if (!this.withdrawnAt) {
      this.invalidate("withdrawnAt", "Withdrawn consent requires withdrawnAt.");
    }
    if (
      this.supersededAt ||
      this.supersededByConsentId ||
      this.accountDeletionApprovedAt
    ) {
      this.invalidate(
        "status",
        "Withdrawn consent cannot contain another termination reason.",
      );
    }
  } else {
    endedAt = this.accountDeletionApprovedAt;
    if (!this.accountDeletionApprovedAt) {
      this.invalidate(
        "accountDeletionApprovedAt",
        "Account-deleted consent requires accountDeletionApprovedAt.",
      );
    }
    if (this.supersededAt || this.supersededByConsentId || this.withdrawnAt) {
      this.invalidate(
        "status",
        "Account-deleted consent cannot contain another termination reason.",
      );
    }
  }

  if (!this.purgeAt) {
    this.invalidate("purgeAt", "Terminal consent requires purgeAt.");
  }
  if (endedAt && endedAt < this.acceptedAt) {
    this.invalidate("status", "Consent cannot end before it was accepted.");
  }
  if (
    endedAt &&
    this.purgeAt &&
    !datesEqual(
      this.purgeAt,
      addUtcCalendarMonths(endedAt, CONSENT_RECORD_RETENTION_MONTHS),
    )
  ) {
    this.invalidate(
      "purgeAt",
      "Consent purgeAt must be twelve UTC calendar months after termination.",
    );
  }

  next();
});

consentRecordSchema.index(
  { subjectUserId: 1, purpose: 1 },
  {
    unique: true,
    name: "uniq_consent_record_active_user_purpose",
    partialFilterExpression: { status: "active" },
  },
);
consentRecordSchema.index(
  { alumniProfileId: 1, purpose: 1 },
  {
    unique: true,
    name: "uniq_consent_record_active_profile_purpose",
    partialFilterExpression: { status: "active" },
  },
);
consentRecordSchema.index(
  { alumniProfileId: 1, purpose: 1, createdAt: -1, _id: -1 },
  { name: "idx_consent_record_profile_history" },
);
consentRecordSchema.index(
  { subjectUserId: 1, status: 1 },
  { name: "idx_consent_record_user_status" },
);
consentRecordSchema.index(
  { purgeAt: 1 },
  { expireAfterSeconds: 0, name: "ttl_consent_record_purge_at" },
);

function removeInternalConsentFields(
  _document: unknown,
  value: IConsentRecord & { _id?: unknown; __v?: number },
) {
  const mutable = value as unknown as Record<string, unknown>;
  if (mutable._id) mutable.id = mutable._id;
  delete mutable._id;
  delete mutable.documentHash;
  delete mutable.supersededByConsentId;
  delete mutable.accountDeletionApprovedAt;
  delete mutable.purgeAt;
  delete mutable.revision;
  delete mutable.__v;
  return mutable;
}

consentRecordSchema.set("toJSON", { transform: removeInternalConsentFields });
consentRecordSchema.set("toObject", { transform: removeInternalConsentFields });

const ConsentRecord: Model<IConsentRecord> =
  (mongoose.models.ConsentRecord as Model<IConsentRecord> | undefined) ||
  mongoose.model<IConsentRecord>("ConsentRecord", consentRecordSchema);

export default ConsentRecord;
