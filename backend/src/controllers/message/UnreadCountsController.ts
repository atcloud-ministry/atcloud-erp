import { Request, Response } from "express";
import Message from "../../models/Message";

// Minimal runtime shapes to reduce explicit any usage without changing behavior
type UnreadCounts = {
  bellNotifications: number;
  systemMessages: number;
  total: number;
};

const MessageModel = Message as unknown as {
  getUnreadCountsForUser: (
    userId: string,
    userRole: string
  ) => Promise<UnreadCounts>;
};

/**
 * Unread Counts Controller
 * Handles retrieving unread counts for both systems
 */
export default class UnreadCountsController {
  /**
   * Get unread counts for both bell notifications and system messages
   */
  static async getUnreadCounts(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      const userRole = req.user?.role;

      if (!userId || !userRole) {
        res.status(401).json({
          success: false,
          message: "Authentication required",
        });
        return;
      }

      const counts = await MessageModel.getUnreadCountsForUser(
        userId,
        userRole
      );

      res.status(200).json({
        success: true,
        data: counts,
      });
    } catch (error) {
      console.error("Error in getUnreadCounts:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
}
