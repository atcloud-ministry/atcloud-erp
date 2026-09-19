import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Request, Response } from "express";
import UserDeletionController from "../../../../src/controllers/user-admin/UserDeletionController";

// Mock dependencies
vi.mock("../../../../src/models", () => ({
  User: {
    findById: vi.fn(),
    find: vi.fn(),
  },
}));

vi.mock("../../../../src/utils/roleUtils", () => ({
  ROLES: {
    SUPER_ADMIN: "Super Admin",
    ADMINISTRATOR: "Administrator",
    LEADER: "Leader",
    STAFF: "Staff",
    PARTICIPANT: "Participant",
  },
}));

vi.mock(
  "../../../../src/services/infrastructure/autoEmailNotificationService",
  () => ({
    AutoEmailNotificationService: {
      sendAccountStatusChangeAdminNotifications: vi.fn(),
    },
  })
);

vi.mock("../../../../src/controllers/unifiedMessageController", () => ({
  UnifiedMessageController: {
    createTargetedSystemMessage: vi.fn(),
  },
}));

vi.mock("../../../../src/services/infrastructure/CacheService", () => ({
  CachePatterns: {
    invalidateUserCache: vi.fn(),
  },
}));

vi.mock("../../../../src/services/infrastructure/SocketService", () => ({
  socketService: {
    disconnectUser: vi.fn(),
  },
}));

vi.mock("../../../../src/utils/systemMessageFormatUtils", () => ({
  formatActorDisplay: vi.fn().mockReturnValue("Admin User"),
}));

vi.mock("../../../../src/services/LockService", () => ({
  lockService: {
    withLock: vi.fn(),
  },
}));

vi.mock("../../../../src/utils/responseHelper", () => ({
  ResponseHelper: {
    authRequired: vi.fn((res) =>
      res
        .status(401)
        .json({ success: false, message: "Authentication required." })
    ),
    forbidden: vi.fn((res, msg) =>
      res.status(403).json({ success: false, message: msg })
    ),
    notFound: vi.fn((res, msg) =>
      res.status(404).json({ success: false, message: msg })
    ),
    success: vi.fn((res, data, message, status) =>
      res.status(status).json({ success: true, data, message })
    ),
    serverError: vi.fn((res) =>
      res.status(500).json({ success: false, message: "Internal server error" })
    ),
  },
}));
vi.mock(
  "../../../../src/services/programs/ProgramMembershipMutationSyncTrigger",
  () => ({
    programMembershipMutationSyncTrigger: {
      userEligibilityChanged: vi.fn(),
    },
  }),
);

import { User } from "../../../../src/models";
import { lockService } from "../../../../src/services/LockService";
import { CachePatterns } from "../../../../src/services/infrastructure/CacheService";
import { ResponseHelper } from "../../../../src/utils/responseHelper";
import { socketService } from "../../../../src/services/infrastructure/SocketService";
import { programMembershipMutationSyncTrigger } from "../../../../src/services/programs/ProgramMembershipMutationSyncTrigger";
import { UnifiedMessageController } from "../../../../src/controllers/unifiedMessageController";

interface MockRequest {
  params: Record<string, string>;
  user?: {
    _id: string;
    id: string;
    role: string;
    email: string;
    firstName?: string;
    lastName?: string;
    avatar?: string;
    gender?: string;
  };
  ip?: string;
  get?: (header: string) => string;
}

