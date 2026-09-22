import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Response } from "express";
import mongoose from "mongoose";
import UserQueryController from "../../../../src/controllers/user-admin/UserQueryController";

// Mock dependencies
vi.mock("../../../../src/models", () => ({
  User: {
    findById: vi.fn(),
  },
}));

vi.mock("../../../../src/utils/roleUtils", () => ({
  PERMISSIONS: { MANAGE_USERS: "manage_users" },
  hasPermission: vi.fn(() => true),
  RoleUtils: {
    canAccessUserProfile: vi.fn(),
  },
}));

import { User } from "../../../../src/models";
import { RoleUtils } from "../../../../src/utils/roleUtils";

interface MockRequest {
  params: Record<string, string>;
  user?: {
    _id: string;
    id: string;
    role: string;
    email: string;
  };
}

describe("UserQueryController", () => {
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
      },
    };
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe("getUserById", () => {
    describe("Authentication", () => {
      it("should return 401 if user is not authenticated", async () => {
        mockReq.user = undefined;

        await UserQueryController.getUserById(
          mockReq as any,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(401);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Authentication required.",
        });
      });
    });

    describe("User Not Found", () => {
      it("should return 404 if user is not found", async () => {
        vi.mocked(RoleUtils.canAccessUserProfile).mockReturnValue(true);
        vi.mocked(User.findById).mockResolvedValue(null);

        await UserQueryController.getUserById(
          mockReq as any,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(404);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "User not found.",
        });
      });
    });

    describe("Authorization", () => {
      it("should return 403 if user lacks permission to view profile", async () => {
        const targetUser = {
          _id: testUserId,
          username: "testuser",
          email: "test@test.com",
          firstName: "Test",
          lastName: "User",
          role: "Super Admin",
        };

        vi.mocked(User.findById).mockResolvedValue(targetUser);
        vi.mocked(RoleUtils.canAccessUserProfile)
          .mockReturnValueOnce(true) // Initial check
          .mockReturnValueOnce(false); // Final check with target role

        await UserQueryController.getUserById(
          mockReq as any,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(403);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Insufficient permissions to access this profile.",
        });
      });
    });

    describe("Success", () => {
      it("should return user profile data successfully", async () => {
        const targetUser = {
          _id: testUserId,
          username: "testuser",
          email: "test@example.com",
          firstName: "Test",
          lastName: "User",
          gender: "Male",
          avatar: "avatar.png",
          phone: "123-456-7890",
          role: "Member",
          isAtCloudLeader: false,
          roleInAtCloud: "Member",
          homeAddress: "123 Main St",
          occupation: "Engineer",
          company: "Tech Corp",
          weeklyChurch: "First Church",
          churchAddress: "456 Church St",
          lastLogin: new Date("2024-01-01"),
          createdAt: new Date("2023-01-01"),
          isVerified: true,
          isActive: true,
        };

        vi.mocked(User.findById).mockResolvedValue(targetUser);
        vi.mocked(RoleUtils.canAccessUserProfile).mockReturnValue(true);

        await UserQueryController.getUserById(
          mockReq as any,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          data: {
            user: {
              id: testUserId,
              username: "testuser",
              email: "test@example.com",
              firstName: "Test",
              lastName: "User",
              gender: "Male",
              avatar: "avatar.png",
              phone: "123-456-7890",
              role: "Member",
              isAtCloudLeader: false,
              roleInAtCloud: "Member",
              homeAddress: "123 Main St",
              occupation: "Engineer",
              company: "Tech Corp",
              weeklyChurch: "First Church",
              churchAddress: "456 Church St",
              lastLogin: targetUser.lastLogin,
              createdAt: targetUser.createdAt,
              isVerified: true,
              isActive: true,
            },
          },
        });
      });

      it("should call RoleUtils.canAccessUserProfile with correct parameters", async () => {
        const targetUser = {
          _id: testUserId,
          username: "testuser",
          email: "test@example.com",
          firstName: "Test",
          lastName: "User",
          role: "Member",
          isVerified: true,
          isActive: true,
        };

        vi.mocked(User.findById).mockResolvedValue(targetUser);
        vi.mocked(RoleUtils.canAccessUserProfile).mockReturnValue(true);

        await UserQueryController.getUserById(
          mockReq as any,
          mockRes as Response
        );

        // Check initial call (with empty target role)
        expect(RoleUtils.canAccessUserProfile).toHaveBeenCalledWith(
          "Administrator",
          "admin123",
          testUserId,
          ""
        );

        // Check final call (with target user's role)
        expect(RoleUtils.canAccessUserProfile).toHaveBeenCalledWith(
          "Administrator",
          "admin123",
          testUserId,
          "Member"
        );
      });
    });

    describe("Error Handling", () => {
      it("should return 500 on database error", async () => {
        vi.mocked(RoleUtils.canAccessUserProfile).mockReturnValue(true);
        vi.mocked(User.findById).mockRejectedValue(new Error("Database error"));

        await UserQueryController.getUserById(
          mockReq as any,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Failed to retrieve user.",
        });
        expect(consoleErrorSpy).toHaveBeenCalled();
      });
    });
  });
});
