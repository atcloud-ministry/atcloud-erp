import { Request, Response } from "express";
import { User } from "../../models";
import {
  SELF_USER_QUERY_PROJECTION,
  serializeSelfUser,
} from "../../serializers/userReadSerializers";

// Response helper utilities
class ResponseHelper {
  static success(
    res: Response,
    data?: unknown,
    message?: string,
    statusCode: number = 200
  ): void {
    const payload: Record<string, unknown> = { success: true };
    if (message) payload.message = message;
    if (typeof data !== "undefined") payload.data = data as unknown;
    res.status(statusCode).json(payload);
  }

  static authRequired(res: Response): void {
    res.status(401).json({
      success: false,
      message: "Authentication required.",
    });
  }

  static serverError(res: Response, error?: unknown): void {
    console.error("Error (500): Internal server error.", error);
    res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
}

export default class GetProfileController {
  /**
   * Get current user profile
   * GET /api/users/profile
   */
  static async getProfile(req: Request, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ResponseHelper.authRequired(res);
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

      ResponseHelper.success(res, { user: serializeSelfUser(user) });
    } catch (error: unknown) {
      ResponseHelper.serverError(res, error);
    }
  }
}
