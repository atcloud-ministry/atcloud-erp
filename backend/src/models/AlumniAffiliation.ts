import {
  isValidDisplayText,
  normalizeDisplayText,
  normalizeNullableDisplayText,
} from "@atcloud/shared-time/registration-profile";
import mongoose, { type Document, type Model, Schema } from "mongoose";
import {
  ACCOUNT_DELETION_RETENTION_DAYS,
  ALUMNI_AFFILIATION_VERIFICATION_STATUSES,
  SHA256_HEX_PATTERN,
  deriveAlumniAffiliationKey,
  deriveAlumniProgramAffiliationKey,
  isNonNegativeSafeInteger,
  isWithinFixedDayRetention,
  type AlumniAffiliationVerificationStatus,
} from "../contracts/alumniDirectoryData";

export const ALUMNI_AFFILIATION_COLLECTION = "alumni_affiliations" as const;

export interface IAlumniAffiliation extends Document {
  alumniProfileId: mongoose.Types.ObjectId;
  programId?: mongoose.Types.ObjectId;
  programName: string;
  cohortLabel?: string | null;
  /** SHA-256 of the canonical program name/cohort identity. */
  affiliationKey: string;
  /** SHA-256 of the canonical Program id/cohort identity when linked. */
  programAffiliationKey?: string;
  verificationStatus: AlumniAffiliationVerificationStatus;
  reviewedAt?: Date | null;
  reviewedBy?: mongoose.Types.ObjectId;
  sourceImportBatchId?: mongoose.Types.ObjectId;
  sourceRowNumber?: number;
  accountDeletionApprovedAt?: Date | null;
  purgeAt?: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

const alumniAffiliationSchema = new Schema<IAlumniAffiliation>(
  {
    alumniProfileId: {
      type: Schema.Types.ObjectId,
      ref: "AlumniProfile",
      required: true,
      immutable: true,
    },
    programId: {
      type: Schema.Types.ObjectId,
      ref: "Program",
      immutable: true,
    },
    programName: {
      type: String,
      required: true,
      immutable: true,
      set: (value: unknown) =>
        typeof value === "string" ? normalizeDisplayText(value) : value,
      validate: {
        validator: (value: unknown) => isValidDisplayText(value, 1, 160),
        message: "Program name must be 1-160 characters on one line.",
      },
    },
    cohortLabel: {
      type: String,
      default: null,
      immutable: true,
      set: (value: unknown) =>
        typeof value === "string" ? normalizeNullableDisplayText(value) : value,
      validate: {
        validator: (value: unknown) =>
          value == null || isValidDisplayText(value, 1, 100),
        message: "Cohort label must be 1-100 characters on one line.",
      },
    },
    affiliationKey: {
      type: String,
      required: true,
      immutable: true,
      lowercase: true,
      match: SHA256_HEX_PATTERN,
    },
    programAffiliationKey: {
      type: String,
      immutable: true,
      lowercase: true,
      match: SHA256_HEX_PATTERN,
      select: false,
    },
    verificationStatus: {
      type: String,
      enum: ALUMNI_AFFILIATION_VERIFICATION_STATUSES,
      required: true,
      default: "pending_review",
    },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
    sourceImportBatchId: {
      type: Schema.Types.ObjectId,
      ref: "AlumniImportBatch",
      immutable: true,
    },
    sourceRowNumber: {
      type: Number,
      min: 1,
      immutable: true,
      validate: {
        validator: (value: unknown) =>
          value === undefined ||
          (Number.isSafeInteger(value) && Number(value) >= 1),
        message: "sourceRowNumber must be a positive safe integer.",
      },
    },
    accountDeletionApprovedAt: { type: Date, default: null },
    purgeAt: { type: Date, default: null },
    revision: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: {
        validator: isNonNegativeSafeInteger,
        message: "AlumniAffiliation revision must be a non-negative safe integer.",
      },
    },
  },
  {
    collection: ALUMNI_AFFILIATION_COLLECTION,
    timestamps: true,
    strict: "throw",
    minimize: false,
    versionKey: false,
  },
);

