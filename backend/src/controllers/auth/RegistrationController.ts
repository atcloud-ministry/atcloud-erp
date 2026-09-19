/**
 * RegistrationController
 * Handles new user registration operations
 * Extracted from authController.ts
 */

import { Request, Response } from "express";
import { User } from "../../models";
import { ROLES } from "../../utils/roleUtils";
import { EmailService } from "../../services/infrastructure/EmailServiceFacade";
import { AutoEmailNotificationService } from "../../services/infrastructure/autoEmailNotificationService";
import { CachePatterns } from "../../services/infrastructure/CacheService";
import GuestMigrationService from "../../services/GuestMigrationService";
import { createLogger } from "../../services/LoggerService";
import { createErrorResponse, createSuccessResponse } from "../../types/api";
import { RegisterRequest, UserDocLike, LoggerLike } from "./types";
import {
  validateRegistrationProfile,
  type RegistrationProfileFields,
} from "@atcloud/shared-time/registration-profile";
import { REGISTRATION_PRIVACY_NOTICE } from "../../config/registrationPrivacyNotice";

const REGISTRATION_LOG_CONTEXT = "Registration";

const registrationLogger = createLogger(
  "RegistrationController",
) as unknown as LoggerLike;

function getSafeErrorName(error: unknown): string {
  const candidate =
    error instanceof Error
      ? error.name
      : typeof error === "object" &&
          error !== null &&
          "name" in error &&
          typeof error.name === "string"
        ? error.name
        : "UnknownError";

  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(candidate)
    ? candidate
    : "UnknownError";
}

function logRegistrationEvent(
  level: "info" | "error",
  eventCode: string,
  options: { userId?: string; error?: unknown } = {},
): void {
  const metadata = {
    eventCode,
    ...(options.userId ? { userId: options.userId } : {}),
    ...(level === "error"
      ? { errorName: getSafeErrorName(options.error) }
      : {}),
  };

  if (level === "info") {
    registrationLogger.info?.(
      "Registration event completed",
      REGISTRATION_LOG_CONTEXT,
      metadata,
    );
    return;
  }

  registrationLogger.error(
    "Registration event failed",
    undefined,
    REGISTRATION_LOG_CONTEXT,
    metadata,
  );
}

export default class RegistrationController {
  static notice(_req: Request, res: Response): void {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(
      createSuccessResponse({
        notice: {
          version: REGISTRATION_PRIVACY_NOTICE.version,
          text: REGISTRATION_PRIVACY_NOTICE.text,
          effectiveAt: REGISTRATION_PRIVACY_NOTICE.effectiveAt,
        },
      }),
    );
  }

