import { Request, Response } from "express";
import { User } from "../../models";
import AuditLog from "../../models/AuditLog";
import {
  RoleUtils,
  ROLES,
  hasPermission,
  PERMISSIONS,
} from "../../utils/roleUtils";
import { socketService } from "../../services/infrastructure/SocketService";
import { AutoEmailNotificationService } from "../../services/infrastructure/autoEmailNotificationService";
import { EmailService } from "../../services/infrastructure/EmailServiceFacade";
import { CachePatterns } from "../../services/infrastructure/CacheService";
import { programMembershipMutationSyncTrigger } from "../../services/programs/ProgramMembershipMutationSyncTrigger";
import { RefreshSessionService } from "../../services/auth/RefreshSessionService";

/**
 * UserDeactivationController
 * Handles deactivateUser - deactivating user accounts with audit trail
 */
export default class UserDeactivationController {
  /**
   * Deactivate user (admin only)
   */
  static async deactivateUser(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      if (!req.user) {
        res.status(401).json({
          success: false,
          message: "Authentication required.",
        });
        return;
      }

      // Check permissions
      if (!hasPermission(req.user.role, PERMISSIONS.DEACTIVATE_USERS)) {
        res.status(403).json({
          success: false,
          message: "Insufficient permissions to deactivate users.",
        });
        return;
      }

      const targetUser = await User.findById(id, "+passwordChangedAt");

      if (!targetUser) {
        res.status(404).json({
          success: false,
          message: "User not found.",
        });
        return;
      }

      // Prevent deactivating own account
      if (String(targetUser._id) === String(req.user._id)) {
        res.status(400).json({
          success: false,
          message: "You cannot deactivate your own account.",
        });
        return;
      }

      // Prevent non-super admins from deactivating super admins
      if (
        targetUser.role === ROLES.SUPER_ADMIN &&
        !RoleUtils.isSuperAdmin(req.user.role)
      ) {
        res.status(403).json({
          success: false,
          message: "You cannot deactivate a Super Admin.",
        });
        return;
      }

      // Role-based restrictions for deactivation
      if (req.user.role === ROLES.LEADER) {
        // Leaders can only deactivate Participants
        if (targetUser.role !== ROLES.PARTICIPANT) {
          res.status(403).json({
            success: false,
            message: "Leaders can only deactivate Participant level users.",
          });
          return;
        }
      } else if (req.user.role === ROLES.ADMINISTRATOR) {
        // Administrators cannot deactivate other Administrators or Super Admins
        if (
          targetUser.role === ROLES.ADMINISTRATOR ||
          targetUser.role === ROLES.SUPER_ADMIN
        ) {
          res.status(403).json({
            success: false,
            message:
              "Administrators cannot deactivate other Administrators or Super Admins.",
          });
          return;
        }
      }

      // Deactivate user
      targetUser.isActive = false;
      const priorSecurityStamp = targetUser.passwordChangedAt?.getTime() ?? 0;
      targetUser.passwordChangedAt = new Date(
        Math.max(Date.now(), priorSecurityStamp + 1_000),
      );
      await targetUser.save();
      await RefreshSessionService.revokeAllForUser(
        String(targetUser._id),
        "account_deactivated",
      );
      programMembershipMutationSyncTrigger.userEligibilityChanged(
        String(targetUser._id),
        {
          actor: {
            type: "user",
            id: String(req.user._id),
            role: req.user.role,
          },
          source: "http",
          correlationId: req.correlationId,
        },
      );

      // Revoke the persisted account's live access before slower side effects.
      socketService.disconnectUser(String(targetUser._id));

      // Audit log for user deactivation
      try {
        await AuditLog.create({
          action: "user_deactivation",
          actor: {
            id: req.user._id,
            role: req.user.role,
            email: req.user.email,
          },
          targetModel: "User",
          targetId: String(targetUser._id),
          details: {
            targetUser: {
              id: targetUser._id,
              email: targetUser.email,
              name:
                `${targetUser.firstName || ""} ${
                  targetUser.lastName || ""
                }`.trim() || targetUser.username,
              role: targetUser.role,
            },
          },
          ipAddress: req.ip,
          userAgent: req.get("user-agent") || "unknown",
        });
      } catch (auditError) {
        console.error(
          "Failed to create audit log for user deactivation:",
          auditError
        );
        // Don't fail the request if audit logging fails
      }

      // Invalidate user cache after deactivation
      await CachePatterns.invalidateUserCache(id);

      // Send deactivation email to the target user (no system message by design)
      try {
        const targetUserName =
          `${targetUser.firstName || ""} ${targetUser.lastName || ""}`.trim() ||
          targetUser.username ||
          targetUser.email;

        await EmailService.sendAccountDeactivationEmail(
          targetUser.email,
          targetUserName,
          {
            role: req.user.role,
            firstName: req.user.firstName,
            lastName: req.user.lastName,
          }
        );
      } catch (emailError) {
        console.error("Failed to send deactivation email:", emailError);
        // Do not fail the request if email fails
      }

      // Notify admins (email + system message) about the deactivation
      try {
        await AutoEmailNotificationService.sendAccountStatusChangeAdminNotifications(
          {
            action: "deactivated",
            targetUser: {
              _id: String(targetUser._id),
              firstName: targetUser.firstName,
              lastName: targetUser.lastName,
              email: targetUser.email,
            },
            actor: {
              _id: String(req.user._id),
              firstName: req.user.firstName,
              lastName: req.user.lastName,
              email: req.user.email,
              role: req.user.role,
              avatar: req.user.avatar,
              gender: req.user.gender,
            },
            createSystemMessage: true,
          }
        );
      } catch (notifyErr) {
        console.error(
          "Failed to send admin deactivation notifications:",
          notifyErr
        );
      }

      // Emit real-time update for Management page
      socketService.emitUserUpdate(String(targetUser._id), {
        type: "status_changed",
        user: {
          id: String(targetUser._id),
          username: targetUser.username,
          email: targetUser.email,
          firstName: targetUser.firstName || undefined,
          lastName: targetUser.lastName || undefined,
          role: targetUser.role,
          isActive: false,
        },
        oldValue: "active",
        newValue: "inactive",
      });

      res.status(200).json({
        success: true,
        message: "User deactivated successfully!",
      });
    } catch (error: unknown) {
      console.error("Deactivate user error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to deactivate user.",
      });
    }
  }
}
