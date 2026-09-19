import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";
import LoginController from "../../../../src/controllers/auth/LoginController";
import { User } from "../../../../src/models";
import { TokenService } from "../../../../src/middleware/auth";
import mongoose from "mongoose";
import { RefreshSessionService } from "../../../../src/services/auth/RefreshSessionService";

// Mock dependencies
vi.mock("../../../../src/models", () => ({
  User: {
    findOne: vi.fn(),
  },
}));

vi.mock("../../../../src/middleware/auth", () => ({
  TokenService: {
    generateTokenPair: vi.fn(),
    parseTimeToMs: vi.fn(),
  },
}));

vi.mock("../../../../src/services/auth/RefreshSessionService", () => ({
  RefreshSessionService: {
    register: vi.fn(),
  },
}));

describe("LoginController", () => {
  let mockReq: any;
  let mockRes: Partial<Response>;
  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;
  let cookieMock: ReturnType<typeof vi.fn>;

  const userId = new mongoose.Types.ObjectId();

  beforeEach(() => {
    vi.clearAllMocks();

    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });
    cookieMock = vi.fn();

    mockReq = {
      body: {},
    };

    mockRes = {
      status: statusMock as any,
      json: jsonMock as any,
      cookie: cookieMock as any,
    };

    // Mock console.error
    vi.spyOn(console, "error").mockImplementation(() => {});

    // Default environment
    process.env.NODE_ENV = "test";
    process.env.JWT_REFRESH_EXPIRE = "7d";
    vi.mocked(RefreshSessionService.register).mockResolvedValue(undefined);
  });

  describe("login", () => {
    describe("validation", () => {
      it("should return 400 if emailOrUsername is missing", async () => {
        mockReq.body = { password: "password123" };

        await LoginController.login(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Email/username and password are required",
            statusCode: 400,
          })
        );
      });

      it("should return 400 if password is missing", async () => {
        mockReq.body = { emailOrUsername: "test@example.com" };

        await LoginController.login(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Email/username and password are required",
            statusCode: 400,
          })
        );
      });

      it("should return 400 if both credentials are missing", async () => {
        mockReq.body = {};

        await LoginController.login(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Email/username and password are required",
            statusCode: 400,
          })
        );
      });
    });

    describe("user lookup", () => {
      it("should find user by email (case insensitive)", async () => {
        mockReq.body = {
          emailOrUsername: "Test@Example.COM",
          password: "password123",
        };

        const mockFindOne = vi.fn().mockReturnValue({
          select: vi.fn().mockResolvedValue(null),
        });
        vi.mocked(User.findOne).mockImplementation(mockFindOne);

        await LoginController.login(mockReq as Request, mockRes as Response);

        expect(User.findOne).toHaveBeenCalledWith({
          $or: [
            { email: "test@example.com" },
            { username: "Test@Example.COM" },
          ],
        });
      });

      it("should find user by username", async () => {
        mockReq.body = {
          emailOrUsername: "testuser",
          password: "password123",
        };

        const mockFindOne = vi.fn().mockReturnValue({
          select: vi.fn().mockResolvedValue(null),
        });
        vi.mocked(User.findOne).mockImplementation(mockFindOne);

        await LoginController.login(mockReq as Request, mockRes as Response);

        expect(User.findOne).toHaveBeenCalledWith({
          $or: [{ email: "testuser" }, { username: "testuser" }],
        });
      });

      it("should return 401 if user not found", async () => {
        mockReq.body = {
          emailOrUsername: "nonexistent@example.com",
          password: "password123",
        };

        const mockFindOne = vi.fn().mockReturnValue({
          select: vi.fn().mockResolvedValue(null),
        });
        vi.mocked(User.findOne).mockImplementation(mockFindOne);

        await LoginController.login(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(401);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Invalid email/username or password",
            statusCode: 401,
          })
        );
      });
    });

    describe("account status checks", () => {
      it("should return 423 if account is locked", async () => {
        mockReq.body = {
          emailOrUsername: "locked@example.com",
          password: "password123",
        };

        const mockUser = {
          _id: userId,
          email: "locked@example.com",
          isAccountLocked: vi.fn().mockReturnValue(true),
        };

        const mockFindOne = vi.fn().mockReturnValue({
          select: vi.fn().mockResolvedValue(mockUser),
        });
        vi.mocked(User.findOne).mockImplementation(mockFindOne);

        await LoginController.login(mockReq as Request, mockRes as Response);

        expect(mockUser.isAccountLocked).toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(423);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message:
              "Account is temporarily locked due to too many failed login attempts. Please try again later",
            statusCode: 423,
          })
        );
      });

      it("should return 403 if account is inactive", async () => {
        mockReq.body = {
          emailOrUsername: "inactive@example.com",
          password: "password123",
        };

        const mockUser = {
          _id: userId,
          email: "inactive@example.com",
          isActive: false,
          isAccountLocked: vi.fn().mockReturnValue(false),
        };

        const mockFindOne = vi.fn().mockReturnValue({
          select: vi.fn().mockResolvedValue(mockUser),
        });
        vi.mocked(User.findOne).mockImplementation(mockFindOne);

        await LoginController.login(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(403);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Account has been deactivated. Please contact support",
            statusCode: 403,
          })
        );
      });

      it("should return 403 if email not verified", async () => {
        mockReq.body = {
          emailOrUsername: "unverified@example.com",
          password: "password123",
        };

        const mockUser = {
          _id: userId,
          email: "unverified@example.com",
          isActive: true,
          isVerified: false,
          isAccountLocked: vi.fn().mockReturnValue(false),
          comparePassword: vi.fn().mockResolvedValue(true),
        };

        const mockFindOne = vi.fn().mockReturnValue({
          select: vi.fn().mockResolvedValue(mockUser),
        });
        vi.mocked(User.findOne).mockImplementation(mockFindOne);

        await LoginController.login(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(403);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Please verify your email address before logging in",
            statusCode: 403,
          })
        );
      });
    });

    describe("password verification", () => {
      it("should return 401 if password is invalid", async () => {
        mockReq.body = {
          emailOrUsername: "test@example.com",
          password: "wrongpassword",
        };

        const mockUser = {
          _id: userId,
          email: "test@example.com",
          isActive: true,
          isVerified: true,
          isAccountLocked: vi.fn().mockReturnValue(false),
          comparePassword: vi.fn().mockResolvedValue(false),
          incrementLoginAttempts: vi.fn().mockResolvedValue(undefined),
        };

        const mockFindOne = vi.fn().mockReturnValue({
          select: vi.fn().mockResolvedValue(mockUser),
        });
        vi.mocked(User.findOne).mockImplementation(mockFindOne);

        await LoginController.login(mockReq as Request, mockRes as Response);

        expect(mockUser.comparePassword).toHaveBeenCalledWith("wrongpassword");
        expect(mockUser.incrementLoginAttempts).toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(401);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Invalid email/username or password",
            statusCode: 401,
          })
        );
      });
    });

    describe("successful login", () => {
      it("should login successfully with valid credentials", async () => {
        mockReq.body = {
          emailOrUsername: "test@example.com",
          password: "password123",
          rememberMe: false,
        };

        const mockUser = {
          _id: userId,
          username: "testuser",
          email: "test@example.com",
          phone: "1234567890",
          firstName: "Test",
          lastName: "User",
          gender: "Male",
          role: "Member",
          isAtCloudLeader: false,
          roleInAtCloud: "Member",
          occupation: "Engineer",
          company: "Tech Corp",
          weeklyChurch: "First Church",
          homeAddress: "123 Home St",
          churchAddress: "456 Church Ave",
          avatar: "avatar.jpg",
          lastLogin: new Date(),
          isActive: true,
          isVerified: true,
          isAccountLocked: vi.fn().mockReturnValue(false),
          comparePassword: vi.fn().mockResolvedValue(true),
          resetLoginAttempts: vi.fn().mockResolvedValue(undefined),
          updateLastLogin: vi.fn().mockResolvedValue(undefined),
        };

        const mockFindOne = vi.fn().mockReturnValue({
          select: vi.fn().mockResolvedValue(mockUser),
        });
        vi.mocked(User.findOne).mockImplementation(mockFindOne);

        const mockTokens = {
          accessToken: "access-token-123",
          refreshToken: "refresh-token-456",
          accessTokenExpires: new Date(),
          refreshTokenExpires: new Date(),
        };
        vi.mocked(TokenService.generateTokenPair).mockReturnValue(mockTokens);
        vi.mocked(TokenService.parseTimeToMs).mockReturnValue(604800000);

        await LoginController.login(mockReq as Request, mockRes as Response);

        expect(mockUser.resetLoginAttempts).toHaveBeenCalled();
        expect(mockUser.updateLastLogin).toHaveBeenCalled();
        expect(TokenService.generateTokenPair).toHaveBeenCalledWith(mockUser, {
          refreshLifetimeMs: 86400000,
        });
        expect(statusMock).toHaveBeenCalledWith(200);

        const response = jsonMock.mock.calls[0][0];
        expect(response.success).toBe(true);
        expect(response.message).toBe("Login successful!");
        expect(response.data.user.email).toBe("test@example.com");
        expect(response.data.accessToken).toBe("access-token-123");
      });

      it("should set short cookie duration when rememberMe is false", async () => {
        mockReq.body = {
          emailOrUsername: "test@example.com",
          password: "password123",
          rememberMe: false,
        };

        const mockUser = {
          _id: userId,
          username: "testuser",
          email: "test@example.com",
          role: "Member",
          isActive: true,
          isVerified: true,
          isAccountLocked: vi.fn().mockReturnValue(false),
          comparePassword: vi.fn().mockResolvedValue(true),
          resetLoginAttempts: vi.fn().mockResolvedValue(undefined),
          updateLastLogin: vi.fn().mockResolvedValue(undefined),
        };

        const mockFindOne = vi.fn().mockReturnValue({
          select: vi.fn().mockResolvedValue(mockUser),
        });
        vi.mocked(User.findOne).mockImplementation(mockFindOne);

        const mockTokens = {
          accessToken: "access-token-123",
          refreshToken: "refresh-token-456",
          accessTokenExpires: new Date(),
          refreshTokenExpires: new Date(),
        };
        vi.mocked(TokenService.generateTokenPair).mockReturnValue(mockTokens);
        vi.mocked(TokenService.parseTimeToMs).mockReturnValue(604800000);

        await LoginController.login(mockReq as Request, mockRes as Response);

        expect(cookieMock).toHaveBeenCalledWith(
          "refreshToken",
          "refresh-token-456",
          expect.objectContaining({
            maxAge: 86400000, // 1 day
          })
        );
      });

      it("should set long cookie duration when rememberMe is true", async () => {
        mockReq.body = {
          emailOrUsername: "test@example.com",
          password: "password123",
          rememberMe: true,
        };

        const mockUser = {
          _id: userId,
          username: "testuser",
          email: "test@example.com",
          role: "Member",
          isActive: true,
          isVerified: true,
          isAccountLocked: vi.fn().mockReturnValue(false),
          comparePassword: vi.fn().mockResolvedValue(true),
          resetLoginAttempts: vi.fn().mockResolvedValue(undefined),
          updateLastLogin: vi.fn().mockResolvedValue(undefined),
        };

        const mockFindOne = vi.fn().mockReturnValue({
          select: vi.fn().mockResolvedValue(mockUser),
        });
        vi.mocked(User.findOne).mockImplementation(mockFindOne);

        const mockTokens = {
          accessToken: "access-token-123",
          refreshToken: "refresh-token-456",
          accessTokenExpires: new Date(),
          refreshTokenExpires: new Date(),
        };
        vi.mocked(TokenService.generateTokenPair).mockReturnValue(mockTokens);
        vi.mocked(TokenService.parseTimeToMs).mockReturnValue(604800000);

        await LoginController.login(mockReq as Request, mockRes as Response);

        expect(cookieMock).toHaveBeenCalledWith(
          "refreshToken",
          "refresh-token-456",
          expect.objectContaining({
            maxAge: 604800000, // 7 days
          })
        );
      });

      it("should use secure cookie in production", async () => {
        process.env.NODE_ENV = "production";

        mockReq.body = {
          emailOrUsername: "test@example.com",
          password: "password123",
        };

        const mockUser = {
          _id: userId,
          username: "testuser",
          email: "test@example.com",
          role: "Member",
          isActive: true,
          isVerified: true,
          isAccountLocked: vi.fn().mockReturnValue(false),
          comparePassword: vi.fn().mockResolvedValue(true),
          resetLoginAttempts: vi.fn().mockResolvedValue(undefined),
          updateLastLogin: vi.fn().mockResolvedValue(undefined),
        };

        const mockFindOne = vi.fn().mockReturnValue({
          select: vi.fn().mockResolvedValue(mockUser),
        });
        vi.mocked(User.findOne).mockImplementation(mockFindOne);

        const mockTokens = {
          accessToken: "access-token-123",
          refreshToken: "refresh-token-456",
          accessTokenExpires: new Date(),
          refreshTokenExpires: new Date(),
        };
        vi.mocked(TokenService.generateTokenPair).mockReturnValue(mockTokens);
        vi.mocked(TokenService.parseTimeToMs).mockReturnValue(604800000);

        await LoginController.login(mockReq as Request, mockRes as Response);

        expect(cookieMock).toHaveBeenCalledWith(
          "refreshToken",
          "refresh-token-456",
          expect.objectContaining({
            secure: true,
          })
        );
      });

      it("should use default 7d expire when JWT_REFRESH_EXPIRE is not set", async () => {
        // Clear the env variable to trigger the fallback
        delete process.env.JWT_REFRESH_EXPIRE;

        mockReq.body = {
          emailOrUsername: "test@example.com",
          password: "password123",
          rememberMe: true,
        };

        const mockUser = {
          _id: userId,
          username: "testuser",
          email: "test@example.com",
          role: "Member",
          isActive: true,
          isVerified: true,
          isAccountLocked: vi.fn().mockReturnValue(false),
          comparePassword: vi.fn().mockResolvedValue(true),
          resetLoginAttempts: vi.fn().mockResolvedValue(undefined),
          updateLastLogin: vi.fn().mockResolvedValue(undefined),
        };

        const mockFindOne = vi.fn().mockReturnValue({
          select: vi.fn().mockResolvedValue(mockUser),
        });
        vi.mocked(User.findOne).mockImplementation(mockFindOne);

        const mockTokens = {
          accessToken: "access-token-123",
          refreshToken: "refresh-token-456",
          accessTokenExpires: new Date(),
          refreshTokenExpires: new Date(),
        };
        vi.mocked(TokenService.generateTokenPair).mockReturnValue(mockTokens);
        vi.mocked(TokenService.parseTimeToMs).mockReturnValue(604800000);

        await LoginController.login(mockReq as Request, mockRes as Response);

        // The fallback "7d" should be passed to parseTimeToMs
        expect(TokenService.parseTimeToMs).toHaveBeenCalledWith("7d");
      });
    });

    describe("error handling", () => {
      it("should handle database errors", async () => {
        mockReq.body = {
          emailOrUsername: "test@example.com",
          password: "password123",
        };

        const mockFindOne = vi.fn().mockReturnValue({
          select: vi.fn().mockRejectedValue(new Error("Database error")),
        });
        vi.mocked(User.findOne).mockImplementation(mockFindOne);

        await LoginController.login(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Login failed. Please try again",
          })
        );
      });

      it("should handle token generation errors", async () => {
        mockReq.body = {
          emailOrUsername: "test@example.com",
          password: "password123",
        };

        const mockUser = {
          _id: userId,
          username: "testuser",
          email: "test@example.com",
          role: "Member",
          isActive: true,
          isVerified: true,
          isAccountLocked: vi.fn().mockReturnValue(false),
          comparePassword: vi.fn().mockResolvedValue(true),
          resetLoginAttempts: vi.fn().mockResolvedValue(undefined),
          updateLastLogin: vi.fn().mockResolvedValue(undefined),
        };

        const mockFindOne = vi.fn().mockReturnValue({
          select: vi.fn().mockResolvedValue(mockUser),
        });
        vi.mocked(User.findOne).mockImplementation(mockFindOne);

        vi.mocked(TokenService.generateTokenPair).mockImplementation(() => {
          throw new Error("Token generation failed");
        });

        await LoginController.login(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Login failed. Please try again",
          })
        );
      });
    });
  });
});
