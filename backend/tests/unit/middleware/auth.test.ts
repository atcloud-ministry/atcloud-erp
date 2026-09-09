import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { User } from "../../../src/models";
import {
  TokenService,
  authenticate,
  authorizeRoles,
  authorizeMinimumRole,
  authorizePermission,
  verifyEmailToken,
  verifyPasswordResetToken,
  requireAdmin,
  requireSuperAdmin,
  requireLeader,
  authorizeEventManagement,
} from "../../../src/middleware/auth";
import { ROLES, RoleUtils, hasPermission } from "../../../src/utils/roleUtils";

// Mock JWT module
vi.mock("jsonwebtoken");

// Mock User & Event models
vi.mock("../../../src/models", () => ({
  User: {
    findById: vi.fn(),
    findOne: vi.fn(),
  },
  Event: {
    findById: vi.fn(),
  },
}));

// Mock role utils
vi.mock("../../../src/utils/roleUtils", () => ({
  ROLES: {
    SUPER_ADMIN: "Super Admin",
    ADMINISTRATOR: "Administrator",
    LEADER: "Leader",
    PARTICIPANT: "Participant",
  },
  RoleUtils: {
    hasAnyRole: vi.fn(),
    hasMinimumRole: vi.fn(),
    isAdmin: vi.fn(),
  },
  PERMISSIONS: {
    MANAGE_USERS: "manage_users",
    VIEW_USER_PROFILES: "view_user_profiles",
    DEACTIVATE_USERS: "deactivate_users",
  },
  hasPermission: vi.fn(),
  Permission: {},
}));

vi.mock("../../../src/utils/event/eventPermissions", () => ({
  isAffiliatedProgramEditor: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../../src/services/authorization/AuthorizationAuditService", () => ({
  recordAuthorizationDenial: vi.fn(),
}));

// Test helpers
const createMockRequest = (authHeader?: string): Partial<Request> => ({
  headers: authHeader ? { authorization: authHeader } : {},
  user: undefined,
  userId: undefined,
  userRole: undefined,
});

const createMockResponse = (): Partial<Response> => {
  const res: any = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res;
};

const createMockNext = (): NextFunction => vi.fn() as any;

const mockUser = {
  _id: "user123",
  email: "test@example.com",
  username: "testuser",
  role: "Participant",
  isActive: true,
  isVerified: true,
  firstName: "Test",
  lastName: "User",
};

const activeRequestUser = (role: string, _id = "user123") => ({
  _id,
  role,
  isActive: true,
  isVerified: true,
});

