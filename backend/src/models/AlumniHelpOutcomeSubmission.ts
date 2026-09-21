import mongoose, { type Document, type Model, Schema } from "mongoose";
import {
  ALUMNI_HELP_OUTCOME_CODES,
  ALUMNI_HELP_OUTCOME_CONFIRMATION_METHODS,
  ALUMNI_HELP_OUTCOME_STATUSES,
  ALUMNI_HELP_TYPES,
  helpOutcomeDueAt,
  isAlumniHelpOutcomeCodeForType,
  isAlumniHelpType,
  type AlumniHelpOutcomeCode,
  type AlumniHelpOutcomeConfirmationMethod,
  type AlumniHelpOutcomeStatus,
  type AlumniHelpType,
} from "../contracts/alumniHelpFlow";
import { datesEqual, isNonNegativeSafeInteger } from "../contracts/alumniDirectoryData";

export const ALUMNI_HELP_OUTCOME_SUBMISSION_COLLECTION =
  "alumni_help_outcome_submissions" as const;

export interface IAlumniHelpOutcomeSubmission extends Document {
  _id: mongoose.Types.ObjectId;
  helpRequestId: mongoose.Types.ObjectId;
  revisionNumber: number;
  previousSubmissionId?: mongoose.Types.ObjectId | null;
  submittedBy: mongoose.Types.ObjectId;
  agreedHelpType: AlumniHelpType;
  outcomeCode: AlumniHelpOutcomeCode;
  status: AlumniHelpOutcomeStatus;
  submittedAt: Date;
  dueAt: Date;
  decidedAt?: Date | null;
  decidedBy?: mongoose.Types.ObjectId | null;
  confirmationMethod?: AlumniHelpOutcomeConfirmationMethod | null;
  purgeAt?: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

const alumniHelpOutcomeSubmissionSchema =
  new Schema<IAlumniHelpOutcomeSubmission>(
    {
      helpRequestId: {
        type: Schema.Types.ObjectId,
        ref: "AlumniHelpRequest",
        required: true,
        immutable: true,
      },
      revisionNumber: {
        type: Number,
        required: true,
        immutable: true,
        min: 1,
        validate: Number.isSafeInteger,
      },
      previousSubmissionId: {
        type: Schema.Types.ObjectId,
        ref: "AlumniHelpOutcomeSubmission",
        default: null,
        immutable: true,
      },
      submittedBy: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true,
        immutable: true,
      },
      agreedHelpType: {
        type: String,
        enum: ALUMNI_HELP_TYPES,
        required: true,
        immutable: true,
      },
      outcomeCode: {
        type: String,
        enum: ALUMNI_HELP_OUTCOME_CODES,
        required: true,
        immutable: true,
      },
      status: {
        type: String,
        enum: ALUMNI_HELP_OUTCOME_STATUSES,
        required: true,
        default: "pending",
      },
      submittedAt: { type: Date, required: true, immutable: true },
      dueAt: { type: Date, required: true, immutable: true },
      decidedAt: { type: Date, default: null },
      decidedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
      confirmationMethod: {
        type: String,
        enum: ALUMNI_HELP_OUTCOME_CONFIRMATION_METHODS,
        default: null,
      },
      purgeAt: { type: Date, default: null },
      revision: {
        type: Number,
        required: true,
        default: 0,
        min: 0,
        validate: isNonNegativeSafeInteger,
      },
    },
    {
      collection: ALUMNI_HELP_OUTCOME_SUBMISSION_COLLECTION,
      timestamps: true,
      strict: "throw",
      minimize: false,
      versionKey: false,
    },
  );

