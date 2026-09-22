import { BaseApiClient } from "./api/common";
import type { Notification } from "../types/notification";

class NotificationService extends BaseApiClient {
  // Get user bell notifications (use NEW unified notifications endpoint)
  async getNotifications(): Promise<Notification[]> {
    type BackendCreator = {
      firstName?: string;
      lastName?: string;
      roleInAtCloud?: string;
      authLevel?: string;
    };
    type BackendBellNotification = {
      id: string;
      title: string;
      content: string;
      isRead: boolean;
      createdAt: string;
      type?: string;
      creator?: BackendCreator;
      metadata?: Record<string, unknown>;
    };

    const response = await this.request<{
      notifications: BackendBellNotification[];
      unreadCount: number;
    }>("/notifications/bell");

    // Transform backend notifications to match frontend interface
    const allowedTypes = [
      "announcement",
      "maintenance",
      "update",
      "warning",
      "auth_level_change",
      "user_management",
      "atcloud_role_change",
      "event_role_change",
    ] as const;
    type SystemMessageType = (typeof allowedTypes)[number];
    const isSystemMessageType = (t: string): t is SystemMessageType =>
      (allowedTypes as readonly string[]).includes(t);

    const notifications: Notification[] = (
      response.data?.notifications || []
    ).map((notification: BackendBellNotification) => {
      const sysType: SystemMessageType = isSystemMessageType(
        notification.type ?? "",
      )
        ? (notification.type as SystemMessageType)
        : "announcement";

      const creator =
        notification.creator &&
        !!notification.creator.firstName &&
        !!notification.creator.lastName
          ? {
              firstName: notification.creator.firstName,
              lastName: notification.creator.lastName,
              roleInAtCloud: notification.creator.roleInAtCloud,
              authLevel: notification.creator.authLevel,
            }
          : undefined;
      const transformed: Notification = {
        id: notification.id,
        type: "SYSTEM_MESSAGE" as const, // All bell notifications are system messages
        title: notification.title,
        message: notification.content,
        isRead: notification.isRead,
        createdAt: notification.createdAt,
        userId: "", // Not needed for system messages
        ...(notification.metadata
          ? { metadata: notification.metadata }
          : {}),
        // Include system message details for proper "From" information display
        systemMessage: {
          id: notification.id,
          type: sysType,
          creator,
        },
      };

      return transformed;
    });

    return notifications;
  }

  // Mark bell notification as read (use NEW unified notifications endpoint)
  async markAsRead(notificationId: string): Promise<void> {
    await this.request(`/notifications/bell/${notificationId}/read`, {
      method: "PATCH", // Standardized to PATCH for consistency
    });
  }

  // Mark all bell notifications as read (use NEW unified notifications endpoint)
  async markAllAsRead(): Promise<void> {
    await this.request("/notifications/bell/read-all", {
      method: "PATCH", // Standardized to PATCH for consistency
    });
  }

  // Delete a specific bell notification (use NEW unified notifications endpoint)
  async deleteNotification(notificationId: string): Promise<void> {
    await this.request(`/notifications/bell/${notificationId}`, {
      method: "DELETE",
    });
  }

  // Get unread counts (NEW unified notifications API)
  async getUnreadCounts(): Promise<{
    bellNotifications: number;
    systemMessages: number;
    total: number;
  }> {
    const response = await this.request<{
      bellNotifications: number;
      systemMessages: number;
      total: number;
    }>("/notifications/unread-counts");
    return (
      response.data || { bellNotifications: 0, systemMessages: 0, total: 0 }
    );
  }

  // Clean up expired notifications (NEW unified notifications API)
  async cleanupExpiredItems(): Promise<{
    removedNotifications: number;
    removedMessages: number;
  }> {
    const response = await this.request<{
      removedNotifications: number;
      removedMessages: number;
    }>("/notifications/cleanup", {
      method: "POST",
    });
    return response.data || { removedNotifications: 0, removedMessages: 0 };
  }

  // Admin: Create notification
  async createNotification(notification: {
    userId?: string;
    type: string;
    title: string;
    message: string;
    data?: unknown;
  }): Promise<Notification> {
    const response = await this.request<Notification>("/notifications", {
      method: "POST",
      body: JSON.stringify(notification),
    });
    return response.data!;
  }

  // Admin: Send bulk notification
  async sendBulkNotification(notification: {
    userIds?: string[];
    type: string;
    title: string;
    message: string;
    data?: unknown;
  }): Promise<void> {
    await this.request("/notifications/bulk", {
      method: "POST",
      body: JSON.stringify(notification),
    });
  }
}

// Create and export a singleton instance
export const notificationService = new NotificationService();
export default notificationService;
