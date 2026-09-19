import Message from "../../models/Message";
import type { IMessage } from "../../models/Message";
import User from "../../models/User";
import { socketService } from "../../services/infrastructure/SocketService";
import { CachePatterns } from "../../services/infrastructure/CacheService";
import { serializeSystemMessageForRecipient } from "../../serializers/systemMessageRealtimeSerializer";

// Minimal runtime shapes to reduce explicit any usage without changing behavior
type UnreadCounts = {
  bellNotifications: number;
  systemMessages: number;
  total: number;
};

export type TargetedSystemMessageDeliveryOptions = {
  /** A caller that owns delivery can suppress only this message-created emit. */
  emitMessageCreatedEvent?: boolean;
};

const MessageModel = Message as unknown as {
  getUnreadCountsForUser: (
    userId: string,
    userRole: string,
  ) => Promise<UnreadCounts>;
};

type TargetRecipient = {
  id: string;
  role: string;
};

/**
 * Targeted System Messages Controller
 * Handles creating system messages for specific users
 */
export default class TargetedSystemMessagesController {
  /**
   * Create targeted system message for specific users
   * Used for: Co-organizer assignments, role-specific notifications
   */
  static async createTargetedSystemMessage(
    messageData: {
      title: string;
      content: string;
      type?: string;
      priority?: string;
      hideCreator?: boolean;
      targetRoles?: string[];
      metadata?: Record<string, unknown>;
      expiresAt?: Date;
    },
    targetUserIds: string[],
    creator?: {
      id: string;
      firstName: string;
      lastName: string;
      username: string;
      avatar?: string;
      gender: string;
      authLevel: string;
      roleInAtCloud?: string;
    },
    deliveryOptions: TargetedSystemMessageDeliveryOptions = {},
  ): Promise<IMessage> {
    try {
      // Use system creator if none provided
      const messageCreator = creator || {
        id: "system",
        firstName: "System",
        lastName: "Administrator",
        username: "system",
        avatar: "/default-avatar-male.jpg", // System default avatar
        gender: "male",
        authLevel: "Super Admin",
        roleInAtCloud: "System",
      };

      const uniqueTargetUserIds = Array.from(new Set(targetUserIds));
      const targetRecipients =
        await TargetedSystemMessagesController.resolveTargetRecipients(
          uniqueTargetUserIds,
          messageData.targetRoles,
        );
      const targetUserIdsForMessage = targetRecipients.map(({ id }) => id);

      // Create targeted message
      const targetedMessage = new Message({
        title: messageData.title,
        content: messageData.content,
        type: messageData.type || "assignment",
        priority: messageData.priority || "high",
        hideCreator: messageData.hideCreator === true,
        creator: messageCreator,
        isActive: true,
        targetRoles: messageData.targetRoles,
        metadata: messageData.metadata,
        expiresAt: messageData.expiresAt,
        // For single-recipient messages that target specific users, persist the target for frontend filtering
        targetUserId:
          (messageData.type === "auth_level_change" ||
            messageData.type === "event_role_change") &&
          targetUserIdsForMessage.length === 1
            ? targetUserIdsForMessage[0]
            : undefined,
        userStates: new Map(),
      });

      // Initialize user states for target users only
      for (const { id: userId } of targetRecipients) {
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
        targetedMessage.userStates.set(userId, userState);
      }

      await targetedMessage.save();

      // Invalidate user caches for targeted message recipients
      for (const { id: userId } of targetRecipients) {
        await CachePatterns.invalidateUserCache(userId);
      }

      // Emit real-time notifications only to target users
      for (const { id: userId, role: userRole } of targetRecipients) {
        if (deliveryOptions.emitMessageCreatedEvent !== false) {
          socketService.emitSystemMessageUpdate(userId, "message_created", {
            message: serializeSystemMessageForRecipient(
              targetedMessage,
              userId,
            ),
          });

          console.log(
            `🔔 Emitted system_message_update for user ${userId}: "${targetedMessage.getBellDisplayTitle()}"`,
          );
        }

        // Update unread counts for target user
        try {
          const updatedCounts = await MessageModel.getUnreadCountsForUser(
            userId,
            userRole,
          );
          socketService.emitUnreadCountUpdate(userId, updatedCounts);
        } catch (error) {
          console.error(
            `Failed to emit unread count update for user ${userId}:`,
            error
          );
        }
      }

      return targetedMessage;
    } catch (error) {
      console.error("Error creating targeted system message:", error);
      throw error;
    }
  }

  private static async resolveTargetRecipients(
    targetUserIds: string[],
    targetRoles?: string[],
  ): Promise<TargetRecipient[]> {
    if (targetUserIds.length === 0) {
      return [];
    }

    const query: Record<string, unknown> = {
      _id: { $in: targetUserIds },
    };
    if (targetRoles && targetRoles.length > 0) {
      query.role = { $in: targetRoles };
    }

    const allowedUsers = await User.find(query).select("_id role");
    const allowedUsersById = new Map(
      allowedUsers.map((user) => [
        user._id.toString(),
        { id: user._id.toString(), role: user.role },
      ]),
    );

    return targetUserIds.flatMap((userId) => {
      const recipient = allowedUsersById.get(userId);
      return recipient ? [recipient] : [];
    });
  }
}
