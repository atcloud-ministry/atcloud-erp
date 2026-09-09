import mongoose, { Schema, Document } from "mongoose";
import {
  buildMessageRoleVisibilityClauses,
  isMessageRoleVisible,
} from "../utils/messageAuthorization";

export class MessageRecipientStateNotFoundError extends Error {
  readonly code = "MESSAGE_RECIPIENT_STATE_NOT_FOUND";

  constructor() {
    super("Message recipient state does not exist");
    this.name = "MessageRecipientStateNotFoundError";
  }
}

function hasRecipientState(
  userStates: Map<string, unknown> | Record<string, unknown> | undefined,
  userId: string
): boolean {
  if (!userStates) return false;
  if (typeof (userStates as Map<string, unknown>).has === "function") {
    return (userStates as Map<string, unknown>).has(userId);
  }
  return Object.prototype.hasOwnProperty.call(userStates, userId);
}

/**
 * Unified Message System - Single Source of Truth
 *
 * This model replaces the previous dual system (SystemMessage + separate notification states)
 * with a unified approach that maintains the same user experience while simplifying the architecture.
 *
 * Features:
 * - Single message document represents both system message and bell notification
 * - User-specific state tracking embedded in the document
 * - Maintains original design: bell notifications + system messages page
 * - Simplified state management and synchronization
 */

export interface IMessage extends Document {
  // Mongoose document id
  _id: mongoose.Types.ObjectId;
  // Message Content
  title: string;
  content: string;
  type:
    | "announcement"
    | "maintenance"
    | "update"
    | "warning"
    | "auth_level_change"
    | "atcloud_role_change"
    | "event_role_change"
    | "user_management"; // Admin-facing user management actions (deactivate/reactivate/delete)
  priority: "low" | "medium" | "high";

  // Creator Information
  creator: {
    id: string;
    firstName: string;
    lastName: string;
    username: string;
    avatar?: string;
    gender: "male" | "female";
    roleInAtCloud?: string;
    authLevel: string; // "Super Admin", "Administrator", etc.
  };
  // Presentation hint: when true, omit creator from API responses
  hideCreator?: boolean;
  createdBy?: mongoose.Types.ObjectId; // For test compatibility

  // Targeting & Lifecycle
  isActive: boolean;
  targetRoles?: string[]; // Optional: target specific roles
  targetUserId?: string; // Optional: target specific user for auth_level_change messages
  expiresAt?: Date;

  // User-Specific States (embedded for performance)
  userStates: Map<
    string,
    {
      // Bell Notification State
      isReadInBell: boolean;
      readInBellAt?: Date;
      isRemovedFromBell: boolean;
      removedFromBellAt?: Date;

      // System Message State
      isReadInSystem: boolean;
      readInSystemAt?: Date;
      isDeletedFromSystem: boolean;
      deletedFromSystemAt?: Date;

      // Unified state (computed)
      lastInteractionAt?: Date;
    }
  >;

  // Metadata
  metadata?: Record<string, unknown>; // Flexible metadata container (e.g., { eventId, kind })
  createdAt: Date;
  updatedAt: Date;

  // Methods
  getUserState(userId: string): {
    isReadInBell: boolean;
    isRemovedFromBell: boolean;
    isReadInSystem: boolean;
    isDeletedFromSystem: boolean;
    readInBellAt?: Date;
    readInSystemAt?: Date;
    removedFromBellAt?: Date;
    deletedFromSystemAt?: Date;
    lastInteractionAt?: Date;
  };
  updateUserState(
    userId: string,
    updates: Partial<{
      isReadInBell: boolean;
      isRemovedFromBell: boolean;
      isReadInSystem: boolean;
      isDeletedFromSystem: boolean;
      readInBellAt?: Date;
      readInSystemAt?: Date;
      removedFromBellAt?: Date;
      deletedFromSystemAt?: Date;
      lastInteractionAt?: Date;
    }>
  ): void;
  markAsReadInBell(userId: string): void;
  markAsReadInSystem(userId: string): void;
  markAsReadEverywhere(userId: string): void;
  removeFromBell(userId: string): void;
  deleteFromSystem(userId: string): void;
  shouldShowInBell(userId: string, userRole: string): boolean;
  shouldShowInSystem(userId: string, userRole: string): boolean;
  getBellDisplayTitle(): string;
  canRemoveFromBell(userId: string): boolean;
}

