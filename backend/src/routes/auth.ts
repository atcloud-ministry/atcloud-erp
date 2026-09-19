import { Router } from "express";
import RegistrationController from "../controllers/auth/RegistrationController";
import LoginController from "../controllers/auth/LoginController";
import TokenController from "../controllers/auth/TokenController";
import EmailVerificationController from "../controllers/auth/EmailVerificationController";
import PasswordResetController from "../controllers/auth/PasswordResetController";
import PasswordChangeController from "../controllers/auth/PasswordChangeController";
import LogoutController from "../controllers/auth/LogoutController";
import ProfileController from "../controllers/auth/ProfileController";
import type { Request, Response, NextFunction } from "express";
import {
  authenticate,
  verifyEmailToken,
  verifyPasswordResetToken,
} from "../middleware/auth";
import {
  validateUserRegistration,
  validateUserLogin,
  validateForgotPassword,
  validateResetPassword,
  validateError,
} from "../middleware/validation";

const router = Router();

// Normalize username to lowercase on registration to match Option C rules
// Exported for unit testing
export const normalizeUsername = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  if (typeof req.body?.username === "string") {
    req.body.username = req.body.username.toLowerCase().trim();
  }
  next();
};

// Public routes (no authentication required)
router.get("/registration-notice", RegistrationController.notice);
router.post(
  "/register",
  normalizeUsername,
  validateUserRegistration,
  validateError,
  RegistrationController.register
);
router.post("/login", validateUserLogin, validateError, LoginController.login);
router.post("/refresh-token", TokenController.refreshToken);
router.get(
  "/verify-email/:token",
  verifyEmailToken,
  EmailVerificationController.verifyEmail
);
router.post(
  "/resend-verification",
  validateForgotPassword,
  validateError,
  EmailVerificationController.resendVerification
);
router.post(
  "/forgot-password",
  validateForgotPassword,
  validateError,
  PasswordResetController.forgotPassword
);
router.post(
  "/reset-password",
  verifyPasswordResetToken,
  validateResetPassword,
  validateError,
  PasswordResetController.resetPassword
);
router.post(
  "/complete-password-change/:token",
  PasswordChangeController.completePasswordChange
);

// Protected routes (authentication required)
router.use(authenticate); // All routes below require authentication

router.post("/logout", LogoutController.logout);
router.get("/profile", ProfileController.getProfile);

// Secure password change routes
router.post(
  "/request-password-change",
  PasswordChangeController.requestPasswordChange,
);

export default router;