alumniAffiliationSchema.pre(
  "validate",
  function enforceAffiliationInvariants(next) {
    if (typeof this.programName === "string" && this.programName.length > 0) {
      this.affiliationKey = deriveAlumniAffiliationKey({
        programName: this.programName,
        cohortLabel: this.cohortLabel,
      });
    }
    if (this.isNew) {
      if (this.programId) {
        this.programAffiliationKey = deriveAlumniProgramAffiliationKey({
          programId: this.programId.toString(),
          cohortLabel: this.cohortLabel,
        });
      } else {
        this.programAffiliationKey = undefined;
      }
    }

    const wasReviewed = this.verificationStatus !== "pending_review";
    const hasAnyReviewField = Boolean(this.reviewedAt || this.reviewedBy);
    const hasCompleteReview = Boolean(this.reviewedAt && this.reviewedBy);
    if (wasReviewed && !hasCompleteReview) {
      this.invalidate(
        "reviewedAt",
        "Reviewed affiliations require reviewedAt and reviewedBy.",
      );
    }
    if (!wasReviewed && hasAnyReviewField) {
      this.invalidate(
        "reviewedAt",
        "Pending affiliations cannot contain review metadata.",
      );
    }

    const hasAnySourceField = Boolean(
      this.sourceImportBatchId || this.sourceRowNumber,
    );
    const hasCompleteSource = Boolean(
      this.sourceImportBatchId && this.sourceRowNumber,
    );
    if (hasAnySourceField && !hasCompleteSource) {
      this.invalidate(
        "sourceImportBatchId",
        "Imported affiliations require batch and row provenance.",
      );
    }

    const hasDeletionSchedule = Boolean(
      this.accountDeletionApprovedAt || this.purgeAt,
    );
    const hasCompleteDeletionSchedule = Boolean(
      this.accountDeletionApprovedAt && this.purgeAt,
    );
    if (hasDeletionSchedule && !hasCompleteDeletionSchedule) {
      this.invalidate(
        "purgeAt",
        "Account deletion requires both accountDeletionApprovedAt and purgeAt.",
      );
    } else if (
      this.accountDeletionApprovedAt &&
      this.purgeAt &&
      !isWithinFixedDayRetention(
        this.purgeAt,
        this.accountDeletionApprovedAt,
        ACCOUNT_DELETION_RETENTION_DAYS,
      )
    ) {
      this.invalidate(
        "purgeAt",
        "AlumniAffiliation purgeAt must be within 30 days after account deletion approval.",
      );
    }

    next();
  },
);

alumniAffiliationSchema.index(
  { alumniProfileId: 1, programId: 1, affiliationKey: 1 },
  {
    unique: true,
    name: "uniq_alumni_affiliation_profile_external_key",
  },
);
alumniAffiliationSchema.index(
  { alumniProfileId: 1, programAffiliationKey: 1 },
  {
    unique: true,
    name: "uniq_alumni_affiliation_profile_program_key",
    partialFilterExpression: { programAffiliationKey: { $type: "string" } },
  },
);
alumniAffiliationSchema.index(
  { alumniProfileId: 1, verificationStatus: 1 },
  { name: "idx_alumni_affiliation_profile_verification" },
);
alumniAffiliationSchema.index(
  { verificationStatus: 1, cohortLabel: 1, alumniProfileId: 1 },
  { name: "idx_alumni_affiliation_verified_cohort" },
);
alumniAffiliationSchema.index(
  { programId: 1, verificationStatus: 1 },
  {
    name: "idx_alumni_affiliation_program_verification",
    partialFilterExpression: { programId: { $type: "objectId" } },
  },
);
alumniAffiliationSchema.index(
  { sourceImportBatchId: 1, sourceRowNumber: 1 },
  {
    name: "idx_alumni_affiliation_source",
    partialFilterExpression: {
      sourceImportBatchId: { $type: "objectId" },
    },
  },
);
alumniAffiliationSchema.index(
  { purgeAt: 1 },
  { expireAfterSeconds: 0, name: "ttl_alumni_affiliation_purge_at" },
);

function removeInternalAffiliationFields(
  _document: unknown,
  value: IAlumniAffiliation & { _id?: unknown; __v?: number },
) {
  const mutable = value as unknown as Record<string, unknown>;
  if (mutable._id) mutable.id = mutable._id;
  delete mutable._id;
  delete mutable.alumniProfileId;
  delete mutable.programId;
  delete mutable.affiliationKey;
  delete mutable.programAffiliationKey;
  delete mutable.verificationStatus;
  delete mutable.reviewedAt;
  delete mutable.reviewedBy;
  delete mutable.sourceImportBatchId;
  delete mutable.sourceRowNumber;
  delete mutable.accountDeletionApprovedAt;
  delete mutable.purgeAt;
  delete mutable.revision;
  delete mutable.__v;
  return mutable;
}

alumniAffiliationSchema.set("toJSON", {
  transform: removeInternalAffiliationFields,
});
alumniAffiliationSchema.set("toObject", {
  transform: removeInternalAffiliationFields,
});

const AlumniAffiliation: Model<IAlumniAffiliation> =
  (mongoose.models.AlumniAffiliation as
    | Model<IAlumniAffiliation>
    | undefined) ||
  mongoose.model<IAlumniAffiliation>(
    "AlumniAffiliation",
    alumniAffiliationSchema,
  );

export default AlumniAffiliation;