// Interface for the Message model with static methods
export interface IMessageModel extends mongoose.Model<IMessage> {
  getBellNotificationsForUser(userId: string, userRole: string): Promise<
    Array<{
      id: mongoose.Types.ObjectId;
      title: string;
      content: string;
      type: IMessage["type"];
      priority: IMessage["priority"];
      createdAt: Date;
      isRead: boolean;
      readAt?: Date;
      showRemoveButton: boolean;
      creator?: {
        firstName: string;
        lastName: string;
        authLevel: string;
        roleInAtCloud?: string;
      };
      metadata?: Record<string, unknown>;
    }>
  >;
  getSystemMessagesForUser(
    userId: string,
    userRole: string,
    page?: number,
    limit?: number
  ): Promise<{
    messages: Array<{
      id: mongoose.Types.ObjectId;
      title: string;
      content: string;
      type: IMessage["type"];
      priority: IMessage["priority"];
      creator?: IMessage["creator"];
      createdAt: Date;
      isRead: boolean;
      readAt?: Date;
      metadata?: Record<string, unknown>;
    }>;
    pagination: {
      currentPage: number;
      totalPages: number;
      totalCount: number;
      hasNext: boolean;
      hasPrev: boolean;
    };
  }>;
  getUnreadCountsForUser(userId: string, userRole: string): Promise<{
    bellNotifications: number;
    systemMessages: number;
    total: number;
  }>;
  createForAllUsers(
    messageData: Partial<IMessage>,
    userIds: string[]
  ): Promise<IMessage>;
  createForSpecificUser(
    messageData: Partial<IMessage>,
    userId: string
  ): Promise<IMessage>;
}

const messageSchema: Schema = new Schema(
  {
    title: {
      type: String,
      required: [true, "Message title is required"],
      maxlength: [200, "Title cannot exceed 200 characters"],
      trim: true,
    },
    content: {
      type: String,
      required: [true, "Message content is required"],
      maxlength: [5000, "Content cannot exceed 5000 characters"],
      trim: true,
    },
    type: {
      type: String,
      enum: [
        "announcement",
        "maintenance",
        "update",
        "warning",
        "auth_level_change",
        "atcloud_role_change",
        "event_role_change",
        "user_management",
      ],
      required: [true, "Message type is required"],
      default: "announcement",
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "medium",
    },
    hideCreator: {
      type: Boolean,
      default: false,
      index: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: undefined,
    },
    creator: {
      id: {
        type: String,
        required: [true, "Creator ID is required"],
      },
      firstName: {
        type: String,
        required: [true, "Creator first name is required"],
        trim: true,
      },
      lastName: {
        type: String,
        required: [true, "Creator last name is required"],
        trim: true,
      },
      username: {
        type: String,
        required: [true, "Creator username is required"],
        trim: true,
      },
      avatar: {
        type: String,
        trim: true,
      },
      gender: {
        type: String,
        enum: ["male", "female"],
        required: [true, "Creator gender is required"],
      },
      roleInAtCloud: {
        type: String,
        trim: true,
      },
      authLevel: {
        type: String,
        required: [true, "Creator auth level is required"],
        trim: true,
      },
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true, // For efficient queries
    },
    targetRoles: [
      {
        type: String,
        trim: true,
      },
    ],
    targetUserId: {
      type: String,
      trim: true,
      index: true, // For efficient filtering of auth_level_change messages
    },
    expiresAt: {
      type: Date,
      // Note: Do not define a simple index here; a TTL index for expiresAt is
      // declared below via messageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
    },
    userStates: {
      type: Map,
      of: {
        // Bell Notification State
        isReadInBell: {
          type: Boolean,
          default: false,
        },
        readInBellAt: Date,
        isRemovedFromBell: {
          type: Boolean,
          default: false,
        },
        removedFromBellAt: Date,

        // System Message State
        isReadInSystem: {
          type: Boolean,
          default: false,
        },
        readInSystemAt: Date,
        isDeletedFromSystem: {
          type: Boolean,
          default: false,
        },
        deletedFromSystemAt: Date,

        // Unified tracking
        lastInteractionAt: Date,
      },
      default: new Map(),
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: function (_doc: unknown, ret: Record<string, unknown>) {
        delete ret.userStates;
        delete ret.targetRoles;
        delete ret.createdBy;
        delete ret.targetUserId;
        // Enforce hideCreator flag at serialization layer
        if ((ret as { hideCreator?: boolean }).hideCreator) {
          (ret as Record<string, unknown>).creator = undefined;
        }
        return ret;
      },
    },
    toObject: {
      virtuals: true,
      transform: function (_doc: unknown, ret: Record<string, unknown>) {
        // Convert Map to Object for object serialization
        if (ret.userStates instanceof Map) {
          (ret as Record<string, unknown>).userStates = Object.fromEntries(
            ret.userStates as Map<string, unknown>
          );
        }
        if ((ret as { hideCreator?: boolean }).hideCreator) {
          (ret as Record<string, unknown>).creator = undefined;
        }
        return ret;
      },
    },
  }
);

