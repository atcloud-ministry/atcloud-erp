import {
  isValidDisplayText,
  normalizeDisplayText,
  normalizeNullableDisplayText,
} from "@atcloud/shared-time/registration-profile";
import mongoose, { type Document, type Model, Schema } from "mongoose";
import {
  ALUMNI_INVITATION_STATUSES,
  INVITATION_CONTACT_RETENTION_MONTHS,
  INVITATION_TOKEN_LIFETIME_DAYS,
  SHA256_HEX_PATTERN,
  addFixedDays,
  addUtcCalendarMonths,
  datesEqual,
  deriveAlumniAffiliationKey,
  deriveAlumniProgramAffiliationKey,
  isNonNegativeSafeInteger,
  type AlumniInvitationStatus,
} from "../contracts/alumniDirectoryData";

export const ALUMNI_INVITATION_COLLECTION = "alumni_invitations" as const;

const CONTACT_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_INVITATION_AFFILIATIONS = 50;
const MAX_SOURCE_BATCHES = 50;

export interface AlumniInvitationAffiliation {
  programId?: mongoose.Types.ObjectId;
  programName: string;
  cohortLabel?: string | null;
  affiliationKey: string;
  sourceImportBatchId: mongoose.Types.ObjectId;
  sourceRowNumber: number;
}

export interface IAlumniInvitation extends Document {
  sourceImportBatchIds: mongoose.Types.ObjectId[];
  contactEmail?: string;
  contactFirstName?: string;
  contactLastName?: string;
  /** Opaque keyed lookup digest. Its calculation belongs to the invitation service. */
  contactLookupHash?: string;
  /** Present only while this invitation is claimable; protected by a unique index. */
  activeContactLookupHash?: string;
  contactLookupVersion: number;
  matchedUserId?: mongoose.Types.ObjectId;
  affiliations: AlumniInvitationAffiliation[];
  status: AlumniInvitationStatus;
  tokenHash?: string;
  issueCount: number;
  issuedAt: Date;
  tokenExpiresAt: Date;
  lastInvitationSentAt: Date;
  claimedByUserId?: mongoose.Types.ObjectId;
  claimedAt?: Date | null;
  invalidatedAt?: Date | null;
  contactPurgeAt: Date;
  contactPurgedAt?: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

const invitationAffiliationSchema = new Schema<AlumniInvitationAffiliation>(
  {
    programId: { type: Schema.Types.ObjectId, ref: "Program" },
    programName: {
      type: String,
      required: true,
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
      lowercase: true,
      match: SHA256_HEX_PATTERN,
    },
    sourceImportBatchId: {
      type: Schema.Types.ObjectId,
      ref: "AlumniImportBatch",
      required: true,
    },
    sourceRowNumber: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: (value: unknown) =>
          Number.isSafeInteger(value) && Number(value) >= 1,
        message: "sourceRowNumber must be a positive safe integer.",
      },
    },
  },
  { _id: false, strict: "throw" },
);

