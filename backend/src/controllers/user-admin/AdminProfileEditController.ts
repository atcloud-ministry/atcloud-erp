import { Request, Response } from "express";
import {
  REGISTRATION_PROFILE_FIELDS,
  type EmploymentStatus,
} from "@atcloud/shared-time/registration-profile";
import { User } from "../../models";
import AuditLog from "../../models/AuditLog";
import { hasPermission, PERMISSIONS } from "../../utils/roleUtils";
import { cleanupOldAvatar } from "../../utils/avatarCleanup";
import { socketService } from "../../services/infrastructure/SocketService";
import { CachePatterns } from "../../services/infrastructure/CacheService";
import {
  applyCanonicalRegistrationProfile,
  containsRegistrationProfileUpdate,
  validateMergedRegistrationProfile,
} from "../../services/RegistrationProfileService";
import {
  synchronizeExistingAlumniProfileProjection,
} from "../../services/alumni/AlumniProfileProjectionSyncService";
import { mongoTransactionService } from "../../services/reliability/MongoTransactionService";

interface AdminProfileEditRequest {
  avatar?: string;
  phone?: string;
  birthYear?: number | string;
  residenceCity?: string;
  residenceRegion?: string | null;
  residenceCountryCode?: string;
  employmentStatus?: EmploymentStatus;
  company?: string | null;
  occupation?: string | null;
  isAtCloudLeader?: boolean;
  roleInAtCloud?: string;
}

const ADMIN_PROFILE_EDIT_FIELDS = [
  "avatar",
  ...REGISTRATION_PROFILE_FIELDS,
  "isAtCloudLeader",
  "roleInAtCloud",
] as const;

const AUDITED_PROFILE_FIELDS = [
  "avatar",
  ...REGISTRATION_PROFILE_FIELDS,
  "homeAddress",
  "isAtCloudLeader",
  "roleInAtCloud",
] as const;

function selectAdminProfileEditFields(body: unknown): AdminProfileEditRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const source = body as Record<string, unknown>;
  const selected: AdminProfileEditRequest = {};
  for (const field of ADMIN_PROFILE_EDIT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      Object.assign(selected, { [field]: source[field] });
    }
  }
  return selected;
}

/** Allows users with the existing User Management permission to edit profiles. */
export default class AdminProfileEditController {
  static async adminEditProfile(req: Request, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({
          success: false,
          message: "Authentication required.",
        });
        return;
      }

      if (!hasPermission(req.user.role, PERMISSIONS.MANAGE_USERS)) {
        res.status(403).json({
          success: false,
          message: `Access denied. Required permission: ${PERMISSIONS.MANAGE_USERS}`,
        });
        return;
      }

      const { id: targetUserId } = req.params;
      const edit = selectAdminProfileEditFields(req.body);
      const { avatar, isAtCloudLeader, roleInAtCloud } = edit;

      if (
        (isAtCloudLeader !== undefined &&
          typeof isAtCloudLeader !== "boolean") ||
        (roleInAtCloud !== undefined && typeof roleInAtCloud !== "string") ||
        (avatar !== undefined && typeof avatar !== "string")
      ) {
        res.status(400).json({
          success: false,
          message: "Invalid admin profile edit payload.",
        });
        return;
      }