// Indexes for performance
messageSchema.index({ isActive: 1, createdAt: -1 });
messageSchema.index({ type: 1, isActive: 1 });
messageSchema.index({ priority: 1, isActive: 1 });
messageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL index

// Instance Methods
messageSchema.methods = {
  /**
   * Get user-specific state for this message
   */
  getUserState(userId: string) {
    const state = this.userStates.get(userId);
    if (!state) {
      return {
        isReadInBell: false,
        isRemovedFromBell: false,
        isReadInSystem: false,
        isDeletedFromSystem: false,
      };
    }

    // Convert Mongoose subdocument to plain object
    return {
      isReadInBell: state.isReadInBell || false,
      isRemovedFromBell: state.isRemovedFromBell || false,
      isReadInSystem: state.isReadInSystem || false,
      isDeletedFromSystem: state.isDeletedFromSystem || false,
      readInBellAt: state.readInBellAt,
      readInSystemAt: state.readInSystemAt,
      removedFromBellAt: state.removedFromBellAt,
      deletedFromSystemAt: state.deletedFromSystemAt,
      lastInteractionAt: state.lastInteractionAt,
    };
  },

  /**
   * Update user state for this message
   */
  updateUserState(
    userId: string,
    updates: Partial<{
      isReadInBell: boolean;
      isRemovedFromBell: boolean;
      isReadInSystem: boolean;
      isDeletedFromSystem: boolean;
      readInBellAt?: Date;
      readInSystemAt?: Date;
      removedFromBellAt?: Date;
      deletedFromSystemAt?: Date;
      lastInteractionAt?: Date;
    }>
  ) {
    if (!hasRecipientState(this.userStates, userId)) {
      throw new MessageRecipientStateNotFoundError();
    }

    const currentState = this.getUserState(userId);
    const newState = {
      ...currentState,
      ...updates,
      lastInteractionAt: new Date(),
    };

    this.userStates.set(userId, newState);
    this.markModified("userStates");
  },

  /**
   * Mark message as read in bell notifications
   */
  markAsReadInBell(userId: string) {
    this.updateUserState(userId, {
      isReadInBell: true,
      readInBellAt: new Date(),
    });
  },

  /**
   * Mark message as read in system messages
   */
  markAsReadInSystem(userId: string) {
    this.updateUserState(userId, {
      isReadInSystem: true,
      readInSystemAt: new Date(),
    });
  },

  /**
   * Mark message as read in both places (unified read)
   */
  markAsReadEverywhere(userId: string) {
    const now = new Date();
    this.updateUserState(userId, {
      isReadInBell: true,
      readInBellAt: now,
      isReadInSystem: true,
      readInSystemAt: now,
    });
  },

  /**
   * Remove message from bell notifications (but keep in system messages)
   */
  removeFromBell(userId: string) {
    this.updateUserState(userId, {
      isRemovedFromBell: true,
      removedFromBellAt: new Date(),
    });
  },

  /**
   * Delete message from system messages (and auto-remove from bell per REQ 9)
   */
  deleteFromSystem(userId: string) {
    this.updateUserState(userId, {
      isDeletedFromSystem: true,
      deletedFromSystemAt: new Date(),
      isRemovedFromBell: true, // REQ 9: Auto-remove from bell when deleted from system
      removedFromBellAt: new Date(),
    });
  },

  /**
   * Check if message should appear in bell notifications for user
   */
  shouldShowInBell(userId: string, userRole: string): boolean {
    if (!hasRecipientState(this.userStates, userId)) {
      return false;
    }
    if (!isMessageRoleVisible(this.targetRoles, userRole)) {
      return false;
    }
    const state = this.getUserState(userId);
    return this.isActive && !state.isRemovedFromBell;
  },

  /**
   * Check if message should appear in system messages for user
   */
  shouldShowInSystem(userId: string, userRole: string): boolean {
    if (!hasRecipientState(this.userStates, userId)) {
      return false;
    }
    if (!isMessageRoleVisible(this.targetRoles, userRole)) {
      return false;
    }
    const state = this.getUserState(userId);
    return this.isActive && !state.isDeletedFromSystem;
  },

  /**
   * Get display title for bell notifications
   */
  getBellDisplayTitle(): string {
    // Return the actual message title for navigation (REQ 10)
    return this.title;
  },

  /**
   * Check if user can remove from bell (typically after reading)
   */
  canRemoveFromBell(userId: string): boolean {
    const state = this.getUserState(userId);
    return state.isReadInBell && !state.isRemovedFromBell;
  },
};

