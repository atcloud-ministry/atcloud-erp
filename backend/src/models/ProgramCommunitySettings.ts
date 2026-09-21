import mongoose, { type Document, type Model, Schema } from "mongoose";
import {
  PROGRAM_COMMUNITY_MEMBER_ROLES,
  PROGRAM_COMMUNITY_SETTINGS_LIMITS,
  type ProgramCommunityMemberRole,
} from "../contracts/programCommunitySettings";
import { isNonNegativeSafeInteger } from "../contracts/alumniDirectoryData";

export const PROGRAM_COMMUNITY_SETTINGS_COLLECTION =
  "program_community_settings" as const;

export const PROGRAM_MEMBERSHIP_PROJECTION_STATES = [
  "pending",
  "open",
  "cutoff",
  "archived",
] as const;
export type ProgramMembershipProjectionState =
  (typeof PROGRAM_MEMBERSHIP_PROJECTION_STATES)[number];

export interface ProgramStudentRoleMapping {
  studentRoleId: string;
  memberRole: ProgramCommunityMemberRole;
}

export interface IProgramCommunitySettings extends Document {
  _id: mongoose.Types.ObjectId;
  programId: mongoose.Types.ObjectId;
  enabled: boolean;
  opensAt?: Date | null;
  closesAt?: Date | null;
  archivedAt?: Date | null;
  studentRoleMappings: ProgramStudentRoleMapping[];
  /** Internal generation used only while no committed primary Room exists. */
  membershipFenceRevision: number;
  /** Last Program-community settings revision materialized into Room access. */
  membershipProjectionRevision: number;
  /** Durable repair state used by the bounded membership reconciler. */
  membershipProjectionState: ProgramMembershipProjectionState;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

const studentRoleMappingSchema = new Schema<ProgramStudentRoleMapping>(
  {
    studentRoleId: {
      type: String,
      required: true,
      trim: true,
      maxlength: PROGRAM_COMMUNITY_SETTINGS_LIMITS.studentRoleId,
      match: /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/,
    },
    memberRole: {
      type: String,
      enum: PROGRAM_COMMUNITY_MEMBER_ROLES,
      required: true,
    },
  },
  { _id: false, strict: "throw" },
);

const programCommunitySettingsSchema = new Schema<IProgramCommunitySettings>(
  {
    programId: {
      type: Schema.Types.ObjectId,
      ref: "Program",
      required: true,
      immutable: true,
    },
    enabled: { type: Boolean, required: true, default: false },
    opensAt: { type: Date, default: null },
    closesAt: { type: Date, default: null },
    archivedAt: { type: Date, default: null },
    studentRoleMappings: {
      type: [studentRoleMappingSchema],
      required: true,
      default: [],
      validate: {
        validator: (value: unknown) =>
          Array.isArray(value) &&
          value.length <=
            PROGRAM_COMMUNITY_SETTINGS_LIMITS.studentRoleMappings,
        message: "Program student-role mappings exceed their supported limit.",
      },
    },
    membershipFenceRevision: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: isNonNegativeSafeInteger,
    },
    membershipProjectionRevision: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: isNonNegativeSafeInteger,
    },
    membershipProjectionState: {
      type: String,
      enum: PROGRAM_MEMBERSHIP_PROJECTION_STATES,
      required: true,
      default: "pending",
    },
    revision: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: isNonNegativeSafeInteger,
    },
  },
  {
    collection: PROGRAM_COMMUNITY_SETTINGS_COLLECTION,
    timestamps: true,
    strict: "throw",
    minimize: false,
    versionKey: false,
  },
);

programCommunitySettingsSchema.pre(
  "validate",
  function enforceProgramCommunitySettingsInvariants(next) {
    if (this.enabled && !this.opensAt) {
      this.invalidate(
        "opensAt",
        "An enabled Program community requires opensAt.",
      );
    }
    if (this.enabled && this.archivedAt) {
      this.invalidate(
        "archivedAt",
        "An archived Program community cannot be enabled.",
      );
    }
    if (this.closesAt && !this.opensAt) {
      this.invalidate("opensAt", "closesAt requires opensAt.");
    }
    if (
      this.opensAt &&
      this.closesAt &&
      this.closesAt.getTime() <= this.opensAt.getTime()
    ) {
      this.invalidate("closesAt", "closesAt must be after opensAt.");
    }
    const seen = new Set<string>();
    for (const mapping of this.studentRoleMappings ?? []) {
      if (seen.has(mapping.studentRoleId)) {
        this.invalidate(
          "studentRoleMappings",
          "Each Program student role may be mapped only once.",
        );
        break;
      }
      seen.add(mapping.studentRoleId);
    }
    next();
  },
);

programCommunitySettingsSchema.index(
  { programId: 1 },
  { unique: true, name: "uniq_program_community_settings_program" },
);
programCommunitySettingsSchema.index(
  { enabled: 1, archivedAt: 1, opensAt: 1, closesAt: 1, programId: 1 },
  { name: "idx_program_community_settings_open_scan" },
);
programCommunitySettingsSchema.index(
  { membershipProjectionState: 1, membershipProjectionRevision: 1, _id: 1 },
  { name: "idx_program_community_membership_repair" },
);

const ProgramCommunitySettings: Model<IProgramCommunitySettings> =
  (mongoose.models.ProgramCommunitySettings as
    | Model<IProgramCommunitySettings>
    | undefined) ||
  mongoose.model<IProgramCommunitySettings>(
    "ProgramCommunitySettings",
    programCommunitySettingsSchema,
  );

export default ProgramCommunitySettings;
