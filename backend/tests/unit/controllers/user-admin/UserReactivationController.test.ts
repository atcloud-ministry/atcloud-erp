import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Response } from "express";
import mongoose from "mongoose";
import UserReactivationController from "../../../../src/controllers/user-admin/UserReactivationController";
import { RefreshSessionService } from "../../../../src/services/auth/RefreshSessionService";

// Mock dependencies
vi.mock("../../../../src/models", () => ({
  User: {
    findById: vi.fn(),
  },
}));
vi.mock("../../../../src/services/auth/RefreshSessionService", () => ({
  RefreshSessionService: {
    revokeAllForUser: vi.fn().mockResolvedValue(0),
  },
}));

vi.mock("../../../../src/models/AuditLog", () => ({
  default: {
    create: vi.fn(),
  },
}));

vi.mock("../../../../src/utils/roleUtils", () => ({
  ROLES: {
    SUPER_ADMIN: "Super Admin",
    ADMINISTRATOR: "Administrator",
    LEADER: "Leader",
    STAFF: "Staff",
    MEMBER: "Member",
    PARTICIPANT: "Participant",
  },
  hasPermission: vi.fn(),
  PERMISSIONS: {
    DEACTIVATE_USERS: "deactivate_users",
  },
}));

vi.mock("../../../../src/services/infrastructure/SocketService", () => ({
  socketService: {
    emitUserUpdate: vi.fn(),
  },
}));

vi.mock(
  "../../../../src/services/infrastructure/autoEmailNotificationService",
  () => ({
    AutoEmailNotificationService: {
      sendAccountStatusChangeAdminNotifications: vi.fn().mockResolvedValue({}),
    },
  }),
);