// Static Methods
messageSchema.statics.getBellNotificationsForUser = async function (
  userId: string,
  userRole: string
) {
  const messages = await this.find({
    isActive: true,
    [`userStates.${userId}`]: { $exists: true }, // Only messages where user exists in userStates
    [`userStates.${userId}.isRemovedFromBell`]: { $ne: true },
    $or: buildMessageRoleVisibilityClauses(userRole),
  }).sort({ createdAt: -1 });

  return messages.map((message: IMessage) => {
    const userState = message.getUserState(userId);
    return {
      id: message._id,
      title: message.getBellDisplayTitle(),
      content: message.content,
      type: message.type,
      priority: message.priority,
      createdAt: message.createdAt,
      isRead: userState.isReadInBell,
      readAt: userState.readInBellAt,
      showRemoveButton: message.canRemoveFromBell(userId),
      // REQ 4: Include "From" information for bell notifications (unless hidden)
      creator: (message as unknown as { hideCreator?: boolean }).hideCreator
        ? undefined
        : {
            firstName: message.creator.firstName,
            lastName: message.creator.lastName,
            authLevel: message.creator.authLevel,
            roleInAtCloud: message.creator.roleInAtCloud,
          },
      metadata: message.metadata,
    };
  });
};

messageSchema.statics.getSystemMessagesForUser = async function (
  userId: string,
  userRole: string,
  page = 1,
  limit = 20
) {
  const skip = (page - 1) * limit;

  const visibilityFilter = {
    isActive: true,
    [`userStates.${userId}`]: { $exists: true },
    [`userStates.${userId}.isDeletedFromSystem`]: { $ne: true },
    $or: buildMessageRoleVisibilityClauses(userRole),
  };

  const messages = await this.find(visibilityFilter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);

  const total = await this.countDocuments(visibilityFilter);

  return {
    messages: messages.map((message: IMessage) => {
      const userState = message.getUserState(userId);
      return {
        id: message._id,
        title: message.title,
        content: message.content,
        type: message.type,
        priority: message.priority,
        creator: (message as unknown as { hideCreator?: boolean }).hideCreator
          ? undefined
          : message.creator,
        createdAt: message.createdAt,
        isRead: userState.isReadInSystem,
        readAt: userState.readInSystemAt,
        metadata: message.metadata,
      };
    }),
    pagination: {
      currentPage: page,
      totalPages: Math.ceil(total / limit),
      totalCount: total,
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
  };
};

messageSchema.statics.getUnreadCountsForUser = async function (
  userId: string,
  userRole: string
) {
  const roleVisibility = buildMessageRoleVisibilityClauses(userRole);
  const bellNotificationsCount = await this.countDocuments({
    isActive: true,
    [`userStates.${userId}`]: { $exists: true }, // Only messages where user exists in userStates
    [`userStates.${userId}.isRemovedFromBell`]: { $ne: true },
    [`userStates.${userId}.isReadInBell`]: { $ne: true },
    $or: roleVisibility,
  });

  const systemMessagesCount = await this.countDocuments({
    isActive: true,
    [`userStates.${userId}`]: { $exists: true }, // Only messages where user exists in userStates
    [`userStates.${userId}.isDeletedFromSystem`]: { $ne: true },
    [`userStates.${userId}.isReadInSystem`]: { $ne: true },
    $or: roleVisibility,
  });

  return {
    bellNotifications: bellNotificationsCount,
    systemMessages: systemMessagesCount,
    total: bellNotificationsCount, // Bell notifications drive the main notification count
  };
};

messageSchema.statics.createForAllUsers = async function (
  messageData: Partial<IMessage>,
  userIds: string[]
) {
  const message = new this(messageData);

  // Initialize user states for all users
  const userStatesMap = new Map();
  userIds.forEach((userId) => {
    userStatesMap.set(userId, {
      isReadInBell: false,
      isRemovedFromBell: false,
      isReadInSystem: false,
      isDeletedFromSystem: false,
    });
  });

  message.userStates = userStatesMap;
  await message.save();

  return message;
};

messageSchema.statics.createForSpecificUser = async function (
  messageData: Partial<IMessage>,
  userId: string
) {
  const message = new this(messageData);

  // Initialize user state for single user
  const userStatesMap = new Map();
  userStatesMap.set(userId, {
    isReadInBell: false,
    isRemovedFromBell: false,
    isReadInSystem: false,
    isDeletedFromSystem: false,
  });

  message.userStates = userStatesMap;
  await message.save();

  return message;
};

// Handle model re-compilation in test environments
export const Message: IMessageModel =
  (mongoose.models.Message as IMessageModel) ||
  mongoose.model<IMessage, IMessageModel>("Message", messageSchema);
export default Message;
