import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Server as SocketIOServer } from "socket.io";
import { Server as HTTPServer } from "http";
import jwt from "jsonwebtoken";
import { socketService } from "../../../../src/services/infrastructure/SocketService";
import {
  Conversation,
  ConversationMember,
  Event,
  Purchase,
  User,
} from "../../../../src/models";
import { createRuntimeConfigDTO } from "../../../../src/contracts/runtimeConfig";
import { featureControlService } from "../../../../src/services/runtime/FeatureControlService";

// Mock dependencies
vi.mock("socket.io", () => ({
  Server: vi.fn(),
}));

vi.mock("jsonwebtoken", () => ({
  default: {
    verify: vi.fn().mockReturnValue({}),
  },
}));

vi.mock("../../../../src/models", () => ({
  User: {
    findById: vi.fn(),
  },
  Event: {
    findById: vi.fn(),
  },
  Program: {
    findById: vi.fn(),
  },
  Purchase: {
    findOne: vi.fn(),
  },
  Conversation: {
    findOne: vi.fn(),
  },
  ConversationMember: {
    findOne: vi.fn(),
  },
}));

vi.mock("../../../../src/services/authorization/AuthorizationAuditService", () => ({
  recordAuthorizationDenial: vi.fn(),
}));

const USER_ID = "507f1f77bcf86cd799439011";
const NAMELESS_USER_ID = "507f1f77bcf86cd799439012";
const EVENT_ID = "507f1f77bcf86cd799439013";
const CONVERSATION_ID = "507f1f77bcf86cd799439014";
const ACCESS_TOKEN_EXP = Math.floor(Date.now() / 1000) + 60 * 60;

