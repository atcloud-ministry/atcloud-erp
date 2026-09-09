import { Request, Response } from "express";
import { User } from "../../models";
import { cleanupOldAvatar } from "../../utils/avatarCleanup";
import { AutoEmailNotificationService } from "../../services/infrastructure/autoEmailNotificationService";
import { CachePatterns } from "../../services/infrastructure/CacheService";

interface UpdateProfileRequest {
  username?: string;
  firstName?: string;
  lastName?: string;
  gender?: "male" | "female";
  email?: string;
  phone?: string;
  isAtCloudLeader?: boolean;
  roleInAtCloud?: string;
  homeAddress?: string;
  occupation?: string;
  company?: string;
  weeklyChurch?: string;
  churchAddress?: string;
  avatar?: string; // Added for gender change avatar updates
}

const SELF_SERVICE_PROFILE_FIELDS = [
  "username",
  "firstName",
  "lastName",
  "gender",
  "email",
  "phone",
  "isAtCloudLeader",
  "roleInAtCloud",
  "homeAddress",
  "occupation",
  "company",
  "weeklyChurch",
  "churchAddress",
] as const;

function selectSelfServiceProfileFields(body: unknown): UpdateProfileRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }

  const source = body as Record<string, unknown>;
  const selected: UpdateProfileRequest = {};
  for (const field of SELF_SERVICE_PROFILE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      Object.assign(selected, { [field]: source[field] });
    }
  }
  return selected;
}

export default class UpdateProfileController {
  /**
   * Update profile
   * PUT /api/users/profile
   */
  static async updateProfile(req: Request, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({
          success: false,
          message: "Authentication required.",
        });
        return;
      }

      const updateData = selectSelfServiceProfileFields(req.body);

      // @Cloud co-worker validation: isAtCloudLeader requires roleInAtCloud
      if (updateData.isAtCloudLeader === true && !updateData.roleInAtCloud) {
        res.status(400).json({
          success: false,
          message: "@Cloud co-worker must have a role specified.",
        });
        return;
      }

      // Clear roleInAtCloud if isAtCloudLeader is set to false
      if (updateData.isAtCloudLeader === false) {
        updateData.roleInAtCloud = undefined;
      }

      // Store old @Cloud values for change detection
      const oldUser = await User.findById(req.user._id);
      if (!oldUser) {
        res.status(404).json({
          success: false,
          message: "User not found.",
        });
        return;
      }

      const oldIsAtCloudLeader = oldUser.isAtCloudLeader;
      const oldRoleInAtCloud = oldUser.roleInAtCloud;

      // Handle gender change: Update avatar to default based on new gender
      if (updateData.gender && updateData.gender !== oldUser.gender) {
        const userForAvatarUpdate = await User.findById(req.user._id);
        if (userForAvatarUpdate) {
          const oldAvatarUrl = userForAvatarUpdate.avatar;

          // Set default avatar based on gender
          const defaultAvatar =
            updateData.gender === "male"
              ? "https://i.pravatar.cc/300?img=12"
              : "https://i.pravatar.cc/300?img=47";

          updateData.avatar = defaultAvatar;

          // Cleanup old avatar file (async)
          if (oldAvatarUrl && oldAvatarUrl !== defaultAvatar) {
            cleanupOldAvatar(
              String(userForAvatarUpdate._id),
              oldAvatarUrl
            ).catch((error) => {
              console.error("Failed to cleanup old avatar:", error);
            });
          }
        }
      }

      // Update user profile
      const updatedUser = await User.findByIdAndUpdate(
        req.user._id,
        { $set: updateData },
        { new: true, runValidators: true, select: "-password" }
      );

      if (!updatedUser) {
        res.status(404).json({
          success: false,
          message: "User not found.",
        });
        return;
      }

      // Check if @Cloud role changed and send notification
      const newIsAtCloudLeader = updatedUser.isAtCloudLeader;
      const newRoleInAtCloud = updatedUser.roleInAtCloud;

