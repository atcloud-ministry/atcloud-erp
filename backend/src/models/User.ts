import mongoose, { Schema, Document } from "mongoose";
import bcrypt from "bcryptjs";
import {
  EMPLOYMENT_STATUSES,
  ISO_COUNTRY_CODES,
  employmentRequiresCompany,
  isBirthYear,
  isE164Phone,
  isEmploymentStatus,
  isIsoSubdivisionCode,
  isValidDisplayText,
  normalizeCountryCode,
  normalizeDisplayText,
  normalizeNullableDisplayText,
  normalizeSubdivisionCode,
  type EmploymentStatus,
  type IsoCountryCode,
} from "@atcloud/shared-time/registration-profile";
import { ROLES, UserRole, RoleUtils } from "../utils/roleUtils";

export interface IUser extends Document {
  // Basic Authentication
  username: string;
  usernameLower?: string;
  email: string;
  phone?: string;
  password: string;

  // Profile Information (matches frontend signUpSchema)
  firstName?: string;
  lastName?: string;
  gender?: "male" | "female";
  avatar?: string;

  // Registration / KPI Information
  birthYear?: number;
  residenceCity?: string;
  residenceRegion?: string | null;
  residenceCountryCode?: IsoCountryCode;
  employmentStatus?: EmploymentStatus;

  // Legacy Address Information
  homeAddress?: string;

  // @Cloud Ministry Specific Fields
  isAtCloudLeader: boolean;
  roleInAtCloud?: string; // Required if isAtCloudLeader is true

  // Professional Information
  occupation?: string | null;
  company?: string | null;
  weeklyChurch?: string;
  churchAddress?: string;

  // System Authorization (matches frontend role system)
  role: UserRole; // "Super Admin" | "Administrator" | "Leader" | "Guest Expert" | "Participant"

  // Account Status
  isActive: boolean;
  isVerified: boolean;
  emailNotifications: boolean;

  // Verification & Security
  emailVerificationToken?: string;
  emailVerificationExpires?: Date;
  passwordResetToken?: string;
  passwordResetExpires?: Date;
  passwordChangeToken?: string;
  passwordChangeExpires?: Date;
  pendingPassword?: string;
  passwordChangedAt?: Date;

  // Login Tracking
  lastLogin?: Date;
  loginAttempts: number;
  lockUntil?: Date;
  hasReceivedWelcomeMessage: boolean; // Track if user has received welcome message

  // Timestamps
  createdAt: Date;
  updatedAt: Date;

  // Methods
  comparePassword(candidatePassword: string): Promise<boolean>;
  generateEmailVerificationToken(): string;
  generatePasswordResetToken(): string;
  incrementLoginAttempts(): Promise<void>;
  resetLoginAttempts(): Promise<void>;
  isAccountLocked(): boolean;
  canChangeRole(newRole: UserRole, changedBy: IUser): boolean;
  getFullName(): string;
  getDisplayName(): string;
  updateLastLogin(): Promise<void>;
}