describe("SocketService", () => {
  let mockIO: any;
  let mockSocket: any;
  let mockHttpServer: HTTPServer;
  let mockUser: any;

  beforeEach(() => {
    // Reset the singleton state
    (socketService as any).io = null;
    (socketService as any).authenticatedSockets = new Map();
    (socketService as any).userSockets = new Map();
    (socketService as any).userAuthorizationRevisions = new Map();
    (socketService as any).resourceAuthorizationRevisions = new Map();
    (socketService as any).eventJoinGuards = new Map();
    (socketService as any).conversationJoinGuards = new Map();

    // Setup mocks
    mockSocket = {
      id: "socket123",
      handshake: {
        auth: {
          token: "valid-jwt-token",
        },
      },
      userId: "user123",
      user: {
        id: "user123",
        firstName: "John",
        lastName: "Doe",
      },
      canManageUsers: false,
      authorizationRevision: 0,
      tokenExpiresAt: ACCESS_TOKEN_EXP * 1000,
      disconnected: false,
      join: vi.fn(),
      leave: vi.fn(),
      disconnect: vi.fn(),
      emit: vi.fn(),
      on: vi.fn(),
      broadcast: {
        emit: vi.fn(),
      },
    };

    mockIO = {
      use: vi.fn(),
      on: vi.fn(),
      to: vi.fn().mockReturnThis(),
      except: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      emit: vi.fn(),
      socketsJoin: vi.fn(),
      socketsLeave: vi.fn(),
      disconnectSockets: vi.fn(),
      engine: {
        on: vi.fn(),
      },
    };

    mockHttpServer = {} as HTTPServer;
    mockUser = {
      _id: USER_ID,
      firstName: "John",
      lastName: "Doe",
      role: "Participant",
      isActive: true,
      isVerified: true,
    };

    vi.mocked(SocketIOServer).mockReturnValue(mockIO);
    vi.mocked(User.findById).mockResolvedValue(mockUser);
    vi.mocked(Event.findById).mockResolvedValue({ _id: EVENT_ID } as any);
    vi.clearAllMocks();
    vi.spyOn(featureControlService, "getRuntimeConfig").mockResolvedValue(
      createRuntimeConfigDTO("on", 1),
    );
    vi.mocked(Conversation.findOne).mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: CONVERSATION_ID,
          status: "current",
        }),
      }),
    } as any);
    vi.mocked(ConversationMember.findOne).mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: "507f1f77bcf86cd799439015",
          status: "active",
          accessWindows: [
            {
              visibleFromSequence: 1,
              visibleThroughSequence: null,
              openedAt: new Date("2026-09-12T12:00:00.000Z"),
              closedAt: null,
            },
          ],
        }),
      }),
    } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  describe("initialize", () => {
    it("should initialize SocketIO server with correct configuration", () => {
      socketService.initialize(mockHttpServer);

      expect(SocketIOServer).toHaveBeenCalledWith(
        mockHttpServer,
        expect.objectContaining({
          cors: expect.objectContaining({
            origin: expect.arrayContaining(["http://localhost:5173"]),
            methods: ["GET", "POST"],
            credentials: true,
          }),
          path: "/socket.io/",
          allowEIO3: true,
        })
      );
    });

    it("should use custom FRONTEND_URL from environment", () => {
      process.env.FRONTEND_URL = "https://custom-frontend.com";

      socketService.initialize(mockHttpServer);

      expect(SocketIOServer).toHaveBeenCalledWith(
        mockHttpServer,
        expect.objectContaining({
          cors: expect.objectContaining({
            origin: expect.arrayContaining(["https://custom-frontend.com"]),
            methods: ["GET", "POST"],
            credentials: true,
          }),
          path: "/socket.io/",
          allowEIO3: true,
        })
      );

      delete process.env.FRONTEND_URL;
    });

    it("should setup socket handlers and authentication middleware", () => {
      socketService.initialize(mockHttpServer);

      expect(mockIO.use).toHaveBeenCalled();
      expect(mockIO.engine.on).toHaveBeenCalledWith(
        "connection_error",
        expect.any(Function)
      );
      expect(mockIO.on).toHaveBeenCalledWith(
        "connection",
        expect.any(Function)
      );
    });
  });

  describe("authenticateSocket", () => {
    let authenticateSocketFn: any;
    let nextFn: any;

    beforeEach(async () => {
      socketService.initialize(mockHttpServer);
      // Get the authentication function that was passed to io.use
      authenticateSocketFn = vi.mocked(mockIO.use).mock.calls[0][0];
      nextFn = vi.fn();

      // Mock User model
      const { User } = await import("../../../../src/models");
      vi.mocked(User.findById).mockResolvedValue(mockUser);
      const { Event } = await import("../../../../src/models");
      vi.mocked(Event.findById).mockResolvedValue({ _id: EVENT_ID } as any);
    });

    it("should authenticate valid token successfully", async () => {
      (vi.mocked(jwt.verify) as any).mockReturnValue({
        userId: USER_ID,
        exp: ACCESS_TOKEN_EXP,
      });

      await authenticateSocketFn(mockSocket, nextFn);

      expect(jwt.verify).toHaveBeenCalledWith(
        "valid-jwt-token",
        process.env.JWT_ACCESS_SECRET || "your-access-secret-key",
        { issuer: "atcloud-system", audience: "atcloud-users" },
      );
      expect(mockSocket.userId).toBe(USER_ID);
      expect(mockSocket.user).toEqual({
        id: USER_ID,
        firstName: "John",
        lastName: "Doe",
      });
      expect(mockSocket.canManageUsers).toBe(false);
      expect(mockSocket.tokenExpiresAt).toBe(ACCESS_TOKEN_EXP * 1000);
      expect(nextFn).toHaveBeenCalledWith();
    });

    it("should reject connection when no token provided", async () => {
      mockSocket.handshake.auth.token = null;

      await authenticateSocketFn(mockSocket, nextFn);

      expect(nextFn).toHaveBeenCalledWith(
        new Error("Authentication token required")
      );
    });

    it("should reject connection when JWT verification fails", async () => {
      (vi.mocked(jwt.verify) as any).mockImplementation(() => {
        throw new Error("Invalid token");
      });

      await authenticateSocketFn(mockSocket, nextFn);

      expect(nextFn).toHaveBeenCalledWith(new Error("Authentication failed"));
    });

    it("rejects an access token without a future expiration", async () => {
      (vi.mocked(jwt.verify) as any).mockReturnValue({ userId: USER_ID });

      await authenticateSocketFn(mockSocket, nextFn);

      expect(User.findById).not.toHaveBeenCalled();
      expect(nextFn).toHaveBeenCalledWith(new Error("Authentication failed"));
    });

    it("should reject connection when user not found", async () => {
      (vi.mocked(jwt.verify) as any).mockReturnValue({
        userId: USER_ID,
        exp: ACCESS_TOKEN_EXP,
      });
      const { User } = await import("../../../../src/models");
      vi.mocked(User.findById).mockResolvedValue(null);

      await authenticateSocketFn(mockSocket, nextFn);

      expect(nextFn).toHaveBeenCalledWith(
        new Error("Invalid, inactive, or unverified user"),
      );
    });

    it("should reject connection when user is inactive", async () => {
      (vi.mocked(jwt.verify) as any).mockReturnValue({
        userId: USER_ID,
        exp: ACCESS_TOKEN_EXP,
      });
      const { User } = await import("../../../../src/models");
      vi.mocked(User.findById).mockResolvedValue({
        ...mockUser,
        isActive: false,
      });

      await authenticateSocketFn(mockSocket, nextFn);

      expect(nextFn).toHaveBeenCalledWith(
        new Error("Invalid, inactive, or unverified user"),
      );
    });

    it("should reject an unverified user", async () => {
      (vi.mocked(jwt.verify) as any).mockReturnValue({
        userId: USER_ID,
        exp: ACCESS_TOKEN_EXP,
      });
      const { User } = await import("../../../../src/models");
      vi.mocked(User.findById).mockResolvedValue({
        ...mockUser,
        isVerified: false,
      });

      await authenticateSocketFn(mockSocket, nextFn);

      expect(nextFn).toHaveBeenCalledWith(
        new Error("Invalid, inactive, or unverified user"),
      );
    });

    it("should fallback to empty firstName/lastName when missing on user", async () => {
      (vi.mocked(jwt.verify) as any).mockReturnValue({
        userId: NAMELESS_USER_ID,
        exp: ACCESS_TOKEN_EXP,
      });

      const { User } = await import("../../../../src/models");
      vi.mocked(User.findById).mockResolvedValue({
        _id: NAMELESS_USER_ID,
        role: "Participant",
        isActive: true,
        isVerified: true,
        // intentionally omit firstName/lastName to hit fallback branches
      } as any);

      await authenticateSocketFn(mockSocket, nextFn);

      expect(mockSocket.user).toEqual({
        id: NAMELESS_USER_ID,
        firstName: "",
        lastName: "",
      });
      expect(nextFn).toHaveBeenCalledWith();
    });

    it("derives MANAGE_USERS room access from the shared permission policy", async () => {
      (vi.mocked(jwt.verify) as any).mockReturnValue({
        userId: USER_ID,
        exp: ACCESS_TOKEN_EXP,
      });
      vi.mocked(User.findById).mockResolvedValue({
        ...mockUser,
        role: "Administrator",
      });

      await authenticateSocketFn(mockSocket, nextFn);

      expect(mockSocket.canManageUsers).toBe(true);
      expect(nextFn).toHaveBeenCalledWith();
    });
  });

  describe("socket connection handling", () => {
    let connectionHandler: any;

    beforeEach(() => {
      socketService.initialize(mockHttpServer);
      const connectionCall = vi
        .mocked(mockIO.on)
        .mock.calls.find((call) => call[0] === "connection");
      connectionHandler = connectionCall?.[1];
    });

    it("should handle socket connection and setup user tracking", () => {
      connectionHandler(mockSocket);

      expect(mockSocket.join).toHaveBeenCalledWith("user:user123");
      expect(mockSocket.emit).toHaveBeenCalledWith("connected", {
        message: "Real-time notifications enabled",
        userId: "user123",
      });
      expect(mockSocket.on).toHaveBeenCalledWith("error", expect.any(Function));
      expect(mockSocket.on).toHaveBeenCalledWith(
        "disconnect",
        expect.any(Function)
      );
      expect(mockSocket.on).toHaveBeenCalledWith(
        "update_status",
        expect.any(Function)
      );
      expect(mockSocket.on).toHaveBeenCalledWith(
        "join_event_room",
        expect.any(Function)
      );
      expect(mockSocket.on).toHaveBeenCalledWith(
        "leave_event_room",
        expect.any(Function)
      );
    });

    it("joins the MANAGE_USERS room only for an authorized socket", () => {
      mockSocket.canManageUsers = true;
      connectionHandler(mockSocket);

      expect(mockSocket.join).toHaveBeenCalledWith("permission:manage_users");
    });

    it("disconnects the socket when its access token expires", () => {
      vi.useFakeTimers();
      const expiredAt = Date.now() + 1_000;
      mockSocket.tokenExpiresAt = expiredAt;
      connectionHandler(mockSocket);

      vi.advanceTimersByTime(999);
      expect(mockSocket.disconnect).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(mockSocket.emit).toHaveBeenCalledWith("auth_expired", {
        expiredAt: new Date(expiredAt).toISOString(),
      });
      expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
    });

    it("rejects a socket when authorization changes during authentication", async () => {
      const authenticateSocketFn = vi.mocked(mockIO.use).mock.calls[0][0];
      let resolveUser!: (user: typeof mockUser) => void;
      vi.mocked(User.findById).mockReturnValue(
        new Promise<typeof mockUser>((resolve) => {
          resolveUser = resolve;
        }) as any,
      );
      (vi.mocked(jwt.verify) as any).mockReturnValue({
        userId: USER_ID,
        exp: ACCESS_TOKEN_EXP,
      });
      const nextFn = vi.fn();

      const authentication = authenticateSocketFn(mockSocket, nextFn);
      await Promise.resolve();
      socketService.syncUserAuthorization(USER_ID, {
        role: "Participant",
        isActive: true,
      });
      resolveUser({ ...mockUser, role: "Administrator" });
      await authentication;

      expect(nextFn).toHaveBeenCalledWith();
      connectionHandler(mockSocket);

      expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
      expect(mockSocket.join).not.toHaveBeenCalled();
      expect(
        (socketService as any).authenticatedSockets.has(mockSocket.id),
      ).toBe(false);
      expect((socketService as any).userSockets.has(USER_ID)).toBe(false);
    });

    it("should handle socket disconnection and cleanup", () => {
      connectionHandler(mockSocket);

      // Get the disconnect handler
      const disconnectCall = vi
        .mocked(mockSocket.on)
        .mock.calls.find((call) => call[0] === "disconnect");
      const disconnectHandler = disconnectCall?.[1];
      disconnectHandler();

      // Verify cleanup
      expect((socketService as any).authenticatedSockets.has("socket123")).toBe(
        false
      );
    });

    it("disconnect handler works when userSockets entry is missing (else branch)", () => {
      connectionHandler(mockSocket);

      // Extract disconnect handler
      const disconnectCall = vi
        .mocked(mockSocket.on)
        .mock.calls.find((call) => call[0] === "disconnect");
      const disconnectHandler = disconnectCall?.[1];

      // Simulate external cleanup that removed user entry before disconnect
      (socketService as any).userSockets = new Map();

      // Should not throw and should simply skip inner cleanup
      expect(() => disconnectHandler()).not.toThrow();
      expect((socketService as any).userSockets.size).toBe(0);
    });

    it("disconnect with multiple sockets keeps user entry (size !== 0 branch)", () => {
      // First connection for user123
      connectionHandler(mockSocket);

      // Second connection for the same user with a different socket id
      const mockSocket2: any = {
        id: "socket456",
        handshake: { auth: { token: "valid-jwt-token" } },
        userId: "user123",
        authorizationRevision: 0,
        tokenExpiresAt: ACCESS_TOKEN_EXP * 1000,
        user: mockSocket.user,
        join: vi.fn(),
        leave: vi.fn(),
        emit: vi.fn(),
        on: vi.fn(),
        broadcast: { emit: vi.fn() },
      };

      connectionHandler(mockSocket2);

      // Verify both sockets are tracked for the user
      const setBefore = (socketService as any).userSockets.get("user123");
      expect(setBefore).toBeDefined();
      expect(setBefore.size).toBe(2);
      expect(setBefore.has("socket123")).toBe(true);
      expect(setBefore.has("socket456")).toBe(true);

      // Disconnect only the first socket
      const disconnectCall1 = vi
        .mocked(mockSocket.on)
        .mock.calls.find((call) => call[0] === "disconnect");
      const disconnectHandler1 = disconnectCall1?.[1];
      disconnectHandler1();

      // After removing one socket, the user entry should still exist with the other socket
      const setAfter = (socketService as any).userSockets.get("user123");
      expect(setAfter).toBeDefined();
      expect(setAfter.size).toBe(1);
      expect(setAfter.has("socket456")).toBe(true);
    });

    it("tracks 250 simultaneous accounts with two isolated connections each", () => {
      vi.useFakeTimers();
      const sockets = Array.from({ length: 250 }, (_unused, userIndex) => {
        const userId = `64f1${(userIndex + 1)
          .toString(16)
          .padStart(20, "0")}`;
        return Array.from({ length: 2 }, (_unusedSocket, socketIndex) => ({
          ...mockSocket,
          id: `capacity-${userIndex}-${socketIndex}`,
          userId,
          authorizationRevision: 0,
          tokenExpiresAt: ACCESS_TOKEN_EXP * 1000,
          disconnected: false,
          join: vi.fn(),
          leave: vi.fn(),
          disconnect: vi.fn(),
          emit: vi.fn(),
          on: vi.fn(),
          broadcast: { emit: vi.fn() },
        }));
      }).flat();

      sockets.forEach((socket) => connectionHandler(socket));

      const authenticated = (socketService as any)
        .authenticatedSockets as Map<string, unknown>;
      const byUser = (socketService as any).userSockets as Map<
        string,
        Set<string>
      >;
      expect(authenticated.size).toBe(500);
      expect(byUser.size).toBe(250);
      expect([...byUser.values()].every((ids) => ids.size === 2)).toBe(true);
      for (const socket of sockets) {
        expect(socket.disconnect).not.toHaveBeenCalled();
        expect(socket.join).toHaveBeenCalledWith(`user:${socket.userId}`);
        expect(socket.join).toHaveBeenCalledTimes(1);
      }

      const targetUserId = sockets[0]!.userId;
      mockIO.to.mockClear();
      mockIO.emit.mockClear();
      expect(
        socketService.emitChatMessageToUser(targetUserId, CONVERSATION_ID, {
          message: {
            id: "64f100000000000000000021",
            conversationId: CONVERSATION_ID,
            sequence: 1,
            sender: {
              id: USER_ID,
              displayName: "Capacity Sender",
              avatar: null,
            },
            clientMessageId: "550e8400-e29b-41d4-a716-446655440000",
            kind: "text",
            content: "capacity message",
            safeLink: null,
            createdAt: "2026-09-12T12:00:00.000Z",
          },
        }),
      ).toBe(true);
      expect(mockIO.to).toHaveBeenCalledWith(`user:${targetUserId}`);
      expect(mockIO.to).not.toHaveBeenCalledWith(
        `user:${sockets[2]!.userId}`,
      );
    });

    it("keeps at most five account connections and closes the oldest", () => {
      const sockets = Array.from({ length: 6 }, (_, index) => ({
        ...mockSocket,
        id: `account-socket-${index + 1}`,
        userId: "user123",
        authorizationRevision: 0,
        tokenExpiresAt: ACCESS_TOKEN_EXP * 1000,
        disconnected: false,
        join: vi.fn(),
        leave: vi.fn(),
        disconnect: vi.fn(),
        emit: vi.fn(),
        on: vi.fn(),
        broadcast: { emit: vi.fn() },
      }));

      sockets.forEach((socket) => connectionHandler(socket));

      expect(sockets[0].disconnect).toHaveBeenCalledWith(true);
      expect(sockets[0].emit).toHaveBeenCalledWith("connection_limit", {
        limit: 5,
        disconnectedAt: expect.any(String),
      });
      for (const socket of sockets.slice(1)) {
        expect(socket.disconnect).not.toHaveBeenCalled();
      }
      const tracked = (socketService as any).userSockets.get("user123");
      expect([...tracked]).toEqual([
        "account-socket-2",
        "account-socket-3",
        "account-socket-4",
        "account-socket-5",
        "account-socket-6",
      ]);
      expect(
        (socketService as any).authenticatedSockets.has("account-socket-1"),
      ).toBe(false);
    });

    it("should handle status updates", () => {
      connectionHandler(mockSocket);

      // Get the status update handler
      const statusCall = vi
        .mocked(mockSocket.on)
        .mock.calls.find((call) => call[0] === "update_status");
      const statusHandler = statusCall?.[1];

      statusHandler("away");

      expect(mockSocket.broadcast.emit).toHaveBeenCalledWith(
        "user_status_update",
        {
          userId: "user123",
          status: "away",
          user: {
            id: mockSocket.user.id,
            firstName: mockSocket.user.firstName,
            lastName: mockSocket.user.lastName,
          },
        }
      );
    });

    it("ignores invalid presence values", () => {
      connectionHandler(mockSocket);
      const statusCall = vi
        .mocked(mockSocket.on)
        .mock.calls.find((call) => call[0] === "update_status");

      statusCall?.[1]("administrator");

      expect(mockSocket.broadcast.emit).not.toHaveBeenCalled();
    });

    it("should handle join_event_room", async () => {
      connectionHandler(mockSocket);

      // Get the join event room handler
      const joinCall = vi
        .mocked(mockSocket.on)
        .mock.calls.find((call) => call[0] === "join_event_room");
      const joinHandler = joinCall?.[1];

      await joinHandler(EVENT_ID);

      expect(mockSocket.join).toHaveBeenCalledWith(`event:${EVENT_ID}`);
    });

    it("should handle leave_event_room", () => {
      connectionHandler(mockSocket);

      // Get the leave event room handler
      const leaveCall = vi
        .mocked(mockSocket.on)
        .mock.calls.find((call) => call[0] === "leave_event_room");
      const leaveHandler = leaveCall?.[1];

      leaveHandler(EVENT_ID);

      expect(mockSocket.leave).toHaveBeenCalledWith(`event:${EVENT_ID}`);
    });
  });

  describe("emitSystemMessageUpdate", () => {
    beforeEach(() => {
      socketService.initialize(mockHttpServer);
    });

    it("should emit system message update to specific user", () => {
      const testData = { messageId: "msg123", action: "read" };

      socketService.emitSystemMessageUpdate(
        "user123",
        "message_read",
        testData
      );

      expect(mockIO.to).toHaveBeenCalledWith("user:user123");
      expect(mockIO.emit).toHaveBeenCalledWith("system_message_update", {
        event: "message_read",
        data: testData,
        timestamp: expect.any(String),
      });
    });

    it("should do nothing when io is not initialized", () => {
      (socketService as any).io = null;

      socketService.emitSystemMessageUpdate("user123", "test", {});

      expect(mockIO.to).not.toHaveBeenCalled();
    });
  });

  describe("emitBellNotificationUpdate", () => {
    beforeEach(() => {
      socketService.initialize(mockHttpServer);
    });

    it("should emit bell notification update to specific user", () => {
      const testData = { notificationId: "notif123", type: "new" };

      socketService.emitBellNotificationUpdate(
        "user123",
        "new_notification",
        testData
      );

      expect(mockIO.to).toHaveBeenCalledWith("user:user123");
      expect(mockIO.emit).toHaveBeenCalledWith("bell_notification_update", {
        event: "new_notification",
        data: testData,
        timestamp: expect.any(String),
      });
    });

    it("should do nothing when io is not initialized", () => {
      (socketService as any).io = null;

      socketService.emitBellNotificationUpdate("user123", "test", {});

      expect(mockIO.to).not.toHaveBeenCalled();
    });
  });

  describe("emitUnreadCountUpdate", () => {
    beforeEach(() => {
      socketService.initialize(mockHttpServer);
    });

    it("should emit unread count update to specific user", () => {
      const counts = {
        bellNotifications: 5,
        systemMessages: 3,
        total: 8,
      };

      socketService.emitUnreadCountUpdate("user123", counts);

      expect(mockIO.to).toHaveBeenCalledWith("user:user123");
      expect(mockIO.emit).toHaveBeenCalledWith("unread_count_update", {
        counts,
        timestamp: expect.any(String),
      });
    });

    it("should do nothing when io is not initialized", () => {
      (socketService as any).io = null;

      socketService.emitUnreadCountUpdate("user123", {
        bellNotifications: 0,
        systemMessages: 0,
        total: 0,
      });

      expect(mockIO.to).not.toHaveBeenCalled();
    });
  });

  describe("emitEventUpdate", () => {
    beforeEach(() => {
      socketService.initialize(mockHttpServer);
    });

    it("should emit event update only to the authorized event room", () => {
      const testData = { userId: "user123", role: "vocalist" };

      socketService.emitEventUpdate(EVENT_ID, "user_signed_up", testData);

      // Event room subscribers receive only an invalidation.
      expect(mockIO.to).toHaveBeenCalledWith(`event:${EVENT_ID}`);
      expect(mockIO.emit).toHaveBeenCalledWith("event_update", {
        eventId: EVENT_ID,
        updateType: "user_signed_up",
        data: null,
        timestamp: expect.any(String),
      });
      expect(mockIO.except).not.toHaveBeenCalled();
      expect(mockIO.emit).toHaveBeenCalledTimes(1);
    });

    it("should do nothing when io is not initialized", () => {
      (socketService as any).io = null;

      socketService.emitEventUpdate(EVENT_ID, "test", {});

      expect(mockIO.emit).not.toHaveBeenCalled();
    });
  });

  describe("emitEventRoomUpdate", () => {
    beforeEach(() => {
      socketService.initialize(mockHttpServer);
    });

    it("should emit event room update to specific event room", () => {
      const testData = { message: "Role is now full" };

      socketService.emitEventRoomUpdate(EVENT_ID, "role_full", testData);

      expect(mockIO.to).toHaveBeenCalledWith(`event:${EVENT_ID}`);
      expect(mockIO.emit).toHaveBeenCalledWith("event_room_update", {
        eventId: EVENT_ID,
        updateType: "role_full",
        data: null,
        timestamp: expect.any(String),
      });
    });

    it("should do nothing when io is not initialized", () => {
      (socketService as any).io = null;

      socketService.emitEventRoomUpdate(EVENT_ID, "test", {});

      expect(mockIO.to).not.toHaveBeenCalled();
    });
  });

  describe("user tracking methods", () => {
    beforeEach(() => {
      socketService.initialize(mockHttpServer);

      // Simulate some connected users
      (socketService as any).userSockets.set(
        "user123",
        new Set(["socket1", "socket2"])
      );
      (socketService as any).userSockets.set("user456", new Set(["socket3"]));
    });

    it("should return correct online users count", () => {
      expect(socketService.getOnlineUsersCount()).toBe(2);
    });

    it("should correctly check if user is online", () => {
      expect(socketService.isUserOnline("user123")).toBe(true);
      expect(socketService.isUserOnline("user456")).toBe(true);
      expect(socketService.isUserOnline("user789")).toBe(false);
    });

    it("should return all online user IDs", () => {
      const onlineUsers = socketService.getOnlineUserIds();
      expect(onlineUsers).toContain("user123");
      expect(onlineUsers).toContain("user456");
      expect(onlineUsers).toHaveLength(2);
    });
  });

  describe("event room management", () => {
    beforeEach(() => {
      socketService.initialize(mockHttpServer);
      mockSocket.userId = USER_ID;
    });

    it("authorizes a valid event room and returns an optional ack", async () => {
      const { User, Event } = await import("../../../../src/models");
      vi.mocked(User.findById).mockResolvedValue(mockUser);
      vi.mocked(Event.findById).mockResolvedValue({ _id: EVENT_ID } as any);
      const ack = vi.fn();

      await socketService.handleJoinEventRoom(
        mockSocket as any,
        EVENT_ID,
        ack,
      );

      expect(Event.findById).toHaveBeenCalledWith(EVENT_ID);
      expect(mockSocket.join).toHaveBeenCalledWith(`event:${EVENT_ID}`);
      expect(ack).toHaveBeenCalledWith({ ok: true, eventId: EVENT_ID });
    });

    it("rejects a malformed event ID before querying or joining", async () => {
      const ack = vi.fn();

      await socketService.handleJoinEventRoom(
        mockSocket as any,
        "event:forged",
        ack,
      );

      expect(User.findById).not.toHaveBeenCalled();
      expect(Event.findById).not.toHaveBeenCalled();
      expect(mockSocket.join).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledWith({
        ok: false,
        code: "INVALID_EVENT_ID",
      });
    });

    it("ignores a hostile non-function acknowledgement payload", async () => {
      await expect(
        socketService.handleJoinEventRoom(
          mockSocket as any,
          "event:forged",
          "not-a-callback" as any,
        ),
      ).resolves.toBeUndefined();

      expect(User.findById).not.toHaveBeenCalled();
      expect(mockSocket.join).not.toHaveBeenCalled();
      expect(() =>
        socketService.handleLeaveEventRoom(
          mockSocket as any,
          "event:forged",
          { hostile: true } as any,
        ),
      ).not.toThrow();
    });

    it("fails closed when the event does not exist", async () => {
      vi.mocked(Event.findById).mockResolvedValue(null);
      const ack = vi.fn();

      await socketService.handleJoinEventRoom(
        mockSocket as any,
        EVENT_ID,
        ack,
      );

      expect(mockSocket.join).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledWith({
        ok: false,
        code: "EVENT_NOT_FOUND",
      });
    });

    it("conceals a paid event from a user without a purchase", async () => {
      vi.mocked(Event.findById).mockResolvedValue({
        _id: EVENT_ID,
        pricing: { isFree: false },
        createdBy: "507f1f77bcf86cd799439099",
        organizerDetails: [],
        programLabels: [],
      } as any);
      vi.mocked(Purchase.findOne).mockReturnValue({
        select: vi.fn().mockResolvedValue(null),
      } as any);
      const ack = vi.fn();

      await socketService.handleJoinEventRoom(
        mockSocket as any,
        EVENT_ID,
        ack,
      );

      expect(mockSocket.join).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledWith({
        ok: false,
        code: "EVENT_NOT_FOUND",
      });
    });

    it("rechecks the account and disconnects it when no longer verified", async () => {
      vi.mocked(User.findById).mockResolvedValue({
        ...mockUser,
        isVerified: false,
      });
      const ack = vi.fn();

      await socketService.handleJoinEventRoom(
        mockSocket as any,
        EVENT_ID,
        ack,
      );

      expect(mockSocket.join).not.toHaveBeenCalled();
      expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
      expect(ack).toHaveBeenCalledWith({
        ok: false,
        code: "ACCOUNT_UNAVAILABLE",
      });
    });

    it("fails closed when the authorization query errors", async () => {
      vi.mocked(Event.findById).mockRejectedValue(new Error("database down"));
      const ack = vi.fn();

      await socketService.handleJoinEventRoom(
        mockSocket as any,
        EVENT_ID,
        ack,
      );

      expect(mockSocket.join).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledWith({
        ok: false,
        code: "AUTHORIZATION_FAILED",
      });
    });

    it("rate-limits repeated valid join attempts before further database work", async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await socketService.handleJoinEventRoom(
          mockSocket as any,
          EVENT_ID,
          vi.fn(),
        );
      }
      const ack = vi.fn();

      await socketService.handleJoinEventRoom(
        mockSocket as any,
        EVENT_ID,
        ack,
      );

      expect(User.findById).toHaveBeenCalledTimes(20);
      expect(ack).toHaveBeenCalledWith({
        ok: false,
        code: "RATE_LIMITED",
      });
    });

    it("rejects a duplicate in-flight join without duplicate database work", async () => {
      let resolveUser!: (user: typeof mockUser) => void;
      const pendingUser = new Promise<typeof mockUser>((resolve) => {
        resolveUser = resolve;
      });
      vi.mocked(User.findById).mockReturnValue(pendingUser as any);
      const firstAck = vi.fn();
      const secondAck = vi.fn();

      const firstJoin = socketService.handleJoinEventRoom(
        mockSocket as any,
        EVENT_ID,
        firstAck,
      );
      await Promise.resolve();
      await socketService.handleJoinEventRoom(
        mockSocket as any,
        EVENT_ID,
        secondAck,
      );

      expect(User.findById).toHaveBeenCalledOnce();
      expect(secondAck).toHaveBeenCalledWith({
        ok: false,
        code: "REQUEST_IN_PROGRESS",
      });

      resolveUser(mockUser);
      await firstJoin;
      expect(firstAck).toHaveBeenCalledWith({ ok: true, eventId: EVENT_ID });
    });

    it("rejects a join when authorization changes during its lookup", async () => {
      let resolveUser!: (user: typeof mockUser) => void;
      vi.mocked(User.findById).mockReturnValue(
        new Promise<typeof mockUser>((resolve) => {
          resolveUser = resolve;
        }) as any,
      );
      const ack = vi.fn();

      const join = socketService.handleJoinEventRoom(
        mockSocket as any,
        EVENT_ID,
        ack,
      );
      await Promise.resolve();
      socketService.syncUserAuthorization(USER_ID, {
        role: "Participant",
        isActive: true,
      });
      resolveUser(mockUser);
      await join;

      expect(mockSocket.join).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledWith({
        ok: false,
        code: "AUTHORIZATION_FAILED",
      });
    });

    it("leaves a room when authorization changes while joining it", async () => {
      let resolveJoin!: () => void;
      mockSocket.join.mockReturnValue(
        new Promise<void>((resolve) => {
          resolveJoin = resolve;
        }),
      );
      const ack = vi.fn();

      const join = socketService.handleJoinEventRoom(
        mockSocket as any,
        EVENT_ID,
        ack,
      );
      await vi.waitFor(() => expect(mockSocket.join).toHaveBeenCalledOnce());
      socketService.syncUserAuthorization(USER_ID, {
        role: "Participant",
        isActive: true,
      });
      resolveJoin();
      await join;

      expect(mockSocket.leave).toHaveBeenCalledWith(`event:${EVENT_ID}`);
      expect(ack).toHaveBeenCalledWith({
        ok: false,
        code: "AUTHORIZATION_FAILED",
      });
    });

    it("rejects an in-flight join when the user is ejected from the resource", async () => {
      let resolveUser!: (user: typeof mockUser) => void;
      vi.mocked(User.findById).mockReturnValue(
        new Promise<typeof mockUser>((resolve) => {
          resolveUser = resolve;
        }) as any,
      );
      const ack = vi.fn();

      const join = socketService.handleJoinEventRoom(
        mockSocket as any,
        EVENT_ID,
        ack,
      );
      await Promise.resolve();
      expect(
        socketService.ejectUserFromResourceRoom(USER_ID, "event", EVENT_ID),
      ).toBe(true);
      resolveUser(mockUser);
      await join;

      expect(mockIO.socketsLeave).toHaveBeenCalledWith(`event:${EVENT_ID}`);
      expect(mockSocket.join).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledWith({
        ok: false,
        code: "AUTHORIZATION_FAILED",
      });
    });

    it("rejects an in-flight join when the resource authorization changes", async () => {
      let resolveUser!: (user: typeof mockUser) => void;
      vi.mocked(User.findById).mockReturnValue(
        new Promise<typeof mockUser>((resolve) => {
          resolveUser = resolve;
        }) as any,
      );
      const ack = vi.fn();

      const join = socketService.handleJoinEventRoom(
        mockSocket as any,
        EVENT_ID,
        ack,
      );
      await Promise.resolve();
      expect(socketService.invalidateResourceRoom("event", EVENT_ID)).toBe(
        true,
      );
      resolveUser(mockUser);
      await join;

      expect(mockIO.in).toHaveBeenCalledWith(`event:${EVENT_ID}`);
      expect(mockIO.disconnectSockets).toHaveBeenCalledWith(true);
      expect(mockSocket.join).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledWith({
        ok: false,
        code: "AUTHORIZATION_FAILED",
      });
    });

    it("leaves a room when the resource changes while joining it", async () => {
      let resolveJoin!: () => void;
      mockSocket.join.mockReturnValue(
        new Promise<void>((resolve) => {
          resolveJoin = resolve;
        }),
      );
      const ack = vi.fn();

      const join = socketService.handleJoinEventRoom(
        mockSocket as any,
        EVENT_ID,
        ack,
      );
      await vi.waitFor(() => expect(mockSocket.join).toHaveBeenCalledOnce());
      socketService.invalidateResourceRoom("event", EVENT_ID);
      resolveJoin();
      await join;

      expect(mockSocket.leave).toHaveBeenCalledWith(`event:${EVENT_ID}`);
      expect(ack).toHaveBeenCalledWith({
        ok: false,
        code: "AUTHORIZATION_FAILED",
      });
    });

    it("cleans up per-socket join guard state on disconnect", () => {
      (socketService as any).eventJoinGuards.set(mockSocket.id, {
        attempts: [Date.now()],
        inFlight: new Set([EVENT_ID]),
      });
      const connectionHandler = vi
        .mocked(mockIO.on)
        .mock.calls.find((call) => call[0] === "connection")?.[1];

      connectionHandler(mockSocket);
      const disconnectHandler = vi
        .mocked(mockSocket.on)
        .mock.calls.find((call) => call[0] === "disconnect")?.[1];
      disconnectHandler();

      expect((socketService as any).eventJoinGuards.has(mockSocket.id)).toBe(
        false,
      );
    });

    it("should handle leave event room", () => {
      socketService.handleLeaveEventRoom(mockSocket as any, EVENT_ID);

      expect(mockSocket.leave).toHaveBeenCalledWith(`event:${EVENT_ID}`);
    });

    it("rejects a malformed leave request", () => {
      const ack = vi.fn();

      socketService.handleLeaveEventRoom(mockSocket as any, "../admin", ack);

      expect(mockSocket.leave).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledWith({
        ok: false,
        code: "INVALID_EVENT_ID",
      });
    });
  });

  describe("conversation room management", () => {
    beforeEach(() => {
      socketService.initialize(mockHttpServer);
      mockSocket.userId = USER_ID;
    });

    it("joins only after a fresh active access-window authorization", async () => {
      const ack = vi.fn();

      await socketService.handleJoinConversationRoom(
        mockSocket,
        CONVERSATION_ID,
        ack,
      );

      expect(Conversation.findOne).toHaveBeenCalled();
      expect(ConversationMember.findOne).toHaveBeenCalled();
      expect(mockSocket.join).toHaveBeenCalledWith(
        `conversation:${CONVERSATION_ID}`,
      );
      expect(ack).toHaveBeenCalledWith({
        ok: true,
        conversationId: CONVERSATION_ID,
      });
    });

    it("conceals a missing or history-only membership", async () => {
      vi.mocked(ConversationMember.findOne).mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({
            _id: "507f1f77bcf86cd799439015",
            status: "history_only",
            accessWindows: [
              {
                visibleFromSequence: 1,
                visibleThroughSequence: 8,
                openedAt: new Date("2026-09-12T12:00:00.000Z"),
                closedAt: new Date("2026-09-12T13:00:00.000Z"),
              },
            ],
          }),
        }),
      } as any);
      const ack = vi.fn();

      await socketService.handleJoinConversationRoom(
        mockSocket,
        CONVERSATION_ID,
        ack,
      );

      expect(mockSocket.join).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledWith({
        ok: false,
        code: "CONVERSATION_NOT_FOUND",
      });
    });

    it("fails closed before member lookup when runtime is off", async () => {
      vi.mocked(featureControlService.getRuntimeConfig).mockResolvedValue(
        createRuntimeConfigDTO("off", 2),
      );
      const ack = vi.fn();

      await socketService.handleJoinConversationRoom(
        mockSocket,
        CONVERSATION_ID,
        ack,
      );

      expect(Conversation.findOne).not.toHaveBeenCalled();
      expect(ConversationMember.findOne).not.toHaveBeenCalled();
      expect(mockSocket.join).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledWith({
        ok: false,
        code: "AUTHORIZATION_FAILED",
      });
    });

    it("rejects malformed conversation IDs without querying state", async () => {
      const ack = vi.fn();

      await socketService.handleJoinConversationRoom(
        mockSocket,
        "../admin",
        ack,
      );

      expect(User.findById).not.toHaveBeenCalled();
      expect(Conversation.findOne).not.toHaveBeenCalled();
      expect(mockSocket.join).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledWith({
        ok: false,
        code: "INVALID_CONVERSATION_ID",
      });
    });

    it("leaves only the canonical conversation room", () => {
      const ack = vi.fn();

      socketService.handleLeaveConversationRoom(
        mockSocket,
        CONVERSATION_ID.toUpperCase(),
        ack,
      );

      expect(mockSocket.leave).toHaveBeenCalledWith(
        `conversation:${CONVERSATION_ID}`,
      );
      expect(ack).toHaveBeenCalledWith({
        ok: true,
        conversationId: CONVERSATION_ID,
      });
    });
  });

  describe("safe socket revocation helpers", () => {
    beforeEach(() => {
      socketService.initialize(mockHttpServer);
    });

    it("disconnects every socket in a canonical user's private room", () => {
      expect(socketService.disconnectUser(USER_ID)).toBe(true);

      expect(mockIO.in).toHaveBeenCalledWith(`user:${USER_ID}`);
      expect(mockIO.disconnectSockets).toHaveBeenCalledWith(true);
    });

    it("bumps authorization revisions before Socket.IO is available", () => {
      (socketService as any).io = null;

      expect(socketService.disconnectUser(USER_ID)).toBe(false);
      expect(
        (socketService as any).userAuthorizationRevisions.get(USER_ID),
      ).toBe(1);

      expect(
        socketService.syncUserAuthorization(USER_ID, {
          role: "Participant",
          isActive: true,
        }),
      ).toBe(false);
      expect(
        (socketService as any).userAuthorizationRevisions.get(USER_ID),
      ).toBe(2);
    });

    it("ejects every user socket from a server-defined resource room", () => {
      expect(
        socketService.ejectUserFromResourceRoom(USER_ID, "event", EVENT_ID),
      ).toBe(true);

      expect(mockIO.in).toHaveBeenCalledWith(`user:${USER_ID}`);
      expect(mockIO.socketsLeave).toHaveBeenCalledWith(`event:${EVENT_ID}`);
    });

    it("disconnects a resource room and bumps its authorization revision", () => {
      expect(socketService.invalidateResourceRoom("event", EVENT_ID)).toBe(
        true,
      );

      expect(mockIO.in).toHaveBeenCalledWith(`event:${EVENT_ID}`);
      expect(mockIO.disconnectSockets).toHaveBeenCalledWith(true);
      expect(
        (socketService as any).resourceAuthorizationRevisions.get(
          `event:${EVENT_ID}`,
        ),
      ).toBe(1);
    });

    it("rejects malformed identifiers without touching Socket.IO rooms", () => {
      expect(socketService.disconnectUser("not-an-id")).toBe(false);
      expect(
        socketService.ejectUserFromResourceRoom(
          USER_ID,
          "conversation",
          "not-an-id",
        ),
      ).toBe(false);
      expect(
        socketService.invalidateResourceRoom(
          "../permission" as any,
          EVENT_ID,
        ),
      ).toBe(false);
      expect(
        socketService.invalidateResourceRoom("event", "not-an-id"),
      ).toBe(false);
      expect(
        socketService.ejectUserFromResourceRoom(
          USER_ID,
          "../permission" as any,
          EVENT_ID,
        ),
      ).toBe(false);

      expect(mockIO.in).not.toHaveBeenCalled();
      expect(mockIO.disconnectSockets).not.toHaveBeenCalled();
      expect(mockIO.socketsLeave).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    beforeEach(() => {
      socketService.initialize(mockHttpServer);
    });

    it("should handle engine connection errors", () => {
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      // Get the connection_error handler
      const errorCall = vi
        .mocked(mockIO.engine.on)
        .mock.calls.find((call) => call[0] === "connection_error");
      const errorHandler = errorCall?.[1];

      const mockError = {
        req: "mock-request",
        code: "CONNECTION_ERROR",
        message: "Connection failed",
      };

      errorHandler(mockError);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Socket.IO engine connection error:",
        "mock-request",
        "CONNECTION_ERROR",
        "Connection failed"
      );

      consoleErrorSpy.mockRestore();
    });

    it("should handle socket errors", () => {
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const connectionCall = vi
        .mocked(mockIO.on)
        .mock.calls.find((call) => call[0] === "connection");
      const connectionHandler = connectionCall?.[1];

      connectionHandler(mockSocket);

      // Get the error handler
      const errorCall = vi
        .mocked(mockSocket.on)
        .mock.calls.find((call) => call[0] === "error");
      const socketErrorHandler = errorCall?.[1];

      const mockError = new Error("Socket error occurred");
      socketErrorHandler(mockError);

      expect(consoleErrorSpy).toHaveBeenCalledWith("Socket error:", mockError);

      consoleErrorSpy.mockRestore();
    });
  });

  describe("singleton instance", () => {
    it("should export a singleton instance", () => {
      expect(socketService).toBeDefined();
      expect(typeof socketService.initialize).toBe("function");
    });

    it("should maintain state across multiple method calls", () => {
      socketService.initialize(mockHttpServer);

      // Simulate adding users
      (socketService as any).userSockets.set("user1", new Set(["socket1"]));

      expect(socketService.getOnlineUsersCount()).toBe(1);
      expect(socketService.isUserOnline("user1")).toBe(true);
    });
  });

  describe("internal handlers - early return branches", () => {
    it("setupSocketHandlers is a no-op when io is null (early return)", () => {
      // Ensure io is null and calling setupSocketHandlers does nothing
      (socketService as any).io = null;
      // @ts-ignore access private for test
      const result = (socketService as any).setupSocketHandlers();
      expect(result).toBeUndefined();
    });
  });
});