      if (oldIsAtCloudLeader !== newIsAtCloudLeader) {
        try {
          if (!oldIsAtCloudLeader && newIsAtCloudLeader) {
            // Scenario 1: No to Yes - User is assigned as @Cloud co-worker
            console.log(
              `🌟 User ${updatedUser.username} (${updatedUser._id}) promoted to @Cloud co-worker with role: ${newRoleInAtCloud}`
            );

            // Send notification with changeType "assigned"
            await AutoEmailNotificationService.sendAtCloudRoleChangeNotification(
              {
                userData: {
                  _id: String(updatedUser._id),
                  firstName: updatedUser.firstName,
                  lastName: updatedUser.lastName,
                  email: updatedUser.email,
                  roleInAtCloud: updatedUser.roleInAtCloud,
                },
                changeType: "assigned",
                systemUser: {
                  _id: "system",
                  firstName: "System",
                  lastName: "",
                  email: "",
                  role: "system",
                  avatar: "",
                },
              }
            );
          } else if (oldIsAtCloudLeader && !newIsAtCloudLeader) {
            // Scenario 2: Yes to No - User is removed from @Cloud co-worker role
            console.log(
              `⚠️ User ${updatedUser.username} (${updatedUser._id}) removed from @Cloud co-worker (was: ${oldRoleInAtCloud})`
            );

            // Send notification with changeType "removed"
            await AutoEmailNotificationService.sendAtCloudRoleChangeNotification(
              {
                userData: {
                  _id: String(updatedUser._id),
                  firstName: updatedUser.firstName,
                  lastName: updatedUser.lastName,
                  email: updatedUser.email,
                  previousRoleInAtCloud: oldRoleInAtCloud,
                },
                changeType: "removed",
                systemUser: {
                  _id: "system",
                  firstName: "System",
                  lastName: "",
                  email: "",
                  role: "system",
                  avatar: "",
                },
              }
            );
          }
        } catch (error) {
          console.error(
            "Failed to send @Cloud role change notification:",
            error
          );
          // Don't fail the profile update if notification fails
        }
      } else if (
        newIsAtCloudLeader &&
        oldRoleInAtCloud &&
        newRoleInAtCloud &&
        oldRoleInAtCloud !== newRoleInAtCloud
      ) {
        // Scenario 3: Role changed within @Cloud co-worker status (e.g., Ministry Leader → Developer)
        console.log(
          `🔄 User ${updatedUser.username} (${updatedUser._id}) @Cloud role changed from ${oldRoleInAtCloud} to ${newRoleInAtCloud}`
        );
        // No notification needed for role changes within co-worker status
      }

      // Invalidate user cache after profile update
      await CachePatterns.invalidateUserCache(String(updatedUser._id));

      res.status(200).json({
        success: true,
        message: "Profile updated successfully.",
        data: {
          id: updatedUser._id,
          username: updatedUser.username,
          email: updatedUser.email,
          phone: updatedUser.phone,
          firstName: updatedUser.firstName,
          lastName: updatedUser.lastName,
          gender: updatedUser.gender,
          avatar: updatedUser.avatar,
          role: updatedUser.role,
          isAtCloudLeader: updatedUser.isAtCloudLeader,
          roleInAtCloud: updatedUser.roleInAtCloud,
          homeAddress: updatedUser.homeAddress,
          occupation: updatedUser.occupation,
          company: updatedUser.company,
          weeklyChurch: updatedUser.weeklyChurch,
          churchAddress: updatedUser.churchAddress,
          lastLogin: updatedUser.lastLogin,
          createdAt: updatedUser.createdAt,
          isVerified: updatedUser.isVerified,
          isActive: updatedUser.isActive,
        },
      });
    } catch (error: unknown) {
      console.error("Update profile error:", error);

      // Handle Mongoose validation errors
      if (
        error &&
        typeof error === "object" &&
        "name" in error &&
        error.name === "ValidationError" &&
        "errors" in error
      ) {
        const errors = (
          error as { errors: Record<string, { message: string }> }
        ).errors;
        const messages = Object.values(errors).map((err) => err.message);
        res.status(400).json({
          success: false,
          message: "Validation failed.",
          errors: messages,
        });
        return;
      }

      res.status(500).json({
        success: false,
        message: "Failed to update profile.",
      });
    }
  }
}
