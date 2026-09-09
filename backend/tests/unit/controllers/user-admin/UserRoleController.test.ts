import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Request, Response } from "express";
import UserRoleController from "../../../../src/controllers/user-admin/UserRoleController";

// Mock dependencies
vi.mock("../../../../src/models", () => ({
  User: {
    findById: vi.fn(),
  },
}));

vi.mock("../../../../src/utils/roleUtils", () => ({
  RoleUtils: {
    isValidRole: vi.fn(),
    canPromoteUser: vi.fn(),
    isPromotion: vi.fn(),
  },
  hasPermission: vi.fn(),
  PERMISSIONS: {
    EDIT_USER_ROLES: "edit_user_roles",
  },
}));

vi.mock("../../../../src/services/infrastructure/SocketService", () => ({
  socketService: {
    emitUserUpdate: vi.fn(),
    syncUserAuthorization: vi.fn(),
  },
}));

vi.mock(
  "../../../../src/services/infrastructure/autoEmailNotificationService",
  () => ({
    AutoEmailNotificationService: {
      sendRoleChangeNotification: vi.fn(),
    },
  })
);

vi.mock("../../../../src/services/infrastructure/CacheService", () => ({
  CachePatterns: {
    invalidateUserCache: vi.fn(),
  },
}));

import { User } from "../../../../src/models";
import { RoleUtils, hasPermission } from "../../../../src/utils/roleUtils";
import { socketService } from "../../../../src/services/infrastructure/SocketService";
import { AutoEmailNotificationService } from "../../../../src/services/infrastructure/autoEmailNotificationService";
import { CachePatterns } from "../../../../src/services/infrastructure/CacheService";

interface MockRequest {
  params: Record<string, string>;
  body: Record<string, unknown>;
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
}

