import { Request, Response } from "express";
import Message from "../../models/Message";
import User from "../../models/User";
import { socketService } from "../../services/infrastructure/SocketService";
import { CachePatterns } from "../../services/infrastructure/CacheService";
import { serializeSystemMessageForRecipient } from "../../serializers/systemMessageRealtimeSerializer";

/**
 * Welcome Notification Controller
 * Handles sending welcome notifications to new users
 */
export default class WelcomeNotificationController {
  /**
   * Send welcome notification to new user (first login)
   */
  static async sendWelcomeNotification(
    req: Request,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.user?.id;

      if (!userId) {
        res.status(401).json({
          success: false,
          message: "Authentication required",
        });
        return;
      }

      const user = await User.findById(userId);
      if (!user) {
        res.status(404).json({
          success: false,
          message: "User not found",
        });
        return;
      }

      // Check if user already received welcome message
      if (user.hasReceivedWelcomeMessage) {
        res.status(200).json({
          success: true,
          message: "Welcome message already sent",
          data: { alreadySent: true },
        });
        return;
      }

      // Create welcome message for the specific user
      const welcomeMessage = new Message({
        title: "🎉 Welcome to @Cloud Event Management System!",
        content: `Hello ${user.firstName}! Welcome to the @Cloud Event Management System. We're excited to have you join our community! Here you can discover upcoming events, connect with other members, and participate in exciting activities. Feel free to explore the platform and don't hesitate to reach out if you need any assistance. Happy networking!`,
        type: "announcement",
        priority: "high",
        hideCreator: true,
        creator: {
          id: "system",
          firstName: "System",
          lastName: "Administrator",
          username: "system",
          gender: "male", // Required field for system messages
          authLevel: "Super Admin",
          roleInAtCloud: "System",
        },
        isActive: true,
        userStates: new Map(),
      });

      // Initialize user state for the target user only
      const userState = {
        isReadInSystem: false,
        isReadInBell: false,
        isRemovedFromBell: false,
        isDeletedFromSystem: false,
        readInSystemAt: undefined,
        readInBellAt: undefined,
        removedFromBellAt: undefined,
        deletedFromSystemAt: undefined,
        lastInteractionAt: undefined,
      };

      welcomeMessage.userStates.set(userId, userState);
      await welcomeMessage.save();

      // Invalidate user cache after welcome message creation
      await CachePatterns.invalidateUserCache(userId);

      // Mark user as having received welcome message
      user.hasReceivedWelcomeMessage = true;
      await user.save();

      // Emit real-time notification
      socketService.emitSystemMessageUpdate(userId, "message_created", {
        message: serializeSystemMessageForRecipient(welcomeMessage, userId),
      });

      // ✅ REMOVED: Redundant bell_notification_update emission
      // Bell notifications are now created by frontend from system_message_update events
      // This eliminates duplicate processing and simplifies the architecture

      res.status(201).json({
        success: true,
        message: "Welcome notification sent successfully",
        data: {
          messageId: welcomeMessage._id,
          title: welcomeMessage.title,
          sent: true,
        },
      });
    } catch (error) {
      console.error("Error in sendWelcomeNotification:", error);
      res.status(500).json({
        success: false,
        message: "Failed to send welcome notification",
      });
    }
  }
}
