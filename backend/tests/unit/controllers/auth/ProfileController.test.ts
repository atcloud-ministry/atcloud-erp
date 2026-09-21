import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";
import ProfileController from "../../../../src/controllers/auth/ProfileController";
import mongoose from "mongoose";

vi.mock("../../../../src/models", () => ({
  User: { findById: vi.fn() },
}));

import { User } from "../../../../src/models";

describe("ProfileController", () => {
  let mockReq: any;
  let mockRes: Partial<Response>;
  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;

  const userId = new mongoose.Types.ObjectId();

  beforeEach(() => {
    vi.clearAllMocks();

    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    mockReq = {
      user: undefined,
    };

    vi.mocked(User.findById).mockImplementation(
      () =>
        ({
          select: vi.fn().mockImplementation(async () => mockReq.user),
        }) as never,
    );

    mockRes = {
      status: statusMock as any,
      json: jsonMock as any,
    };

    // Mock console.error
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  describe("getProfile", () => {
    describe("authentication", () => {
      it("should return 401 if user not authenticated", async () => {
        mockReq.user = undefined;

        await ProfileController.getProfile(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(401);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Authentication required.",
        });
      });

      it("should return 401 if user is null", async () => {
        mockReq.user = null;

        await ProfileController.getProfile(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(401);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Authentication required.",
        });
      });
    });

    describe("profile retrieval", () => {
      it("should return user profile with all fields", async () => {
        const mockUser = {
          _id: userId,
          username: "testuser",
          email: "test@example.com",
          phone: "1234567890",
          birthYear: 1990,
          residenceCity: "Seattle",
          residenceRegion: "US-WA",
          residenceCountryCode: "US",
          employmentStatus: "employed",
          firstName: "Test",
          lastName: "User",
          gender: "male",
          avatar: "avatar.jpg",
          role: "Participant",
          isAtCloudLeader: false,
          roleInAtCloud: "Member",
          occupation: "Software Engineer",
          company: "Tech Corp",
          weeklyChurch: "First Church",
          homeAddress: "123 Home St",
          churchAddress: "456 Church Ave",
          lastLogin: new Date("2025-01-01"),
          createdAt: new Date("2024-01-01"),
          isVerified: true,
          isActive: true,
        };

        mockReq.user = mockUser;

        await ProfileController.getProfile(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          data: {
            user: {
              id: userId.toString(),
              username: "testuser",
              email: "test@example.com",
              phone: "1234567890",
              birthYear: 1990,
              residenceCity: "Seattle",
              residenceRegion: "US-WA",
              residenceCountryCode: "US",
              employmentStatus: "employed",
              firstName: "Test",
              lastName: "User",
              gender: "male",
              avatar: "avatar.jpg",
              role: "Participant",
              isAtCloudLeader: false,
              roleInAtCloud: "Member",
              occupation: "Software Engineer",
              company: "Tech Corp",
              weeklyChurch: "First Church",
              homeAddress: "123 Home St",
              churchAddress: "456 Church Ave",
              lastLogin: mockUser.lastLogin,
              createdAt: mockUser.createdAt,
              isVerified: true,
              isActive: true,
            },
          },
        });
      });

      it("should return profile with minimal fields", async () => {
        const mockUser = {
          _id: userId,
          username: "minimaluser",
          email: "minimal@example.com",
          role: "Participant",
        };

        mockReq.user = mockUser;

        await ProfileController.getProfile(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        const response = jsonMock.mock.calls[0][0];
        expect(response.success).toBe(true);
        expect(response.data.user.id).toBe(userId.toString());
        expect(response.data.user.username).toBe("minimaluser");
        expect(response.data.user.email).toBe("minimal@example.com");
        expect(response.data.user.role).toBe("Participant");
      });

      it("should handle user with optional fields as undefined", async () => {
        const mockUser = {
          _id: userId,
          username: "testuser",
          email: "test@example.com",
          role: "Participant",
          phone: undefined,
          firstName: undefined,
          lastName: undefined,
          avatar: undefined,
        };

        mockReq.user = mockUser;

        await ProfileController.getProfile(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        const response = jsonMock.mock.calls[0][0];
        expect(response.data.user.phone).toBeUndefined();
        expect(response.data.user.firstName).toBeUndefined();
        expect(response.data.user.lastName).toBeUndefined();
        expect(response.data.user.avatar).toBeUndefined();
      });

      it("should handle Super Admin role", async () => {
        const mockUser = {
          _id: userId,
          username: "admin",
          email: "admin@example.com",
          role: "Super Admin",
          isAtCloudLeader: true,
          roleInAtCloud: "Leadership",
        };

        mockReq.user = mockUser;

        await ProfileController.getProfile(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        const response = jsonMock.mock.calls[0][0];
        expect(response.data.user.role).toBe("Super Admin");
        expect(response.data.user.isAtCloudLeader).toBe(true);
      });

      it("should handle date fields correctly", async () => {
        const createdDate = new Date("2024-01-01T10:00:00Z");
        const loginDate = new Date("2025-01-01T15:30:00Z");

        const mockUser = {
          _id: userId,
          username: "testuser",
          email: "test@example.com",
          role: "Participant",
          createdAt: createdDate,
          lastLogin: loginDate,
        };

        mockReq.user = mockUser;

        await ProfileController.getProfile(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        const response = jsonMock.mock.calls[0][0];
        expect(response.data.user.createdAt).toBe(createdDate);
        expect(response.data.user.lastLogin).toBe(loginDate);
      });

      it("should handle inactive users", async () => {
        const mockUser = {
          _id: userId,
          username: "inactiveuser",
          email: "inactive@example.com",
          role: "Participant",
          isActive: false,
        };

        mockReq.user = mockUser;

        await ProfileController.getProfile(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        const response = jsonMock.mock.calls[0][0];
        expect(response.data.user.isActive).toBe(false);
      });

      it("should handle unverified users", async () => {
        const mockUser = {
          _id: userId,
          username: "unverified",
          email: "unverified@example.com",
          role: "Participant",
          isVerified: false,
        };

        mockReq.user = mockUser;

        await ProfileController.getProfile(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        const response = jsonMock.mock.calls[0][0];
        expect(response.data.user.isVerified).toBe(false);
      });
    });

    describe("error handling", () => {
      it("should handle errors when accessing user properties", async () => {
        // Create a user object that throws when accessing _id
        const mockUser = {
          get _id() {
            throw new Error("Database error");
          },
          username: "testuser",
          email: "test@example.com",
          role: "Participant",
        };

        mockReq.user = mockUser;

        await ProfileController.getProfile(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Failed to retrieve profile.",
        });
      });

      it("should handle unexpected errors gracefully", async () => {
        // Mock statusMock to throw an error
        statusMock.mockImplementation(() => {
          throw new Error("Response error");
        });

        mockReq.user = {
          _id: userId,
          username: "testuser",
          email: "test@example.com",
          role: "Participant",
        };

        // Should not throw
        await expect(
          ProfileController.getProfile(mockReq as Request, mockRes as Response)
        ).rejects.toThrow("Response error");
      });
    });
  });
});
