import { Request, Response } from "express";
import Message from "../../models/Message";
import { socketService } from "../../services/infrastructure/SocketService";
import { CachePatterns } from "../../services/infrastructure/CacheService";
import { buildMessageRoleVisibilityClauses } from "../../utils/messageAuthorization";

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
 * Bell Notifications Bulk Read Controller
 * Handles marking all bell notifications as read
 */
export default class BellNotificationsBulkReadController {
  /**
   * Mark all bell notifications as read
   */
  static async markAllBellNotificationsAsRead(
    req: Request,
    res: Response
  ): Promise<void> {
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

      // Find all active messages that are unread in bell notifications
      const messages = await Message.find({
        isActive: true,
        [`userStates.${userId}`]: { $exists: true }, // Only messages where user exists in userStates
        [`userStates.${userId}.isRemovedFromBell`]: { $ne: true },
        [`userStates.${userId}.isReadInBell`]: { $ne: true },
        $or: buildMessageRoleVisibilityClauses(userRole),
      });

      let markedCount = 0;
      for (const message of messages) {
        // Only mark as read in BELL, do not change System Messages read state
        message.markAsReadInBell(userId);
        await message.save();
        markedCount++;

        // Emit real-time updates for bell notifications only
        socketService.emitBellNotificationUpdate(userId, "notification_read", {
          messageId: message._id,
          isRead: true,
          readAt: new Date(),
        });
      }

      // Invalidate user cache after marking all as read
      if (markedCount > 0) {
        await CachePatterns.invalidateUserCache(userId);
      }

      // Get updated unread counts after marking all as read
      const updatedCounts = await MessageModel.getUnreadCountsForUser(
        userId,
        userRole
      );

      // Emit unread count update for real-time bell count updates
      socketService.emitUnreadCountUpdate(userId, updatedCounts);

      res.status(200).json({
        success: true,
        message: `All bell notifications marked as read`,
        data: {
          markedCount,
        },
      });
    } catch (error) {
      console.error("Error in markAllBellNotificationsAsRead:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
}