const alumniInvitationSchema = new Schema<IAlumniInvitation>(
  {
    sourceImportBatchIds: {
      type: [Schema.Types.ObjectId],
      ref: "AlumniImportBatch",
      required: true,
      validate: {
        validator: (values: unknown) =>
          Array.isArray(values) &&
          values.length >= 1 &&
          values.length <= MAX_SOURCE_BATCHES &&
          new Set(values.map(String)).size === values.length,
        message: "sourceImportBatchIds must contain 1-50 unique batch ids.",
      },
    },
    contactEmail: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 254,
      match: CONTACT_EMAIL_PATTERN,
      select: false,
    },
    contactFirstName: {
      type: String,
      set: (value: unknown) =>
        typeof value === "string" ? normalizeNullableDisplayText(value) : value,
      validate: {
        validator: (value: unknown) =>
          value == null || isValidDisplayText(value, 1, 100),
        message: "Contact first name must be 1-100 characters on one line.",
      },
      select: false,
    },
    contactLastName: {
      type: String,
      set: (value: unknown) =>
        typeof value === "string" ? normalizeNullableDisplayText(value) : value,
      validate: {
        validator: (value: unknown) =>
          value == null || isValidDisplayText(value, 1, 100),
        message: "Contact last name must be 1-100 characters on one line.",
      },
      select: false,
    },
    contactLookupHash: {
      type: String,
      lowercase: true,
      match: SHA256_HEX_PATTERN,
      select: false,
    },
    activeContactLookupHash: {
      type: String,
      lowercase: true,
      match: SHA256_HEX_PATTERN,
      select: false,
    },
    contactLookupVersion: {
      type: Number,
      required: true,
      default: 1,
      enum: [1],
    },
    matchedUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      select: false,
    },
    affiliations: {
      type: [invitationAffiliationSchema],
      required: true,
      validate: {
        validator: (values: unknown) =>
          Array.isArray(values) &&
          values.length >= 1 &&
          values.length <= MAX_INVITATION_AFFILIATIONS,
        message: "Invitations must contain 1-50 affiliation candidates.",
      },
    },
    status: {
      type: String,
      enum: ALUMNI_INVITATION_STATUSES,
      required: true,
      default: "active",
    },
    tokenHash: {
      type: String,
      lowercase: true,
      match: SHA256_HEX_PATTERN,
      select: false,
    },
    issueCount: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
      validate: {
        validator: (value: unknown) =>
          Number.isSafeInteger(value) && Number(value) >= 1,
        message: "issueCount must be a positive safe integer.",
      },
    },
    issuedAt: { type: Date, required: true },
    tokenExpiresAt: { type: Date, required: true },
    lastInvitationSentAt: { type: Date, required: true },
    claimedByUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      select: false,
    },
    claimedAt: { type: Date, default: null },
    invalidatedAt: { type: Date, default: null },
    contactPurgeAt: { type: Date, required: true },
    contactPurgedAt: { type: Date, default: null },
    revision: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: {
        validator: isNonNegativeSafeInteger,
        message: "AlumniInvitation revision must be a non-negative safe integer.",
      },
    },
  },
  {
    collection: ALUMNI_INVITATION_COLLECTION,
    timestamps: true,
    strict: "throw",
    minimize: false,
    versionKey: false,
  },
);

