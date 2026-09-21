import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// Register mocks BEFORE importing modules under test
const STABLE_USER = Object.freeze({ id: "user-1", role: "User" });
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ currentUser: STABLE_USER }),
}));

vi.mock("../hooks/useSocket", () => ({
  useSocket: () => ({ socket: undefined, connected: false }),
}));

vi.mock("../services/systemMessageService", async () => {
  const mod = await vi.importActual<any>("../services/systemMessageService");
  return {
    ...mod,
    systemMessageService: {
      getSystemMessages: vi.fn().mockResolvedValue([
        {
          id: "m-1",
          title: "Maintenance Tonight",
          content: "We will have a brief maintenance window",
          type: "maintenance",
          priority: "medium",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          isActive: true,
          isRead: false,
        },
      ]),
      getUnreadCount: vi.fn().mockResolvedValue(1),
      markAsRead: vi.fn().mockResolvedValue(true),
      deleteSystemMessage: vi.fn().mockResolvedValue(true),
    },
  };
});

vi.mock("../services/notificationService", async () => {
  const mod = await vi.importActual<any>("../services/notificationService");
  return {
    ...mod,
    notificationService: {
      getNotifications: vi.fn().mockResolvedValue([]),
      markAsRead: vi.fn().mockResolvedValue(undefined),
      markAllAsRead: vi.fn().mockResolvedValue(undefined),
      deleteNotification: vi.fn().mockResolvedValue(undefined),
      getUnreadCounts: vi.fn().mockResolvedValue({
        bellNotifications: 0,
        systemMessages: 1,
        total: 1,
      }),
    },
  };
});

import {
  NotificationProvider,
  useNotifications,
} from "../contexts/NotificationContext";
import { NotificationProvider as NotificationModalProvider } from "../contexts/NotificationModalContext";
import { notificationService } from "../services/notificationService";

function renderNotifications() {
  const wrapper = ({ children }: any) => (
    <NotificationModalProvider>
      <NotificationProvider>{children}</NotificationProvider>
    </NotificationModalProvider>
  );
  const { result } = renderHook(() => useNotifications(), { wrapper });
  return result;
}

describe("Bell 'Mark all read' should not mark system messages as read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps system messages unread after markAllAsRead() is invoked", async () => {
    const result = renderNotifications();
    // Wait for provider's async load to populate system messages
    await waitFor(() => {
      expect(result.current.systemMessages.length).toBe(1);
      expect(result.current.systemMessageUnreadCount).toBe(1);
    });
    // Precondition: the single system message is unread
    expect(result.current.systemMessages[0].isRead).toBe(false);

    // Act: mark all bell notifications as read
    await act(async () => {
      await result.current.markAllAsRead();
    });

    // Assert: system messages remain unchanged (still unread)
    expect(result.current.systemMessages[0].isRead).toBe(false);
    expect(result.current.systemMessageUnreadCount).toBe(1);
  });

  it("updates the System Messages and launcher-source count after a read", async () => {
    const result = renderNotifications();
    await waitFor(() => {
      expect(result.current.systemMessageUnreadCount).toBe(1);
    });
    vi.mocked(notificationService.getUnreadCounts).mockResolvedValueOnce({
      bellNotifications: 0,
      systemMessages: 0,
      total: 0,
    });

    await act(async () => {
      await result.current.markSystemMessageAsRead("m-1");
    });

    expect(result.current.systemMessages[0].isRead).toBe(true);
    expect(result.current.systemMessageUnreadCount).toBe(0);
  });
});
