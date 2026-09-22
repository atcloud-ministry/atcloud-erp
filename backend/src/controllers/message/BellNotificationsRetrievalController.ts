import { Request, Response } from "express";
import Message from "../../models/Message";
import User from "../../models/User";
import { isMessageRoleVisible } from "../../utils/messageAuthorization";
import { serializeSystemMessageMetadata } from "../../serializers/systemMessageRealtimeSerializer";

// Minimal runtime shapes to reduce explicit any usage without changing behavior
type UserStateRecord = {
  isReadInSystem?: boolean;
  isReadInBell?: boolean;
  isRemovedFromBell?: boolean;
  isDeletedFromSystem?: boolean;
  readInSystemAt?: unknown;
  readInBellAt?: unknown;
  removedFromBellAt?: unknown;
  deletedFromSystemAt?: unknown;
  lastInteractionAt?: unknown;
};

type MessageDocLike = {
  _id: unknown;
  title: string;
  content: string;
  type: string;
  priority: string;
  creator: {
    firstName?: string;
    lastName?: string;
    authLevel?: string;
    roleInAtCloud?: string;
  };
  userStates: Map<string, UserStateRecord> | Record<string, UserStateRecord>;
  createdAt: unknown;
  getBellDisplayTitle?: () => string;
  canRemoveFromBell?: (userId: string) => boolean;
  toJSON?: () => unknown;
  metadata?: unknown;
  hideCreator?: boolean;
  createdBy?: unknown;
  targetUserId?: string;
};

type BellCreatorDTO = {
  firstName?: string;
  lastName?: string;
  authLevel?: string;
  roleInAtCloud?: string;
};

function getUserState(
  message: MessageDocLike,
  userId: string
): UserStateRecord | undefined {
  const states = message.userStates as MessageDocLike["userStates"] | undefined;
  if (!states) return undefined;
  if (states instanceof Map) {
    return states.get(userId);
  }
  return (states as Record<string, UserStateRecord>)[userId];
}

function serializeBellCreator(
  message: MessageDocLike,
): BellCreatorDTO | undefined {
  if (message.hideCreator === true || !message.creator) return undefined;

  return {
    firstName: message.creator.firstName,
    lastName: message.creator.lastName,
    authLevel: message.creator.authLevel,
    roleInAtCloud: message.creator.roleInAtCloud,
  };
}

/**
 * Bell Notifications Retrieval Controller
 * Handles fetching bell notifications for the dropdown
 */
export default class BellNotificationsRetrievalController {
  /**
   * Get bell notifications for current user
   * Used by: Bell notification dropdown
   */
  static async getBellNotifications(
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

      // Get current user to check their role for targetRoles filtering
      const currentUser = await User.findById(userId).select("role");
      if (!currentUser) {
        res.status(404).json({
          success: false,
          message: "User not found",
        });
        return;
      }

      // Get messages that should appear in bell notifications - Fixed for Mongoose Map compatibility
      const allMessages = await Message.find({
        isActive: true,
        userStates: { $exists: true },
      }).sort({ createdAt: -1 });

      // Filter messages that have the user in userStates and are not removed from bell
      // AND check targetRoles if specified
      const userMessages = allMessages.filter((message) => {
        if (!message.userStates) {
          return false;
        }

        // Handle both Map and Object userStates
        let userState;
        if (message.userStates instanceof Map) {
          if (!message.userStates.has(userId)) {
            return false;
          }
          userState = message.userStates.get(userId);
        } else {
          // userStates is a plain object
          if (!message.userStates[userId]) {
            return false;
          }
          userState = message.userStates[userId];
        }

        const hasValidUserState = userState && !userState.isRemovedFromBell;
        if (!hasValidUserState) {
          return false;
        }

        if (!isMessageRoleVisible(message.targetRoles, currentUser.role)) {
          return false;
        }

        return true;
      });

      // Transform for bell notification display
      const notifications = userMessages.map((message) => {
        const m = message as unknown as MessageDocLike;
        const userState = getUserState(m, userId) as
          | UserStateRecord
          | undefined;
        const creator = serializeBellCreator(m);
        const metadata = serializeSystemMessageMetadata(m.metadata);
        return {
          id: m._id,
          title: m.getBellDisplayTitle ? m.getBellDisplayTitle() : m.title,
          content: m.content,
          type: m.type,
          priority: m.priority,
          createdAt: m.createdAt,
          isRead: Boolean(userState?.isReadInBell),
          readAt: userState?.readInBellAt,
          showRemoveButton: m.canRemoveFromBell
            ? m.canRemoveFromBell(userId)
            : true,
          ...(metadata ? { metadata } : {}),
          ...(creator ? { creator } : {}),
        };
      });

      const unreadCount = notifications.filter((n) => !n.isRead).length;

      res.status(200).json({
        success: true,
        data: {
          notifications,
          unreadCount,
        },
      });
    } catch (error) {
      console.error("Error in getBellNotifications:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
}
