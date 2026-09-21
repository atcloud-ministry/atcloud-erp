/**
 * ProfileController
 * Handles user profile retrieval
 * Extracted from authController.ts
 */

import { Request, Response } from "express";
import { User } from "../../models";
import {
  SELF_USER_QUERY_PROJECTION,
  serializeSelfUser,
} from "../../serializers/userReadSerializers";
import { logSafeErrorEvent } from "../../utils/safeEventLogger";

export default class ProfileController {
  static async getProfile(req: Request, res: Response): Promise<void> {
    let userId: string | undefined;
    try {
      if (!req.user) {
        res.status(401).json({
          success: false,
          message: "Authentication required.",
        });
        return;
      }
      userId = String(req.user._id);

      const user = await User.findById(userId).select(
        SELF_USER_QUERY_PROJECTION,
      );
      if (!user) {
        res.status(404).json({
          success: false,
          message: "User not found.",
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: {
          user: serializeSelfUser(user),
        },
      });
    } catch (error: unknown) {
      logSafeErrorEvent(
        "AUTH_PROFILE_READ_FAILED",
        error,
        userId,
      );
      res.status(500).json({
        success: false,
        message: "Failed to retrieve profile.",
      });
    }
  }
}
