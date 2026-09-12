import { Request, Response } from "express";
import { User } from "../../models";
import { cleanupOldAvatar } from "../../utils/avatarCleanup";
import { AutoEmailNotificationService } from "../../services/infrastructure/autoEmailNotificationService";
import { CachePatterns } from "../../services/infrastructure/CacheService";
import type { EmploymentStatus } from "@atcloud/shared-time/registration-profile";
import {
  applyCanonicalRegistrationProfile,
  containsRegistrationProfileUpdate,
  validateMergedRegistrationProfile,
} from "../../services/RegistrationProfileService";
import {
  synchronizeExistingAlumniProfileProjection,
} from "../../services/alumni/AlumniProfileProjectionSyncService";
import { mongoTransactionService } from "../../services/reliability/MongoTransactionService";
import { serializeSelfUser } from "../../serializers/userReadSerializers";

interface UpdateProfileRequest {
  username?: string;
  firstName?: string;
  lastName?: string;
  gender?: "male" | "female";
  email?: string;
  phone?: string;
  birthYear?: number | string;
  residenceCity?: string;
  residenceRegion?: string | null;
  residenceCountryCode?: string;
  employmentStatus?: EmploymentStatus;
  isAtCloudLeader?: boolean;
  roleInAtCloud?: string;
  occupation?: string | null;
  company?: string | null;
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
  "birthYear",
  "residenceCity",
  "residenceRegion",
  "residenceCountryCode",
  "employmentStatus",
  "isAtCloudLeader",
  "roleInAtCloud",
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

      const requestedUpdate = selectSelfServiceProfileFields(req.body);
      const write = await mongoTransactionService.run(async (session) => {
        // Reload for every retry so validation and projection generation share
        // one transaction snapshot.
        const oldUser = await User.findById(req.user!._id)
          .select("+birthYear")
          .session(session);
        if (!oldUser) return { kind: "not_found" } as const;

        const updateData = { ...requestedUpdate };
        const oldIsAtCloudLeader = oldUser.isAtCloudLeader;
        const oldRoleInAtCloud = oldUser.roleInAtCloud;
        const oldAvatarUrl = oldUser.avatar;

        const nextIsAtCloudLeader =
          updateData.isAtCloudLeader ?? oldUser.isAtCloudLeader;
        const nextRoleInAtCloud =
          updateData.roleInAtCloud ?? oldUser.roleInAtCloud;

        if (nextIsAtCloudLeader && !nextRoleInAtCloud) {
          return { kind: "role_required" } as const;
        }

        if (updateData.isAtCloudLeader === false) {
          updateData.roleInAtCloud = undefined;
        }

        const registrationProfileResult = containsRegistrationProfileUpdate(
          updateData,
        )
          ? validateMergedRegistrationProfile(oldUser, updateData)
          : undefined;
        if (registrationProfileResult && !registrationProfileResult.success) {
          return {
            kind: "registration_invalid",
            issues: registrationProfileResult.issues,
          } as const;
        }

        if (updateData.gender && updateData.gender !== oldUser.gender) {
          updateData.avatar =
            updateData.gender === "male"
              ? "https://i.pravatar.cc/300?img=12"
              : "https://i.pravatar.cc/300?img=47";
        }

        Object.assign(oldUser, updateData);
        if (registrationProfileResult?.success) {
          applyCanonicalRegistrationProfile(
            oldUser,
            registrationProfileResult.value,
          );
        }
        const updatedUser = await oldUser.save({ session });
        await synchronizeExistingAlumniProfileProjection(updatedUser, session);
        return {
          kind: "updated",
          updatedUser,
          oldIsAtCloudLeader,
          oldRoleInAtCloud,
          oldAvatarUrl,
        } as const;
      });

      if (write.kind === "not_found") {
        res.status(404).json({
          success: false,
          message: "User not found.",
        });
        return;
      }
      if (write.kind === "role_required") {
        res.status(400).json({
          success: false,
          message: "@Cloud co-worker must have a role specified.",
        });
        return;
      }
      if (write.kind === "registration_invalid") {
        res.status(400).json({
          success: false,
          message: write.issues
            .map((issue) => `${issue.field}: ${issue.message}`)
            .join("; "),
          errors: write.issues,
        });
        return;
      }
      const {
        updatedUser,
        oldIsAtCloudLeader,
        oldRoleInAtCloud,
        oldAvatarUrl,
      } = write;

      if (oldAvatarUrl && oldAvatarUrl !== updatedUser.avatar) {
        cleanupOldAvatar(String(updatedUser._id), oldAvatarUrl).catch(
          (error) => {
            console.error("Failed to cleanup old avatar:", error);
          },
        );
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
        data: serializeSelfUser(updatedUser),
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