  static async register(req: Request, res: Response): Promise<void> {
    try {
      const {
        username,
        email,
        phone,
        birthYear,
        residenceCity,
        residenceRegion,
        residenceCountryCode,
        employmentStatus,
        password,
        confirmPassword,
        firstName,
        lastName,
        gender,
        isAtCloudLeader,
        roleInAtCloud,
        occupation,
        company,
        weeklyChurch,
        churchAddress,
        acceptTerms,
        registrationNoticeVersion,
      }: RegisterRequest = req.body;

      // Input validation
      if (acceptTerms !== true) {
        res
          .status(400)
          .json(
            createErrorResponse(
              "You must accept the registration privacy notice to register",
              400
            )
          );
        return;
      }
      if (
        registrationNoticeVersion !== REGISTRATION_PRIVACY_NOTICE.version
      ) {
        res
          .status(409)
          .json(
            createErrorResponse(
              "The registration privacy notice has changed. Review and accept the current notice.",
              409,
            ),
          );
        return;
      }

      if (password !== confirmPassword) {
        res
          .status(400)
          .json(createErrorResponse("Passwords do not match", 400));
        return;
      }

      if (gender !== "male" && gender !== "female") {
        res
          .status(400)
          .json(
            createErrorResponse(
              "Gender must be either 'male' or 'female'",
              400
            )
          );
        return;
      }

      const registrationProfileResult = validateRegistrationProfile({
        phone,
        birthYear,
        residenceCity,
        residenceRegion,
        residenceCountryCode,
        employmentStatus,
        company,
        occupation,
      });
      if (!registrationProfileResult.success) {
        res
          .status(400)
          .json(
            createErrorResponse(
              registrationProfileResult.issues
                .map((issue) => `${issue.field}: ${issue.message}`)
                .join("; "),
              400,
            ),
          );
        return;
      }
      const registrationProfile = registrationProfileResult.value;

      // Check if user already exists
      // Note: Case-insensitive uniqueness is ultimately enforced by the
      // usernameLower unique index in the User model. The router currently
      // normalizes req.body.username to lowercase before validation; even if
      // that normalization were altered, the usernameLower index still prevents
      // duplicates that differ only by case.
      const existingUser = await User.findOne({
        $or: [{ email: email.toLowerCase() }, { username: username }],
      });

      if (existingUser) {
        const message =
          existingUser.email === email.toLowerCase()
            ? "Email address is already registered"
            : "Username is already taken";
        res.status(409).json(createErrorResponse(message, 409));
        return;
      }

      // Validate @Cloud co-worker requirements
      if (isAtCloudLeader && !roleInAtCloud) {
        res
          .status(400)
          .json(
            createErrorResponse(
              "Role in @Cloud is required for @Cloud co-workers",
              400
            )
          );
        return;
      }

      // Create new user
      // Use a typed object so we can set avatar without casting to any
      const userData: {
        username: string;
        email: string;
        phone: string;
        birthYear: number;
        residenceCity: string;
        residenceRegion: string | null;
        residenceCountryCode: RegistrationProfileFields["residenceCountryCode"];
        employmentStatus: RegistrationProfileFields["employmentStatus"];
        password: string;
        firstName?: string;
        lastName?: string;
        gender?: "male" | "female";
        isAtCloudLeader: boolean;
        roleInAtCloud?: string;
        occupation?: string | null;
        company?: string | null;
        weeklyChurch?: string;
        churchAddress?: string;
        role: string;
        isActive: boolean;
        isVerified: boolean;
        loginAttempts: number;
        avatar?: string;
        registrationPrivacyNoticeVersion: string;
        registrationPrivacyNoticeDocumentHash: string;
        registrationPrivacyNoticeAcceptedAt: Date;
      } = {
        username,
        email: email.toLowerCase(),
        phone: registrationProfile.phone,
        birthYear: registrationProfile.birthYear,
        residenceCity: registrationProfile.residenceCity,
        residenceRegion: registrationProfile.residenceRegion,
        residenceCountryCode: registrationProfile.residenceCountryCode,
        employmentStatus: registrationProfile.employmentStatus,
        password,
        firstName,
        lastName,
        gender,
        isAtCloudLeader,
        roleInAtCloud: isAtCloudLeader ? roleInAtCloud : undefined,
        occupation: registrationProfile.occupation,
        company: registrationProfile.company,
        weeklyChurch,
        churchAddress,
        role: ROLES.PARTICIPANT, // Default role
        isActive: true,
        isVerified: false, // Will be verified via email
        loginAttempts: 0,
        registrationPrivacyNoticeVersion: REGISTRATION_PRIVACY_NOTICE.version,
        registrationPrivacyNoticeDocumentHash:
          REGISTRATION_PRIVACY_NOTICE.documentHash,
        registrationPrivacyNoticeAcceptedAt: new Date(),
      };

      // Set default avatar based on gender
      if (gender === "female") {
        userData.avatar = "/default-avatar-female.jpg";
      } else if (gender === "male") {
        userData.avatar = "/default-avatar-male.jpg";
      }

      const user = new User(userData);

      // Generate email verification token
      const verificationToken = (
        user as unknown as UserDocLike
      ).generateEmailVerificationToken?.();

      await user.save();

      // Send @Cloud role admin notifications if user signed up as @Cloud co-worker
      if (isAtCloudLeader) {
        try {
          await AutoEmailNotificationService.sendAtCloudRoleChangeNotification({
            userData: {
              _id: String((user as unknown as UserDocLike)._id),
              firstName: user.firstName || user.username,
              lastName: user.lastName || "",
              email: user.email,
              roleInAtCloud: user.roleInAtCloud,
            },
            changeType: "signup",
            systemUser: {
              firstName: "System",
              lastName: "Registration",
              email: "system@church.com",
              role: "System",
            },
          });
          logRegistrationEvent("info", "REGISTRATION_ADMIN_NOTIFICATION_SENT", {
            userId: String((user as unknown as UserDocLike)._id),
          });
        } catch (notificationError) {
          logRegistrationEvent(
            "error",
            "REGISTRATION_ADMIN_NOTIFICATION_FAILED",
            {
              userId: String((user as unknown as UserDocLike)._id),
              error: notificationError,
            },
          );
          // Don't fail the registration if notification fails
        }
      }

      // Send verification email
      const emailSent = await EmailService.sendVerificationEmail(
        user.email,
        user.firstName || user.username,
        verificationToken || ""
      );

      if (!emailSent) {
        logRegistrationEvent(
          "error",
          "REGISTRATION_VERIFICATION_EMAIL_NOT_SENT",
          {
            userId: String((user as unknown as UserDocLike)._id),
            error: { name: "VerificationEmailNotSent" },
          },
        );
      }

      // Note: No system message or bell notification needed here since
      // unverified users cannot log in to see them. Email verification is sufficient.

      const u = user as unknown as UserDocLike;
      const responseData = {
        user: {
          id: u._id,
          username: u.username,
          email: u.email,
          firstName: u.firstName,
          lastName: u.lastName,
          role: u.role,
          isAtCloudLeader: u.isAtCloudLeader,
          isVerified: u.isVerified,
        },
      };

      // Invalidate user-related caches after successful registration
      await CachePatterns.invalidateUserCache(
        String((user as unknown as UserDocLike)._id)
      );

      // Auto-migrate guest registrations immediately on signup (optional via env)
      // ENABLE_GUEST_AUTO_MIGRATION=true enables; set to false to disable
      // Skip during unit tests to avoid DB dependencies; allow in integration scope
      const shouldAutoMigrateOnRegister =
        process.env.ENABLE_GUEST_AUTO_MIGRATION !== "false" &&
        (process.env.NODE_ENV !== "test" ||
          process.env.VITEST_SCOPE === "integration");
      if (shouldAutoMigrateOnRegister) {
        try {
          await GuestMigrationService.performGuestToUserMigration(
            String((user as unknown as UserDocLike)._id),
            user.email
          );
        } catch (e) {
          // Non-fatal: don't block signup
          logRegistrationEvent(
            "error",
            "REGISTRATION_GUEST_MIGRATION_FAILED",
            {
              userId: String((user as unknown as UserDocLike)._id),
              error: e,
            },
          );
        }
      }

      res
        .status(201)
        .json(
          createSuccessResponse(
            responseData,
            "Registration successful! Please check your email to verify your account"
          )
        );
    } catch (error) {
      logRegistrationEvent("error", "REGISTRATION_FAILED", { error });

      const dup = error as {
        code?: number;
        keyPattern?: Record<string, unknown>;
      };
      if (dup?.code === 11000) {
        // Duplicate key error
        const field = dup.keyPattern ? Object.keys(dup.keyPattern)[0] : "Field";
        res
          .status(409)
          .json(createErrorResponse(`${field} is already registered`, 409));
        return;
      }

      const valErr = error as {
        name?: string;
        errors?: Record<string, { message?: string }>;
      };
      if (valErr?.name === "ValidationError" && valErr.errors) {
        // Extract detailed field-level error messages from Mongoose ValidationError
        const fieldErrors = Object.entries(valErr.errors)
          .map(([field, err]) => `${field}: ${err.message || "Invalid value"}`)
          .join("; ");
        res
          .status(400)
          .json(createErrorResponse(fieldErrors || "Validation failed", 400));
        return;
      }
      if (valErr?.name === "ValidationError") {
        res.status(400).json(createErrorResponse("Validation failed", 400));
        return;
      }

      res
        .status(500)
        .json(createErrorResponse("Registration failed. Please try again"));
    }
  }
}