alumniHelpOutcomeSubmissionSchema.pre(
  "validate",
  function enforceOutcomeInvariants(next) {
    if (
      isAlumniHelpType(this.agreedHelpType) &&
      !isAlumniHelpOutcomeCodeForType(this.agreedHelpType, this.outcomeCode)
    ) {
      this.invalidate(
        "outcomeCode",
        "Outcome code is not available for the agreed help type.",
      );
    }
    if (
      this.submittedAt instanceof Date &&
      !Number.isNaN(this.submittedAt.getTime()) &&
      !datesEqual(this.dueAt, helpOutcomeDueAt(this.submittedAt))
    ) {
      this.invalidate(
        "dueAt",
        "Outcome dueAt must be exactly 480 hours after submission.",
      );
    }
    if (
      (this.revisionNumber === 1 && this.previousSubmissionId) ||
      (this.revisionNumber > 1 && !this.previousSubmissionId)
    ) {
      this.invalidate(
        "previousSubmissionId",
        "Outcome revision ancestry is invalid.",
      );
    }

    if (this.status === "pending") {
      if (this.decidedAt || this.decidedBy || this.confirmationMethod) {
        this.invalidate(
          "status",
          "Pending outcomes cannot contain decision metadata.",
        );
      }
    } else if (this.status === "confirmed") {
      if (!this.decidedAt || !this.confirmationMethod) {
        this.invalidate(
          "status",
          "Confirmed outcomes require decision metadata.",
        );
      }
      if (this.confirmationMethod === "provider" && !this.decidedBy) {
        this.invalidate(
          "decidedBy",
          "Provider confirmation requires decidedBy.",
        );
      }
      if (this.confirmationMethod === "automatic_20_day" && this.decidedBy) {
        this.invalidate(
          "decidedBy",
          "Automatic confirmation cannot identify a user decision maker.",
        );
      }
    } else if (
      !this.decidedAt ||
      !this.decidedBy ||
      this.confirmationMethod
    ) {
      this.invalidate(
        "status",
        "Denied outcomes require a provider decision without confirmationMethod.",
      );
    }

    if (this.purgeAt && this.purgeAt <= this.dueAt) {
      this.invalidate("purgeAt", "Outcome purgeAt must be after dueAt.");
    }
    next();
  },
);

alumniHelpOutcomeSubmissionSchema.index(
  { helpRequestId: 1, revisionNumber: 1 },
  { unique: true, name: "uniq_alumni_help_outcome_request_revision" },
);
alumniHelpOutcomeSubmissionSchema.index(
  { helpRequestId: 1 },
  {
    unique: true,
    name: "uniq_alumni_help_outcome_pending_request",
    partialFilterExpression: { status: "pending" },
  },
);
alumniHelpOutcomeSubmissionSchema.index(
  { status: 1, dueAt: 1, _id: 1 },
  { name: "idx_alumni_help_outcome_deadline" },
);
alumniHelpOutcomeSubmissionSchema.index(
  { helpRequestId: 1, revisionNumber: 1, _id: 1 },
  { name: "idx_alumni_help_outcome_history" },
);
alumniHelpOutcomeSubmissionSchema.index(
  { purgeAt: 1 },
  { expireAfterSeconds: 0, name: "ttl_alumni_help_outcome_purge_at" },
);

function removeInternalOutcomeFields(
  _document: unknown,
  value: IAlumniHelpOutcomeSubmission & { _id?: unknown; __v?: number },
) {
  const mutable = value as unknown as Record<string, unknown>;
  if (mutable._id) mutable.id = mutable._id;
  delete mutable._id;
  delete mutable.helpRequestId;
  delete mutable.submittedBy;
  delete mutable.decidedBy;
  delete mutable.purgeAt;
  delete mutable.__v;
  return mutable;
}

alumniHelpOutcomeSubmissionSchema.set("toJSON", {
  transform: removeInternalOutcomeFields,
});
alumniHelpOutcomeSubmissionSchema.set("toObject", {
  transform: removeInternalOutcomeFields,
});

const AlumniHelpOutcomeSubmission: Model<IAlumniHelpOutcomeSubmission> =
  (mongoose.models.AlumniHelpOutcomeSubmission as
    | Model<IAlumniHelpOutcomeSubmission>
    | undefined) ||
  mongoose.model<IAlumniHelpOutcomeSubmission>(
    "AlumniHelpOutcomeSubmission",
    alumniHelpOutcomeSubmissionSchema,
  );

export default AlumniHelpOutcomeSubmission;
