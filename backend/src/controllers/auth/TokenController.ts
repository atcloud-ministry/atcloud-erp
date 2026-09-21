/**
 * TokenController
 * Handles JWT token refresh operations
 * Extracted from authController.ts
 */

import { Request, Response } from "express";
import { User } from "../../models";
import { TokenService } from "../../middleware/auth";
import {
  REFRESH_TOKEN_COOKIE_NAME,
  refreshTokenClearCookieOptions,
  refreshTokenCookieOptions,
} from "../../utils/refreshTokenCookie";
import { isTokenCurrentForPasswordChange } from "../../utils/tokenRevocation";
import { logSafeErrorEvent } from "../../utils/safeEventLogger";
import {
  RefreshSessionRejectedError,
  RefreshSessionService,
} from "../../services/auth/RefreshSessionService";

function rejectRefresh(res: Response, message: string): void {
  res.clearCookie(
    REFRESH_TOKEN_COOKIE_NAME,
    refreshTokenClearCookieOptions(),
  );
  res.status(401).json({ success: false, message });
}

export default class TokenController {
  static async refreshToken(req: Request, res: Response): Promise<void> {
    let userId: string | undefined;
    try {
      const refreshToken = req.cookies[REFRESH_TOKEN_COOKIE_NAME];

      if (!refreshToken) {
        rejectRefresh(res, "Refresh token not provided.");
        return;
      }

      // Verify the refresh token
      let decoded;
      try {
        decoded = TokenService.verifyRefreshToken(refreshToken);
      } catch {
        rejectRefresh(res, "Invalid refresh token.");
        return;
      }

      if (!decoded || !decoded.userId) {
        rejectRefresh(res, "Invalid refresh token.");
        return;
      }
      userId = String(decoded.userId);

      // Get user to ensure they still exist and are active
      const user = await User.findById(decoded.userId, "+passwordChangedAt");

      const tokenMatchesPassword =
        user != null && isTokenCurrentForPasswordChange(decoded, user);
      if (!user || !user.isActive || !user.isVerified || !tokenMatchesPassword) {
        if (user && !tokenMatchesPassword) {
          await RefreshSessionService.revokeAllForUser(
            String(user._id),
            "password_changed",
          );
        } else {
          await RefreshSessionService.revokeAllForUser(
            String(decoded.userId),
            user ? "account_deactivated" : "account_deleted",
          );
        }
        rejectRefresh(res, "User not found or unavailable.");
        return;
      }

      // Prepare the replacement JWT, then atomically compare-and-swap the
      // stored JTI hash. A concurrent/stale token revokes the whole family.
      const nextIdentity = RefreshSessionService.createRotationIdentity(
        decoded.sid,
      );
      const refreshExpiresAt = TokenService.refreshTokenExpiresAt(decoded);
      const newTokens = TokenService.generateTokenPair(user, {
        refreshIdentity: nextIdentity,
        refreshExpiresAt,
      });
      const rotation = await RefreshSessionService.rotate({
        claims: decoded,
        nextIdentity,
        nextExpiresAt: newTokens.refreshTokenExpires,
      });

      // Set new refresh token in cookie
      const remainingSessionMs = Math.max(
        1,
        rotation.expiresAt.getTime() - Date.now(),
      );
      res.cookie(
        REFRESH_TOKEN_COOKIE_NAME,
        newTokens.refreshToken,
        refreshTokenCookieOptions(
          Math.min(rotation.lifetimeMs, remainingSessionMs),
        ),
      );

      res.status(200).json({
        success: true,
        data: {
          accessToken: newTokens.accessToken,
        },
        message: "Token refreshed successfully.",
      });
    } catch (error: unknown) {
      logSafeErrorEvent("AUTH_REFRESH_FAILED", error, userId);
      if (error instanceof RefreshSessionRejectedError) {
        rejectRefresh(res, "Token refresh failed.");
        return;
      }
      res.status(503).json({
        success: false,
        message: "Token refresh is temporarily unavailable.",
      });
    }
  }
}
