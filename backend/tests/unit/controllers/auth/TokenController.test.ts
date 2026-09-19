import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";
import TokenController from "../../../../src/controllers/auth/TokenController";
import { User } from "../../../../src/models";
import { TokenService } from "../../../../src/middleware/auth";
import mongoose from "mongoose";
import {
  RefreshSessionRejectedError,
  RefreshSessionService,
} from "../../../../src/services/auth/RefreshSessionService";

// Mock dependencies
vi.mock("../../../../src/models", () => ({
  User: {
    findById: vi.fn(),
  },
}));

vi.mock("../../../../src/middleware/auth", () => ({
  TokenService: {
    verifyRefreshToken: vi.fn(),
    generateTokenPair: vi.fn(),
    refreshTokenExpiresAt: vi.fn(),
  },
}));

vi.mock(
  "../../../../src/services/auth/RefreshSessionService",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("../../../../src/services/auth/RefreshSessionService")
    >();
    return {
      ...actual,
      RefreshSessionService: {
        createRotationIdentity: vi.fn(() => ({
          familyId: "11111111-1111-4111-8111-111111111111",
          tokenId: "22222222-2222-4222-8222-222222222222",
        })),
        rotate: vi.fn(),
        revokeAllForUser: vi.fn(),
      },
    };
  },
);

