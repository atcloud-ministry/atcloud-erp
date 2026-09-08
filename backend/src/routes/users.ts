import { Router } from "express";
import GetProfileController from "../controllers/profile/GetProfileController";
import UpdateProfileController from "../controllers/profile/UpdateProfileController";
import UploadAvatarController from "../controllers/profile/UploadAvatarController";
import ChangePasswordController from "../controllers/profile/ChangePasswordController";
import UserReadController from "../controllers/UserReadController";
import UserRoleController from "../controllers/user-admin/UserRoleController";
import UserDeactivationController from "../controllers/user-admin/UserDeactivationController";
import UserReactivationController from "../controllers/user-admin/UserReactivationController";
import UserDeletionController from "../controllers/user-admin/UserDeletionController";
import UserDeletionImpactController from "../controllers/user-admin/UserDeletionImpactController";
import AdminProfileEditController from "../controllers/user-admin/AdminProfileEditController";
import { UserAnalyticsController } from "../controllers/UserAnalyticsController";
import {
  authenticate,
  requireAdmin,
  requireSuperAdmin,
  requireLeader,
  authorizePermission,
} from "../middleware/auth";
import { uploadAvatar } from "../middleware/upload";
import { PERMISSIONS } from "../utils/roleUtils";
import {
  validateUserUpdate,
  validateObjectId,
  handleValidationErrors,
} from "../middleware/validation";
import { uploadLimiter, analyticsLimiter } from "../middleware/rateLimiting";

const router = Router();

// All routes require authentication
router.use(authenticate);

// User profile routes (ProfileController)
router.get("/profile", GetProfileController.getProfile);
router.put(
  "/profile",
  validateUserUpdate,
  handleValidationErrors,
  UpdateProfileController.updateProfile,
);

// Avatar upload route (ProfileController)
router.post(
  "/avatar",
  uploadLimiter,
  uploadAvatar,
  UploadAvatarController.uploadAvatar,
);

// Legacy account-management reads. Community reads use /api/community/members.
router.get(
  "/",
  authorizePermission(PERMISSIONS.MANAGE_USERS),
  UserReadController.listLegacyAdminUsers,
);
router.get(
  "/search",
  authorizePermission(PERMISSIONS.MANAGE_USERS),
  UserReadController.listLegacyAdminUsers,
);

// Community stats - available to all authenticated users who can view the Community page
router.get(
  "/community-stats",
  authorizePermission(PERMISSIONS.VIEW_USER_PROFILES),
  analyticsLimiter,
  UserAnalyticsController.getCommunityStats,
);

// Full analytics stats - requires system analytics permission
router.get(
  "/stats",
  authorizePermission(PERMISSIONS.VIEW_SYSTEM_ANALYTICS),
  analyticsLimiter,
  UserAnalyticsController.getUserStats, // UserAnalyticsController
);

// Get user by ID (access control handled in controller) - MUST come after specific routes (UserAdminController)
router.get(
  "/:id",
  validateObjectId,
  handleValidationErrors,
  authorizePermission(PERMISSIONS.MANAGE_USERS),
  UserReadController.getAdminUser,
);

// Admin user management routes (UserAdminController)
router.put(
  "/:id/admin-edit",
  validateObjectId,
  handleValidationErrors,
  requireAdmin,
  AdminProfileEditController.adminEditProfile,
);
router.put(
  "/:id/role",
  validateObjectId,
  handleValidationErrors,
  requireAdmin,
  UserRoleController.updateUserRole,
);
router.put(
  "/:id/deactivate",
  validateObjectId,
  handleValidationErrors,
  requireLeader,
  UserDeactivationController.deactivateUser,
);
router.put(
  "/:id/reactivate",
  validateObjectId,
  handleValidationErrors,
  requireLeader,
  UserReactivationController.reactivateUser,
);

// Delete user impact analysis route (Super Admin only) (UserAdminController)
router.get(
  "/:id/deletion-impact",
  validateObjectId,
  handleValidationErrors,
  requireSuperAdmin,
  UserDeletionImpactController.getUserDeletionImpact,
);

// Delete user route (Super Admin only) (UserAdminController)
router.delete(
  "/:id",
  validateObjectId,
  handleValidationErrors,
  requireSuperAdmin,
  UserDeletionController.deleteUser,
);

// Password change route (ProfileController)
router.post(
  "/:id/change-password",
  validateObjectId,
  handleValidationErrors,
  ChangePasswordController.changePassword,
);

export default router;
