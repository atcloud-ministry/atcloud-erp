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
import { UserDocLike, toIdString } from "./types";
import { programMembershipMutationSyncTrigger } from "../../services/programs/ProgramMembershipMutationSyncTrigger";
import { logSafeErrorEvent } from "../../utils/safeEventLogger";

export default class EmailVerificationController {
  static async verifyEmail(req: Request, res: Response): Promise<void> {
    let userId: string | undefined;
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
      userId = toIdString(user._id);

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
          const performResult =
            await GuestMigrationService.performGuestToUserMigration(
              userId,
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
          }
        } catch (migrationError: unknown) {
          // Log and continue; do not fail verification
          logSafeErrorEvent(
            "AUTH_VERIFY_GUEST_MIGRATION_FAILED",
            migrationError,
            userId,
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
      logSafeErrorEvent("AUTH_EMAIL_VERIFICATION_FAILED", error, userId);
      res.status(500).json({
        success: false,
        message: "Email verification failed.",
        errorType: "server_error",
      });
    }
  }

  static async resendVerification(req: Request, res: Response): Promise<void> {
    let userId: string | undefined;
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
      userId = String(user._id);

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
      logSafeErrorEvent("AUTH_VERIFICATION_RESEND_FAILED", error, userId);
      res.status(500).json({
        success: false,
        message: "Failed to resend verification email.",
      });
    }
  }
}
