import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Server as SocketIOServer } from "socket.io";
import { Server as HTTPServer } from "http";
import { socketService } from "../../../../src/services/infrastructure/SocketService";

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
}));

vi.mock("../../../../src/services/authorization/AuthorizationAuditService", () => ({
  recordAuthorizationDenial: vi.fn(),
}));

describe("SocketService.emitUserUpdate", () => {
  let mockIO: any;
  let mockHttpServer: HTTPServer;

  beforeEach(() => {
    // Reset the singleton state
    (socketService as any).io = null;
    (socketService as any).authenticatedSockets = new Map();
    (socketService as any).userSockets = new Map();
    (socketService as any).userAuthorizationRevisions = new Map();

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

    vi.mocked(SocketIOServer).mockReturnValue(mockIO);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("should emit user_update event with correct data for role_changed", () => {
    socketService.initialize(mockHttpServer);

    const updateData = {
      type: "role_changed" as const,
      user: {
        id: "user123",
        username: "testuser",
        email: "test@example.com",
        firstName: "John",
        lastName: "Doe",
        role: "admin",
      },
      oldValue: "member",
      newValue: "admin",
    };

    socketService.emitUserUpdate("user123", updateData);

    expect(mockIO.to).toHaveBeenCalledWith("permission:manage_users");
    expect(mockIO.emit.mock.calls[0]).toEqual(["user_update", {
      userId: "user123",
      ...updateData,
      timestamp: expect.any(String),
    }]);
    expect(mockIO.except).toHaveBeenCalledWith("permission:manage_users");
    expect(mockIO.emit.mock.calls[1][1]).toEqual({
      userId: "user123",
      type: "role_changed",
      user: { id: "user123" },
      timestamp: expect.any(String),
    });
    expect(mockIO.emit.mock.calls[1][1]).not.toHaveProperty("user.email");
    expect(mockIO.emit.mock.calls[1][1]).not.toHaveProperty("user.role");
  });

  it("should emit user_update event for status_changed", () => {
    socketService.initialize(mockHttpServer);

    const updateData = {
      type: "status_changed" as const,
      user: {
        id: "user456",
        isActive: false,
      },
      oldValue: "active",
      newValue: "inactive",
    };

    socketService.emitUserUpdate("user456", updateData);

    expect(mockIO.emit.mock.calls[0]).toEqual(["user_update", {
      userId: "user456",
      ...updateData,
      timestamp: expect.any(String),
    }]);
    expect(mockIO.emit.mock.calls[1][1]).toEqual({
      userId: "user456",
      type: "status_changed",
      user: { id: "user456" },
      timestamp: expect.any(String),
    });
  });

  it("should emit user_update event for deleted", () => {
    socketService.initialize(mockHttpServer);

    const updateData = {
      type: "deleted" as const,
      user: {
        id: "user789",
        username: "deleteduser",
      },
    };

    socketService.emitUserUpdate("user789", updateData);

    expect(mockIO.emit.mock.calls[0]).toEqual(["user_update", {
      userId: "user789",
      ...updateData,
      timestamp: expect.any(String),
    }]);
    expect(mockIO.emit.mock.calls[1][1]).toEqual({
      userId: "user789",
      type: "deleted",
      user: { id: "user789" },
      timestamp: expect.any(String),
    });
  });

  it("should emit user_update event for profile_edited with changes", () => {
    socketService.initialize(mockHttpServer);

    const updateData = {
      type: "profile_edited" as const,
      user: {
        id: "user111",
        firstName: "Updated",
        lastName: "Name",
        phone: "555-1234",
        avatar: "new-avatar.png",
        isAtCloudLeader: true,
        roleInAtCloud: "leader",
      },
      changes: {
        firstName: true,
        lastName: true,
        phone: true,
      },
    };

    socketService.emitUserUpdate("user111", updateData);

    expect(mockIO.emit.mock.calls[0]).toEqual(["user_update", {
      userId: "user111",
      ...updateData,
      timestamp: expect.any(String),
    }]);
    const safePayload = mockIO.emit.mock.calls[1][1];
    expect(safePayload).toEqual({
      userId: "user111",
      type: "profile_edited",
      user: { id: "user111", avatar: "new-avatar.png" },
      timestamp: expect.any(String),
    });
    expect(safePayload).not.toHaveProperty("user.phone");
    expect(safePayload).not.toHaveProperty("user.firstName");
  });

  it("should not emit when io is not initialized", () => {
    // Don't call initialize - io remains null
    // The service uses this.log.warn internally, but doesn't emit

    const updateData = {
      type: "role_changed" as const,
      user: {
        id: "user123",
      },
    };

    // Should not throw
    socketService.emitUserUpdate("user123", updateData);

    // mockIO.emit should not have been called since io is null
    expect(mockIO.emit).not.toHaveBeenCalled();
  });

  it("should include timestamp in emitted event", () => {
    socketService.initialize(mockHttpServer);

    const beforeTime = new Date().toISOString();

    const updateData = {
      type: "status_changed" as const,
      user: {
        id: "user222",
      },
    };

    socketService.emitUserUpdate("user222", updateData);

    const afterTime = new Date().toISOString();

    expect(mockIO.emit).toHaveBeenCalled();
    const emittedData = mockIO.emit.mock.calls[0][1];
    expect(emittedData.timestamp).toBeDefined();
    expect(emittedData.timestamp >= beforeTime).toBe(true);
    expect(emittedData.timestamp <= afterTime).toBe(true);
  });

  it("should handle minimal user data", () => {
    socketService.initialize(mockHttpServer);

    const updateData = {
      type: "role_changed" as const,
      user: {
        id: "minimalUser",
      },
    };

    socketService.emitUserUpdate("minimalUser", updateData);

    expect(mockIO.emit.mock.calls[0]).toEqual(["user_update", {
      userId: "minimalUser",
      ...updateData,
      timestamp: expect.any(String),
    }]);
    expect(mockIO.emit.mock.calls[1][1]).toEqual({
      userId: "minimalUser",
      type: "role_changed",
      user: { id: "minimalUser" },
      timestamp: expect.any(String),
    });
  });

  it("disconnects live sockets after a persisted role change", () => {
    socketService.initialize(mockHttpServer);
    const userId = "507f1f77bcf86cd799439011";

    expect(
      socketService.syncUserAuthorization(userId, {
        role: "Administrator",
        isActive: true,
      }),
    ).toBe(true);
    expect(mockIO.in).toHaveBeenCalledWith(`user:${userId}`);
    expect(mockIO.disconnectSockets).toHaveBeenCalledWith(true);

    socketService.emitUserUpdate(userId, {
      type: "role_changed",
      user: { id: userId, role: "Administrator" },
    });
    expect(mockIO.disconnectSockets).toHaveBeenCalledTimes(1);
  });

  it("disconnects a deactivated canonical user", () => {
    socketService.initialize(mockHttpServer);
    const userId = "507f1f77bcf86cd799439011";

    socketService.syncUserAuthorization(userId, { isActive: false });

    expect(mockIO.socketsLeave).toHaveBeenCalledWith(
      "permission:manage_users",
    );
    expect(mockIO.disconnectSockets).toHaveBeenCalledWith(true);
  });
});