const userSchema: Schema = new Schema(
  {
    // Basic Authentication
    username: {
      type: String,
      required: [true, "Username is required"],
      unique: true,
      trim: true,
      minlength: [3, "Username must be at least 3 characters long"],
      maxlength: [20, "Username cannot exceed 20 characters"],
      validate: {
        validator: function (value: string) {
          if (!value) return false;
          // Option C rules:
          // - lowercase only [a-z0-9_]
          // - 3-20 chars
          // - start with a letter
          // - end with letter/number (no trailing underscore)
          // - no consecutive underscores
          const re = /^(?!.*__)[a-z][a-z0-9_]{1,18}[a-z0-9]$/;
          return re.test(value);
        },
        message:
          "Username must be 3-20 chars, lowercase letters/numbers/underscore, start with a letter, no consecutive or edge underscores",
      },
    },
    // Shadow field for case-insensitive uniqueness
    usernameLower: {
      type: String,
      select: false,
    },
    email: {
      type: String,
      required: [true, "Email address is required"],
      unique: true,
      trim: true,
      lowercase: true,
      match: [
        /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/,
        "Please provide a valid email address",
      ],
    },
    phone: {
      type: String,
      trim: true,
      required: [
        function (this: IUser) {
          return this.employmentStatus !== undefined;
        },
        "Phone number is required for a complete registration profile",
      ],
      maxlength: [20, "Phone number cannot exceed 20 characters"],
      validate: {
        validator: function (this: IUser, value: string) {
          if (!value || value === "") return true; // Allow empty string
          if (this.employmentStatus !== undefined) {
            return isE164Phone(value);
          }
          // More flexible phone validation - allow various formats
          const cleanPhone = value.replace(/[\s()+-]/g, "");
          return /^\d{7,15}$/.test(cleanPhone);
        },
        message:
          "Please provide a valid phone number; complete profiles require E.164 format",
      },
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [8, "Password must be at least 8 characters long"],
      select: false, // Don't include password in queries by default
      validate: {
        validator: function (password: string) {
          // Password must contain at least one uppercase, one lowercase, one number
          return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/.test(password);
        },
        message:
          "Password must contain at least one uppercase letter, one lowercase letter, and one number",
      },
    },

    // Profile Information
    firstName: {
      type: String,
      trim: true,
      maxlength: [50, "First name cannot exceed 50 characters"],
    },
    lastName: {
      type: String,
      trim: true,
      maxlength: [50, "Last name cannot exceed 50 characters"],
    },
    gender: {
      type: String,
      enum: ["male", "female"],
    },
    avatar: {
      type: String,
      default: "/default-avatar-male.jpg", // Default fallback
    },

    // @Cloud Ministry Specific Fields
    isAtCloudLeader: {
      type: Boolean,
      default: false,
    },
    roleInAtCloud: {
      type: String,
      trim: true,
      maxlength: [100, "Role in @Cloud cannot exceed 100 characters"],
      validate: {
        validator: function (value: string) {
          // roleInAtCloud is required if isAtCloudLeader is true
          if (this.isAtCloudLeader && !value) {
            return false;
          }
          return true;
        },
        message: "Role in @Cloud is required for @Cloud co-workers",
      },
    },

    // Registration / KPI Information. Fields remain optional at schema level
    // until a profile is completed so existing accounts can be backfilled.
    birthYear: {
      type: Schema.Types.Int32,
      select: false,
      required: [
        function (this: IUser) {
          return this.employmentStatus !== undefined;
        },
        "Birth year is required for a complete registration profile",
      ],
      validate: {
        validator: (value: number) => value == null || isBirthYear(value),
        message: "Birth year must be an integer from 1900 to the current UTC year",
      },
    },
    residenceCountryCode: {
      type: String,
      trim: true,
      set: (value: unknown) =>
        typeof value === "string" ? normalizeCountryCode(value) : value,
      enum: {
        values: [...ISO_COUNTRY_CODES],
        message: "Residence country must be an ISO 3166-1 alpha-2 code",
      },
      required: [
        function (this: IUser) {
          return this.employmentStatus !== undefined;
        },
        "Residence country is required for a complete registration profile",
      ],
    },
    residenceRegion: {
      type: String,
      trim: true,
      set: (value: unknown) =>
        typeof value === "string"
          ? normalizeSubdivisionCode(value) || null
          : value,
      required: [
        function (this: IUser) {
          return this.residenceCountryCode === "US";
        },
        "Residence region is required for US residences",
      ],
      validate: {
        validator: function (this: IUser, value: string | null | undefined) {
          return (
            value == null ||
            isIsoSubdivisionCode(value, this.residenceCountryCode)
          );
        },
        message: "Residence region must match the selected country",
      },
    },
    residenceCity: {
      type: String,
      set: (value: unknown) =>
        typeof value === "string" ? normalizeDisplayText(value) : value,
      required: [
        function (this: IUser) {
          return this.employmentStatus !== undefined;
        },
        "Residence city is required for a complete registration profile",
      ],
      validate: {
        validator: (value: string | null | undefined) =>
          value == null || isValidDisplayText(value),
        message: "Residence city must be 1-100 characters on one line",
      },
    },
    employmentStatus: {
      type: String,
      enum: {
        values: [...EMPLOYMENT_STATUSES],
        message: "Employment status is invalid",
      },
      validate: {
        validator: (value: unknown) =>
          value === undefined || isEmploymentStatus(value),
        message: "Employment status is invalid",
      },
    },

    // Professional Information
    occupation: {
      type: String,
      set: (value: unknown) =>
        typeof value === "string" ? normalizeNullableDisplayText(value) : value,
      validate: {
        validator: (value: string | null | undefined) =>
          value == null || isValidDisplayText(value),
        message: "Occupation cannot exceed 100 characters and must be on one line",
      },
    },
    company: {
      type: String,
      set: (value: unknown) =>
        typeof value === "string" ? normalizeNullableDisplayText(value) : value,
      required: [
        function (this: IUser) {
          return (
            this.employmentStatus !== undefined &&
            employmentRequiresCompany(this.employmentStatus)
          );
        },
        "Company is required when employed or self-employed",
      ],
      validate: {
        validator: (value: string | null | undefined) =>
          value == null || isValidDisplayText(value),
        message: "Company cannot exceed 100 characters and must be on one line",
      },
    },
    weeklyChurch: {
      type: String,
      trim: true,
      maxlength: [100, "Weekly church cannot exceed 100 characters"],
    },
    churchAddress: {
      type: String,
      trim: true,
      maxlength: [200, "Church address cannot exceed 200 characters"],
    },

    // Address Information
    homeAddress: {
      type: String,
      trim: true,
      maxlength: [200, "Home address cannot exceed 200 characters"],
    },

    // System Authorization
    role: {
      type: String,
      enum: Object.values(ROLES),
      default: ROLES.PARTICIPANT,
      required: [true, "User role is required"],
    },

    // Account Status
    isActive: {
      type: Boolean,
      default: true,
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    emailNotifications: {
      type: Boolean,
      default: true, // Users opt-in to email notifications by default
    },

    // Verification & Security
    emailVerificationToken: {
      type: String,
      select: false,
    },
    emailVerificationExpires: {
      type: Date,
      select: false,
    },
    passwordResetToken: {
      type: String,
      select: false,
    },
    passwordResetExpires: {
      type: Date,
      select: false,
    },
    passwordChangeToken: {
      type: String,
      select: false,
    },
    passwordChangeExpires: {
      type: Date,
      select: false,
    },
    pendingPassword: {
      type: String,
      select: false,
    },
    passwordChangedAt: {
      type: Date,
      select: false,
    },

    // Login Tracking
    lastLogin: {
      type: Date,
    },
    loginAttempts: {
      type: Number,
      default: 0,
    },
    lockUntil: {
      type: Date,
    },
    hasReceivedWelcomeMessage: {
      type: Boolean,
      default: false, // New users haven't received welcome message yet
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: function (_doc: unknown, ret: Record<string, unknown>) {
        const r = ret as Record<string, unknown> & {
          _id?: unknown;
          __v?: unknown;
          password?: unknown;
          emailVerificationToken?: unknown;
          emailVerificationExpires?: unknown;
          passwordResetToken?: unknown;
          passwordResetExpires?: unknown;
        };
        r.id = r._id as unknown as string;
        delete r._id;
        delete r.__v;
        delete r.password;
        delete r.emailVerificationToken;
        delete r.emailVerificationExpires;
        delete r.passwordResetToken;
        delete r.passwordResetExpires;
        return r;
      },
    },
  },
);

// Indexes for performance (email and username already have unique indexes from schema)
userSchema.index({ role: 1 });
userSchema.index({ isActive: 1 });
userSchema.index({ isVerified: 1 });
userSchema.index({ emailNotifications: 1 });
userSchema.index({ isAtCloudLeader: 1 });
userSchema.index({ createdAt: -1 });
// Support analytics queries over recent activity
userSchema.index({ lastLogin: -1 });
// Analytics: group/filter by weeklyChurch in user analytics
userSchema.index({ weeklyChurch: 1 });

// Compound indexes
userSchema.index({ isActive: 1, isVerified: 1 });
userSchema.index({ isActive: 1, isVerified: 1, emailNotifications: 1 });
userSchema.index({ role: 1, isActive: 1 });
userSchema.index({ isAtCloudLeader: 1, role: 1 });
// Active users sorted by recent activity (analytics overview)
userSchema.index({ isActive: 1, lastLogin: -1 });
// Case-insensitive unique username via shadow field
userSchema.index({ usernameLower: 1 }, { unique: true });
// Compound indexes aligned with analytics queries
userSchema.index({ isActive: 1, weeklyChurch: 1 });

// Text search index
userSchema.index({
  username: "text",
  firstName: "text",
  lastName: "text",
  email: "text",
  occupation: "text",
  company: "text",
});

// Virtual for account locked status
userSchema.virtual("isLocked").get(function (this: IUser) {
  return !!(this.lockUntil && this.lockUntil.getTime() > Date.now());
});

// Pre-save middleware to hash password
userSchema.pre<IUser>("save", async function (next) {
  // Only hash password if it's modified
  if (!this.isModified("password")) return next();

  try {
    // Hash password with cost of 12 (avoid separate genSalt to play nice with test mocks)
    this.password = await bcrypt.hash(this.password, 12);
    next();
  } catch (error: unknown) {
    next(error as Error);
  }
});

// Pre-validate/Pre-save to maintain usernameLower shadow field
userSchema.pre<IUser>("validate", function (next) {
  if (this.username) {
    // enforce lowercase in canonical field expectations
    // The UI/backend validation already enforces lowercase; this is a safeguard for programmatic inserts
    this.usernameLower = this.username.toLowerCase();
  }
  next();
});

// Once employment status is explicit, company has one canonical meaning.
// Legacy records without employmentStatus retain their current company value.
userSchema.pre<IUser>("validate", function (next) {
  if (
    isEmploymentStatus(this.employmentStatus) &&
    !employmentRequiresCompany(this.employmentStatus)
  ) {
    this.company = null;
  }
  next();
});

// Pre-save middleware for @Cloud co-worker validation
userSchema.pre<IUser>("save", function (next) {
  // If user is not an @Cloud co-worker, clear the roleInAtCloud field
  if (!this.isAtCloudLeader) {
    this.roleInAtCloud = undefined;
  }
  next();
});

// Compare password method
userSchema.methods.comparePassword = async function (
  candidatePassword: string,
): Promise<boolean> {
  const stored = this.password as string | undefined;
  if (!stored) {
    throw new Error("Password comparison failed");
  }
  try {
    // Dynamic import ensures we use the same module instance Vitest spies patch
    const mod = (await import("bcryptjs")) as
      | { default: typeof bcrypt }
      | typeof bcrypt;
    const bcryptLike: {
      compare: (data: string, encrypted: string) => Promise<boolean>;
    } =
      "default" in (mod as object)
        ? (mod as { default: typeof bcrypt }).default
        : (mod as typeof bcrypt);
    const isMatch = await bcryptLike.compare(
      candidatePassword,
      stored as string,
    );
    return !!isMatch;
  } catch {
    // On bcrypt failure, surface a consistent error (tests expect rejection)
    throw new Error("Password comparison failed");
  }
};

// Generate email verification token
userSchema.methods.generateEmailVerificationToken = function (): string {
  // Use dynamic import to avoid require style (ESM compatibility & lint rule)
  const crypto: typeof import("crypto") = require("crypto"); // eslint-disable-line @typescript-eslint/no-require-imports
  const resetToken = crypto.randomBytes(32).toString("hex");

  this.emailVerificationToken = crypto
    .createHash("sha256")
    .update(resetToken)
    .digest("hex");

  this.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  return resetToken;
};

// Generate password reset token
userSchema.methods.generatePasswordResetToken = function (): string {
  const crypto: typeof import("crypto") = require("crypto"); // eslint-disable-line @typescript-eslint/no-require-imports
  const resetToken = crypto.randomBytes(32).toString("hex");

  this.passwordResetToken = crypto
    .createHash("sha256")
    .update(resetToken)
    .digest("hex");

  this.passwordResetExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  return resetToken;
};

// Increment login attempts
userSchema.methods.incrementLoginAttempts = async function (): Promise<void> {
  // If we have a previous lock that has expired, restart at 1
  if (this.lockUntil && this.lockUntil < Date.now()) {
    return this.updateOne({
      $unset: { lockUntil: 1 },
      $set: { loginAttempts: 1 },
    });
  }

  const updates: Record<string, unknown> = { $inc: { loginAttempts: 1 } };

  // Lock account after 5 failed attempts for 2 hours
  if (this.loginAttempts + 1 >= 5 && !this.isLocked) {
    updates.$set = { lockUntil: Date.now() + 2 * 60 * 60 * 1000 }; // 2 hours
  }

  return this.updateOne(updates);
};

// Reset login attempts
userSchema.methods.resetLoginAttempts = async function (): Promise<void> {
  return this.updateOne({
    $unset: { loginAttempts: 1, lockUntil: 1 },
  });
};

// Check if account is locked
userSchema.methods.isAccountLocked = function (): boolean {
  return !!(this.lockUntil && this.lockUntil > Date.now());
};

// Check if user can change role
userSchema.methods.canChangeRole = function (
  newRole: UserRole,
  changedBy: IUser,
): boolean {
  return RoleUtils.canPromoteUser(changedBy.role, this.role, newRole);
};

// Get full name
userSchema.methods.getFullName = function (): string {
  if (this.firstName && this.lastName) {
    return `${this.firstName} ${this.lastName}`;
  } else if (this.firstName) {
    return this.firstName;
  } else if (this.lastName) {
    return this.lastName;
  }
  return this.username;
};

// Get display name for UI
userSchema.methods.getDisplayName = function (): string {
  const fullName = this.getFullName();
  return fullName !== this.username ? fullName : `@${this.username}`;
};

// Update last login
userSchema.methods.updateLastLogin = async function (): Promise<void> {
  this.lastLogin = new Date();
  await this.save({ validateBeforeSave: false });
};

// Static method to find user by email or username
userSchema.statics.findByEmailOrUsername = function (identifier: string) {
  const identLower = identifier.toLowerCase();
  return this.findOne({
    $or: [
      { email: identLower },
      { usernameLower: identLower },
      { username: identifier }, // fallback for any legacy data
    ],
    isActive: true,
  });
};

// Legacy notification methods removed - now using unified Message system
// All notification functionality moved to UnifiedMessageController

// Legacy system message methods removed - now using unified Message system
// All system message functionality moved to UnifiedMessageController

// Static method to find user by email or username
userSchema.statics.findByEmailOrUsername = function (identifier: string) {
  const identLower = identifier.toLowerCase();
  return this.findOne({
    $or: [
      { email: identLower },
      { usernameLower: identLower },
      { username: identifier },
    ],
    isActive: true,
  });
};

// Static method to get user statistics
userSchema.statics.getUserStats = async function () {
  const pipeline = [
    {
      $group: {
        _id: "$role",
        count: { $sum: 1 },
        activeCount: {
          $sum: { $cond: [{ $eq: ["$isActive", true] }, 1, 0] },
        },
        verifiedCount: {
          $sum: { $cond: [{ $eq: ["$isVerified", true] }, 1, 0] },
        },
        atCloudLeaderCount: {
          $sum: { $cond: [{ $eq: ["$isAtCloudLeader", true] }, 1, 0] },
        },
      },
    },
  ];

  const stats = await this.aggregate(pipeline);

  return {
    totalUsers: stats.reduce((sum, stat) => sum + stat.count, 0),
    activeUsers: stats.reduce((sum, stat) => sum + stat.activeCount, 0),
    verifiedUsers: stats.reduce((sum, stat) => sum + stat.verifiedCount, 0),
    atCloudLeaders: stats.reduce(
      (sum, stat) => sum + stat.atCloudLeaderCount,
      0,
    ),
    roleDistribution: stats.reduce(
      (acc, stat) => {
        acc[stat._id] = stat.count;
        return acc;
      },
      {} as Record<string, number>,
    ),
  };
};

// Handle model re-compilation in test environments
export default mongoose.models.User ||
  mongoose.model<IUser>("User", userSchema);
