import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import type { ReactNode } from "react";
import { useToastReplacement } from "./NotificationModalContext";
import type { Notification, SystemMessage } from "../types/notification";
import { notificationService } from "../services/notificationService";
import { systemMessageService } from "../services/systemMessageService";
import { authService } from "../services/api";
import type { SystemAuthorizationLevel } from "../types";
import { useAuth } from "../hooks/useAuth";
import { useSocket } from "../hooks/useSocket";

interface NotificationContextType {
  // Notifications (for bell dropdown - includes system messages)
  notifications: Notification[];
  unreadCount: number;
  markAsRead: (notificationId: string) => Promise<void>;
  markAllAsRead: () => Promise<void>;
  removeNotification: (notificationId: string) => Promise<void>;

  // Combined notifications for bell dropdown (includes system messages converted to notifications)
  allNotifications: Notification[];
  totalUnreadCount: number;

  // System Messages (for dedicated system messages page)
  systemMessages: SystemMessage[];
  markSystemMessageAsRead: (messageId: string) => Promise<void>;
  reloadSystemMessages: () => Promise<void>;
}

const NotificationContext = createContext<NotificationContextType | undefined>(
  undefined
);

export const NotificationProvider = ({ children }: { children: ReactNode }) => {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [systemMessages, setSystemMessages] = useState<SystemMessage[]>([]);
  const notification = useToastReplacement();
  const { currentUser, updateUser } = useAuth();
  const socket = useSocket();

  // Load system messages from backend
  const loadSystemMessages = useCallback(async () => {
    try {
      if (!currentUser) return;

      const data = await systemMessageService.getSystemMessages();

      const processedMessages = (data || []).map((message: unknown) => {
        const base = (message ?? {}) as Record<string, unknown> & {
          createdAt?: string;
        };
        return {
          ...base,
          createdAt: base.createdAt || new Date().toISOString(),
        } as SystemMessage;
      });

      setSystemMessages(processedMessages);
    } catch (error) {
      console.error("Failed to load system messages:", error);
    }
  }, [currentUser]);

  // Load notifications from backend
  useEffect(() => {
    const loadNotifications = async () => {
      try {
        if (!currentUser) return;

        const data = await notificationService.getNotifications();
        const processedNotifications = data.map((notification: unknown) => {
          const base = (notification ?? {}) as Record<string, unknown> & {
            createdAt?: string;
          };
          return {
            ...base,
            createdAt: base.createdAt || new Date().toISOString(),
          } as Notification;
        });

        setNotifications(processedNotifications);
      } catch (error) {
        console.error("Failed to load notifications:", error);
      }
    };

    loadNotifications();
  }, [currentUser]);

  // Load system messages on user change
  useEffect(() => {
    loadSystemMessages();
  }, [loadSystemMessages]);

  // Real-time WebSocket listeners for instant updates
  useEffect(() => {
    if (!currentUser || !socket.socket) return;

    type CreatorInfo = {
      firstName?: string;
      lastName?: string;
      authLevel?: string;
      roleInAtCloud?: string;
    };

    type SystemMessageCreatedData = {
      message: {
        id: string;
        title: string;
        content: string;
        type: string;
        priority?: string;
        creator?: CreatorInfo;
        createdAt: string;
        targetUserId?: string;
        metadata?: Record<string, unknown>;
      };
    };
    type SystemMessageReadData = { messageId: string; readAt?: string };
    type SystemMessageDeletedData = { messageId: string };

    type SystemMessageUpdate =
      | { event: "message_created"; data: SystemMessageCreatedData }
      | { event: "message_read"; data: SystemMessageReadData }
      | { event: "message_deleted"; data: SystemMessageDeletedData };

    const toSystemMessageType = (t: unknown): SystemMessage["type"] => {
      const allowed: SystemMessage["type"][] = [
        "announcement",
        "maintenance",
        "update",
        "warning",
        "auth_level_change",
        "user_management",
        "atcloud_role_change",
        "event_role_change",
      ];
      return typeof t === "string" && (allowed as string[]).includes(t)
        ? (t as SystemMessage["type"])
        : "update";
    };

    const toPriority = (p: unknown): SystemMessage["priority"] => {
      return p === "low" || p === "medium" || p === "high" ? p : "medium";
    };

    const toSystemCreator = (
      c: unknown
    ): SystemMessage["creator"] | undefined => {
      if (
        c &&
        typeof c === "object" &&
        "id" in c &&
        "username" in c &&
        "gender" in c
      ) {
        const cc = c as {
          id: string;
          username: string;
          gender: string;
          firstName?: string;
          lastName?: string;
          avatar?: string;
          roleInAtCloud?: string;
          authLevel?: string;
        };
        return {
          id: cc.id,
          username: cc.username,
          gender: cc.gender === "female" ? "female" : "male",
          firstName: cc.firstName ?? "",
          lastName: cc.lastName ?? "",
          avatar: cc.avatar,
          roleInAtCloud: cc.roleInAtCloud,
          authLevel: cc.authLevel,
        };
      }
      return undefined;
    };

    const handleSystemMessageUpdate = (update: SystemMessageUpdate) => {
      switch (update.event) {
        case "message_created":
          const messageId = update.data.message.id;

          // Handle new system message creation
          const newMessage: SystemMessage = {
            id: messageId,
            title: update.data.message.title,
            content: update.data.message.content,
            type: toSystemMessageType(update.data.message.type),
            priority: toPriority(update.data.message.priority),
            creator: toSystemCreator(update.data.message.creator),
            createdAt: update.data.message.createdAt,
            targetUserId: update.data.message.targetUserId,
            isRead: false,
            metadata: update.data.message.metadata,
          };

          setSystemMessages((prev) => {
            // Check if message already exists to avoid duplicates
            const exists = prev.some((msg) => msg.id === newMessage.id);
            if (exists) return prev;

            return [newMessage, ...prev];
          });

          // ✅ UNIFIED: Create bell notification from system message
          const bellNotification: Notification = {
            id: messageId,
            type: "SYSTEM_MESSAGE" as const,
            title: newMessage.title,
            message: newMessage.content,
            isRead: false,
            createdAt: newMessage.createdAt,
            userId: "",
            ...(newMessage.metadata
              ? { metadata: newMessage.metadata }
              : {}),
            systemMessage: {
              id: messageId,
              type: newMessage.type,
              creator: newMessage.creator
                ? {
                    firstName: newMessage.creator.firstName,
                    lastName: newMessage.creator.lastName,
                    authLevel: newMessage.creator.authLevel,
                    roleInAtCloud: newMessage.creator.roleInAtCloud,
                  }
                : undefined,
            },
            eventId:
              typeof newMessage.metadata?.eventId === "string"
                ? (newMessage.metadata.eventId as string)
                : undefined,
          };

          setNotifications((prev) => {
            // Check if notification already exists to avoid duplicates
            const exists = prev.some(
              (notif) => notif.id === bellNotification.id
            );
            if (exists) return prev;

            return [bellNotification, ...prev];
          });

          // If this is a system authorization level change targeting this user,
          // refresh the authenticated profile and update permissions immediately.
          if (update.data.message.type === "auth_level_change") {
            (async () => {
              try {
                const profile = await authService.getProfile();
                updateUser({
                  role: profile.role as SystemAuthorizationLevel,
                  isAtCloudLeader: profile.isAtCloudLeader ? "Yes" : "No",
                  roleInAtCloud: profile.roleInAtCloud,
                });
              } catch (e) {
                console.error(
                  "Failed to refresh profile after role change:",
                  e
                );
              }
            })();
          }

          // Show toast notification (except for role change events which are handled by EventDetail)
          if (
            update.data.message.type !== "atcloud_role_change" &&
            update.data.message.type !== "event_role_change"
          ) {
            notification.info(
              `New ${update.data.message.type}: ${update.data.message.title}`,
              {
                title: "System Message",
                autoCloseDelay: 5000,
              }
            );
          }
          break;
        case "message_read":
          setSystemMessages((prev) =>
            prev.map((msg) =>
              msg.id === update.data.messageId
                ? { ...msg, isRead: true, readAt: update.data.readAt }
                : msg
            )
          );
          break;
        case "message_deleted":
          setSystemMessages((prev) =>
            prev.filter((msg) => msg.id !== update.data.messageId)
          );
          break;
      }
    };

    type BellNotificationUpdate =
      | {
          event: "notification_read";
          data: { messageId: string; readAt?: string };
        }
      | { event: "notification_removed"; data: { messageId: string } };

    const handleBellNotificationUpdate = (update: BellNotificationUpdate) => {
      // ✅ SIMPLIFIED: Since system messages now handle bell notification creation,
      // this handler only processes direct bell notification events (read/remove)
      switch (update.event) {
        case "notification_read":
          setNotifications((prev) =>
            prev.map((notification) =>
              notification.id === update.data.messageId
                ? { ...notification, isRead: true, readAt: update.data.readAt }
                : notification
            )
          );
          break;
        case "notification_removed":
          setNotifications((prev) =>
            prev.filter(
              (notification) => notification.id !== update.data.messageId
            )
          );
          break;
      }
    };

    const handleUnreadCountUpdate = async () => {
      // Refresh notifications to ensure the UI is consistent with the new counts
      try {
        const data = await notificationService.getNotifications();
        const processedNotifications = data.map((notification: unknown) => {
          const base = (notification ?? {}) as Record<string, unknown> & {
            createdAt?: string;
          };
          return {
            ...base,
            createdAt: base.createdAt || new Date().toISOString(),
          } as Notification;
        });
        setNotifications(processedNotifications);
      } catch (error) {
        console.error(
          "Failed to refresh notifications after count update:",
          error
        );
      }
    };

    // On reconnect, fetch the latest messages to avoid missing any while offline.
    // Skip the initial connection because the normal load effects already fetch.
    const socketInstance = socket.socket;
    let hasConnected = socketInstance.connected;
    const handleReconnect = async () => {
      if (!hasConnected) {
        hasConnected = true;
        return;
      }
      try {
        await loadSystemMessages();
        const data = await notificationService.getNotifications();
        const processed = data.map((n: unknown) => {
          const base = (n ?? {}) as Record<string, unknown> & {
            createdAt?: string;
          };
          return {
            ...base,
            createdAt: base.createdAt || new Date().toISOString(),
          } as Notification;
        });
        setNotifications(processed);
      } catch (err) {
        console.error("Failed to refresh after reconnect:", err);
      }
    };

    socketInstance.on("system_message_update", handleSystemMessageUpdate);
    socketInstance.on("bell_notification_update", handleBellNotificationUpdate);
    socketInstance.on("unread_count_update", handleUnreadCountUpdate);
    socketInstance.on("connect", handleReconnect);

    return () => {
      socketInstance.off("system_message_update", handleSystemMessageUpdate);
      socketInstance.off(
        "bell_notification_update",
        handleBellNotificationUpdate,
      );
      socketInstance.off("unread_count_update", handleUnreadCountUpdate);
      socketInstance.off("connect", handleReconnect);
    };
  }, [
    currentUser,
    socket.socket,
    loadSystemMessages,
    notification,
    updateUser,
  ]);

  const markAsRead = useCallback(
    async (notificationId: string) => {
      try {
        await notificationService.markAsRead(notificationId);
      } catch (error) {
        console.error("Failed to mark notification as read:", error);
        notification.error("Failed to mark notification as read");
      }
    },
    [notification],
  );

  const markAllAsRead = useCallback(async () => {
    try {
      await notificationService.markAllAsRead();
    } catch (error) {
      console.error("Failed to mark all notifications as read:", error);
      notification.error("Failed to mark all notifications as read");
    }
  }, [notification]);

  const removeNotification = useCallback(
    async (notificationId: string) => {
      try {
        await notificationService.deleteNotification(notificationId);
        await loadSystemMessages();
        setNotifications((prev) =>
          prev.filter((item) => item.id !== notificationId),
        );
      } catch (error) {
        console.error("Failed to remove notification:", error);
        notification.error("Failed to remove notification");
      }
    },
    [loadSystemMessages, notification],
  );

  const markSystemMessageAsRead = useCallback(
    async (messageId: string) => {
      try {
        await systemMessageService.markAsRead(messageId);
        const readAt = new Date().toISOString();

        setSystemMessages((prev) =>
          prev.map((message) =>
            message.id === messageId
              ? { ...message, isRead: true, readAt }
              : message,
          ),
        );
        setNotifications((prev) =>
          prev.map((item) =>
            item.id === messageId
              ? { ...item, isRead: true, readAt }
              : item,
          ),
        );
      } catch (error) {
        console.error("Failed to mark system message as read:", error);
        notification.error("Failed to mark system message as read");
      }
    },
    [notification],
  );

  const unreadCount = useMemo(
    () => notifications.filter((item) => !item.isRead).length,
    [notifications],
  );
  const allNotifications = useMemo(
    () =>
      [...notifications].sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    [notifications],
  );
  const totalUnreadCount = unreadCount;

  const contextValue = useMemo<NotificationContextType>(
    () => ({
      notifications,
      unreadCount,
      markAsRead,
      markAllAsRead,
      removeNotification,
      allNotifications,
      totalUnreadCount,
      systemMessages,
      markSystemMessageAsRead,
      reloadSystemMessages: loadSystemMessages,
    }),
    [
      notifications,
      unreadCount,
      markAsRead,
      markAllAsRead,
      removeNotification,
      allNotifications,
      totalUnreadCount,
      systemMessages,
      markSystemMessageAsRead,
      loadSystemMessages,
    ],
  );

  return (
    <NotificationContext.Provider value={contextValue}>
      {children}
    </NotificationContext.Provider>
  );
};

export function useNotifications() {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error(
      "useNotifications must be used within NotificationProvider"
    );
  }
  return context;
}
