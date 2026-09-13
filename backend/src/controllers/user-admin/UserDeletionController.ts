import { Request, Response } from "express";
import { User } from "../../models";
import AuditLog from "../../models/AuditLog";
import { ROLES } from "../../utils/roleUtils";
import { AutoEmailNotificationService } from "../../services/infrastructure/autoEmailNotificationService";
import { UnifiedMessageController } from "../unifiedMessageController";
import { CachePatterns } from "../../services/infrastructure/CacheService";
import { formatActorDisplay } from "../../utils/systemMessageFormatUtils";
import { lockService } from "../../services/LockService";
import { ResponseHelper } from "../../utils/responseHelper";
import { socketService } from "../../services/infrastructure/SocketService";
import { programMembershipMutationSyncTrigger } from "../../services/programs/ProgramMembershipMutationSyncTrigger";

/**
 * UserDeletionController
 * Handles deleteUser - permanent user deletion with cascade cleanup (Super Admin only)
 */
export default class UserDeletionController {
  /**
   * Delete user permanently (Super Admin only)
   * WARNING: This permanently removes the user and all associated data
   */
  static async deleteUser(req: Request, res: Response): Promise<void> {
    try {
      const { id: userId } = req.params;
      const currentUser = req.user;

      if (!currentUser) {
        return ResponseHelper.authRequired(res);
      }

      // Only Super Admin can delete users
      if (currentUser.role !== ROLES.SUPER_ADMIN) {
        return ResponseHelper.forbidden(
          res,
          "Only Super Admin can delete users."
        );
      }

      // Check if user exists
      const userToDelete = await User.findById(userId);
      if (!userToDelete) {
        return ResponseHelper.notFound(res, "User not found.");
      }

      // Prevent deletion of other Super Admins
      if (userToDelete.role === ROLES.SUPER_ADMIN) {
        return ResponseHelper.forbidden(
          res,
          "Cannot delete Super Admin users."
        );
      }

      // Prevent self-deletion
      if (userToDelete.id === currentUser.id) {
        return ResponseHelper.forbidden(res, "Cannot delete your own account.");
      }

      // Import UserDeletionService dynamically to avoid circular imports
      const { UserDeletionService } = await import(
        "../../services/UserDeletionService"
      );

      // Perform complete cascading deletion with lock to prevent race conditions
      // Lock key: user-deletion:{userId} ensures per-user serialization
      // Timeout: 10000ms (longer than default) due to complex 18-step deletion process
      const deletionReport = await lockService.withLock(
        `user-deletion:${userId}`,
        async () => {
          return await UserDeletionService.deleteUserCompletely(
            userId,
            currentUser
          );
        },
        10000
      );
      programMembershipMutationSyncTrigger.userEligibilityChanged(userId, {
        actor: {
          type: "user",
          id: String(currentUser._id),
          role: currentUser.role,
        },
        source: "http",
        correlationId: req.correlationId,
      });

      // Revoke the deleted account's live HTTP-adjacent session immediately.
      socketService.disconnectUser(userId);

      // Send targeted admin notifications for user deletion (security best practice)
      try {
        const adminUsers = await User.find({
          role: { $in: ["Administrator", "Super Admin"] },
          isActive: { $ne: false },
        }).select("_id");

        // ✅ UPDATED: Create system message instead of direct bell notification
        // This follows the unified system message-centered architecture
        if (adminUsers.length > 0) {
          const adminUserIds = adminUsers.map((admin) => String(admin._id));

          // Enhance admin message content to include username and full name
          const deletedUserFullName =
            [userToDelete.firstName, userToDelete.lastName]
              .filter(Boolean)
              .join(" ") ||
            userToDelete.username ||
            deletionReport.userEmail;
          const deletedUserUsername = userToDelete.username;

          await UnifiedMessageController.createTargetedSystemMessage(
            {
              title: "User Account Deleted",
              content: `User account ${deletedUserFullName} (@${deletedUserUsername}, ${
                deletionReport.userEmail
              }) was permanently deleted by ${formatActorDisplay(
                currentUser
              )}.`,
              type: "user_management",
              priority: "high",
              hideCreator: true,
            },
            adminUserIds,
            {
              id: String(currentUser._id),
              firstName: currentUser.firstName || "Unknown",
              lastName: currentUser.lastName || "User",
              username: currentUser.email.split("@")[0],
              avatar: currentUser.avatar,
              gender: currentUser.gender || "male",
              authLevel: currentUser.role,
              roleInAtCloud: currentUser.roleInAtCloud || currentUser.role,
            }
          );
        }

        console.log(
          `✅ Sent user deletion notifications to ${adminUsers.length} admins`
        );
      } catch (error) {
        console.error("❌ Failed to send admin deletion notifications:", error);
      }

      // Additionally send admin emails about deletion using unified service
      try {
        await AutoEmailNotificationService.sendAccountStatusChangeAdminNotifications(
          {
            action: "deleted",
            targetUser: {
              _id: String(userToDelete._id),
              firstName: userToDelete.firstName,
              lastName: userToDelete.lastName,
              email: userToDelete.email,
            },
            actor: {
              _id: String(currentUser._id),
              firstName: currentUser.firstName,
              lastName: currentUser.lastName,
              email: currentUser.email,
              role: currentUser.role,
              avatar: currentUser.avatar,
              gender: currentUser.gender,
            },
            createSystemMessage: false, // already created above to avoid duplicates
          }
        );
      } catch (notifyErr) {
        console.error("Failed to send admin deletion emails:", notifyErr);
      }

      console.log(
        `User completely deleted: ${deletionReport.userEmail} by Super Admin: ${currentUser.email}`
      );

      // Audit log for user deletion
      try {
        await AuditLog.create({
          action: "user_deletion",
          actor: {
            id: currentUser._id,
            role: currentUser.role,
            email: currentUser.email,
          },
          targetModel: "User",
          targetId: userId,
          details: {
            targetUser: {
              id: userId,
              email: deletionReport.userEmail,
              name:
                `${userToDelete.firstName || ""} ${
                  userToDelete.lastName || ""
                }`.trim() || userToDelete.username,
              role: userToDelete.role,
            },
            deletionReport: {
              registrations: deletionReport.deletedData.registrations,
              eventsCreated: deletionReport.deletedData.eventsCreated,
              eventOrganizations: deletionReport.deletedData.eventOrganizations,
              messages: deletionReport.deletedData.messagesCreated,
              affectedEvents: deletionReport.updatedStatistics.events.length,
            },
          },
          ipAddress: req.ip,
          userAgent: req.get("user-agent") || "unknown",
        });
      } catch (auditError) {
        console.error(
          "Failed to create audit log for user deletion:",
          auditError
        );
        // Don't fail the request if audit logging fails
      }

      // Invalidate user-related caches after successful deletion
      await CachePatterns.invalidateUserCache(userId);

      ResponseHelper.success(
        res,
        {
          deletionReport,
          summary: `Successfully deleted user ${userToDelete.firstName} ${userToDelete.lastName} and all associated data.`,
        },
        `User ${userToDelete.firstName} ${userToDelete.lastName} has been permanently deleted along with all associated data.`,
        200
      );
    } catch (error: unknown) {
      console.error("Delete user error:", error);
      ResponseHelper.serverError(res, error);
    }
  }
}
