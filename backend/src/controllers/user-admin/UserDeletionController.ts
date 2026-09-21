import { Request, Response } from "express";
import { User } from "../../models";
import { ROLES } from "../../utils/roleUtils";
import { AutoEmailNotificationService } from "../../services/infrastructure/autoEmailNotificationService";
import { UnifiedMessageController } from "../unifiedMessageController";
import { CachePatterns } from "../../services/infrastructure/CacheService";
import { formatActorDisplay } from "../../utils/systemMessageFormatUtils";
import { lockService } from "../../services/LockService";
import { ResponseHelper } from "../../utils/responseHelper";
import { socketService } from "../../services/infrastructure/SocketService";
import { programMembershipMutationSyncTrigger } from "../../services/programs/ProgramMembershipMutationSyncTrigger";
import { logSafeErrorEvent } from "../../utils/safeEventLogger";

const USER_DELETION_NOTICE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

/**
 * UserDeletionController
 * Handles account deletion and approved record lifecycles (Super Admin only)
 */
export default class UserDeletionController {
  /**
   * Delete a user account (Super Admin only).
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
            currentUser,
            req.correlationId
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

          await UnifiedMessageController.createTargetedSystemMessage(
            {
              title: "User Account Deleted",
              content: `A user account was permanently deleted by ${formatActorDisplay(
                currentUser
              )}.`,
              type: "user_management",
              priority: "high",
              hideCreator: true,
              expiresAt: new Date(
                Date.now() + USER_DELETION_NOTICE_RETENTION_MS,
              ),
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
        console.error("Admin deletion notification failed", {
          targetUserId: userId,
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
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
        console.error("Admin deletion email failed", {
          targetUserId: userId,
          errorType:
            notifyErr instanceof Error ? notifyErr.name : "UnknownError",
        });
      }

      console.log("User deletion request completed", {
        targetUserId: userId,
        actorId: String(currentUser._id),
      });

      // Invalidate user-related caches after successful deletion
      await CachePatterns.invalidateUserCache(userId);

      ResponseHelper.success(
        res,
        {
          deletionReport,
          summary: `Successfully deleted the account for ${userToDelete.firstName} ${userToDelete.lastName}.`,
        },
        `The account for ${userToDelete.firstName} ${userToDelete.lastName} has been deleted.`,
        200
      );
    } catch (error: unknown) {
      logSafeErrorEvent(
        "ADMIN_USER_DELETION_FAILED",
        error,
        req.user?._id != null ? String(req.user._id) : undefined,
      );
      ResponseHelper.serverError(res);
    }
  }
}
