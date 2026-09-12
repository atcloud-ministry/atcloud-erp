import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
  NotificationProvider,
  useNotifications,
} from "../contexts/NotificationContext";
import { NotificationProvider as NotificationModalProvider } from "../contexts/NotificationModalContext";
import { AuthProvider } from "../contexts/AuthContext";

// --- Mocks ---
// Create a simple in-memory fake socket with on/off/emit
type Listener = (...args: unknown[]) => void;

class FakeSocket {
  private listeners: Record<string, Set<Listener>> = {};
  on(event: string, cb: Listener) {
    if (!this.listeners[event]) this.listeners[event] = new Set();
    this.listeners[event].add(cb);
  }
  off(event: string, cb?: Listener) {
    if (!this.listeners[event]) return;
    if (cb) {
      this.listeners[event].delete(cb);
    } else {
      this.listeners[event].clear();
    }
  }
  emit(event: string, ...args: unknown[]) {
    const set = this.listeners[event];
    if (!set) return;
    for (const cb of Array.from(set)) cb(...args);
  }
  removeAllListeners() {
    this.listeners = {};
  }
  disconnect() {}
  get connected() {
    return true;
  }
  get connecting() {
    return false;
  }
  listenerCount(event: string) {
    return this.listeners[event]?.size ?? 0;
  }
}

const fakeSocketInstance = new FakeSocket();

vi.mock("../hooks/useSocket", () => {
  return {
    useSocket: () => ({
      socket: fakeSocketInstance,
      connected: true,
      error: null,
      onlineUsers: [],
      forceReconnect: vi.fn(),
      joinEventUpdates: vi.fn(),
      leaveEventUpdates: vi.fn(),
      updateStatus: vi.fn(),
      onEventUpdate: vi.fn(),
      onNewNotification: vi.fn(),
    }),
  };
});

// Mock API services used by AuthProvider and NotificationContext
vi.mock("../services/api", () => {
  return {
    authService: {
      getProfile: vi.fn().mockResolvedValue({
        id: "u1",
        username: "tester",
        firstName: "Test",
        lastName: "User",
        email: "test@example.com",
        role: "Member",
        isAtCloudLeader: false,
        gender: "male",
      }),
      login: vi.fn(),
      logout: vi.fn(),
      refreshToken: vi.fn(),
    },
  };
});

vi.mock("../services/notificationService", () => {
  return {
    notificationService: {
      getNotifications: vi.fn().mockResolvedValue([]),
      markAsRead: vi.fn().mockResolvedValue(undefined),
      markAllAsRead: vi.fn().mockResolvedValue(undefined),
      deleteNotification: vi.fn().mockResolvedValue(undefined),
      getUnreadCounts: vi.fn().mockResolvedValue({
        bellNotifications: 0,
        systemMessages: 0,
        total: 0,
      }),
      cleanupExpiredItems: vi.fn().mockResolvedValue({
        removedNotifications: 0,
        removedMessages: 0,
      }),
    },
  };
});

vi.mock("../services/systemMessageService", () => {
  return {
    systemMessageService: {
      getSystemMessages: vi.fn().mockResolvedValue([]),
      getUnreadCount: vi.fn().mockResolvedValue(0),
      markAsRead: vi.fn().mockResolvedValue(true),
      deleteSystemMessage: vi.fn().mockResolvedValue(true),
    },
  };
});

function renderNotifications() {
  const wrapper = ({ children }: any) => (
    <AuthProvider>
      <NotificationModalProvider>
        <NotificationProvider>{children}</NotificationProvider>
      </NotificationModalProvider>
    </AuthProvider>
  );
  const { result } = renderHook(() => useNotifications(), { wrapper });
  return result;
}

describe("Bell notifications derived from system_message_update", () => {
  it("creates a bell notification when a system_message_update(message_created) arrives", async () => {
    // Ensure auth flow treats user as logged in
    localStorage.setItem("authToken", "test-token");
    const result = renderNotifications();
    // Wait until NotificationContext has registered socket listeners
    await waitFor(() => {
      expect(
        fakeSocketInstance.listenerCount("system_message_update")
      ).toBeGreaterThan(0);
    });

    const payload = {
      event: "message_created",
      data: {
        message: {
          id: "m-1",
          title: "Event Updated: Test",
          content: "Edited by Administrator Jane Doe",
          type: "update",
          priority: "medium",
          creator: {
            firstName: "Jane",
            lastName: "Doe",
            authLevel: "Administrator",
            roleInAtCloud: undefined,
          },
          createdAt: new Date().toISOString(),
          targetUserId: "u1",
          metadata: {
            eventId: "e123",
            kind: "alumni_help_workflow",
            requestId: "64f100000000000000000001",
          },
        },
      },
    } as any;

    await act(async () => {
      fakeSocketInstance.emit("system_message_update", payload);
    });

    await waitFor(() => {
      expect(result.current.allNotifications.length).toBeGreaterThan(0);
      const found = result.current.allNotifications.find(
        (n) => n.type === "SYSTEM_MESSAGE" && n.systemMessage?.type === "update"
      );
      expect(found).toBeTruthy();
      expect(found?.eventId).toBe("e123");
      expect(found?.metadata).toEqual({
        eventId: "e123",
        kind: "alumni_help_workflow",
        requestId: "64f100000000000000000001",
      });
    });
  });
});
