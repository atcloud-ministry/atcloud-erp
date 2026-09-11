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

export default class ProfileController {
  static async getProfile(req: Request, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({
          success: false,
          message: "Authentication required.",
        });
        return;
      }

      const user = await User.findById(req.user._id).select(
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
      console.error("Get profile error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to retrieve profile.",
      });
    }
  }
}