describe("Auth Middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set up default environment variables
    process.env.JWT_ACCESS_SECRET = "test-access-secret";
    process.env.JWT_REFRESH_SECRET = "test-refresh-secret";
    process.env.JWT_ACCESS_EXPIRE = "2h";
    process.env.JWT_REFRESH_EXPIRE = "7d";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("TokenService", () => {
    describe("production configuration", () => {
      it("rejects missing or placeholder JWT secrets", () => {
        const originalNodeEnv = process.env.NODE_ENV;
        const originalAccess = process.env.JWT_ACCESS_SECRET;
        const originalRefresh = process.env.JWT_REFRESH_SECRET;
        try {
          process.env.NODE_ENV = "production";
          delete process.env.JWT_ACCESS_SECRET;
          process.env.JWT_REFRESH_SECRET = "your-refresh-secret-key";

          expect(() => TokenService.assertProductionConfiguration()).toThrow(
            /JWT_ACCESS_SECRET/,
          );
        } finally {
          process.env.NODE_ENV = originalNodeEnv;
          process.env.JWT_ACCESS_SECRET = originalAccess;
          process.env.JWT_REFRESH_SECRET = originalRefresh;
        }
      });

      it("rejects reused access and refresh secrets", () => {
        const originalNodeEnv = process.env.NODE_ENV;
        const originalAccess = process.env.JWT_ACCESS_SECRET;
        const originalRefresh = process.env.JWT_REFRESH_SECRET;
        try {
          process.env.NODE_ENV = "production";
          const sharedSecret = "a-secure-but-incorrectly-shared-secret-value";
          process.env.JWT_ACCESS_SECRET = sharedSecret;
          process.env.JWT_REFRESH_SECRET = sharedSecret;

          expect(() => TokenService.assertProductionConfiguration()).toThrow(
            /must be different/,
          );
        } finally {
          process.env.NODE_ENV = originalNodeEnv;
          process.env.JWT_ACCESS_SECRET = originalAccess;
          process.env.JWT_REFRESH_SECRET = originalRefresh;
        }
      });

      it("accepts distinct non-placeholder production secrets", () => {
        const originalNodeEnv = process.env.NODE_ENV;
        const originalAccess = process.env.JWT_ACCESS_SECRET;
        const originalRefresh = process.env.JWT_REFRESH_SECRET;
        try {
          process.env.NODE_ENV = "production";
          process.env.JWT_ACCESS_SECRET =
            "access-secret-with-at-least-thirty-two-random-characters";
          process.env.JWT_REFRESH_SECRET =
            "refresh-secret-with-at-least-thirty-two-random-characters";

          expect(() =>
            TokenService.assertProductionConfiguration(),
          ).not.toThrow();
        } finally {
          process.env.NODE_ENV = originalNodeEnv;
          process.env.JWT_ACCESS_SECRET = originalAccess;
          process.env.JWT_REFRESH_SECRET = originalRefresh;
        }
      });
    });

    describe("generateAccessToken", () => {
      it("should generate access token with correct payload", () => {
        const payload = {
          userId: "user123",
          email: "test@example.com",
          role: "Participant",
        };

        const mockToken = "mock-access-token";
        (jwt.sign as any).mockReturnValue(mockToken);

        const result = TokenService.generateAccessToken(payload);

        expect(jwt.sign).toHaveBeenCalledWith(payload, "test-access-secret", {
          expiresIn: "2h",
          issuer: "atcloud-system",
          audience: "atcloud-users",
        });
        expect(result).toBe(mockToken);
      });

      it("should use default secret if env var not set", () => {
        delete process.env.JWT_ACCESS_SECRET;
        const payload = {
          userId: "user123",
          email: "test@example.com",
          role: "Participant",
        };

        TokenService.generateAccessToken(payload);

        expect(jwt.sign).toHaveBeenCalledWith(
          payload,
          "your-access-secret-key",
          expect.any(Object),
        );
      });
    });

    describe("generateRefreshToken", () => {
      it("should generate refresh token with correct payload", () => {
        const payload = { userId: "user123" };
        const mockToken = "mock-refresh-token";
        (jwt.sign as any).mockReturnValue(mockToken);

        const result = TokenService.generateRefreshToken(payload);

        expect(jwt.sign).toHaveBeenCalledWith(payload, "test-refresh-secret", {
          expiresIn: "7d",
          issuer: "atcloud-system",
          audience: "atcloud-users",
        });
        expect(result).toBe(mockToken);
      });
    });

    describe("verifyAccessToken", () => {
      it("should verify valid access token", () => {
        const token = "valid-token";
        const mockPayload = { userId: "user123", email: "test@example.com" };
        (jwt.verify as any).mockReturnValue(mockPayload);

        const result = TokenService.verifyAccessToken(token);

        expect(jwt.verify).toHaveBeenCalledWith(token, "test-access-secret", {
          issuer: "atcloud-system",
          audience: "atcloud-users",
        });
        expect(result).toEqual(mockPayload);
      });

      it("should throw error for invalid token", () => {
        const token = "invalid-token";
        (jwt.verify as any).mockImplementation(() => {
          throw new Error("Invalid token");
        });

        expect(() => TokenService.verifyAccessToken(token)).toThrow(
          "Invalid access token",
        );
      });
    });

    describe("verifyRefreshToken", () => {
      it("should verify valid refresh token", () => {
        const token = "valid-refresh-token";
        const mockPayload = { userId: "user123" };
        (jwt.verify as any).mockReturnValue(mockPayload);

        const result = TokenService.verifyRefreshToken(token);

        expect(jwt.verify).toHaveBeenCalledWith(token, "test-refresh-secret", {
          issuer: "atcloud-system",
          audience: "atcloud-users",
        });
        expect(result).toEqual(mockPayload);
      });

      it("should throw error for invalid refresh token", () => {
        const token = "invalid-refresh-token";
        (jwt.verify as any).mockImplementation(() => {
          throw new Error("Invalid token");
        });

        expect(() => TokenService.verifyRefreshToken(token)).toThrow(
          "Invalid refresh token",
        );
      });
    });

    describe("generateTokenPair", () => {
      it("should generate both access and refresh tokens", () => {
        const mockAccessToken = "mock-access-token";
        const mockRefreshToken = "mock-refresh-token";

        (jwt.sign as any)
          .mockReturnValueOnce(mockAccessToken)
          .mockReturnValueOnce(mockRefreshToken);

        const result = TokenService.generateTokenPair(mockUser as any);

        expect(result).toEqual({
          accessToken: mockAccessToken,
          refreshToken: mockRefreshToken,
          accessTokenExpires: expect.any(Date),
          refreshTokenExpires: expect.any(Date),
        });

        // Verify access token generation
        expect(jwt.sign).toHaveBeenCalledWith(
          {
            userId: "user123",
            email: "test@example.com",
            role: "Participant",
          },
          "test-access-secret",
          expect.any(Object),
        );

        // Verify refresh token generation
        expect(jwt.sign).toHaveBeenCalledWith(
          { userId: "user123" },
          "test-refresh-secret",
          expect.any(Object),
        );
      });
    });

    describe("decodeToken", () => {
      it("should decode token without verification", () => {
        const token = "some-token";
        const mockPayload = { userId: "user123", exp: Date.now() };
        (jwt.decode as any).mockReturnValue(mockPayload);

        const result = TokenService.decodeToken(token);

        expect(jwt.decode).toHaveBeenCalledWith(token);
        expect(result).toEqual(mockPayload);
      });
    });
  });

  describe("authenticate middleware", () => {
    it("should authenticate valid user successfully", async () => {
      const req = createMockRequest("Bearer valid-token") as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      const mockDecoded = { userId: "user123", email: "test@example.com" };
      (jwt.verify as any).mockReturnValue(mockDecoded);

      const mockUserQuery = {
        select: vi.fn().mockResolvedValue(mockUser),
      };
      (User.findById as any).mockReturnValue(mockUserQuery);

      await authenticate(req, res, next);

      expect(User.findById).toHaveBeenCalledWith("user123");
      expect(mockUserQuery.select).toHaveBeenCalledWith("-password");
      expect(req.user).toEqual(mockUser);
      expect(req.userId).toBe("user123");
      expect(req.userRole).toBe("Participant");
      expect(req.authPrincipal).toEqual({
        kind: "user",
        userId: "user123",
        role: "Participant",
        isActive: true,
        isVerified: true,
      });
      expect(req.authPrincipal).not.toHaveProperty("email");
      expect(Object.isFrozen(req.authPrincipal)).toBe(true);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("should return 401 when no authorization header provided", async () => {
      const req = createMockRequest() as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      await authenticate(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Access denied. No token provided or invalid format.",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("should return 401 when authorization header does not start with Bearer", async () => {
      const req = createMockRequest("Basic invalid-format") as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      await authenticate(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Access denied. No token provided or invalid format.",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("should return 401 when token is empty", async () => {
      const req = createMockRequest("Bearer ") as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      await authenticate(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Access denied. Token is missing.",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("should return 401 when user not found", async () => {
      const req = createMockRequest("Bearer valid-token") as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      const mockDecoded = { userId: "user123" };
      (jwt.verify as any).mockReturnValue(mockDecoded);

      const mockUserQuery = {
        select: vi.fn().mockResolvedValue(null),
      };
      (User.findById as any).mockReturnValue(mockUserQuery);

      await authenticate(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Invalid token. User not found or inactive.",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("should return 401 when user is inactive", async () => {
      const req = createMockRequest("Bearer valid-token") as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      const mockDecoded = { userId: "user123" };
      (jwt.verify as any).mockReturnValue(mockDecoded);

      const inactiveUser = { ...mockUser, isActive: false };
      const mockUserQuery = {
        select: vi.fn().mockResolvedValue(inactiveUser),
      };
      (User.findById as any).mockReturnValue(mockUserQuery);

      await authenticate(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Invalid token. User not found or inactive.",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("should return 403 when user is not verified", async () => {
      const req = createMockRequest("Bearer valid-token") as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      const mockDecoded = { userId: "user123" };
      (jwt.verify as any).mockReturnValue(mockDecoded);

      const unverifiedUser = { ...mockUser, isVerified: false };
      const mockUserQuery = {
        select: vi.fn().mockResolvedValue(unverifiedUser),
      };
      (User.findById as any).mockReturnValue(mockUserQuery);

      await authenticate(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Account not verified. Please verify your email address.",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("should return 401 for JsonWebTokenError", async () => {
      const req = createMockRequest("Bearer invalid-token") as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      const error = new Error("Invalid token");
      error.name = "JsonWebTokenError";

      // Mock TokenService.verifyAccessToken to throw the error
      vi.spyOn(TokenService, "verifyAccessToken").mockImplementation(() => {
        throw error;
      });

      await authenticate(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Invalid token format.",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("should return 401 for TokenExpiredError", async () => {
      const req = createMockRequest("Bearer expired-token") as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      const error = new Error("Token expired");
      error.name = "TokenExpiredError";

      // Mock TokenService.verifyAccessToken to throw the error
      vi.spyOn(TokenService, "verifyAccessToken").mockImplementation(() => {
        throw error;
      });

      await authenticate(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Token has expired.",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("should return 401 for other authentication errors", async () => {
      const req = createMockRequest("Bearer some-token") as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      vi.spyOn(TokenService, "verifyAccessToken").mockImplementation(() => {
        throw new Error("Some other error");
      });

      await authenticate(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Authentication failed.",
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("authorizeRoles middleware", () => {
    it("should allow access when user has one of the required roles", async () => {
      // Mock RoleUtils.hasAnyRole to return true
      vi.mocked(RoleUtils.hasAnyRole).mockReturnValue(true);

      const authorizeMiddleware = authorizeRoles(
        ROLES.ADMINISTRATOR,
        ROLES.LEADER,
      );
      const req = {
        user: activeRequestUser("Administrator"),
      } as unknown as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      await authorizeMiddleware(req, res, next);

      expect(RoleUtils.hasAnyRole).toHaveBeenCalledWith("Administrator", [
        ROLES.ADMINISTRATOR,
        ROLES.LEADER,
      ]);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("should return 401 when user not authenticated", async () => {
      const authorizeMiddleware = authorizeRoles(
        ROLES.ADMINISTRATOR,
        ROLES.LEADER,
      );
      const req = {} as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      await authorizeMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Authentication required.",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("should return 403 when user does not have required role", async () => {
      // Mock RoleUtils.hasAnyRole to return false
      vi.mocked(RoleUtils.hasAnyRole).mockReturnValue(false);

      const authorizeMiddleware = authorizeRoles(
        ROLES.ADMINISTRATOR,
        ROLES.LEADER,
      );
      const req = {
        user: activeRequestUser("Participant"),
      } as unknown as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      await authorizeMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: `Access denied. Required roles: ${ROLES.ADMINISTRATOR} or ${ROLES.LEADER}`,
        error: "Insufficient permissions.",
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("authorizeMinimumRole middleware", () => {
    it("should allow access when user has minimum role or higher", async () => {
      // Mock RoleUtils.hasMinimumRole to return true
      vi.mocked(RoleUtils.hasMinimumRole).mockReturnValue(true);

      const authorizeMiddleware = authorizeMinimumRole(ROLES.LEADER);
      const req = {
        user: activeRequestUser("Administrator"),
      } as unknown as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      await authorizeMiddleware(req, res, next);

      expect(RoleUtils.hasMinimumRole).toHaveBeenCalledWith(
        "Administrator",
        ROLES.LEADER,
      );
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("should return 401 when user not authenticated", async () => {
      const authorizeMiddleware = authorizeMinimumRole(ROLES.LEADER);
      const req = {} as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      await authorizeMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Authentication required.",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("should return 403 when user does not have minimum role", async () => {
      // Mock RoleUtils.hasMinimumRole to return false
      vi.mocked(RoleUtils.hasMinimumRole).mockReturnValue(false);

      const authorizeMiddleware = authorizeMinimumRole(ROLES.LEADER);
      const req = {
        user: activeRequestUser("Participant"),
      } as unknown as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      await authorizeMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: `Access denied. Minimum required role: ${ROLES.LEADER}`,
        error: "Insufficient permissions.",
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("Method Existence Tests", () => {
    it("should have TokenService class", () => {
      expect(TokenService).toBeDefined();
    });

    it("should have authenticate middleware", () => {
      expect(authenticate).toBeDefined();
      expect(typeof authenticate).toBe("function");
    });

    it("should have authorizeRoles middleware", () => {
      expect(authorizeRoles).toBeDefined();
      expect(typeof authorizeRoles).toBe("function");
    });

    it("should have authorizeMinimumRole middleware", () => {
      expect(authorizeMinimumRole).toBeDefined();
      expect(typeof authorizeMinimumRole).toBe("function");
    });
  });

  describe("authorizePermission middleware", () => {
    it("should allow when user has required permission", async () => {
      vi.mocked(hasPermission).mockReturnValue(true as any);

      const middleware = authorizePermission("manage_users" as any);
      const req = { user: activeRequestUser(ROLES.ADMINISTRATOR) } as any;
      const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      await middleware(req, res, next);

      expect(hasPermission).toHaveBeenCalledWith(
        ROLES.ADMINISTRATOR,
        "manage_users",
      );
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("should return 401 when no user present", async () => {
      const middleware = authorizePermission("view_user_profiles" as any);
      const req = {} as any;
      const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Authentication required.",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("should return 403 when permission not granted", async () => {
      vi.mocked(hasPermission).mockReturnValue(false as any);

      const middleware = authorizePermission("deactivate_users" as any);
      const req = { user: activeRequestUser(ROLES.PARTICIPANT) } as any;
      const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Access denied. Required permission: deactivate_users",
        error: "Insufficient permissions.",
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("verifyEmailToken middleware", () => {
    it("should return 400 when token param is missing", async () => {
      const req: any = { params: {} };
      const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      await verifyEmailToken(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Verification token is required.",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("should attach user and call next for valid token", async () => {
      const crypto = await import("crypto");
      const token = "valid-token-123";
      const hashed = crypto.createHash("sha256").update(token).digest("hex");

      const mockUser = { _id: "u1", isActive: true, isVerified: true };
      const { User } = await import("../../../src/models");
      (User.findOne as any).mockImplementation(async (query: any) => {
        if (
          query.emailVerificationToken === hashed &&
          query.emailVerificationExpires
        ) {
          return mockUser;
        }
        return null;
      });

      const req: any = { params: { token } };
      const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      await verifyEmailToken(req, res, next);

      expect(req.user).toEqual(mockUser);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("should return expired token response when token found but expired", async () => {
      const crypto = await import("crypto");
      const token = "expired-token-456";
      const hashed = crypto.createHash("sha256").update(token).digest("hex");

      const { User } = await import("../../../src/models");
      // First call (with expires gt now) returns null; second call (check existence) returns an expired user
      (User.findOne as any)
        .mockImplementationOnce(async () => null)
        .mockImplementationOnce(async (query: any) => {
          if (query.emailVerificationToken === hashed) return { _id: "u2" };
          return null;
        });

      const req: any = { params: { token } };
      const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      await verifyEmailToken(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Verification token has expired.",
        errorType: "expired_token",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("should return alreadyVerified when token not found at all", async () => {
      const token = "used-token-789";
      const { User } = await import("../../../src/models");
      (User.findOne as any)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      const req: any = { params: { token } };
      const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      await verifyEmailToken(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: "Email verification completed successfully.",
        alreadyVerified: true,
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("should return 500 when an unexpected error occurs", async () => {
      const token = "boom-token";
      const { User } = await import("../../../src/models");
      (User.findOne as any).mockImplementation(() => {
        throw new Error("DB down");
      });

      const req: any = { params: { token } };
      const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      await verifyEmailToken(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Email verification failed.",
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("verifyPasswordResetToken middleware", () => {
    it("should return 400 when token missing in body", async () => {
      const req: any = { body: {} };
      const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      await verifyPasswordResetToken(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Reset token is required.",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("should attach user and next for valid reset token", async () => {
      const crypto = await import("crypto");
      const token = "reset-token-abc";
      const hashed = crypto.createHash("sha256").update(token).digest("hex");

      const mockUser = { _id: "u3" };
      const { User } = await import("../../../src/models");
      const select = vi.fn().mockResolvedValue(mockUser);
      (User.findOne as any).mockReturnValue({ select });

      const req: any = { body: { token } };
      const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      await verifyPasswordResetToken(req, res, next);

      // Ensure findOne was called with hashed token
      expect((User.findOne as any).mock.calls[0][0]).toMatchObject({
        passwordResetToken: hashed,
      });
      expect(select).toHaveBeenCalledWith(
        "+passwordResetToken +passwordResetExpires",
      );
      expect(req.user).toEqual(mockUser);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("should return 400 for invalid or expired reset token", async () => {
      const token = "bad-token";
      const { User } = await import("../../../src/models");
      const select = vi.fn().mockResolvedValue(null);
      (User.findOne as any).mockReturnValue({ select });

      const req: any = { body: { token } };
      const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      await verifyPasswordResetToken(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Invalid or expired reset token.",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("should return 500 when an unexpected error occurs", async () => {
      const token = "reset-exception";
      const { User } = await import("../../../src/models");
      const select = vi.fn().mockImplementation(() => {
        throw new Error("DB error");
      });
      (User.findOne as any).mockReturnValue({ select });

      const req: any = { body: { token } };
      const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      await verifyPasswordResetToken(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Password reset verification failed.",
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("Admin/SuperAdmin helpers", () => {
    it("requireAdmin should enforce minimum Administrator role", async () => {
      vi.mocked(RoleUtils.hasMinimumRole).mockReturnValue(false);
      const req: any = { user: activeRequestUser(ROLES.PARTICIPANT) };
      const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      await requireAdmin(req as any, res as any, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: `Access denied. Minimum required role: ${ROLES.ADMINISTRATOR}`,
        error: "Insufficient permissions.",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("requireSuperAdmin should restrict to Super Admin role", async () => {
      const req: any = { user: activeRequestUser(ROLES.ADMINISTRATOR) };
      const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      await requireSuperAdmin(req as any, res as any, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: `Access denied. Required roles: ${ROLES.SUPER_ADMIN}`,
        error: "Insufficient permissions.",
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("authorizeEventManagement middleware", () => {
    it("should return 401 when no user", async () => {
      const req: any = { params: { eventId: "e1" } };
      const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      await authorizeEventManagement(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Authentication required.",
      });
    });

    it("should return 400 when no event id provided", async () => {
      const req: any = {
        user: activeRequestUser(ROLES.PARTICIPANT, "u1"),
        params: {},
      };
      const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      await authorizeEventManagement(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Event ID is required.",
      });
    });

    it("should allow Super Admin without checking event", async () => {
      const { Event } = await import("../../../src/models");
      const req: any = {
        user: activeRequestUser(ROLES.SUPER_ADMIN, "u1"),
        params: { eventId: "e1" },
      };
      const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      await authorizeEventManagement(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(Event.findById).not.toHaveBeenCalled();
    });

    it("should allow Administrator without checking event", async () => {
      const { Event } = await import("../../../src/models");
      const req: any = {
        user: activeRequestUser(ROLES.ADMINISTRATOR, "u1"),
        params: { eventId: "e1" },
      };
      const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      await authorizeEventManagement(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(Event.findById).not.toHaveBeenCalled();
    });

    it("should 404 when event not found", async () => {
      const { Event } = await import("../../../src/models");
      (Event.findById as any).mockResolvedValue(null);

      const req: any = {
        user: activeRequestUser(ROLES.LEADER, "u1"),
        params: { eventId: "e404" },
      };
      const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      await authorizeEventManagement(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Event not found.",
      });
    });

    it("should allow when user is event creator", async () => {
      const { Event } = await import("../../../src/models");
      (Event.findById as any).mockResolvedValue({ createdBy: "u1" });

      const req: any = {
        user: activeRequestUser(ROLES.LEADER, "u1"),
        params: { eventId: "e1" },
      };
      const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      await authorizeEventManagement(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it("should allow when user is organizer", async () => {
      const { Event } = await import("../../../src/models");
      (Event.findById as any).mockResolvedValue({
        createdBy: "someone",
        organizerDetails: [{ userId: "u1" }],
      });

      const req: any = {
        user: activeRequestUser(ROLES.LEADER, "u1"),
        params: { eventId: "e1" },
      };
      const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      await authorizeEventManagement(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it("should 403 when user is neither creator nor organizer", async () => {
      const { Event } = await import("../../../src/models");
      (Event.findById as any).mockResolvedValue({
        createdBy: "someone",
        organizerDetails: [{ userId: "u2" }],
      });

      const req: any = {
        user: activeRequestUser(ROLES.LEADER, "u1"),
        params: { eventId: "e1" },
      };
      const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      await authorizeEventManagement(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message:
          "Access denied. You must be an Administrator, Super Admin, event creator, listed organizer, or a mentor/class rep of an affiliated program to manage this event.",
      });
    });
  });

  describe("authenticateOptional", () => {
    let authenticateOptional: any;

    beforeEach(async () => {
      const authModule = await import("../../../src/middleware/auth");
      authenticateOptional = authModule.authenticateOptional;
    });

    it("should proceed without user when no auth header provided", async () => {
      const req: any = { headers: {} };
      const res: any = {};
      const next = vi.fn();

      await authenticateOptional(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeUndefined();
    });

    it("should proceed without user when auth header doesn't start with Bearer", async () => {
      const req: any = { headers: { authorization: "Basic abc123" } };
      const res: any = {};
      const next = vi.fn();

      await authenticateOptional(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeUndefined();
    });

    it("should proceed without user when token is empty", async () => {
      const req: any = { headers: { authorization: "Bearer " } };
      const res: any = {};
      const next = vi.fn();

      await authenticateOptional(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeUndefined();
    });

    it("should attach user when valid token is provided", async () => {
      const mockUser = {
        _id: "user123",
        role: "Participant",
        isActive: true,
        isVerified: true,
      };

      // Mock token verification to return valid payload
      vi.spyOn(TokenService, "verifyAccessToken").mockReturnValue({
        userId: "user123",
        email: "test@example.com",
        role: "Participant",
      });

      (User.findById as any).mockReturnValue({
        select: vi.fn().mockResolvedValue(mockUser),
      });

      const req: any = { headers: { authorization: "Bearer validtoken123" } };
      const res: any = {};
      const next = vi.fn();

      await authenticateOptional(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBe(mockUser);
      expect(req.userId).toBe("user123");
      expect(req.userRole).toBe("Participant");
    });

    it("should proceed without user when user not found", async () => {
      vi.spyOn(TokenService, "verifyAccessToken").mockReturnValue({
        userId: "user123",
        email: "test@example.com",
        role: "Participant",
      });

      (User.findById as any).mockReturnValue({
        select: vi.fn().mockResolvedValue(null),
      });

      const req: any = { headers: { authorization: "Bearer validtoken123" } };
      const res: any = {};
      const next = vi.fn();

      await authenticateOptional(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeUndefined();
    });

    it("should proceed without user when user is not active", async () => {
      vi.spyOn(TokenService, "verifyAccessToken").mockReturnValue({
        userId: "user123",
        email: "test@example.com",
        role: "Participant",
      });

      (User.findById as any).mockReturnValue({
        select: vi.fn().mockResolvedValue({
          _id: "user123",
          role: "Participant",
          isActive: false,
          isVerified: true,
        }),
      });

      const req: any = { headers: { authorization: "Bearer validtoken123" } };
      const res: any = {};
      const next = vi.fn();

      await authenticateOptional(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeUndefined();
    });

    it("should proceed without user when user is not verified", async () => {
      vi.spyOn(TokenService, "verifyAccessToken").mockReturnValue({
        userId: "user123",
        email: "test@example.com",
        role: "Participant",
      });

      (User.findById as any).mockReturnValue({
        select: vi.fn().mockResolvedValue({
          _id: "user123",
          role: "Participant",
          isActive: true,
          isVerified: false,
        }),
      });

      const req: any = { headers: { authorization: "Bearer validtoken123" } };
      const res: any = {};
      const next = vi.fn();

      await authenticateOptional(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeUndefined();
    });

    it("should proceed without user when token verification fails", async () => {
      vi.spyOn(TokenService, "verifyAccessToken").mockImplementation(() => {
        throw new Error("Invalid token");
      });

      const req: any = { headers: { authorization: "Bearer invalidtoken" } };
      const res: any = {};
      const next = vi.fn();

      await authenticateOptional(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeUndefined();
    });
  });
});
