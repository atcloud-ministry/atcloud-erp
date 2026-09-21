import { Request, Response } from "express";
import { Types } from "mongoose";
import Message from "../../models/Message";
import User from "../../models/User";
import { socketService } from "../../services/infrastructure/SocketService";
import { CachePatterns } from "../../services/infrastructure/CacheService";
import { serializeSystemMessageForRecipient } from "../../serializers/systemMessageRealtimeSerializer";
import { ROLES, RoleUtils, type UserRole } from "../../utils/roleUtils";

// Minimal runtime shapes to reduce explicit any usage without changing behavior
type UnreadCounts = {
  bellNotifications: number;
  systemMessages: number;
  total: number;
};

const MessageModel = Message as unknown as {
  getUnreadCountsForUser: (
    userId: string,
    userRole: string,
  ) => Promise<UnreadCounts>;
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
  getBellDisplayTitle?: () => string;
  hideCreator?: boolean;
  createdBy?: unknown;
  createdAt: unknown;
};

/**
 * System Messages Creation Controller
 * Handles creation of broadcast system messages (Admin only)
 */
export default class SystemMessagesCreationController {
  /**
   * Create new system message (Admin only)
   * Automatically creates bell notifications for all users
   */
  static async createSystemMessage(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      const { title, content, type, priority, targetRoles, excludeUserIds } =
        req.body as {
          title: string;
          content: string;
          type?: string;
          priority?: string;
          targetRoles?: unknown;
          excludeUserIds?: unknown;
        };
      // Determine whether to include creator info in the message presentation
      // Accept both includeCreator (preferred from UI) and hideCreator (for flexibility)
      const includeCreatorFlagRaw = (req.body as Record<string, unknown>)[
        "includeCreator"
      ];
      const hideCreatorFlagRaw = (req.body as Record<string, unknown>)[
        "hideCreator"
      ];
      // Default is to include creator unless explicitly disabled
      const includeCreatorFlag =
        typeof includeCreatorFlagRaw === "boolean"
          ? includeCreatorFlagRaw
          : includeCreatorFlagRaw === "false"
          ? false
          : includeCreatorFlagRaw === "true"
          ? true
          : true;
      const hideCreator =
        typeof hideCreatorFlagRaw === "boolean"
          ? hideCreatorFlagRaw
          : hideCreatorFlagRaw === "true"
          ? true
          : hideCreatorFlagRaw === "false"
          ? false
          : !includeCreatorFlag;

      if (!userId) {
        res.status(401).json({
          success: false,
          message: "Authentication required",
        });
        return;
      }

      const requestBody = req.body as Record<string, unknown>;
      const hasTargetRoles = Object.prototype.hasOwnProperty.call(
        requestBody,
        "targetRoles",
      );
      let normalizedTargetRoles: UserRole[] | undefined;

      if (hasTargetRoles) {
        const roleLimit = Object.values(ROLES).length;
        if (
          !Array.isArray(targetRoles) ||
          targetRoles.length === 0 ||
          targetRoles.length > roleLimit ||
          !targetRoles.every(
            (role) => typeof role === "string" && RoleUtils.isValidRole(role),
          )
        ) {
          res.status(400).json({
            success: false,
            message: "targetRoles must be a non-empty array of valid roles",
          });
          return;
        }

        normalizedTargetRoles = Array.from(
          new Set(targetRoles as UserRole[]),
        );
      }

      const hasExcludeUserIds = Object.prototype.hasOwnProperty.call(
        requestBody,
        "excludeUserIds",
      );
      let normalizedExcludedUserIds: Set<string> | undefined;

      if (hasExcludeUserIds) {
        if (
          !Array.isArray(excludeUserIds) ||
          !excludeUserIds.every(
            (excludedUserId) =>
              typeof excludedUserId === "string" &&
              Types.ObjectId.isValid(excludedUserId),
          )
        ) {
          res.status(400).json({
            success: false,
            message: "excludeUserIds must be an array of valid user IDs",
          });
          return;
        }

        normalizedExcludedUserIds = new Set(
          excludeUserIds.map((excludedUserId) =>
            new Types.ObjectId(excludedUserId as string).toString(),
          ),
        );
      }

      // Get creator information
      const creator = await User.findById(userId).select(
        "firstName lastName username avatar gender roleInAtCloud role"
      );

      if (!creator) {
        res.status(404).json({
          success: false,
          message: "User not found",
        });
        return;
      }

      // Check permissions (non-Participant can create)
      if (creator.role === "Participant") {
        res.status(403).json({
          success: false,
          message: "Insufficient permissions to create system messages",
        });
        return;
      }

      // Get all users to initialize states
      // 🔒 OPTIMIZATION: If targetRoles is specified, only get users with matching roles
      let allUsers;
      if (normalizedTargetRoles) {
        // Only get users whose role matches one of the targetRoles
        allUsers = await User.find(
          { role: { $in: normalizedTargetRoles } },
          "_id role",
        );
        console.log(
          `🎯 Creating message for ${
            allUsers.length
          } users with roles: ${normalizedTargetRoles.join(", ")}`,
        );
      } else {
        // No targetRoles specified, get all users
        allUsers = await User.find({}, "_id role");
        console.log(
          `📢 Creating broadcast message for ${allUsers.length} users`
        );
      }

      let recipients = allUsers.map((user) => ({
        id: String((user as unknown as { _id: unknown })._id),
        role: String((user as unknown as { role: unknown }).role),
      }));

      // Exclude specific users if excludeUserIds is provided
      if (normalizedExcludedUserIds) {
        recipients = recipients.filter(
          ({ id }) => !normalizedExcludedUserIds.has(id),
        );
        console.log(
          `📝 Excluding ${normalizedExcludedUserIds.size} users from system message`,
        );
      } // Create message with all user states initialized
      const messageData = {
        title,
        content,
        type: type || "announcement",
        priority: priority || "medium",
        creator: {
          id: String((creator as unknown as { _id: unknown })._id),
          firstName: creator.firstName,
          lastName: creator.lastName,
          username: creator.username,
          avatar: creator.avatar,
          gender: creator.gender,
          roleInAtCloud: creator.roleInAtCloud,
          authLevel: creator.role, // Using role property from User model
        },
        targetRoles: normalizedTargetRoles,
        isActive: true,
        createdBy: (creator as unknown as { _id: unknown })._id, // Add createdBy field for test compatibility
      };

      // ✅ MIGRATED: Using standardized createTargetedSystemMessage pattern
      // ⚠️ DEPRECATED: Message.createForAllUsers pattern
      // 📋 MIGRATION: Replace with UnifiedMessageController.createTargetedSystemMessage
      // 🔗 Reference: TRIO_SYSTEM_REFACTORING_BLUEPRINT.md - Phase 1
      // 📋 REFACTORING: Replaced deprecated Message.createForAllUsers with direct Message creation
      // 🔗 Reference: TRIO_SYSTEM_REFACTORING_BLUEPRINT.md - Phase 1

      // Create message using standardized pattern (same as createTargetedSystemMessage)
      // Note: We always store creator details for auditability, but respect hideCreator
      // at API and serialization layers so clients won't see creator when hidden.
      const message = new Message({
        title: messageData.title,
        content: messageData.content,
        type: messageData.type,
        priority: messageData.priority,
        creator: messageData.creator,
        hideCreator,
        targetRoles: messageData.targetRoles, // 🎯 Store targetRoles for filtering
        isActive: true,
        userStates: new Map(),
      });

      // Initialize user states for all target users
      for (const { id: userId } of recipients) {
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
        message.userStates.set(userId, userState);
      }

      await message.save();

      // Invalidate user caches for message recipients
      for (const { id: userId } of recipients) {
        await CachePatterns.invalidateUserCache(userId);
      }

      // Emit real-time notifications to target users (standardized pattern)
      for (const { id: userId, role: userRole } of recipients) {
        socketService.emitSystemMessageUpdate(userId, "message_created", {
          message: serializeSystemMessageForRecipient(message, userId),
        });

        // ✅ REMOVED: Redundant bell_notification_update emission
        // Bell notifications are now created by frontend from system_message_update events
        // This eliminates duplicate processing and simplifies the architecture

        console.log(
          `🔔 Emitted system_message_update for user ${userId}: "${message.getBellDisplayTitle()}"`
        );

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

      res.status(201).json({
        success: true,
        message: "System message created successfully",
        data: {
          message: {
            id: message._id,
            title: message.title,
            content: message.content,
            type: message.type,
            priority: message.priority,
            // Hide creator in immediate response if requested
            creator: (message as unknown as MessageDocLike).hideCreator
              ? undefined
              : (message as unknown as MessageDocLike).creator,
            hideCreator: (message as unknown as MessageDocLike).hideCreator,
            createdBy: message.createdBy, // Include createdBy in response
            createdAt: message.createdAt,
            recipientCount: recipients.length,
          },
        },
      });
    } catch (error) {
      console.error("Error in createSystemMessage:", error);

      // Handle validation errors with appropriate status code
      if (error instanceof Error && error.name === "ValidationError") {
        res.status(400).json({
          success: false,
          message: "Title and content are required",
        });
        return;
      }

      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
}
