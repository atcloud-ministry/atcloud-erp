/**
 * EmailVerificationController
 * Handles email verification and resend verification operations
 * Extracted from authController.ts
 */

import { Request, Response } from "express";
import { User } from "../../models";
import { EmailService } from "../../services/infrastructure/EmailServiceFacade";
import { CachePatterns } from "../../services/infrastructure/CacheService";
import GuestMigrationService from "../../services/GuestMigrationService";
import { createLogger } from "../../services/LoggerService";
import { UserDocLike, LoggerLike, toIdString } from "./types";
import { programMembershipMutationSyncTrigger } from "../../services/programs/ProgramMembershipMutationSyncTrigger";

export default class EmailVerificationController {
  static async verifyEmail(req: Request, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(400).json({
          success: false,
          message: "Invalid verification token.",
          errorType: "invalid_token",
        });
        return;
      }

      const user = req.user as unknown as UserDocLike;

      // Check if already verified
      if (user.isVerified) {
        res.status(200).json({
          success: true,
          message: "Email is already verified.",
          alreadyVerified: true,
        });
        return;
      }

      // Mark as verified and clear verification token
      user.isVerified = true;
      user.emailVerificationToken = undefined;
      user.emailVerificationExpires = undefined;

      await user.save();
      programMembershipMutationSyncTrigger.userEligibilityChanged(
        toIdString(user._id),
        {
          actor: {
            type: "user",
            id: toIdString(user._id),
            role: user.role ?? "Participant",
          },
          source: "http",
          correlationId: req.correlationId,
        },
      );

      // Invalidate user cache after email verification
      await CachePatterns.invalidateUserCache(toIdString(user._id));

      // Send welcome email
      await EmailService.sendWelcomeEmail(
        user.email,
        (user.firstName || user.username || "User") as string
      );

      // Attempt to migrate any pending guest registrations for this verified user
      // Auto-enabled by default outside of tests. Set ENABLE_GUEST_AUTO_MIGRATION=false to disable.
      let migrationSummary:
        | { modified: number; remainingPending: number }
        | undefined;
      const autoMigrateEnabled =
        process.env.ENABLE_GUEST_AUTO_MIGRATION !== "false" &&
        (process.env.NODE_ENV !== "test" ||
          process.env.VITEST_SCOPE === "integration");
      if (autoMigrateEnabled) {
        try {
          const log: LoggerLike =
            createLogger && typeof createLogger === "function"
              ? (createLogger("AuthController") as unknown as LoggerLike)
              : (console as LoggerLike);
          const performResult =
            await GuestMigrationService.performGuestToUserMigration(
              toIdString(user._id),
              user.email
            );
          if (performResult.ok) {
            const remainingEligible =
              await GuestMigrationService.detectGuestRegistrationsByEmail(
                user.email.toLowerCase()
              );
            migrationSummary = {
              modified: performResult.modified,
              remainingPending: remainingEligible.length,
            };
            log.info?.(
              "Guest auto-migration completed after verifyEmail",
              "GuestMigration",
              {
                userId: toIdString(user._id),
                email: user.email.toLowerCase(),
                modified: performResult.modified,
                remainingPending: remainingEligible.length,
              }
            );
          }
        } catch (migrationError: unknown) {
          // Log and continue; do not fail verification
          const log: LoggerLike =
            createLogger && typeof createLogger === "function"
              ? (createLogger("AuthController") as unknown as LoggerLike)
              : (console as LoggerLike);
          log.error(
            "Guest auto-migration failed after verifyEmail",
            migrationError,
            "GuestMigration",
            {
              userId: toIdString(user._id),
              email: user.email.toLowerCase(),
            }
          );
        }
      }

      res.status(200).json({
        success: true,
        message: "Email verified successfully! Welcome to @Cloud Ministry.",
        freshlyVerified: true,
        migration: migrationSummary,
      });
    } catch (error: unknown) {
      console.error("Email verification error:", error);
      res.status(500).json({
        success: false,
        message: "Email verification failed.",
        errorType: "server_error",
      });
    }
  }

  static async resendVerification(req: Request, res: Response): Promise<void> {
    try {
      const { email } = req.body;

      if (!email) {
        res.status(400).json({
          success: false,
          message: "Email address is required.",
        });
        return;
      }

      const user = await User.findOne({
        email: email.toLowerCase(),
        isActive: true,
        isVerified: false,
      });

      if (!user) {
        res.status(404).json({
          success: false,
          message: "User not found or already verified.",
        });
        return;
      }

      // Generate new verification token
      const verificationToken = (
        user as unknown as UserDocLike
      ).generateEmailVerificationToken?.();
      await user.save();

      // Send verification email
      const emailSent = await EmailService.sendVerificationEmail(
        user.email,
        user.firstName || user.username,
        verificationToken
      );

      if (!emailSent) {
        res.status(500).json({
          success: false,
          message: "Failed to send verification email.",
        });
        return;
      }

      res.status(200).json({
        success: true,
        message: "Verification email sent successfully.",
      });
    } catch (error: unknown) {
      console.error("Resend verification error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to resend verification email.",
      });
    }
  }
}