describe("TokenController", () => {
  let mockReq: any;
  let mockRes: Partial<Response>;
  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;
  let cookieMock: ReturnType<typeof vi.fn>;
  let clearCookieMock: ReturnType<typeof vi.fn>;

  const userId = new mongoose.Types.ObjectId();

  beforeEach(() => {
    vi.clearAllMocks();

    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });
    cookieMock = vi.fn();
    clearCookieMock = vi.fn();

    mockReq = {
      cookies: {},
    };

    mockRes = {
      status: statusMock as any,
      json: jsonMock as any,
      cookie: cookieMock as any,
      clearCookie: clearCookieMock as any,
    };

    // Mock console.error
    vi.spyOn(console, "error").mockImplementation(() => {});

    // Default environment
    process.env.NODE_ENV = "test";
    process.env.JWT_REFRESH_EXPIRE = "7d";
    vi.mocked(TokenService.refreshTokenExpiresAt).mockReturnValue(
      new Date(Date.now() + 604800000),
    );
    vi.mocked(RefreshSessionService.rotate).mockResolvedValue({
      expiresAt: new Date(Date.now() + 604800000),
      lifetimeMs: 604800000,
    });
    vi.mocked(RefreshSessionService.revokeAllForUser).mockResolvedValue(0);
  });

  describe("refreshToken", () => {
    describe("validation", () => {
      it("should return 401 if refresh token not provided", async () => {
        mockReq.cookies = {};

        await TokenController.refreshToken(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(401);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Refresh token not provided.",
        });
      });

      it("should return 401 if refresh token is invalid", async () => {
        mockReq.cookies = { refreshToken: "invalid-token" };
        vi.mocked(TokenService.verifyRefreshToken).mockReturnValue(null as any);

        await TokenController.refreshToken(
          mockReq as Request,
          mockRes as Response
        );

        expect(TokenService.verifyRefreshToken).toHaveBeenCalledWith(
          "invalid-token"
        );
        expect(statusMock).toHaveBeenCalledWith(401);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Invalid refresh token.",
        });
      });

      it("should return 401 if decoded token has no userId", async () => {
        mockReq.cookies = { refreshToken: "valid-token" };
        vi.mocked(TokenService.verifyRefreshToken).mockReturnValue({} as any);

        await TokenController.refreshToken(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(401);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Invalid refresh token.",
        });
      });

      it("should return 401 if user not found", async () => {
        mockReq.cookies = { refreshToken: "valid-token" };
        vi.mocked(TokenService.verifyRefreshToken).mockReturnValue({
          userId: userId.toString(),
          iat: 1_700_000_000,
        } as any);
        vi.mocked(User.findById).mockResolvedValue(null);

        await TokenController.refreshToken(
          mockReq as Request,
          mockRes as Response
        );

        expect(User.findById).toHaveBeenCalledWith(
          userId.toString(),
          "+passwordChangedAt",
        );
        expect(statusMock).toHaveBeenCalledWith(401);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "User not found or unavailable.",
        });
      });

      it("should return 401 if user is inactive", async () => {
        mockReq.cookies = { refreshToken: "valid-token" };
        vi.mocked(TokenService.verifyRefreshToken).mockReturnValue({
          userId: userId.toString(),
          iat: 1_700_000_000,
        } as any);

        const mockUser = {
          _id: userId,
          email: "test@example.com",
          isActive: false,
          isVerified: true,
        };

        vi.mocked(User.findById).mockResolvedValue(mockUser as any);

        await TokenController.refreshToken(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(401);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "User not found or unavailable.",
        });
      });

      it("should return 401 if user is unverified", async () => {
        mockReq.cookies = { refreshToken: "valid-token" };
        vi.mocked(TokenService.verifyRefreshToken).mockReturnValue({
          userId: userId.toString(),
        } as any);
        vi.mocked(User.findById).mockResolvedValue({
          _id: userId,
          isActive: true,
          isVerified: false,
        } as any);

        await TokenController.refreshToken(mockReq as Request, mockRes as Response);

        expect(TokenService.generateTokenPair).not.toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(401);
      });

      it("rejects a refresh token issued before the password changed", async () => {
        mockReq.cookies = { refreshToken: "old-refresh-token" };
        vi.mocked(TokenService.verifyRefreshToken).mockReturnValue({
          userId: userId.toString(),
          iat: 1_700_000_000,
        } as any);
        vi.mocked(User.findById).mockResolvedValue({
          _id: userId,
          isActive: true,
          isVerified: true,
          passwordChangedAt: new Date(1_700_000_001_000),
        } as any);

        await TokenController.refreshToken(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(401);
        expect(TokenService.generateTokenPair).not.toHaveBeenCalled();
      });

      it("rejects a refresh token from the ambiguous password-change second", async () => {
        mockReq.cookies = { refreshToken: "same-second-refresh-token" };
        vi.mocked(TokenService.verifyRefreshToken).mockReturnValue({
          userId: userId.toString(),
          iat: 1_700_000_001,
        } as any);
        vi.mocked(User.findById).mockResolvedValue({
          _id: userId,
          isActive: true,
          isVerified: true,
          passwordChangedAt: new Date(1_700_000_001_750),
        } as any);

        await TokenController.refreshToken(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(401);
        expect(TokenService.generateTokenPair).not.toHaveBeenCalled();
      });
    });

    describe("token generation", () => {
      it("should generate new token pair for valid refresh token", async () => {
        mockReq.cookies = { refreshToken: "valid-refresh-token" };

        vi.mocked(TokenService.verifyRefreshToken).mockReturnValue({
          userId: userId.toString(),
          iat: 1_700_000_001,
        } as any);

        const mockUser = {
          _id: userId,
          email: "test@example.com",
          isActive: true,
          isVerified: true,
          passwordChangedAt: new Date(1_700_000_000_750),
          role: "Member",
        };

        vi.mocked(User.findById).mockResolvedValue(mockUser as any);

        const newTokens = {
          accessToken: "new-access-token",
          refreshToken: "new-refresh-token",
          accessTokenExpires: new Date(),
          refreshTokenExpires: new Date(),
        };

        vi.mocked(TokenService.generateTokenPair).mockReturnValue(newTokens);

        await TokenController.refreshToken(
          mockReq as Request,
          mockRes as Response
        );

        expect(TokenService.generateTokenPair).toHaveBeenCalledWith(
          mockUser,
          expect.objectContaining({
            refreshIdentity: expect.any(Object),
            refreshExpiresAt: expect.any(Date),
          }),
        );
        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          data: {
            accessToken: "new-access-token",
          },
          message: "Token refreshed successfully.",
        });
      });

      it("should set refresh token cookie with correct options", async () => {
        mockReq.cookies = { refreshToken: "valid-refresh-token" };

        vi.mocked(TokenService.verifyRefreshToken).mockReturnValue({
          userId: userId.toString(),
        } as any);

        const mockUser = {
          _id: userId,
          email: "test@example.com",
          isActive: true,
          isVerified: true,
        };

        vi.mocked(User.findById).mockResolvedValue(mockUser as any);

        const newTokens = {
          accessToken: "new-access-token",
          refreshToken: "new-refresh-token",
          accessTokenExpires: new Date(),
          refreshTokenExpires: new Date(),
        };

        vi.mocked(TokenService.generateTokenPair).mockReturnValue(newTokens);

        await TokenController.refreshToken(
          mockReq as Request,
          mockRes as Response
        );

        expect(cookieMock).toHaveBeenCalledWith(
          "refreshToken",
          "new-refresh-token",
          {
            httpOnly: true,
            secure: false, // NODE_ENV = test
            sameSite: "strict",
            path: "/api/auth",
            maxAge: 604800000,
          }
        );
      });

      it("should use secure cookie in production", async () => {
        process.env.NODE_ENV = "production";

        mockReq.cookies = { refreshToken: "valid-refresh-token" };

        vi.mocked(TokenService.verifyRefreshToken).mockReturnValue({
          userId: userId.toString(),
        } as any);

        const mockUser = {
          _id: userId,
          email: "test@example.com",
          isActive: true,
          isVerified: true,
        };

        vi.mocked(User.findById).mockResolvedValue(mockUser as any);

        const newTokens = {
          accessToken: "new-access-token",
          refreshToken: "new-refresh-token",
          accessTokenExpires: new Date(),
          refreshTokenExpires: new Date(),
        };

        vi.mocked(TokenService.generateTokenPair).mockReturnValue(newTokens);

        await TokenController.refreshToken(
          mockReq as Request,
          mockRes as Response
        );

        expect(cookieMock).toHaveBeenCalledWith(
          "refreshToken",
          "new-refresh-token",
          expect.objectContaining({
            secure: true,
          })
        );
      });

      it("preserves the signed absolute family expiry", async () => {
        const fixedExpiry = new Date(Date.now() + 86_400_000);
        vi.mocked(TokenService.refreshTokenExpiresAt).mockReturnValue(fixedExpiry);

        mockReq.cookies = { refreshToken: "valid-refresh-token" };

        vi.mocked(TokenService.verifyRefreshToken).mockReturnValue({
          userId: userId.toString(),
        } as any);

        const mockUser = {
          _id: userId,
          email: "test@example.com",
          isActive: true,
          isVerified: true,
        };

        vi.mocked(User.findById).mockResolvedValue(mockUser as any);

        const newTokens = {
          accessToken: "new-access-token",
          refreshToken: "new-refresh-token",
          accessTokenExpires: new Date(),
          refreshTokenExpires: new Date(),
        };

        vi.mocked(TokenService.generateTokenPair).mockReturnValue(newTokens);

        await TokenController.refreshToken(
          mockReq as Request,
          mockRes as Response
        );

        expect(TokenService.generateTokenPair).toHaveBeenCalledWith(
          mockUser,
          expect.objectContaining({ refreshExpiresAt: fixedExpiry }),
        );
      });
    });

    describe("error handling", () => {
      it("should handle token verification errors", async () => {
        mockReq.cookies = { refreshToken: "valid-refresh-token" };

        vi.mocked(TokenService.verifyRefreshToken).mockImplementation(() => {
          throw new Error("Verification failed");
        });

        await TokenController.refreshToken(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(401);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Invalid refresh token.",
        });
        expect(clearCookieMock).toHaveBeenCalled();
      });

      it("should handle database errors", async () => {
        mockReq.cookies = { refreshToken: "valid-refresh-token" };

        vi.mocked(TokenService.verifyRefreshToken).mockReturnValue({
          userId: userId.toString(),
        } as any);

        vi.mocked(User.findById).mockRejectedValue(new Error("Database error"));

        await TokenController.refreshToken(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(503);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Token refresh is temporarily unavailable.",
        });
        expect(clearCookieMock).not.toHaveBeenCalled();
      });

      it("returns 401 and clears the cookie for persisted-session replay", async () => {
        mockReq.cookies = { refreshToken: "replayed-refresh-token" };
        vi.mocked(TokenService.verifyRefreshToken).mockReturnValue({
          userId: userId.toString(),
          iat: 1_700_000_001,
        } as any);
        vi.mocked(User.findById).mockResolvedValue({
          _id: userId,
          email: "test@example.com",
          isActive: true,
          isVerified: true,
          role: "Member",
        } as any);
        vi.mocked(TokenService.generateTokenPair).mockReturnValue({
          accessToken: "unused-access-token",
          refreshToken: "unused-refresh-token",
          accessTokenExpires: new Date(),
          refreshTokenExpires: new Date(),
        });
        vi.mocked(RefreshSessionService.rotate).mockRejectedValue(
          new RefreshSessionRejectedError("token_reuse"),
        );

        await TokenController.refreshToken(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(401);
        expect(clearCookieMock).toHaveBeenCalledWith(
          "refreshToken",
          expect.objectContaining({ path: "/api/auth" }),
        );
      });
    });
  });
});
