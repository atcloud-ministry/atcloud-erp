import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";

// Mock the models before importing auth
vi.mock("../../../src/models", () => ({
  User: {
    findById: vi.fn().mockReturnThis(),
    select: vi.fn(),
  },
}));

// Mock jsonwebtoken
vi.mock("jsonwebtoken", () => ({
  default: {
    verify: vi.fn(),
  },
}));

import { authenticate } from "../../../src/middleware/auth";
import { User } from "../../../src/models";

describe("authenticate middleware - test token shortcuts", () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;
  let jsonMock: ReturnType<typeof vi.fn>;
  let statusMock: ReturnType<typeof vi.fn>;
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();

    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";

    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });
    mockNext = vi.fn() as unknown as NextFunction;

    mockReq = {
      headers: {},
      cookies: {},
    };

    mockRes = {
      status: statusMock,
      json: jsonMock,
    } as unknown as Partial<Response>;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  describe("test-admin- token prefix", () => {
    it("should authenticate with test-admin- token when user is found", async () => {
      const validObjectId = new mongoose.Types.ObjectId().toString();
      mockReq.headers = {
        authorization: `Bearer test-admin-${validObjectId}`,
      };

      const mockUser = {
        _id: validObjectId,
        role: "Administrator",
        isActive: true,
        isVerified: true,
      };
      vi.mocked(User.findById).mockResolvedValue(mockUser);

      await authenticate(mockReq as Request, mockRes as Response, mockNext);

      expect(User.findById).toHaveBeenCalledWith(validObjectId);
      expect(mockNext).toHaveBeenCalled();
      expect((mockReq as any).user).toEqual(mockUser);
      expect((mockReq as any).userId).toBe(validObjectId);
      expect((mockReq as any).userRole).toBe("Administrator");
    });

    it("should create fallback admin user when user not found (test-admin-)", async () => {
      const validObjectId = new mongoose.Types.ObjectId().toString();
      mockReq.headers = {
        authorization: `Bearer test-admin-${validObjectId}`,
      };

      vi.mocked(User.findById).mockResolvedValue(null);

      await authenticate(mockReq as Request, mockRes as Response, mockNext);

      expect(User.findById).toHaveBeenCalledWith(validObjectId);
      expect(mockNext).toHaveBeenCalled();
      expect((mockReq as any).user).toEqual({
        _id: validObjectId,
        id: validObjectId,
        role: "Administrator",
        isVerified: true,
        isActive: true,
      });
      expect((mockReq as any).userId).toBe(validObjectId);
      expect((mockReq as any).userRole).toBe("Administrator");
    });

    it("should not use test-admin- shortcut for invalid ObjectId", async () => {
      mockReq.headers = {
        authorization: "Bearer test-admin-invalid-id",
      };

      // Since invalid ObjectId won't trigger shortcut, it will try to verify as JWT
      // which will fail since we mock jwt.verify to throw
      vi.mocked(jwt.verify).mockImplementation(() => {
        throw new Error("Invalid token");
      });

      await authenticate(mockReq as Request, mockRes as Response, mockNext);

      // Should fail since it tries JWT verification
      expect(statusMock).toHaveBeenCalledWith(401);
    });
  });

  describe("test- token prefix (non-admin)", () => {
    it("should authenticate with test- token when user is found", async () => {
      const validObjectId = new mongoose.Types.ObjectId().toString();
      mockReq.headers = {
        authorization: `Bearer test-${validObjectId}`,
      };

      const mockUser = {
        _id: validObjectId,
        role: "Participant",
        isActive: true,
        isVerified: true,
      };
      vi.mocked(User.findById).mockResolvedValue(mockUser);

      await authenticate(mockReq as Request, mockRes as Response, mockNext);

      expect(User.findById).toHaveBeenCalledWith(validObjectId);
      expect(mockNext).toHaveBeenCalled();
      expect((mockReq as any).user).toEqual(mockUser);
      expect((mockReq as any).userId).toBe(validObjectId);
      expect((mockReq as any).userRole).toBe("Participant");
    });

    it("uses the persisted role instead of the test-token prefix role", async () => {
      const validObjectId = new mongoose.Types.ObjectId().toString();
      mockReq.headers = {
        authorization: `Bearer test-admin-${validObjectId}`,
      };

      const mockUser = {
        _id: validObjectId,
        role: "Participant",
        isActive: true,
        isVerified: true,
      };
      vi.mocked(User.findById).mockResolvedValue(mockUser);

      await authenticate(mockReq as Request, mockRes as Response, mockNext);

      expect((mockReq as any).userRole).toBe("Participant");
      expect((mockReq as any).authPrincipal).toEqual({
        kind: "user",
        userId: validObjectId,
        role: "Participant",
        isActive: true,
        isVerified: true,
      });
      expect(mockNext).toHaveBeenCalledOnce();
    });

    it("rejects an inactive persisted user", async () => {
      const validObjectId = new mongoose.Types.ObjectId().toString();
      mockReq.headers = {
        authorization: `Bearer test-admin-${validObjectId}`,
      };
      vi.mocked(User.findById).mockResolvedValue({
        _id: validObjectId,
        role: "Administrator",
        isActive: false,
        isVerified: true,
      });

      await authenticate(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should create fallback participant user when user not found (test-)", async () => {
      const validObjectId = new mongoose.Types.ObjectId().toString();
      mockReq.headers = {
        authorization: `Bearer test-${validObjectId}`,
      };

      vi.mocked(User.findById).mockResolvedValue(null);

      await authenticate(mockReq as Request, mockRes as Response, mockNext);

      expect(User.findById).toHaveBeenCalledWith(validObjectId);
      expect(mockNext).toHaveBeenCalled();
      expect((mockReq as any).user).toEqual({
        _id: validObjectId,
        id: validObjectId,
        role: "Participant",
        isVerified: true,
        isActive: true,
      });
      expect((mockReq as any).userId).toBe(validObjectId);
      expect((mockReq as any).userRole).toBe("Participant");
    });

    it("should not use test- shortcut for invalid ObjectId", async () => {
      mockReq.headers = {
        authorization: "Bearer test-not-an-object-id",
      };

      vi.mocked(jwt.verify).mockImplementation(() => {
        throw new Error("Invalid token");
      });

      await authenticate(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(401);
    });
  });

  describe("non-test environment", () => {
    it("should not use test shortcuts in production", async () => {
      process.env.NODE_ENV = "production";

      const validObjectId = new mongoose.Types.ObjectId().toString();
      mockReq.headers = {
        authorization: `Bearer test-admin-${validObjectId}`,
      };

      vi.mocked(jwt.verify).mockImplementation(() => {
        throw new Error("Invalid token");
      });

      await authenticate(mockReq as Request, mockRes as Response, mockNext);

      // Should not call User.findById for test token in production
      // Instead, it should try to verify as JWT and fail
      expect(statusMock).toHaveBeenCalledWith(401);
    });
  });
});