describe("UserDeletionController", () => {
  let mockReq: MockRequest;
  let mockRes: Partial<Response>;
  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: any;
  let consoleLogSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();

    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    mockRes = {
      status: statusMock as unknown as Response["status"],
      json: jsonMock as unknown as Response["json"],
    };

    mockReq = {
      params: { id: "targetUser123" },
      user: {
        _id: "admin123",
        id: "admin123",
        role: "Super Admin",
        email: "admin@test.com",
        firstName: "Admin",
        lastName: "User",
      },
      ip: "127.0.0.1",
      get: vi.fn().mockReturnValue("Mozilla/5.0"),
    };

    vi.mocked(CachePatterns.invalidateUserCache).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  describe("deleteUser", () => {
    describe("Authentication", () => {
      it("should return 401 if user is not authenticated", async () => {
        mockReq.user = undefined;

        await UserDeletionController.deleteUser(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(ResponseHelper.authRequired).toHaveBeenCalledWith(mockRes);
      });
    });

    describe("Authorization", () => {
      it("should return 403 if user is not Super Admin", async () => {
        mockReq.user = {
          _id: "admin123",
          id: "admin123",
          role: "Administrator",
          email: "admin@test.com",
        };

        await UserDeletionController.deleteUser(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(ResponseHelper.forbidden).toHaveBeenCalledWith(
          mockRes,
          "Only Super Admin can delete users."
        );
      });

      it("should return 404 if target user not found", async () => {
        vi.mocked(User.findById).mockResolvedValue(null);

        await UserDeletionController.deleteUser(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(ResponseHelper.notFound).toHaveBeenCalledWith(
          mockRes,
          "User not found."
        );
      });

      it("should return 403 if trying to delete Super Admin", async () => {
        const mockSuperAdminUser = {
          _id: "targetUser123",
          id: "targetUser123",
          role: "Super Admin",
          email: "superadmin@test.com",
        };
        vi.mocked(User.findById).mockResolvedValue(mockSuperAdminUser);

        await UserDeletionController.deleteUser(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(ResponseHelper.forbidden).toHaveBeenCalledWith(
          mockRes,
          "Cannot delete Super Admin users."
        );
      });

      it("should return 403 if trying to delete self", async () => {
        mockReq.params.id = "admin123";
        const mockTargetUser = {
          _id: "admin123",
          id: "admin123",
          role: "Administrator",
          email: "admin@test.com",
        };
        vi.mocked(User.findById).mockResolvedValue(mockTargetUser);

        await UserDeletionController.deleteUser(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(ResponseHelper.forbidden).toHaveBeenCalledWith(
          mockRes,
          "Cannot delete your own account."
        );
      });
    });

    describe("Successful Deletion", () => {
      const mockTargetUser = {
        _id: "targetUser123",
        id: "targetUser123",
        username: "targetuser",
        email: "target@test.com",
        firstName: "Target",
        lastName: "User",
        role: "Participant",
      };

      const mockDeletionReport = {
        userEmail: "target@test.com",
        deletedData: {
          registrations: 5,
          eventsCreated: 2,
          eventOrganizations: 1,
          messagesCreated: 10,
        },
        updatedStatistics: {
          events: ["event1", "event2"],
        },
      };

      beforeEach(() => {
        vi.mocked(User.findById).mockResolvedValue(mockTargetUser);
        vi.mocked(User.find).mockReturnValue({
          select: vi
            .fn()
            .mockResolvedValue([{ _id: "admin1" }, { _id: "admin2" }]),
        } as any);
        vi.mocked(lockService.withLock).mockImplementation(
          async (_key, callback) => callback()
        );

        // Mock the dynamic import of UserDeletionService
        vi.doMock("../../../../src/services/UserDeletionService", () => ({
          UserDeletionService: {
            deleteUserCompletely: vi.fn().mockResolvedValue(mockDeletionReport),
          },
        }));
      });

      it("should delete user with lock service", async () => {
        vi.mocked(lockService.withLock).mockResolvedValue(mockDeletionReport);

        await UserDeletionController.deleteUser(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(lockService.withLock).toHaveBeenCalledWith(
          "user-deletion:targetUser123",
          expect.any(Function),
          10000
        );
        expect(
          programMembershipMutationSyncTrigger.userEligibilityChanged,
        ).toHaveBeenCalledWith("targetUser123", {
          actor: {
            type: "user",
            id: "admin123",
            role: "Super Admin",
          },
          source: "http",
          correlationId: undefined,
        });
        expect(ResponseHelper.success).toHaveBeenCalled();
      });

      it("should invalidate user cache after deletion", async () => {
        vi.mocked(lockService.withLock).mockResolvedValue(mockDeletionReport);

        await UserDeletionController.deleteUser(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(CachePatterns.invalidateUserCache).toHaveBeenCalledWith(
          "targetUser123"
        );
      });

      it("should disconnect every live socket for the deleted user", async () => {
        vi.mocked(lockService.withLock).mockResolvedValue(mockDeletionReport);

        await UserDeletionController.deleteUser(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(socketService.disconnectUser).toHaveBeenCalledWith(
          "targetUser123"
        );
      });

      it("creates a short-lived deletion notice without retaining target PII", async () => {
        const now = new Date("2032-01-31T20:15:00.000Z");
        vi.useFakeTimers();
        vi.setSystemTime(now);
        vi.mocked(lockService.withLock).mockResolvedValue(mockDeletionReport);

        await UserDeletionController.deleteUser(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        const call = vi.mocked(
          UnifiedMessageController.createTargetedSystemMessage,
        ).mock.calls[0];
        expect(call).toBeDefined();
        expect(call?.[0]).toMatchObject({
          title: "User Account Deleted",
          content: "A user account was permanently deleted by Admin User.",
          type: "user_management",
          expiresAt: new Date("2032-03-01T20:15:00.000Z"),
        });
        expect(call?.[1]).toEqual(["admin1", "admin2"]);

        const persistedNoticeInput = JSON.stringify(call);
        expect(persistedNoticeInput).not.toContain("targetUser123");
        expect(persistedNoticeInput).not.toContain("targetuser");
        expect(persistedNoticeInput).not.toContain("target@test.com");
        expect(persistedNoticeInput).not.toContain("Target User");
      });

    });

    describe("Error Handling", () => {
      it("should return 500 on database error", async () => {
        vi.mocked(User.findById).mockRejectedValue(new Error("Database error"));

        await UserDeletionController.deleteUser(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(ResponseHelper.serverError).toHaveBeenCalledWith(mockRes);
        expect(consoleErrorSpy).toHaveBeenCalled();
      });
    });
  });
});
