export interface Notification {
  id: string;
  type:
    | "system"
    | "user_message"
    | "management_action"
    | "SYSTEM_MESSAGE"
    | "USER_ACTION"
    | "EVENT_UPDATE";
  // REMOVED: "EVENT_REMINDER" - was frontend remnant causing duplicate bell notifications
  title: string;
  message: string;
  isRead: boolean;
  priority?: "high" | "medium" | "low";
  createdAt: string;
  userId: string;

  // For user actions
  actionType?: "promotion" | "demotion" | "role_change";
  actionDetails?: {
    fromRole: string;
    toRole: string;
    actorName: string;
  };

  // For events
  eventId?: string;

  // Server-authored, recipient-scoped navigation metadata.
  metadata?: Record<string, unknown>;

  // For system messages (when displayed in bell dropdown)
  systemMessage?: {
    id: string;
    type:
      | "announcement"
      | "maintenance"
      | "update"
      | "warning"
      | "auth_level_change"
      | "user_management"
      | "atcloud_role_change"
      | "event_role_change";
    creator?: {
      firstName: string;
      lastName: string;
      roleInAtCloud?: string;
      authLevel?: string; // System auth level (Super Admin, Administrator, etc.)
    };
  };
}

export interface SystemMessage {
  id: string;
  title: string;
  content: string;
  type:
    | "announcement"
    | "maintenance"
    | "update"
    | "warning"
    | "auth_level_change"
    | "user_management"
    | "atcloud_role_change"
    | "event_role_change";
  isRead: boolean;
  readAt?: string; // Timestamp when message was read
  createdAt: string;
  priority: "low" | "medium" | "high";
  isActive?: boolean;
  updatedAt?: string;

  // For auth level change messages - target specific user
  targetUserId?: string;

  // Message creator information
  creator?: {
    id: string;
    firstName: string;
    lastName: string;
    username: string;
    avatar?: string;
    gender: "male" | "female";
    roleInAtCloud?: string;
    authLevel?: string; // System auth level (Super Admin, Administrator, etc.)
  };

  // Additional metadata for complex system messages
  metadata?: Record<string, unknown>; // e.g., { eventId, kind }
}
