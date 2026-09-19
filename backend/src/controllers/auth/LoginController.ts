/**
 * LoginController
 * Handles user login operations
 * Extracted from authController.ts
 */

import { Request, Response } from "express";
import { User, IUser } from "../../models";
import { TokenService } from "../../middleware/auth";
import { createErrorResponse, createSuccessResponse } from "../../types/api";
import { LoginRequest } from "./types";
import { serializeSelfUser } from "../../serializers/userReadSerializers";
import {
  REFRESH_TOKEN_COOKIE_NAME,
  refreshTokenCookieOptions,
} from "../../utils/refreshTokenCookie";
import { logSafeErrorEvent } from "../../utils/safeEventLogger";
import { RefreshSessionService } from "../../services/auth/RefreshSessionService";

export default class LoginController {
  static async login(req: Request, res: Response): Promise<void> {
    let userId: string | undefined;
    try {
      const { emailOrUsername, password, rememberMe }: LoginRequest = req.body;

      if (!emailOrUsername || !password) {
        res
          .status(400)
          .json(
            createErrorResponse("Email/username and password are required", 400)
          );
        return;
      }

      // Find user by email or username
      const user = await User.findOne({
        $or: [
          { email: emailOrUsername.toLowerCase() },
          { username: emailOrUsername },
        ],
      }).select(
        "+password +loginAttempts +lockUntil +birthYear +passwordChangedAt",
      );

      if (!user) {
        res
          .status(401)
          .json(createErrorResponse("Invalid email/username or password", 401));
        return;
      }
      if (user._id != null) userId = String(user._id);

      // Check if account is locked
      if ((user as IUser).isAccountLocked()) {
        res
          .status(423)
          .json(
            createErrorResponse(
              "Account is temporarily locked due to too many failed login attempts. Please try again later",
              423
            )
          );
        return;
      }

      // Check if account is active
      if (!(user as IUser).isActive) {
        res
          .status(403)
          .json(
            createErrorResponse(
              "Account has been deactivated. Please contact support",
              403
            )
          );
        return;
      }

      // Verify password
      const isPasswordValid = await (user as IUser).comparePassword(password);

      if (!isPasswordValid) {
        await (user as IUser).incrementLoginAttempts();
        res
          .status(401)
          .json(createErrorResponse("Invalid email/username or password", 401));
        return;
      }

      // Check if email is verified (optional based on requirements)
      if (!(user as IUser).isVerified) {
        res
          .status(403)
          .json(
            createErrorResponse(
              "Please verify your email address before logging in",
              403
            )
          );
        return;
      }

      // Reset login attempts and update last login
      await (user as IUser).resetLoginAttempts();
      await (user as IUser).updateLastLogin();

      // Set cookie options based on rememberMe
      const refreshExpireMs = TokenService.parseTimeToMs(
        process.env.JWT_REFRESH_EXPIRE || "7d"
      );
      const shortExpireMs = 24 * 60 * 60 * 1000; // 1 day for non-rememberMe
      const sessionLifetimeMs = rememberMe ? refreshExpireMs : shortExpireMs;

      // Generate tokens and persist the device-scoped refresh-token family
      // before exposing either token to the client.
      const tokens = TokenService.generateTokenPair(user, {
        refreshLifetimeMs: sessionLifetimeMs,
      });
      await RefreshSessionService.register({
        userId: String(user._id),
        identity: tokens.refreshIdentity,
        expiresAt: tokens.refreshTokenExpires,
        refreshLifetimeMs: sessionLifetimeMs,
      });

      // Set refresh token as httpOnly cookie
      res.cookie(
        REFRESH_TOKEN_COOKIE_NAME,
        tokens.refreshToken,
        refreshTokenCookieOptions(sessionLifetimeMs),
      );

      const responseData = {
        user: serializeSelfUser(user),
        accessToken: tokens.accessToken,
        expiresAt: tokens.accessTokenExpires,
      };

      res
        .status(200)
        .json(createSuccessResponse(responseData, "Login successful!"));
    } catch (error: unknown) {
      logSafeErrorEvent("AUTH_LOGIN_FAILED", error, userId);
      res
        .status(500)
        .json(createErrorResponse("Login failed. Please try again"));
    }
  }
}
