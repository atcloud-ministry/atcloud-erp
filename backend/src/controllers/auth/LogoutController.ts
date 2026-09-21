/**
 * LogoutController
 * Handles user logout operations
 * Extracted from authController.ts
 */

import { Request, Response } from "express";
import {
  REFRESH_TOKEN_COOKIE_NAME,
  refreshTokenClearCookieOptions,
} from "../../utils/refreshTokenCookie";
import { logSafeErrorEvent } from "../../utils/safeEventLogger";
import { TokenService } from "../../middleware/auth";
import {
  RefreshSessionRejectedError,
  RefreshSessionService,
} from "../../services/auth/RefreshSessionService";

export default class LogoutController {
  static async logout(req: Request, res: Response): Promise<void> {
    try {
      // Clear the refresh token cookie
      res.clearCookie(
        REFRESH_TOKEN_COOKIE_NAME,
        refreshTokenClearCookieOptions(),
      );

      const refreshToken = req.cookies?.[REFRESH_TOKEN_COOKIE_NAME];
      if (refreshToken && req.user?._id != null) {
        let claims;
        try {
          claims = TokenService.verifyRefreshToken(refreshToken);
        } catch {
          // The cookie is already cleared and an invalid token has no session
          // authority. Logout remains idempotent.
        }
        if (claims) {
          try {
            await RefreshSessionService.revokeCurrent(
              claims,
              String(req.user._id),
            );
          } catch (error: unknown) {
            // A stale cookie has no additional authority to revoke. Persistence
            // failures still surface so a valid stolen token cannot remain live.
            if (!(error instanceof RefreshSessionRejectedError)) throw error;
          }
        }
      }

      res.status(200).json({
        success: true,
        message: "Logged out successfully!",
      });
    } catch (error: unknown) {
      logSafeErrorEvent(
        "AUTH_LOGOUT_FAILED",
        error,
        req.user?._id != null ? String(req.user._id) : undefined,
      );
      res.status(500).json({
        success: false,
        message: "Logout failed.",
      });
    }
  }
}
