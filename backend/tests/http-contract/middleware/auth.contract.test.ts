import express from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  authenticate,
  authorizeRoles,
  authorizeMinimumRole,
  authorizePermission,
  TokenService,
} from "../../../src/middleware/auth";
import { User } from "../../../src/models";
import { ROLES } from "../../../src/utils/roleUtils";

describe("Auth Middleware Integration", () => {
  let app: express.Application;
  const activeUser = (role: string) => ({
    _id: "507f1f77bcf86cd799439011",
    role,
    isActive: true,
    isVerified: true,
  });

  beforeEach(() => {
    app = express();
    app.use(express.json());
    vi.restoreAllMocks();
  });

  const mountProtectedEcho = (middleware: any) => {
    app.get("/protected", middleware, (req: any, res) => {
      res.status(200).json({
        ok: true,
        userId: req.userId,
        role: req.userRole,
      });
    });
  };

  describe("authenticate", () => {
    it("returns 401 when Authorization header missing", async () => {
      mountProtectedEcho(authenticate);
      const res = await request(app).get("/protected");
      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/No token provided/);
    });

    it("returns 401 when Authorization not Bearer", async () => {
      mountProtectedEcho(authenticate);
      const res = await request(app)
        .get("/protected")
        .set("Authorization", "Token abc");
      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/No token provided|invalid format/i);
    });

    it("returns 401 when Bearer token missing", async () => {
      mountProtectedEcho(authenticate);
      const res = await request(app)
        .get("/protected")
        .set("Authorization", "Bearer ");
      expect(res.status).toBe(401);
      // Middleware may treat this as missing token or invalid format depending on header parsing
      expect(res.body.message).toMatch(
        /Token is missing|No token provided|invalid format/i
      );
    });

    it("returns 401 for invalid token (generic)", async () => {
      vi.spyOn(TokenService, "verifyAccessToken").mockImplementation(() => {
        throw new Error("Invalid access token");
      });
      mountProtectedEcho(authenticate);
      const res = await request(app)
        .get("/protected")
        .set("Authorization", "Bearer bad.token");
      expect(res.status).toBe(401);
      expect(res.body.message).toBe("Authentication failed.");
    });

    it("returns 401 for JsonWebTokenError branch", async () => {
      // Mock to bypass internal wrapper and surface a named error
      vi.spyOn(TokenService, "verifyAccessToken").mockImplementation(() => {
        const err: any = new Error("jwt malformed");
        err.name = "JsonWebTokenError";
        throw err;
      });
      mountProtectedEcho(authenticate);
      const res = await request(app)
        .get("/protected")
        .set("Authorization", "Bearer malformed");
      expect(res.status).toBe(401);
      expect(res.body.message).toBe("Invalid token format.");
    });

    it("returns 401 for TokenExpiredError branch", async () => {
      vi.spyOn(TokenService, "verifyAccessToken").mockImplementation(() => {
        const err: any = new Error("jwt expired");
        err.name = "TokenExpiredError";
        throw err;
      });
      mountProtectedEcho(authenticate);
      const res = await request(app)
        .get("/protected")
        .set("Authorization", "Bearer expired");
      expect(res.status).toBe(401);
      expect(res.body.message).toBe("Token has expired.");
    });

    it("returns 401 when user not found or inactive", async () => {
      vi.spyOn(TokenService, "verifyAccessToken").mockReturnValue({
        userId: "507f1f77bcf86cd799439011",
      } as any);
      vi.spyOn(User, "findById").mockReturnValue({
        select: vi.fn().mockResolvedValue(null),
      } as any);
      mountProtectedEcho(authenticate);
      const res = await request(app)
        .get("/protected")
        .set("Authorization", "Bearer good.token");
      expect(res.status).toBe(401);
      expect(res.body.message).toBe(
        "Invalid token. User not found or inactive."
      );
    });

    it("returns 403 when user not verified", async () => {
      vi.spyOn(TokenService, "verifyAccessToken").mockReturnValue({
        userId: "507f1f77bcf86cd799439011",
      } as any);
      vi.spyOn(User, "findById").mockReturnValue({
        select: vi.fn().mockResolvedValue({
          isActive: true,
          isVerified: false,
        }),
      } as any);
      mountProtectedEcho(authenticate);
      const res = await request(app)
        .get("/protected")
        .set("Authorization", "Bearer good.token");
      expect(res.status).toBe(403);
      expect(res.body.message).toBe(
        "Account not verified. Please verify your email address."
      );
    });

    it("passes and sets user context on success", async () => {
      vi.spyOn(TokenService, "verifyAccessToken").mockReturnValue({
        userId: "507f1f77bcf86cd799439011",
        role: ROLES.PARTICIPANT,
        email: "user@test.com",
      } as any);
      vi.spyOn(User, "findById").mockReturnValue({
        select: vi.fn().mockResolvedValue({
          _id: "507f1f77bcf86cd799439011",
          role: ROLES.PARTICIPANT,
          isActive: true,
          isVerified: true,
        }),
      } as any);
      mountProtectedEcho(authenticate);
      const res = await request(app)
        .get("/protected")
        .set("Authorization", "Bearer good.token");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        userId: "507f1f77bcf86cd799439011",
        role: ROLES.PARTICIPANT,
      });
    });
  });

  describe("authorization helpers", () => {
    it("authorizeRoles denies when user missing", async () => {
      app.get("/admin", authorizeRoles(ROLES.ADMINISTRATOR), (req, res) => {
        res.json({ ok: true });
      });
      const res = await request(app).get("/admin");
      expect(res.status).toBe(401);
    });

    it("authorizeRoles denies when role not allowed", async () => {
      app.get(
        "/admin",
        (req: any, _res, next) => {
          req.user = activeUser(ROLES.PARTICIPANT) as any;
          next();
        },
        authorizeRoles(ROLES.ADMINISTRATOR),
        (req, res) => {
          res.json({ ok: true });
        }
      );
      const res = await request(app).get("/admin");
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Insufficient permissions.");
    });

    it("authorizeRoles passes when role allowed", async () => {
      app.get(
        "/admin",
        (req: any, _res, next) => {
          req.user = activeUser(ROLES.ADMINISTRATOR) as any;
          next();
        },
        authorizeRoles(ROLES.ADMINISTRATOR),
        (req, res) => res.json({ ok: true })
      );
      const res = await request(app).get("/admin");
      expect(res.status).toBe(200);
    });

    it("authorizeMinimumRole denies below threshold", async () => {
      app.get(
        "/leader",
        (req: any, _res, next) => {
          req.user = activeUser(ROLES.PARTICIPANT) as any;
          next();
        },
        authorizeMinimumRole(ROLES.LEADER),
        (req, res) => res.json({ ok: true })
      );
      const res = await request(app).get("/leader");
      expect(res.status).toBe(403);
    });

    it("authorizeMinimumRole passes at or above threshold", async () => {
      app.get(
        "/leader",
        (req: any, _res, next) => {
          req.user = activeUser(ROLES.ADMINISTRATOR) as any;
          next();
        },
        authorizeMinimumRole(ROLES.LEADER),
        (req, res) => res.json({ ok: true })
      );
      const res = await request(app).get("/leader");
      expect(res.status).toBe(200);
    });

    it("authorizePermission denies when missing permission", async () => {
      app.get(
        "/perm",
        (req: any, _res, next) => {
          req.user = activeUser(ROLES.PARTICIPANT) as any;
          next();
        },
        authorizePermission("manage_users" as any),
        (req, res) => res.json({ ok: true })
      );
      const res = await request(app).get("/perm");
      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/Required permission/);
    });

    it("authorizePermission passes when permission granted", async () => {
      app.get(
        "/perm",
        (req: any, _res, next) => {
          req.user = activeUser(ROLES.SUPER_ADMIN) as any;
          next();
        },
        authorizePermission("manage_users" as any),
        (req, res) => res.json({ ok: true })
      );
      const res = await request(app).get("/perm");
      expect(res.status).toBe(200);
    });
  });
});