alumniInvitationSchema.pre(
  "validate",
  function enforceInvitationInvariants(next) {
    if (!this.isNew && this.isModified("contactLookupVersion")) {
      this.invalidate(
        "contactLookupVersion",
        "Invitation contactLookupVersion cannot change after creation.",
      );
    }
    const lifecycleFields = [
      "status",
      "matchedUserId",
      "issueCount",
      "issuedAt",
      "tokenExpiresAt",
      "lastInvitationSentAt",
      "claimedByUserId",
      "claimedAt",
      "invalidatedAt",
      "contactPurgeAt",
      "contactPurgedAt",
    ];
    const privateFields = [
      "contactEmail",
      "contactFirstName",
      "contactLastName",
      "contactLookupHash",
      "activeContactLookupHash",
      "matchedUserId",
      "claimedByUserId",
      "tokenHash",
    ];
    if (
      !this.isNew &&
      lifecycleFields.some((path) => this.isModified(path)) &&
      privateFields.some((path) => !this.isSelected(path))
    ) {
      this.invalidate(
        "status",
        "Invitation lifecycle changes must explicitly load all private fields.",
      );
    }

    const requiredDates = [
      this.issuedAt,
      this.tokenExpiresAt,
      this.lastInvitationSentAt,
      this.contactPurgeAt,
    ];
    const hasAllRequiredDates = requiredDates.every(
      (value) => value instanceof Date && !Number.isNaN(value.getTime()),
    );
    if (!hasAllRequiredDates) {
      return next();
    }

    if (
      !datesEqual(
        this.tokenExpiresAt,
        addFixedDays(this.issuedAt, INVITATION_TOKEN_LIFETIME_DAYS),
      )
    ) {
      this.invalidate(
        "tokenExpiresAt",
        "Invitation tokenExpiresAt must be 14 days after issuedAt.",
      );
    }
    if (this.lastInvitationSentAt < this.issuedAt) {
      this.invalidate(
        "lastInvitationSentAt",
        "lastInvitationSentAt cannot precede issuedAt.",
      );
    }
    if (
      !datesEqual(
        this.contactPurgeAt,
        addUtcCalendarMonths(
          this.lastInvitationSentAt,
          INVITATION_CONTACT_RETENTION_MONTHS,
        ),
      )
    ) {
      this.invalidate(
        "contactPurgeAt",
        "Invitation contactPurgeAt must be six UTC calendar months after the last invitation.",
      );
    }

    const hasContact = Boolean(this.contactEmail && this.contactLookupHash);
    const hasAnyContact = Boolean(
      this.contactEmail ||
        this.contactFirstName ||
        this.contactLastName ||
        this.contactLookupHash,
    );
    if (hasAnyContact && !hasContact) {
      this.invalidate(
        "contactEmail",
        "Invitation contact data requires email and lookup hash.",
      );
    }
    if (this.contactPurgedAt && hasAnyContact) {
      this.invalidate(
        "contactPurgedAt",
        "Purged invitation contact data cannot remain on the record.",
      );
    }

    for (const affiliation of this.affiliations) {
      if (
        typeof affiliation.programName === "string" &&
        affiliation.programName.length > 0
      ) {
        affiliation.affiliationKey = deriveAlumniAffiliationKey({
          programName: affiliation.programName,
          cohortLabel: affiliation.cohortLabel,
        });
      }
    }
    const uniqueAffiliationKeys = new Set(
      this.affiliations.map((affiliation) => affiliation.affiliationKey),
    );
    const programAffiliationKeys = this.affiliations
      .filter((affiliation) => Boolean(affiliation.programId))
      .map((affiliation) =>
        deriveAlumniProgramAffiliationKey({
          programId: affiliation.programId!.toString(),
          cohortLabel: affiliation.cohortLabel,
        }),
      );
    if (
      uniqueAffiliationKeys.size !== this.affiliations.length ||
      new Set(programAffiliationKeys).size !== programAffiliationKeys.length
    ) {
      this.invalidate(
        "affiliations",
        "Invitation affiliation candidates must be unique.",
      );
    }

    if (this.status === "active") {
      if (
        !hasContact ||
        !this.activeContactLookupHash ||
        !this.tokenHash ||
        this.contactPurgedAt
      ) {
        this.invalidate(
          "status",
          "Active invitations require contact data, active lookup hash, and token hash.",
        );
      }
      if (
        this.contactLookupHash &&
        this.activeContactLookupHash !== this.contactLookupHash
      ) {
        this.invalidate(
          "activeContactLookupHash",
          "Active contact lookup hash must match the retained contact lookup hash.",
        );
      }
      if (this.claimedAt || this.claimedByUserId || this.invalidatedAt) {
        this.invalidate(
          "status",
          "Active invitations cannot contain terminal metadata.",
        );
      }
    }

    if (this.status === "claimed") {
      if (!this.claimedAt || !this.claimedByUserId) {
        this.invalidate(
          "claimedAt",
          "Claimed invitations require claimedAt and claimedByUserId.",
        );
      }
      if (
        this.matchedUserId &&
        this.claimedByUserId &&
        !this.matchedUserId.equals(this.claimedByUserId)
      ) {
        this.invalidate(
          "claimedByUserId",
          "Matched invitations may only be claimed by the matched user.",
        );
      }
      if (
        this.tokenHash ||
        this.activeContactLookupHash ||
        hasAnyContact ||
        !this.contactPurgedAt
      ) {
        this.invalidate(
          "status",
          "Claimed invitations must clear token and contact data immediately.",
        );
      }
      if (
        this.claimedAt &&
        (this.claimedAt < this.lastInvitationSentAt ||
          this.claimedAt >= this.tokenExpiresAt)
      ) {
        this.invalidate(
          "claimedAt",
          "Invitation claims must occur after sending and before token expiry.",
        );
      }
      if (
        this.claimedAt &&
        this.contactPurgedAt &&
        !datesEqual(this.contactPurgedAt, this.claimedAt)
      ) {
        this.invalidate(
          "contactPurgedAt",
          "Claimed invitation contact must be purged at claim time.",
        );
      }
      if (this.invalidatedAt) {
        this.invalidate(
          "invalidatedAt",
          "Claimed invitations cannot also be invalidated.",
        );
      }
    }

    if (this.status === "invalidated") {
      if (!this.invalidatedAt) {
        this.invalidate(
          "invalidatedAt",
          "Invalidated invitations require invalidatedAt.",
        );
      }
      if (this.invalidatedAt && this.invalidatedAt < this.issuedAt) {
        this.invalidate(
          "invalidatedAt",
          "Invitation invalidation cannot precede issuance.",
        );
      }
      if (this.tokenHash || this.activeContactLookupHash) {
        this.invalidate(
          "status",
          "Invalidated invitations cannot retain an active token or lookup hash.",
        );
      }
      if (this.claimedAt || this.claimedByUserId) {
        this.invalidate(
          "status",
          "Invalidated invitations cannot contain claim metadata.",
        );
      }
      if (!this.contactPurgedAt && !hasContact) {
        this.invalidate(
          "contactEmail",
          "Unpurged invalidated invitations must retain complete contact data.",
        );
      }
      if (this.contactPurgedAt && this.matchedUserId) {
        this.invalidate(
          "matchedUserId",
          "Purged unclaimed invitations cannot retain a matched user link.",
        );
      }
      if (
        this.contactPurgedAt &&
        this.contactPurgedAt < this.contactPurgeAt
      ) {
        this.invalidate(
          "contactPurgedAt",
          "Unclaimed invitation contact cannot be purged before contactPurgeAt.",
        );
      }
    }

    next();
  },
);

