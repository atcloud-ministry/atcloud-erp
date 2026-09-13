import { Request, Response } from "express";
import { User } from "../../models";
import AuditLog from "../../models/AuditLog";
import { ROLES, hasPermission, PERMISSIONS } from "../../utils/roleUtils";
import { socketService } from "../../services/infrastructure/SocketService";
import { AutoEmailNotificationService } from "../../services/infrastructure/autoEmailNotificationService";
import { EmailService } from "../../services/infrastructure/EmailServiceFacade";
import { CachePatterns } from "../../services/infrastructure/CacheService";
import { programMembershipMutationSyncTrigger } from "../../services/programs/ProgramMembershipMutationSyncTrigger";

/**
 * UserReactivationController
 * Handles reactivateUser - reactivating deactivated user accounts
 */
export default class UserReactivationController {
  /**
   * Reactivate user (admin only)
   */
  static async reactivateUser(req: Request, res: Response): Promise<void> {
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
          message: "Insufficient permissions to reactivate users.",
        });
        return;
      }

      const targetUser = await User.findById(id);

      if (!targetUser) {
        res.status(404).json({
          success: false,
          message: "User not found.",
        });
        return;
      }

      // Role-based restrictions for reactivation (same as deactivation)
      if (req.user.role === ROLES.LEADER) {
        // Leaders can only reactivate Participants
        if (targetUser.role !== ROLES.PARTICIPANT) {
          res.status(403).json({
            success: false,
            message: "Leaders can only reactivate Participant level users.",
          });
          return;
        }
      } else if (req.user.role === ROLES.ADMINISTRATOR) {
        // Administrators cannot reactivate other Administrators or Super Admins
        if (
          targetUser.role === ROLES.ADMINISTRATOR ||
          targetUser.role === ROLES.SUPER_ADMIN
        ) {
          res.status(403).json({
            success: false,
            message:
              "Administrators cannot reactivate other Administrators or Super Admins.",
          });
          return;
        }
      }

      // Reactivate user
      targetUser.isActive = true;
      await targetUser.save();
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

      // Audit log for user reactivation
      try {
        await AuditLog.create({
          action: "user_reactivation",
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
          "Failed to create audit log for user reactivation:",
          auditError
        );
        // Don't fail the request if audit logging fails
      }

      // Invalidate user cache after reactivation
      await CachePatterns.invalidateUserCache(id);

      // Send reactivation email to the target user (no system message by design)
      try {
        const targetUserName =
          `${targetUser.firstName || ""} ${targetUser.lastName || ""}`.trim() ||
          targetUser.username ||
          targetUser.email;

        await EmailService.sendAccountReactivationEmail(
          targetUser.email,
          targetUserName,
          {
            role: req.user.role,
            firstName: req.user.firstName,
            lastName: req.user.lastName,
          }
        );
      } catch (emailError) {
        console.error("Failed to send reactivation email:", emailError);
        // Do not fail the request if email fails
      }

      // Notify admins (email + system message) about the reactivation
      try {
        await AutoEmailNotificationService.sendAccountStatusChangeAdminNotifications(
          {
            action: "reactivated",
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
          "Failed to send admin reactivation notifications:",
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
          isActive: true,
        },
        oldValue: "inactive",
        newValue: "active",
      });

      res.status(200).json({
        success: true,
        message: "User reactivated successfully!",
      });
    } catch (error: unknown) {
      console.error("Reactivate user error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to reactivate user.",
      });
    }
  }
}
