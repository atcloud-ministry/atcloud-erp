import { Request, Response } from "express";
import Message from "../../models/Message";
import User from "../../models/User";
import { isMessageRoleVisible } from "../../utils/messageAuthorization";
import { serializeSystemMessageMetadata } from "../../serializers/systemMessageRealtimeSerializer";

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

/**
 * System Messages Retrieval Controller
 * Handles fetching system messages for the System Messages page
 */
export default class SystemMessagesRetrievalController {
  /**
   * Get system messages for current user
   * Used by: System Messages page (/dashboard/system-messages)
   */
  static async getSystemMessages(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const type = req.query.type as string;

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

      // Build query filters - Fixed for Mongoose Map compatibility
      const filters: Record<string, unknown> = {
        isActive: true,
        // For Mongoose Maps, we need to query differently
        userStates: { $exists: true },
      };

      if (type) {
        filters.type = type;
      }

      // Get messages with pagination - we'll filter in-memory for Map compatibility
      const skip = (page - 1) * limit;
      const allMessages = await Message.find(filters).sort({ createdAt: -1 });

      console.log(
        `Found ${allMessages.length} total messages for user ${userId}`
      );

      // Filter messages that have the user in userStates and are not deleted
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

        const hasValidUserState = userState && !userState.isDeletedFromSystem;
        if (!hasValidUserState) {
          return false;
        }

        if (!isMessageRoleVisible(message.targetRoles, currentUser.role)) {
          return false;
        }

        return true;
      });
      console.log(
        `After filtering, found ${userMessages.length} messages for user ${userId}`
      );

      // Apply pagination to filtered results
      const paginatedMessages = userMessages.slice(skip, skip + limit);
      const totalCount = userMessages.length;

      // Transform for frontend
      const transformedMessages = paginatedMessages.map((message) => {
        const m = message as unknown as MessageDocLike;
        const userState = getUserState(m, userId) as
          | UserStateRecord
          | undefined;

        // Infer targetUserId for legacy messages that missed this field
        let targetUserId = m.targetUserId;
        if (
          !targetUserId &&
          (m.type === "auth_level_change" || m.type === "event_role_change")
        ) {
          try {
            const states = m.userStates;
            if (states instanceof Map) {
              if (states.size === 1) {
                const [onlyKey] = Array.from(states.keys());
                targetUserId = onlyKey;
              }
            } else if (states && typeof states === "object") {
              const keys = Object.keys(states as Record<string, unknown>);
              if (keys.length === 1) {
                targetUserId = keys[0];
              }
            }
          } catch {
            // Ignore inference errors; targetUserId will remain undefined
          }
        }

        const visibleTargetUserId =
          targetUserId === userId ? targetUserId : undefined;

        return {
          id: m._id,
          title: m.title,
          content: m.content,
          type: m.type,
          priority: m.priority,
          // Include metadata so clients can render contextual CTAs (e.g., View Event Details)
          metadata: serializeSystemMessageMetadata(m.metadata),
          // Hide creator in API response when hideCreator flag is set
          creator: m.hideCreator ? undefined : m.creator,
          targetUserId: visibleTargetUserId,
          createdAt: m.createdAt,
          isRead: Boolean(userState?.isReadInSystem),
          readAt: userState?.readInSystemAt,
        };
      });

      res.status(200).json({
        success: true,
        data: {
          messages: transformedMessages,
          pagination: {
            currentPage: page,
            totalPages: Math.ceil(totalCount / limit),
            totalCount,
            hasNext: skip + limit < totalCount,
            hasPrev: skip > 0,
          },
          unreadCount: transformedMessages.filter((msg) => !msg.isRead).length,
        },
      });
    } catch (error) {
      console.error("Error in getSystemMessages:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
}