describe("UserRoleController", () => {
  let mockReq: MockRequest;
  let mockRes: Partial<Response>;
  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();

    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    mockRes = {
      status: statusMock as unknown as Response["status"],
      json: jsonMock as unknown as Response["json"],
    };

    mockReq = {
      params: { id: "targetUser123" },
      body: { role: "Leader" },
      user: {
        _id: "admin123",
        id: "admin123",
        role: "Super Admin",
        email: "admin@test.com",
        firstName: "Admin",
        lastName: "User",
      },
    };

    vi.mocked(CachePatterns.invalidateUserCache).mockResolvedValue(undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe("updateUserRole", () => {
    describe("Authentication", () => {
      it("should return 401 if user is not authenticated", async () => {
        mockReq.user = undefined;

        await UserRoleController.updateUserRole(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(401);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Authentication required.",
        });
      });
    });

    describe("Authorization", () => {
      it("should return 403 if user lacks permission", async () => {
        vi.mocked(hasPermission).mockReturnValue(false);

        await UserRoleController.updateUserRole(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(403);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Insufficient permissions to edit user roles.",
        });
      });
    });

    describe("Validation", () => {
      it("should return 400 if role is missing", async () => {
        vi.mocked(hasPermission).mockReturnValue(true);
        mockReq.body = {};

        await UserRoleController.updateUserRole(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Valid role is required.",
        });
      });

      it("should return 400 if role is invalid", async () => {
        vi.mocked(hasPermission).mockReturnValue(true);
        vi.mocked(RoleUtils.isValidRole).mockReturnValue(false);
        mockReq.body = { role: "InvalidRole" };

        await UserRoleController.updateUserRole(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Valid role is required.",
        });
      });

      it("should return 404 if target user not found", async () => {
        vi.mocked(hasPermission).mockReturnValue(true);
        vi.mocked(RoleUtils.isValidRole).mockReturnValue(true);
        vi.mocked(User.findById).mockResolvedValue(null);

        await UserRoleController.updateUserRole(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(404);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "User not found.",
        });
      });

      it("should return 403 if role promotion not allowed", async () => {
        vi.mocked(hasPermission).mockReturnValue(true);
        vi.mocked(RoleUtils.isValidRole).mockReturnValue(true);
        vi.mocked(RoleUtils.canPromoteUser).mockReturnValue(false);

        const mockTargetUser = {
          _id: "targetUser123",
          role: "Participant",
          save: vi.fn(),
        };
        vi.mocked(User.findById).mockResolvedValue(mockTargetUser);

        await UserRoleController.updateUserRole(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(403);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "You cannot promote this user to the specified role.",
        });
      });
    });

    describe("Successful Role Update", () => {
      const createMockTargetUser = () => ({
        _id: "targetUser123",
        id: "targetUser123",
        username: "targetuser",
        email: "target@test.com",
        firstName: "Target",
        lastName: "User",
        role: "Participant",
        isActive: true,
        save: vi.fn(),
      });

      const mockAdminUser = {
        _id: "admin123",
        firstName: "Admin",
        lastName: "User",
        email: "admin@test.com",
        role: "Super Admin",
        avatar: "/avatar.jpg",
        gender: "male",
      };

      let mockTargetUser: ReturnType<typeof createMockTargetUser>;

      beforeEach(() => {
        mockTargetUser = createMockTargetUser();
        vi.mocked(hasPermission).mockReturnValue(true);
        vi.mocked(RoleUtils.isValidRole).mockReturnValue(true);
        vi.mocked(RoleUtils.canPromoteUser).mockReturnValue(true);
        vi.mocked(RoleUtils.isPromotion).mockReturnValue(true);
        vi.mocked(User.findById).mockImplementation((id) => {
          if (id === "targetUser123")
            return Promise.resolve(mockTargetUser) as any;
          if (id === "admin123") return Promise.resolve(mockAdminUser) as any;
          return Promise.resolve(null) as any;
        });
        vi.mocked(
          AutoEmailNotificationService.sendRoleChangeNotification
        ).mockResolvedValue({
          emailsSent: 1,
          messagesCreated: 1,
          success: true,
        });
      });

      it("should update user role successfully", async () => {
        await UserRoleController.updateUserRole(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(mockTargetUser.save).toHaveBeenCalled();
        expect(mockTargetUser.role).toBe("Leader");
        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
            message: expect.stringContaining("Leader"),
          })
        );
      });

      it("should invalidate user cache after role change", async () => {
        await UserRoleController.updateUserRole(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(CachePatterns.invalidateUserCache).toHaveBeenCalledWith(
          "targetUser123"
        );
      });

      it("should send role change notification", async () => {
        await UserRoleController.updateUserRole(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(
          AutoEmailNotificationService.sendRoleChangeNotification
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            userData: expect.objectContaining({
              email: "target@test.com",
              oldRole: "Participant",
              newRole: "Leader",
            }),
            isPromotion: true,
          })
        );
      });

      it("should emit socket update for role change", async () => {
        await UserRoleController.updateUserRole(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(socketService.emitUserUpdate).toHaveBeenCalledWith(
          "targetUser123",
          expect.objectContaining({
            type: "role_changed",
            oldValue: "Participant",
            newValue: "Leader",
          })
        );
      });

      it("should synchronize live authorization immediately after persistence", async () => {
        await UserRoleController.updateUserRole(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(socketService.syncUserAuthorization).toHaveBeenCalledWith(
          "targetUser123",
          { role: "Leader", isActive: true },
        );
        expect(mockTargetUser.save.mock.invocationCallOrder[0]).toBeLessThan(
          vi.mocked(socketService.syncUserAuthorization).mock
            .invocationCallOrder[0],
        );
        expect(
          vi.mocked(socketService.syncUserAuthorization).mock
            .invocationCallOrder[0],
        ).toBeLessThan(
          vi.mocked(CachePatterns.invalidateUserCache).mock
            .invocationCallOrder[0],
        );
      });

      it("should succeed even if notification fails", async () => {
        vi.mocked(
          AutoEmailNotificationService.sendRoleChangeNotification
        ).mockRejectedValue(new Error("Notification failed"));

        await UserRoleController.updateUserRole(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(consoleErrorSpy).toHaveBeenCalled();
      });
    });

    describe("Error Handling", () => {
      it("should return 500 on database error", async () => {
        vi.mocked(hasPermission).mockReturnValue(true);
        vi.mocked(RoleUtils.isValidRole).mockReturnValue(true);
        vi.mocked(User.findById).mockRejectedValue(new Error("Database error"));

        await UserRoleController.updateUserRole(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Failed to update user role.",
        });
        expect(consoleErrorSpy).toHaveBeenCalled();
      });
    });
  });
});