vi.mock("../../../../src/services/infrastructure/EmailServiceFacade", () => ({
  EmailService: {
    sendAccountReactivationEmail: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../../../src/services/infrastructure/CacheService", () => ({
  CachePatterns: {
    invalidateUserCache: vi.fn().mockResolvedValue(undefined),
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
import AuditLog from "../../../../src/models/AuditLog";
import { hasPermission, ROLES } from "../../../../src/utils/roleUtils";
import { socketService } from "../../../../src/services/infrastructure/SocketService";
import { EmailService } from "../../../../src/services/infrastructure/EmailServiceFacade";
import { CachePatterns } from "../../../../src/services/infrastructure/CacheService";
import { programMembershipMutationSyncTrigger } from "../../../../src/services/programs/ProgramMembershipMutationSyncTrigger";

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
  get?: (name: string) => string | undefined;
}

describe("UserReactivationController", () => {
  let mockReq: MockRequest;
  let mockRes: Partial<Response>;
  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: any;
  let testUserId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    testUserId = new mongoose.Types.ObjectId().toString();

    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    mockRes = {
      status: statusMock as any,
      json: jsonMock as any,
    };

    mockReq = {
      params: { id: testUserId },
      user: {
        _id: "admin123",
        id: "admin123",
        role: "Administrator",
        email: "admin@test.com",
        firstName: "Admin",
        lastName: "User",
      },
      ip: "127.0.0.1",
      get: vi.fn().mockReturnValue("test-user-agent"),
    };
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe("reactivateUser", () => {
    describe("Authentication", () => {
      it("should return 401 if user is not authenticated", async () => {
        mockReq.user = undefined;

        await UserReactivationController.reactivateUser(
          mockReq as any,
          mockRes as Response,
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

        await UserReactivationController.reactivateUser(
          mockReq as any,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(403);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Insufficient permissions to reactivate users.",
        });
      });

      it("should deny Leader from reactivating non-Participant users", async () => {
        mockReq.user!.role = ROLES.LEADER;
        vi.mocked(hasPermission).mockReturnValue(true);

        const targetUser = createMockUser({ role: ROLES.LEADER });
        vi.mocked(User.findById).mockResolvedValue(targetUser);

        await UserReactivationController.reactivateUser(
          mockReq as any,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(403);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Leaders can only reactivate Participant level users.",
        });
      });

      it("should deny Administrator from reactivating other Administrators", async () => {
        mockReq.user!.role = ROLES.ADMINISTRATOR;
        vi.mocked(hasPermission).mockReturnValue(true);

        const targetUser = createMockUser({ role: ROLES.ADMINISTRATOR });
        vi.mocked(User.findById).mockResolvedValue(targetUser);

        await UserReactivationController.reactivateUser(
          mockReq as any,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(403);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message:
            "Administrators cannot reactivate other Administrators or Super Admins.",
        });
      });

      it("should deny Administrator from reactivating Super Admins", async () => {
        mockReq.user!.role = ROLES.ADMINISTRATOR;
        vi.mocked(hasPermission).mockReturnValue(true);

        const targetUser = createMockUser({ role: ROLES.SUPER_ADMIN });
        vi.mocked(User.findById).mockResolvedValue(targetUser);

        await UserReactivationController.reactivateUser(
          mockReq as any,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(403);
      });
    });

    describe("User Not Found", () => {
      it("should return 404 if user is not found", async () => {
        vi.mocked(hasPermission).mockReturnValue(true);
        vi.mocked(User.findById).mockResolvedValue(null);

        await UserReactivationController.reactivateUser(
          mockReq as any,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(404);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "User not found.",
        });
      });
    });

    describe("Success", () => {
      it("should reactivate user successfully", async () => {
        vi.mocked(hasPermission).mockReturnValue(true);

        const targetUser = createMockUser({
          role: ROLES.PARTICIPANT,
          isActive: false,
        });
        vi.mocked(User.findById).mockResolvedValue(targetUser);

        await UserReactivationController.reactivateUser(
          mockReq as any,
          mockRes as Response,
        );

        expect(targetUser.isActive).toBe(true);
        expect(RefreshSessionService.revokeAllForUser).toHaveBeenCalledWith(
          testUserId,
          "account_deactivated",
        );
        expect(targetUser.save).toHaveBeenCalled();
        expect(
          vi.mocked(RefreshSessionService.revokeAllForUser).mock
            .invocationCallOrder[0],
        ).toBeLessThan(targetUser.save.mock.invocationCallOrder[0]);
        expect(
          programMembershipMutationSyncTrigger.userEligibilityChanged,
        ).toHaveBeenCalledWith(testUserId, {
          actor: {
            type: "user",
            id: "admin123",
            role: "Administrator",
          },
          source: "http",
          correlationId: undefined,
        });
        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          message: "User reactivated successfully!",
        });
      });

      it("should create audit log for reactivation", async () => {
        vi.mocked(hasPermission).mockReturnValue(true);

        const targetUser = createMockUser({ role: ROLES.PARTICIPANT });
        vi.mocked(User.findById).mockResolvedValue(targetUser);

        await UserReactivationController.reactivateUser(
          mockReq as any,
          mockRes as Response,
        );

        expect(AuditLog.create).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "user_reactivation",
            actor: expect.objectContaining({
              id: "admin123",
              role: "Administrator",
              email: "admin@test.com",
            }),
            targetModel: "User",
          }),
        );
      });

      it("should invalidate user cache after reactivation", async () => {
        vi.mocked(hasPermission).mockReturnValue(true);

        const targetUser = createMockUser({ role: ROLES.PARTICIPANT });
        vi.mocked(User.findById).mockResolvedValue(targetUser);

        await UserReactivationController.reactivateUser(
          mockReq as any,
          mockRes as Response,
        );

        expect(CachePatterns.invalidateUserCache).toHaveBeenCalledWith(
          testUserId,
        );
      });

      it("should send reactivation email to user", async () => {
        vi.mocked(hasPermission).mockReturnValue(true);

        const targetUser = createMockUser({ role: ROLES.PARTICIPANT });
        vi.mocked(User.findById).mockResolvedValue(targetUser);

        await UserReactivationController.reactivateUser(
          mockReq as any,
          mockRes as Response,
        );

        expect(EmailService.sendAccountReactivationEmail).toHaveBeenCalledWith(
          targetUser.email,
          expect.any(String),
          expect.objectContaining({
            role: "Administrator",
          }),
        );
      });

      it("should emit socket event for real-time update", async () => {
        vi.mocked(hasPermission).mockReturnValue(true);

        const targetUser = createMockUser({ role: ROLES.PARTICIPANT });
        vi.mocked(User.findById).mockResolvedValue(targetUser);

        await UserReactivationController.reactivateUser(
          mockReq as any,
          mockRes as Response,
        );

        expect(socketService.emitUserUpdate).toHaveBeenCalledWith(
          String(targetUser._id),
          expect.objectContaining({
            type: "status_changed",
            oldValue: "inactive",
            newValue: "active",
          }),
        );
      });

      it("should allow Leader to reactivate Participant", async () => {
        mockReq.user!.role = ROLES.LEADER;
        vi.mocked(hasPermission).mockReturnValue(true);

        const targetUser = createMockUser({ role: ROLES.PARTICIPANT });
        vi.mocked(User.findById).mockResolvedValue(targetUser);

        await UserReactivationController.reactivateUser(
          mockReq as any,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
      });
    });

    describe("Error Handling", () => {
      it("should return 500 on database error", async () => {
        vi.mocked(hasPermission).mockReturnValue(true);
        vi.mocked(User.findById).mockRejectedValue(new Error("Database error"));

        await UserReactivationController.reactivateUser(
          mockReq as any,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Failed to reactivate user.",
        });
        expect(consoleErrorSpy).toHaveBeenCalled();
      });

      it("should not fail if audit log creation fails", async () => {
        vi.mocked(hasPermission).mockReturnValue(true);

        const targetUser = createMockUser({ role: ROLES.PARTICIPANT });
        vi.mocked(User.findById).mockResolvedValue(targetUser);
        vi.mocked(AuditLog.create).mockRejectedValue(new Error("Audit error"));

        await UserReactivationController.reactivateUser(
          mockReq as any,
          mockRes as Response,
        );

        // Should still succeed
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should not fail if email sending fails", async () => {
        vi.mocked(hasPermission).mockReturnValue(true);

        const targetUser = createMockUser({ role: ROLES.PARTICIPANT });
        vi.mocked(User.findById).mockResolvedValue(targetUser);
        vi.mocked(EmailService.sendAccountReactivationEmail).mockRejectedValue(
          new Error("Email error"),
        );

        await UserReactivationController.reactivateUser(
          mockReq as any,
          mockRes as Response,
        );

        // Should still succeed
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should not fail if admin notifications fail", async () => {
        vi.mocked(hasPermission).mockReturnValue(true);

        const { AutoEmailNotificationService } =
          await import("../../../../src/services/infrastructure/autoEmailNotificationService");
        vi.mocked(
          AutoEmailNotificationService.sendAccountStatusChangeAdminNotifications,
        ).mockRejectedValue(new Error("Notification error"));

        const targetUser = createMockUser({ role: ROLES.PARTICIPANT });
        vi.mocked(User.findById).mockResolvedValue(targetUser);

        await UserReactivationController.reactivateUser(
          mockReq as any,
          mockRes as Response,
        );

        // Should still succeed
        expect(statusMock).toHaveBeenCalledWith(200);
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          "Failed to send admin reactivation notifications:",
          expect.any(Error),
        );
      });
    });
  });

  // Helper function to create mock user
  function createMockUser(
    overrides: Partial<{
      _id: string;
      role: string;
      isActive: boolean;
      email: string;
      username: string;
      firstName: string;
      lastName: string;
    }> = {},
  ) {
    return {
      _id: testUserId,
      username: "testuser",
      email: "test@example.com",
      firstName: "Test",
      lastName: "User",
      role: ROLES.PARTICIPANT,
      isActive: false,
      save: vi.fn().mockResolvedValue(true),
      ...overrides,
    };
  }
});
