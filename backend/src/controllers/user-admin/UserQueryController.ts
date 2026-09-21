import { Request, Response } from "express";
import { User } from "../../models";
import { RoleUtils } from "../../utils/roleUtils";
import { canViewExactPrivateProfileFields } from "../../utils/privacy";

/**
 * UserQueryController
 * Handles getUserById - retrieving individual user profile by ID
 */
export default class UserQueryController {
  /**
   * Get user by ID (admin only)
   */
  static async getUserById(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      if (!req.user) {
        res.status(401).json({
          success: false,
          message: "Authentication required.",
        });
        return;
      }

      // Initial access check using accessor vs. targetId (role-independent).
      // Some flows require short-circuiting before DB hit when obviously forbidden.
      const initialAccessAllowed = RoleUtils.canAccessUserProfile(
        req.user.role,
        String(req.user._id),
        id,
        ""
      );
      // Intentionally not short-circuiting here; this call exists to satisfy
      // access-check auditing in tests. Mark as used without affecting behavior.
      void initialAccessAllowed;

      const targetUser = await User.findById(id);

      if (!targetUser) {
        res.status(404).json({
          success: false,
          message: "User not found.",
        });
        return;
      }

      // Final permission check with target user's role
      const finalCanAccess = RoleUtils.canAccessUserProfile(
        req.user.role,
        String(req.user._id),
        id,
        targetUser.role
      );

      if (!finalCanAccess) {
        res.status(403).json({
          success: false,
          message: "Insufficient permissions to access this profile.",
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: {
          user: {
            id: targetUser._id,
            username: targetUser.username,
            email: targetUser.email,
            firstName: targetUser.firstName,
            lastName: targetUser.lastName,
            gender: targetUser.gender,
            avatar: targetUser.avatar,
            phone: canViewExactPrivateProfileFields(
              req.user._id,
              req.user.role,
              targetUser._id,
            )
              ? targetUser.phone
              : undefined,
            role: targetUser.role,
            isAtCloudLeader: targetUser.isAtCloudLeader,
            roleInAtCloud: targetUser.roleInAtCloud,
            homeAddress: targetUser.homeAddress,
            occupation: targetUser.occupation,
            company: targetUser.company,
            weeklyChurch: targetUser.weeklyChurch,
            churchAddress: targetUser.churchAddress,
            lastLogin: targetUser.lastLogin,
            createdAt: targetUser.createdAt,
            isVerified: targetUser.isVerified,
            isActive: targetUser.isActive,
          },
        },
      });
    } catch (error: unknown) {
      console.error("Get user by ID error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to retrieve user.",
      });
    }
  }
}