alumniInvitationSchema.index(
  { tokenHash: 1 },
  {
    unique: true,
    name: "uniq_alumni_invitation_token_hash",
    partialFilterExpression: { tokenHash: { $type: "string" } },
  },
);
alumniInvitationSchema.index(
  { activeContactLookupHash: 1 },
  {
    unique: true,
    name: "uniq_alumni_invitation_active_contact",
    partialFilterExpression: {
      activeContactLookupHash: { $type: "string" },
    },
  },
);
alumniInvitationSchema.index(
  { status: 1, tokenExpiresAt: 1, _id: 1 },
  { name: "idx_alumni_invitation_status_expiry" },
);
alumniInvitationSchema.index(
  { status: 1, contactPurgeAt: 1, _id: 1 },
  { name: "idx_alumni_invitation_contact_cleanup" },
);
alumniInvitationSchema.index(
  { sourceImportBatchIds: 1 },
  { name: "idx_alumni_invitation_source_batches" },
);

function removePrivateInvitationFields(
  _document: unknown,
  value: IAlumniInvitation & { _id?: unknown; __v?: number },
) {
  const mutable = value as unknown as Record<string, unknown>;
  if (mutable._id) mutable.id = mutable._id;
  delete mutable._id;
  delete mutable.contactEmail;
  delete mutable.contactFirstName;
  delete mutable.contactLastName;
  delete mutable.contactLookupHash;
  delete mutable.activeContactLookupHash;
  delete mutable.tokenHash;
  delete mutable.sourceImportBatchIds;
  delete mutable.affiliations;
  delete mutable.matchedUserId;
  delete mutable.claimedByUserId;
  delete mutable.contactPurgeAt;
  delete mutable.contactPurgedAt;
  delete mutable.revision;
  delete mutable.__v;
  return mutable;
}

alumniInvitationSchema.set("toJSON", {
  transform: removePrivateInvitationFields,
});
alumniInvitationSchema.set("toObject", {
  transform: removePrivateInvitationFields,
});

const AlumniInvitation: Model<IAlumniInvitation> =
  (mongoose.models.AlumniInvitation as
    | Model<IAlumniInvitation>
    | undefined) ||
  mongoose.model<IAlumniInvitation>(
    "AlumniInvitation",
    alumniInvitationSchema,
  );

export default AlumniInvitation;
