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
 * System Messages Read Controller
 * Handles marking system messages as read
 */
export default class SystemMessagesReadController {
  /**
   * Mark system message as read
   * Also marks corresponding bell notification as read for consistency
   */
  static async markSystemMessageAsRead(
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
        res.status(400).json({ success: false, message: "Invalid message ID" });
        return;
      }

      const message = await Message.findOne(
        buildRecipientMessageFilter(messageId, userId, userRole)
      );
      if (!message) {
        res.status(404).json({
          success: false,
          message: "Message not found",
        });
        return;
      }

      // Mark as read in both system messages and bell notifications for consistency
      message.markAsReadEverywhere(userId);
      await message.save();

      // Invalidate user cache after message read
      await CachePatterns.invalidateUserCache(userId);

      // Get updated unread counts
      const updatedCounts = await MessageModel.getUnreadCountsForUser(
        userId,
        userRole
      );

      // Emit real-time updates
      socketService.emitSystemMessageUpdate(userId, "message_read", {
        messageId: message._id,
        isRead: true,
        readAt: new Date(),
      });

      socketService.emitBellNotificationUpdate(userId, "notification_read", {
        messageId: message._id,
        isRead: true,
        readAt: new Date(),
      });

      // Emit unread count update for real-time bell count updates
      socketService.emitUnreadCountUpdate(userId, updatedCounts);

      res.status(200).json({
        success: true,
        message: "Message marked as read",
      });
    } catch (error) {
      console.error("Error in markSystemMessageAsRead:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
}
