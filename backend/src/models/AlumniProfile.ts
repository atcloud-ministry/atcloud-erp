import {
  codePointLength,
  isValidDisplayText,
  normalizeDisplayText,
  normalizeNullableDisplayText,
  normalizeSearchText,
} from "@atcloud/shared-time/registration-profile";
import mongoose, { type Document, type Model, Schema } from "mongoose";
import {
  ACCOUNT_DELETION_RETENTION_DAYS,
  ALUMNI_PROFILE_PUBLISH_STATUSES,
  isNonNegativeSafeInteger,
  isWithinFixedDayRetention,
  type AlumniProfilePublishStatus,
} from "../contracts/alumniDirectoryData";

export const ALUMNI_PROFILE_COLLECTION = "alumni_profiles" as const;

const MAX_HEADLINE_CODE_POINTS = 160;
const MAX_INDUSTRY_CODE_POINTS = 100;
const MAX_SKILL_CODE_POINTS = 80;
const MAX_SKILLS = 20;
const MAX_BIO_CODE_POINTS = 2_000;
const MAX_SEARCH_TEXT_CODE_POINTS = 4_000;
const MAX_SEARCH_KEY_CODE_POINTS = 200;
const MAX_COHORT_KEYS = 50;

export interface AlumniHelpOfferings {
  careerAdvice: boolean;
  warmIntroduction: boolean;
  formalEmployeeReferral: boolean;
}

export interface AlumniProfileSearchProjection {
  searchText: string;
  displayNameKey: string;
  companyKey: string;
  occupationKey: string;
  industryKey: string;
  skillKeys: string[];
  generalLocationKey: string;
  cohortKeys: string[];
}

export interface IAlumniProfile extends Document {
  userId: mongoose.Types.ObjectId;
  professionalHeadline?: string | null;
  industry?: string | null;
  skills: string[];
  bio?: string | null;
  helpOfferings: AlumniHelpOfferings;
  publishStatus: AlumniProfilePublishStatus;
  currentPublicationConsentId?: mongoose.Types.ObjectId;
  searchProjection: AlumniProfileSearchProjection;
  publishedAt?: Date | null;
  withdrawnAt?: Date | null;
  accountDeletionApprovedAt?: Date | null;
  purgeAt?: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

function normalizedNullableDisplayText(value: unknown): unknown {
  return typeof value === "string" ? normalizeNullableDisplayText(value) : value;
}

function normalizeDisplayTextArray(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map((entry) =>
        typeof entry === "string" ? normalizeDisplayText(entry) : entry,
      )
    : value;
}

function normalizeSearchValue(value: unknown): unknown {
  return typeof value === "string" ? normalizeSearchText(value) : value;
}

function normalizeSearchArray(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map((entry) =>
        typeof entry === "string" ? normalizeSearchText(entry) : entry,
      )
    : value;
}

function validSearchKey(value: unknown, maximum = MAX_SEARCH_KEY_CODE_POINTS) {
  return (
    typeof value === "string" &&
    value === normalizeSearchText(value) &&
    codePointLength(value) <= maximum
  );
}

const helpOfferingsSchema = new Schema<AlumniHelpOfferings>(
  {
    careerAdvice: { type: Boolean, required: true, default: false },
    warmIntroduction: { type: Boolean, required: true, default: false },
    formalEmployeeReferral: { type: Boolean, required: true, default: false },
  },
  { _id: false, strict: "throw" },
);

const searchProjectionSchema = new Schema<AlumniProfileSearchProjection>(
  {
    searchText: {
      type: String,
      default: "",
      set: normalizeSearchValue,
      validate: {
        validator: (value: unknown) =>
          validSearchKey(value, MAX_SEARCH_TEXT_CODE_POINTS),
        message: "searchText must be a normalized, bounded search value.",
      },
    },
    displayNameKey: {
      type: String,
      default: "",
      set: normalizeSearchValue,
      validate: { validator: (value: unknown) => validSearchKey(value) },
    },
    companyKey: {
      type: String,
      default: "",
      set: normalizeSearchValue,
      validate: { validator: (value: unknown) => validSearchKey(value) },
    },
    occupationKey: {
      type: String,
      default: "",
      set: normalizeSearchValue,
      validate: { validator: (value: unknown) => validSearchKey(value) },
    },
    industryKey: {
      type: String,
      default: "",
      set: normalizeSearchValue,
      validate: { validator: (value: unknown) => validSearchKey(value) },
    },
    skillKeys: {
      type: [String],
      required: true,
      default: [],
      set: normalizeSearchArray,
      validate: {
        validator: (values: unknown) =>
          Array.isArray(values) &&
          values.length <= MAX_SKILLS &&
          values.every((value) => validSearchKey(value)),
        message: "skillKeys must contain normalized, bounded search values.",
      },
    },
    generalLocationKey: {
      type: String,
      default: "",
      set: normalizeSearchValue,
      validate: { validator: (value: unknown) => validSearchKey(value) },
    },
    cohortKeys: {
      type: [String],
      required: true,
      default: [],
      set: normalizeSearchArray,
      validate: {
        validator: (values: unknown) =>
          Array.isArray(values) &&
          values.length <= MAX_COHORT_KEYS &&
          values.every((value) => validSearchKey(value)),
        message: "cohortKeys must contain normalized, bounded search values.",
      },
    },
  },
  { _id: false, strict: "throw", minimize: false },
);

const alumniProfileSchema = new Schema<IAlumniProfile>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    professionalHeadline: {
      type: String,
      default: null,
      set: normalizedNullableDisplayText,
      validate: {
        validator: (value: unknown) =>
          value == null ||
          isValidDisplayText(value, 1, MAX_HEADLINE_CODE_POINTS),
        message: "Professional headline must be 1-160 characters on one line.",
      },
    },
    industry: {
      type: String,
      default: null,
      set: normalizedNullableDisplayText,
      validate: {
        validator: (value: unknown) =>
          value == null ||
          isValidDisplayText(value, 1, MAX_INDUSTRY_CODE_POINTS),
        message: "Industry must be 1-100 characters on one line.",
      },
    },
    skills: {
      type: [String],
      required: true,
      default: [],
      set: normalizeDisplayTextArray,
      validate: {
        validator: (values: unknown) =>
          Array.isArray(values) &&
          values.length <= MAX_SKILLS &&
          values.every((value) =>
            isValidDisplayText(value, 1, MAX_SKILL_CODE_POINTS),
          ),
        message: "Skills must contain at most 20 values of 1-80 characters.",
      },
    },
    bio: {
      type: String,
      default: null,
      set: normalizedNullableDisplayText,
      validate: {
        validator: (value: unknown) =>
          value == null || isValidDisplayText(value, 1, MAX_BIO_CODE_POINTS),
        message: "Bio must be 1-2000 characters.",
      },
    },
    helpOfferings: {
      type: helpOfferingsSchema,
      required: true,
      default: () => ({}),
    },
    publishStatus: {
      type: String,
      enum: ALUMNI_PROFILE_PUBLISH_STATUSES,
      required: true,
      default: "draft",
    },
    currentPublicationConsentId: {
      type: Schema.Types.ObjectId,
      ref: "ConsentRecord",
    },
    searchProjection: {
      type: searchProjectionSchema,
      required: true,
      default: () => ({}),
      select: false,
    },
    publishedAt: { type: Date, default: null },
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
        message: "AlumniProfile revision must be a non-negative safe integer.",
      },
    },
  },
  {
    collection: ALUMNI_PROFILE_COLLECTION,
    timestamps: true,
    strict: "throw",
    minimize: false,
    versionKey: false,
  },
);

