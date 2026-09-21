import { Request, Response } from "express";
import { User } from "../../models";
import { RoleUtils, hasPermission, PERMISSIONS } from "../../utils/roleUtils";
import { socketService } from "../../services/infrastructure/SocketService";
import { AutoEmailNotificationService } from "../../services/infrastructure/autoEmailNotificationService";
import { CachePatterns } from "../../services/infrastructure/CacheService";

/**
 * UserRoleController
 * Handles updateUserRole - changing user roles with notifications
 */
export default class UserRoleController {
  /**
   * Update user role (admin only)
   */
  static async updateUserRole(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { role } = req.body;

      if (!req.user) {
        res.status(401).json({
          success: false,
          message: "Authentication required.",
        });
        return;
      }

      // Check permissions
      if (!hasPermission(req.user.role, PERMISSIONS.EDIT_USER_ROLES)) {
        res.status(403).json({
          success: false,
          message: "Insufficient permissions to edit user roles.",
        });
        return;
      }

      if (!role || !RoleUtils.isValidRole(role)) {
        res.status(400).json({
          success: false,
          message: "Valid role is required.",
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

      // Check if role change is allowed
      const canPromote = RoleUtils.canPromoteUser(
        req.user.role,
        targetUser.role,
        role
      );

      if (!canPromote) {
        res.status(403).json({
          success: false,
          message: "You cannot promote this user to the specified role.",
        });
        return;
      }

      // Store the old role before updating
      const oldRole = targetUser.role;

      // Update role
      targetUser.role = role;
      await targetUser.save();

      // Apply the persisted role before cache/email work can delay revocation.
      socketService.syncUserAuthorization(String(targetUser._id), {
        role: targetUser.role,
        isActive: targetUser.isActive !== false,
      });

      // Invalidate user cache after role change
      await CachePatterns.invalidateUserCache(id);

      // 🚀 NEW: Trigger unified notification system after successful role update
      try {
        const isPromotion = RoleUtils.isPromotion(oldRole, role);

        // Fetch complete user data for the person making the change to get avatar and gender
        const changedByUser = await User.findById(req.user._id);
        if (!changedByUser) {
          throw new Error("Could not find the user making the role change");
        }

        await AutoEmailNotificationService.sendRoleChangeNotification({
          userData: {
            _id: String(targetUser._id),
            firstName: targetUser.firstName || "Unknown",
            lastName: targetUser.lastName || "User",
            email: targetUser.email,
            oldRole: oldRole,
            newRole: role,
          },
          changedBy: {
            _id: changedByUser._id?.toString(),
            firstName: changedByUser.firstName || "Unknown",
            lastName: changedByUser.lastName || "Admin",
            email: changedByUser.email,
            role: changedByUser.role,
            avatar: changedByUser.avatar, // Include avatar for correct display
            gender: changedByUser.gender, // Include gender for correct display
          },
          reason: `Role changed by ${changedByUser.firstName || "Admin"} ${
            changedByUser.lastName || ""
          }`,
          isPromotion,
        });
      } catch (notificationError: unknown) {
        const notifMsg =
          notificationError instanceof Error
            ? notificationError.message
            : String(notificationError);
        console.error("⚠️ Failed to send role change notifications:", notifMsg);
        // Don't fail the role update if notifications fail - log it and continue
      }

      // Emit real-time update for Management page
      socketService.emitUserUpdate(String(targetUser._id), {
        type: "role_changed",
        user: {
          id: String(targetUser._id),
          username: targetUser.username,
          email: targetUser.email,
          firstName: targetUser.firstName || undefined,
          lastName: targetUser.lastName || undefined,
          role: targetUser.role,
          isActive: targetUser.isActive !== false,
        },
        oldValue: oldRole,
        newValue: role,
      });

      res.status(200).json({
        success: true,
        message: `User role updated to ${role} successfully! Notifications sent.`,
        data: {
          user: {
            id: targetUser._id,
            username: targetUser.username,
            email: targetUser.email,
            role: targetUser.role,
          },
        },
      });
    } catch (error: unknown) {
      console.error("Update user role error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to update user role.",
      });
    }
  }
}
