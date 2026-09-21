/**
 * PasswordChangeController
 * Handles authenticated password change operations (request and complete)
 * Extracted from authController.ts
 */

import { Request, Response } from "express";
import { User } from "../../models";
import { EmailService } from "../../services/infrastructure/EmailServiceFacade";
import { CachePatterns } from "../../services/infrastructure/CacheService";
import { UnifiedMessageController } from "../unifiedMessageController";
import { UserDocLike, toIdString } from "./types";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { RefreshSessionService } from "../../services/auth/RefreshSessionService";

export default class PasswordChangeController {
  // Phase 1: Request password change - requires current password and new password
  static async requestPasswordChange(
    req: Request,
    res: Response
  ): Promise<void> {
    try {
      const { currentPassword, newPassword } = req.body;
      const userId = toIdString((req.user as unknown as UserDocLike)._id);

      // Validate required fields
      if (!currentPassword || !newPassword) {
        res.status(400).json({
          success: false,
          message: "Current password and new password are required.",
        });
        return;
      }

      // Validate new password strength
      if (newPassword.length < 8) {
        res.status(400).json({
          success: false,
          message: "New password must be at least 8 characters long.",
        });
        return;
      }

      // Find user and verify current password
      const user = await User.findById(userId).select("+password");
      if (!user) {
        res.status(404).json({
          success: false,
          message: "User not found.",
        });
        return;
      }

      // Verify current password
      const isCurrentPasswordValid = await bcrypt.compare(
        currentPassword,
        user.password
      );
      if (!isCurrentPasswordValid) {
        res.status(400).json({
          success: false,
          message: "Current password is incorrect.",
        });
        return;
      }

      // Generate password change token (10 minutes expiry)
      const passwordChangeToken = crypto.randomBytes(32).toString("hex");
      const hashedToken = crypto
        .createHash("sha256")
        .update(passwordChangeToken)
        .digest("hex");

      // Hash the new password for temporary storage
      const hashedNewPassword = await bcrypt.hash(newPassword, 12);

      // Store pending password change
      user.passwordChangeToken = hashedToken;
      user.passwordChangeExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
      user.pendingPassword = hashedNewPassword; // Store hashed new password temporarily
      await user.save({ validateBeforeSave: false });

      // Send password change request trio
      try {
        await EmailService.sendPasswordChangeRequestEmail(
          user.email,
          user.firstName || user.username,
          passwordChangeToken
        );

        await UnifiedMessageController.createTargetedSystemMessage(
          {
            title: "Password Change Request",
            content: `A password change was requested for your account. Please check your email to confirm this change. This request expires in 10 minutes.`,
            // Use a valid type in the Message schema
            type: "warning",
            priority: "high",
            hideCreator: true,
          },
          [userId.toString()],
          {
            id: "system",
            firstName: "System",
            lastName: "",
            username: "system",
            // Use valid values per schema to avoid validation failures
            gender: "male",
            authLevel: "Super Admin",
            avatar: "",
          }
        );
      } catch (error) {
        console.error("Password change request notification failed", {
          userId,
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
      }

      res.status(200).json({
        success: true,
        message:
          "Password change request sent. Please check your email to confirm.",
      });
    } catch (error: unknown) {
      console.error("Password change request failed", {
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      res.status(500).json({
        success: false,
        message: "Password change request failed.",
      });
    }
  }

  // Phase 2: Complete password change - verify token and apply new password
  static async completePasswordChange(
    req: Request,
    res: Response
  ): Promise<void> {
    try {
      const { token } = req.params;

      if (!token) {
        res.status(400).json({
          success: false,
          message: "Password change token is required.",
        });
        return;
      }

      // Hash the provided token to match stored hash
      const hashedToken = crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");

      // Find user with valid password change token
      const user = await User.findOne({
        passwordChangeToken: hashedToken,
        passwordChangeExpires: { $gt: Date.now() },
      }).select("+pendingPassword");

      if (!user) {
        res.status(400).json({
          success: false,
          message: "Password change token is invalid or has expired.",
        });
        return;
      }

      if (!user.pendingPassword) {
        res.status(400).json({
          success: false,
          message: "No pending password change found.",
        });
        return;
      }

      // Apply the new password using direct update to avoid double hashing
      // The pendingPassword is already hashed, so we update directly without triggering pre-save hooks
      const changedAt = new Date();
      const updateResult = await User.updateOne(
        {
          _id: user._id,
          passwordChangeToken: hashedToken,
          passwordChangeExpires: { $gt: changedAt },
        },
        {
          $set: {
            password: user.pendingPassword,
            passwordChangedAt: changedAt,
          },
          $unset: {
            passwordChangeToken: 1,
            passwordChangeExpires: 1,
            pendingPassword: 1,
          },
        }
      );
      if (updateResult.modifiedCount !== 1) {
        res.status(400).json({
          success: false,
          message: "Password change token is invalid or has expired.",
        });
        return;
      }

      try {
        await RefreshSessionService.revokeAllForUser(
          toIdString(user._id),
          "password_changed",
        );
      } catch (error: unknown) {
        // The CAS wrote passwordChangedAt with the password, so all prior JWTs
        // remain rejected even if defense-in-depth session cleanup is delayed.
        console.warn("Refresh session revocation after password change failed", {
          userId: toIdString(user._id),
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
      }

      // Invalidate user cache after password update
      await CachePatterns.invalidateUserCache(toIdString(user._id));

      // Send password change success trio
      try {
        await EmailService.sendPasswordResetSuccessEmail(
          user.email,
          user.firstName || user.username
        );

        await UnifiedMessageController.createTargetedSystemMessage(
          {
            title: "Password Changed Successfully",
            content: `Your account password was changed successfully on ${new Date().toLocaleString()}. If you didn't make this change, please contact support immediately.`,
            // Use a valid type in the Message schema
            type: "update",
            priority: "medium",
            hideCreator: true,
          },
          [toIdString(user._id)],
          {
            id: "system",
            firstName: "System",
            lastName: "",
            username: "system",
            gender: "male",
            authLevel: "Super Admin",
            avatar: "",
          }
        );
      } catch (error) {
        console.error("Password change success notification failed", {
          userId: toIdString(user._id),
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
      }

      res.status(200).json({
        success: true,
        message: "Password changed successfully!",
      });
    } catch (error: unknown) {
      console.error("Password change completion failed", {
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      res.status(500).json({
        success: false,
        message: "Password change completion failed.",
      });
    }
  }
}
