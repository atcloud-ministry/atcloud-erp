import { Request, Response } from "express";
import { Types } from "mongoose";
import Message from "../../models/Message";
import { socketService } from "../../services/infrastructure/SocketService";
import { CachePatterns } from "../../services/infrastructure/CacheService";
import { buildRecipientMessageFilter } from "./MessageRecipientAuthorization";

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
 * Bell Notifications Read Controller
 * Handles marking bell notifications as read
 */
export default class BellNotificationsReadController {
  /**
   * Mark bell notification as read
   * Also marks corresponding system message as read for consistency
   */
  static async markBellNotificationAsRead(
    req: Request,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.user?.id;
      const userRole = req.user?.role;
      const { messageId } = req.params;

      if (!userId || !userRole) {
        res.status(401).json({
          success: false,
          message: "Authentication required",
        });
        return;
      }

      if (!Types.ObjectId.isValid(messageId)) {
        res.status(400).json({
          success: false,
          message: "Invalid message ID",
        });
        return;
      }

      const message = await Message.findOne(
        buildRecipientMessageFilter(messageId, userId, userRole)
      );
      if (!message) {
        res.status(404).json({
          success: false,
          message: "Notification not found",
        });
        return;
      }

      // Mark as read in both bell notifications and system messages for consistency
      message.markAsReadEverywhere(userId);
      await message.save();

      // Invalidate user cache after bell notification read
      await CachePatterns.invalidateUserCache(userId);

      // Get updated unread counts
      const updatedCounts = await MessageModel.getUnreadCountsForUser(
        userId,
        userRole
      );

      // Emit real-time updates
      socketService.emitBellNotificationUpdate(userId, "notification_read", {
        messageId: message._id,
        isRead: true,
        readAt: new Date(),
      });

      socketService.emitSystemMessageUpdate(userId, "message_read", {
        messageId: message._id,
        isRead: true,
        readAt: new Date(),
      });

      // Emit unread count update for real-time bell count updates
      socketService.emitUnreadCountUpdate(userId, updatedCounts);

      res.status(200).json({
        success: true,
        message: "Notification marked as read",
      });
    } catch (error) {
      console.error("Error in markBellNotificationAsRead:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
}