alumniProfileSchema.pre("validate", function enforceProfileInvariants(next) {
  const projectionSourceFields = [
    "professionalHeadline",
    "industry",
    "skills",
    "bio",
  ];
  if (
    !this.isNew &&
    (projectionSourceFields.some((path) => this.isModified(path)) ||
      (this.isModified("publishStatus") && this.publishStatus === "published")) &&
    !this.isSelected("searchProjection")
  ) {
    this.invalidate(
      "searchProjection",
      "Profile search-source changes must explicitly load and rebuild searchProjection.",
    );
  }

  if (this.publishStatus === "published") {
    if (!this.publishedAt) {
      this.invalidate("publishedAt", "Published profiles require publishedAt.");
    }
    if (!this.currentPublicationConsentId) {
      this.invalidate(
        "currentPublicationConsentId",
        "Published profiles require a current publication consent.",
      );
    }
    if (this.withdrawnAt) {
      this.invalidate("withdrawnAt", "Published profiles cannot be withdrawn.");
    }
  } else if (this.currentPublicationConsentId) {
    this.invalidate(
      "currentPublicationConsentId",
      "Only published profiles may reference current publication consent.",
    );
  }

  if (this.publishStatus === "withdrawn" && !this.withdrawnAt) {
    this.invalidate("withdrawnAt", "Withdrawn profiles require withdrawnAt.");
  }
  if (this.publishStatus !== "withdrawn" && this.withdrawnAt) {
    this.invalidate("withdrawnAt", "Only withdrawn profiles may set withdrawnAt.");
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
      "AlumniProfile purgeAt must be within 30 days after account deletion approval.",
    );
  }
  if (hasDeletionSchedule && this.publishStatus === "published") {
    this.invalidate(
      "publishStatus",
      "A profile scheduled for account deletion cannot remain published.",
    );
  }

  next();
});

alumniProfileSchema.index(
  { userId: 1 },
  { unique: true, name: "uniq_alumni_profile_user" },
);
alumniProfileSchema.index(
  { publishStatus: 1, "searchProjection.displayNameKey": 1, _id: 1 },
  { name: "idx_alumni_profile_directory" },
);
alumniProfileSchema.index(
  { "searchProjection.searchText": "text" },
  { name: "text_alumni_profile_search" },
);
alumniProfileSchema.index(
  { purgeAt: 1 },
  { expireAfterSeconds: 0, name: "ttl_alumni_profile_purge_at" },
);

function removeInternalProfileFields(
  _document: unknown,
  value: IAlumniProfile & { _id?: unknown; __v?: number },
) {
  const mutable = value as unknown as Record<string, unknown>;
  if (mutable._id) mutable.id = mutable._id;
  delete mutable._id;
  delete mutable.searchProjection;
  delete mutable.currentPublicationConsentId;
  delete mutable.accountDeletionApprovedAt;
  delete mutable.purgeAt;
  delete mutable.revision;
  delete mutable.__v;
  return mutable;
}

alumniProfileSchema.set("toJSON", { transform: removeInternalProfileFields });
alumniProfileSchema.set("toObject", { transform: removeInternalProfileFields });

const AlumniProfile: Model<IAlumniProfile> =
  (mongoose.models.AlumniProfile as Model<IAlumniProfile> | undefined) ||
  mongoose.model<IAlumniProfile>("AlumniProfile", alumniProfileSchema);

export default AlumniProfile;