      const write = await mongoTransactionService.run(async (session) => {
        const targetUser = await User.findById(targetUserId)
          .select("+birthYear")
          .session(session);
        if (!targetUser) return { kind: "not_found" } as const;

        const update = { ...edit };
        const nextIsAtCloudLeader =
          isAtCloudLeader ?? targetUser.isAtCloudLeader;
        const nextRoleInAtCloud = roleInAtCloud ?? targetUser.roleInAtCloud;
        if (nextIsAtCloudLeader && !nextRoleInAtCloud) {
          return { kind: "role_required" } as const;
        }

        const oldValues = Object.fromEntries(
          AUDITED_PROFILE_FIELDS.map((field) => [field, targetUser[field]]),
        ) as Record<(typeof AUDITED_PROFILE_FIELDS)[number], unknown>;

        const registrationProfileResult = containsRegistrationProfileUpdate(
          update,
        )
          ? validateMergedRegistrationProfile(targetUser, update)
          : undefined;
        if (registrationProfileResult && !registrationProfileResult.success) {
          return {
            kind: "registration_invalid",
            issues: registrationProfileResult.issues,
          } as const;
        }

        if (isAtCloudLeader === false) {
          update.roleInAtCloud = undefined;
        }

        Object.assign(targetUser, update);
        if (registrationProfileResult?.success) {
          applyCanonicalRegistrationProfile(
            targetUser,
            registrationProfileResult.value,
          );
        }
        const updatedUser = await targetUser.save({ session });
        await synchronizeExistingAlumniProfileProjection(updatedUser, session);
        return { kind: "updated", updatedUser, oldValues, update } as const;
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
          message: "Role in @Cloud is required for @Cloud co-workers.",
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
      const { updatedUser, oldValues, update } = write;

      if (
        avatar !== undefined &&
        oldValues.avatar !== updatedUser.avatar &&
        oldValues.avatar
      ) {
        cleanupOldAvatar(String(targetUserId), String(oldValues.avatar)).catch(
          (error) => {
            console.error(
              "Failed to cleanup old avatar during admin edit:",
              error,
            );
          },
        );
      }

      try {
        const changes: Record<string, { old: unknown; new: unknown }> = {};
        for (const field of AUDITED_PROFILE_FIELDS) {
          const nextValue = updatedUser[field];
          if (oldValues[field] !== nextValue) {
            changes[field] = { old: oldValues[field], new: nextValue };
          }
        }

        if (Object.keys(changes).length > 0) {
          await AuditLog.create({
            action: "admin_profile_edit",
            actor: {
              id: req.user._id,
              role: req.user.role,
              email: req.user.email,
            },
            targetModel: "User",
            targetId: targetUserId,
            details: {
              targetUser: {
                id: updatedUser._id,
                email: updatedUser.email,
                name:
                  `${updatedUser.firstName || ""} ${
                    updatedUser.lastName || ""
                  }`.trim() || updatedUser.username,
              },
              changes,
            },
            ipAddress: req.ip,
            userAgent: req.get("user-agent") || "unknown",
          });
        }
      } catch (auditError) {
        console.error(
          "Failed to create audit log for admin profile edit:",
          auditError,
        );
      }

      await CachePatterns.invalidateUserCache(targetUserId);

      // birthYear and the new structured profile values stay off the socket.
      // Authorized admins receive change flags and can refetch the HTTP DTO.
      socketService.emitUserUpdate(String(updatedUser._id), {
        type: "profile_edited",
        user: {
          id: String(updatedUser._id),
          username: updatedUser.username,
          email: updatedUser.email,
          firstName: updatedUser.firstName || undefined,
          lastName: updatedUser.lastName || undefined,
          role: updatedUser.role,
          avatar: updatedUser.avatar || undefined,
          phone: updatedUser.phone || undefined,
          isAtCloudLeader: updatedUser.isAtCloudLeader || undefined,
          roleInAtCloud: updatedUser.roleInAtCloud || undefined,
          isActive: updatedUser.isActive !== false,
        },
        changes: {
          avatar: avatar !== undefined,
          phone: update.phone !== undefined,
          birthYear: update.birthYear !== undefined,
          residenceCity: update.residenceCity !== undefined,
          residenceRegion: update.residenceRegion !== undefined,
          residenceCountryCode: update.residenceCountryCode !== undefined,
          employmentStatus: update.employmentStatus !== undefined,
          company: update.company !== undefined,
          occupation: update.occupation !== undefined,
          isAtCloudLeader: isAtCloudLeader !== undefined,
          roleInAtCloud: roleInAtCloud !== undefined,
        },
      });

      res.status(200).json({
        success: true,
        message: "Profile updated successfully by admin.",
        data: {
          id: updatedUser._id,
          avatar: updatedUser.avatar,
          phone: updatedUser.phone,
          birthYear: updatedUser.birthYear,
          residenceCity: updatedUser.residenceCity,
          residenceRegion: updatedUser.residenceRegion,
          residenceCountryCode: updatedUser.residenceCountryCode,
          employmentStatus: updatedUser.employmentStatus,
          company: updatedUser.company,
          occupation: updatedUser.occupation,
          isAtCloudLeader: updatedUser.isAtCloudLeader,
          roleInAtCloud: updatedUser.roleInAtCloud,
        },
      });
    } catch (error: unknown) {
      console.error("Admin edit profile error:", error);
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
        res.status(400).json({
          success: false,
          message: "Validation failed.",
          errors: Object.values(errors).map((item) => item.message),
        });
        return;
      }
      res.status(500).json({
        success: false,
        error: "Failed to update user profile",
      });
    }
  }
}
