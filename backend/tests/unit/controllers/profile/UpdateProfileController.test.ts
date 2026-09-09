import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Request, Response } from "express";
import UpdateProfileController from "../../../../src/controllers/profile/UpdateProfileController";

// Mock dependencies
vi.mock("../../../../src/models", () => ({
  User: {
    findById: vi.fn(),
    findByIdAndUpdate: vi.fn(),
  },
}));

vi.mock("../../../../src/utils/avatarCleanup", () => ({
  cleanupOldAvatar: vi.fn(),
}));

vi.mock(
  "../../../../src/services/infrastructure/autoEmailNotificationService",
  () => ({
    AutoEmailNotificationService: {
      sendAtCloudRoleChangeNotification: vi.fn(),
    },
  }),
);

vi.mock("../../../../src/services/infrastructure/CacheService", () => ({
  CachePatterns: {
    invalidateUserCache: vi.fn(),
  },
}));

vi.mock("../../../../src/services/LoggerService", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { User } from "../../../../src/models";
import { cleanupOldAvatar } from "../../../../src/utils/avatarCleanup";
import { AutoEmailNotificationService } from "../../../../src/services/infrastructure/autoEmailNotificationService";
import { CachePatterns } from "../../../../src/services/infrastructure/CacheService";

interface MockRequest {
  user?: {
    _id: string;
    id: string;
    role: string;
    email: string;
  };
  body: Record<string, unknown>;
}

describe("UpdateProfileController", () => {
  let mockReq: MockRequest;
  let mockRes: Partial<Response>;
  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: any;
  let consoleLogSpy: any;

  const createMockUser = (overrides = {}) => ({
    _id: "user123",
    username: "testuser",
    email: "user@test.com",
    firstName: "Test",
    lastName: "User",
    gender: "male",
    avatar: "/old-avatar.jpg",
    role: "Participant",
    isAtCloudLeader: false,
    roleInAtCloud: null,
    phone: "123456789",
    homeAddress: "123 Test St",
    occupation: "Developer",
    company: "TestCo",
    weeklyChurch: "Test Church",
    churchAddress: "456 Church Ave",
    isActive: true,
    isVerified: true,
    lastLogin: new Date(),
    createdAt: new Date(),
    ...overrides,
  });

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
      user: {
        _id: "user123",
        id: "user123",
        role: "Participant",
        email: "user@test.com",
      },
      body: {},
    };

    vi.mocked(cleanupOldAvatar).mockResolvedValue(true);
    vi.mocked(CachePatterns.invalidateUserCache).mockResolvedValue(undefined);
    vi.mocked(
      AutoEmailNotificationService.sendAtCloudRoleChangeNotification,
    ).mockResolvedValue({ emailsSent: 1, messagesCreated: 1, success: true });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  describe("updateProfile", () => {
    describe("Authentication", () => {
      it("should return 401 if user is not authenticated", async () => {
        mockReq.user = undefined;

        await UpdateProfileController.updateProfile(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(401);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Authentication required.",
        });
      });
    });

    describe("Validation", () => {
      it("should return 400 if isAtCloudLeader is true but roleInAtCloud is missing", async () => {
        mockReq.body = { isAtCloudLeader: true };

        await UpdateProfileController.updateProfile(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "@Cloud co-worker must have a role specified.",
        });
      });

      it("should return 404 if user not found initially", async () => {
        mockReq.body = { firstName: "Updated" };
        vi.mocked(User.findById).mockResolvedValue(null);

        await UpdateProfileController.updateProfile(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(404);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "User not found.",
        });
      });
    });

    describe("Profile Update", () => {
      it("should update profile successfully", async () => {
        const mockUser = createMockUser();
        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(User.findByIdAndUpdate).mockResolvedValue(mockUser);

        mockReq.body = { firstName: "Updated" };

        await UpdateProfileController.updateProfile(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
          "user123",
          { $set: { firstName: "Updated" } },
          { new: true, runValidators: true, select: "-password" },
        );
        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
            message: "Profile updated successfully.",
          }),
        );
      });

      it("should exclude authorization, account-status, and credential fields", async () => {
        const mockUser = createMockUser();
        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(User.findByIdAndUpdate).mockResolvedValue(
          createMockUser({ firstName: "Updated" }),
        );

        mockReq.body = {
          firstName: "Updated",
          role: "Super Admin",
          isActive: false,
          isVerified: false,
          password: "AttackerPass123!",
          passwordResetToken: "attacker-token",
        };

        await UpdateProfileController.updateProfile(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
          "user123",
          { $set: { firstName: "Updated" } },
          { new: true, runValidators: true, select: "-password" },
        );
      });

      it("should return 404 if user not found after update", async () => {
        const mockUser = createMockUser();
        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(User.findByIdAndUpdate).mockResolvedValue(null);

        mockReq.body = { firstName: "Updated" };

        await UpdateProfileController.updateProfile(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(404);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "User not found.",
        });
      });

      it("should invalidate user cache after successful update", async () => {
        const mockUser = createMockUser();
        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(User.findByIdAndUpdate).mockResolvedValue(mockUser);

        mockReq.body = { firstName: "Updated" };

        await UpdateProfileController.updateProfile(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(CachePatterns.invalidateUserCache).toHaveBeenCalledWith(
          "user123",
        );
      });
    });

    describe("Gender Change", () => {
      it("should update avatar to male default when gender changes to male", async () => {
        const mockUser = createMockUser({ gender: "female" });
        const updatedUser = createMockUser({
          gender: "male",
          avatar: "https://i.pravatar.cc/300?img=12",
        });

        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(User.findByIdAndUpdate).mockResolvedValue(updatedUser);

        mockReq.body = { gender: "male" };

        await UpdateProfileController.updateProfile(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
          "user123",
          {
            $set: {
              gender: "male",
              avatar: "https://i.pravatar.cc/300?img=12",
            },
          },
          expect.any(Object),
        );
      });

      it("should update avatar to female default when gender changes to female", async () => {
        const mockUser = createMockUser({ gender: "male" });
        const updatedUser = createMockUser({
          gender: "female",
          avatar: "https://i.pravatar.cc/300?img=47",
        });

        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(User.findByIdAndUpdate).mockResolvedValue(updatedUser);

        mockReq.body = { gender: "female" };

        await UpdateProfileController.updateProfile(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
          "user123",
          {
            $set: {
              gender: "female",
              avatar: "https://i.pravatar.cc/300?img=47",
            },
          },
          expect.any(Object),
        );
      });

      it("should cleanup old avatar on gender change", async () => {
        const mockUser = createMockUser({
          gender: "female",
          avatar: "/old.jpg",
        });
        const updatedUser = createMockUser({ gender: "male" });

        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(User.findByIdAndUpdate).mockResolvedValue(updatedUser);

        mockReq.body = { gender: "male" };

        await UpdateProfileController.updateProfile(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        await vi.waitFor(
          () => {
            expect(cleanupOldAvatar).toHaveBeenCalledWith(
              "user123",
              "/old.jpg",
            );
          },
          { timeout: 100 },
        );
      });

      it("should continue even if avatar cleanup fails", async () => {
        const mockUser = createMockUser({
          gender: "female",
          avatar: "/old.jpg",
        });
        const updatedUser = createMockUser({ gender: "male" });

        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(User.findByIdAndUpdate).mockResolvedValue(updatedUser);
        vi.mocked(cleanupOldAvatar).mockRejectedValue(
          new Error("Cleanup failed"),
        );

        mockReq.body = { gender: "male" };

        await UpdateProfileController.updateProfile(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        // Should still succeed despite cleanup failure
        expect(statusMock).toHaveBeenCalledWith(200);
      });
    });

    describe("@Cloud Role Changes", () => {
      it("should clear roleInAtCloud when isAtCloudLeader is set to false", async () => {
        const mockUser = createMockUser({
          isAtCloudLeader: true,
          roleInAtCloud: "Developer",
        });
        const updatedUser = createMockUser({
          isAtCloudLeader: false,
          roleInAtCloud: null,
        });

        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(User.findByIdAndUpdate).mockResolvedValue(updatedUser);

        mockReq.body = { isAtCloudLeader: false };

        await UpdateProfileController.updateProfile(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
          "user123",
          { $set: { isAtCloudLeader: false, roleInAtCloud: undefined } },
          expect.any(Object),
        );
      });

      it("should send notification when promoted to @Cloud co-worker", async () => {
        const mockUser = createMockUser({ isAtCloudLeader: false });
        const updatedUser = createMockUser({
          isAtCloudLeader: true,
          roleInAtCloud: "Ministry Leader",
        });

        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(User.findByIdAndUpdate).mockResolvedValue(updatedUser);

        mockReq.body = {
          isAtCloudLeader: true,
          roleInAtCloud: "Ministry Leader",
        };

        await UpdateProfileController.updateProfile(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(
          AutoEmailNotificationService.sendAtCloudRoleChangeNotification,
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            changeType: "assigned",
            userData: expect.objectContaining({
              roleInAtCloud: "Ministry Leader",
            }),
          }),
        );
      });

      it("should send notification when removed from @Cloud co-worker", async () => {
        const mockUser = createMockUser({
          isAtCloudLeader: true,
          roleInAtCloud: "Developer",
        });
        const updatedUser = createMockUser({
          isAtCloudLeader: false,
          roleInAtCloud: null,
        });

        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(User.findByIdAndUpdate).mockResolvedValue(updatedUser);

        mockReq.body = { isAtCloudLeader: false };

        await UpdateProfileController.updateProfile(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(
          AutoEmailNotificationService.sendAtCloudRoleChangeNotification,
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            changeType: "removed",
            userData: expect.objectContaining({
              previousRoleInAtCloud: "Developer",
            }),
          }),
        );
      });

      it("should not send notification for role change within co-worker status", async () => {
        const mockUser = createMockUser({
          isAtCloudLeader: true,
          roleInAtCloud: "Developer",
        });
        const updatedUser = createMockUser({
          isAtCloudLeader: true,
          roleInAtCloud: "Ministry Leader",
        });

        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(User.findByIdAndUpdate).mockResolvedValue(updatedUser);

        mockReq.body = { roleInAtCloud: "Ministry Leader" };

        await UpdateProfileController.updateProfile(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(
          AutoEmailNotificationService.sendAtCloudRoleChangeNotification,
        ).not.toHaveBeenCalled();
      });

      it("should continue update even if notification fails", async () => {
        const mockUser = createMockUser({ isAtCloudLeader: false });
        const updatedUser = createMockUser({
          isAtCloudLeader: true,
          roleInAtCloud: "Developer",
        });

        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(User.findByIdAndUpdate).mockResolvedValue(updatedUser);
        vi.mocked(
          AutoEmailNotificationService.sendAtCloudRoleChangeNotification,
        ).mockRejectedValue(new Error("Email failed"));

        mockReq.body = { isAtCloudLeader: true, roleInAtCloud: "Developer" };

        await UpdateProfileController.updateProfile(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          "Failed to send @Cloud role change notification:",
          expect.any(Error),
        );
      });
    });

    describe("Error Handling", () => {
      it("should return 400 for Mongoose validation errors", async () => {
        const mockUser = createMockUser();
        vi.mocked(User.findById).mockResolvedValue(mockUser);

        const validationError = {
          name: "ValidationError",
          errors: {
            email: { message: "Invalid email format" },
            phone: { message: "Invalid phone number" },
          },
        };
        vi.mocked(User.findByIdAndUpdate).mockRejectedValue(validationError);

        mockReq.body = { email: "invalid" };

        await UpdateProfileController.updateProfile(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Validation failed.",
          errors: expect.arrayContaining([
            "Invalid email format",
            "Invalid phone number",
          ]),
        });
      });

      it("should return 500 on generic database error", async () => {
        vi.mocked(User.findById).mockRejectedValue(new Error("Database error"));

        mockReq.body = { firstName: "Test" };

        await UpdateProfileController.updateProfile(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Failed to update profile.",
        });
        expect(consoleErrorSpy).toHaveBeenCalled();
      });
    });
  });
});
