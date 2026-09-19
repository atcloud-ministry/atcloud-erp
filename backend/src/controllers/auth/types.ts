/**
 * Shared types and helpers for authentication controllers
 * Extracted from authController.ts
 */

import mongoose from "mongoose";
import type {
  EmploymentStatus,
  IsoCountryCode,
} from "@atcloud/shared-time/registration-profile";

// Lightweight helpers to avoid `any` while preserving runtime behavior
export type LoggerLike = {
  error: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
};

export type UserDocLike = {
  _id: mongoose.Types.ObjectId | string;
  username?: string;
  email: string;
  phone?: string;
  birthYear?: number;
  residenceCity?: string;
  residenceRegion?: string | null;
  residenceCountryCode?: IsoCountryCode;
  employmentStatus?: EmploymentStatus;
  firstName?: string;
  lastName?: string;
  gender?: string;
  role?: string;
  isAtCloudLeader?: boolean;
  isVerified?: boolean;
  roleInAtCloud?: string;
  occupation?: string | null;
  company?: string | null;
  weeklyChurch?: string;
  homeAddress?: string;
  churchAddress?: string;
  avatar?: string;
  lastLogin?: Date | string;
  isActive?: boolean;
  // account and security fields used in flows below
  emailVerificationToken?: string;
  emailVerificationExpires?: Date | string;
  password?: string;
  passwordResetToken?: string;
  passwordResetExpires?: Date | string;
  passwordChangedAt?: Date;
  generateEmailVerificationToken: () => string;
  isAccountLocked?: () => boolean;
  comparePassword?: (pwd: string) => Promise<boolean>;
  incrementLoginAttempts?: () => Promise<void>;
  resetLoginAttempts?: () => Promise<void>;
  updateLastLogin?: () => Promise<void>;
  save: () => Promise<void>;
};

// Re-export from shared utility for backwards compatibility
export { toIdString } from "../../utils/idUtils";

// Interface for registration request (matches frontend signUpSchema)
export interface RegisterRequest {
  username: string;
  email: string;
  phone: string;
  birthYear: number | string;
  residenceCity: string;
  residenceRegion: string | null;
  residenceCountryCode: string;
  employmentStatus: EmploymentStatus;
  password: string;
  confirmPassword: string;
  firstName?: string;
  lastName?: string;
  gender?: "male" | "female";
  isAtCloudLeader: boolean;
  roleInAtCloud?: string;
  occupation?: string | null;
  company?: string | null;
  weeklyChurch?: string;
  churchAddress?: string;
  acceptTerms: boolean;
  registrationNoticeVersion: string;
}

// Interface for login request
export interface LoginRequest {
  emailOrUsername: string;
  password: string;
  rememberMe?: boolean;
}
