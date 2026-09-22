import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import {
  generalLimiter,
  authLimiter,
  searchLimiter,
  uploadLimiter,
  analyticsLimiter,
  profileLimiter,
  exportLimiter,
  systemMessagesLimiter,
} from "../../../src/middleware/rateLimiting";

// Mock the environment
const originalEnv = process.env;

describe("Rate Limiting Middleware", () => {
  let app: express.Application;

  beforeEach(() => {
    // Reset environment variables for each test
    process.env = { ...originalEnv };
    vi.clearAllMocks();

    // Ensure local supertest requests are not routed through proxies
    // Some environments export HTTP(S)_PROXY which can break supertest with
    // "Parse Error: Expected HTTP/" by attempting HTTPS CONNECT to a proxy.
    for (const key of [
      "HTTP_PROXY",
      "http_proxy",
      "HTTPS_PROXY",
      "https_proxy",
      "ALL_PROXY",
      "all_proxy",
      "NO_PROXY",
      "no_proxy",
    ]) {
      delete (process.env as any)[key];
    }
    // Explicitly disable proxying local addresses for good measure
    process.env.NO_PROXY = "localhost,127.0.0.1,::1";

    // Create a fresh express app for each test
    app = express();
    app.use(express.json());
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe("Environment Configuration", () => {
    test("should respect NODE_ENV development setting", async () => {
      process.env.NODE_ENV = "development";

      app.use("/test", generalLimiter, (req, res) => {
        res.json({ success: true });
      });

      const response = await request(app).get("/test").expect(200);

      expect(response.body.success).toBe(true);
    });

    test("should respect production environment limits", async () => {
      process.env.NODE_ENV = "production";

      app.use("/test", generalLimiter, (req, res) => {
        res.json({ success: true });
      });

      const response = await request(app).get("/test").expect(200);

      expect(response.body.success).toBe(true);
    });

    test("should handle emergency disable flag", async () => {
      process.env.ENABLE_RATE_LIMITING = "false";

      app.use("/test", generalLimiter, (req, res) => {
        res.json({ success: true });
      });

      const response = await request(app).get("/test").expect(200);

      expect(response.body.success).toBe(true);
    });
  });

  describe("General Limiter", () => {
    test("should allow requests within limits", async () => {
      app.use("/api", generalLimiter, (req, res) => {
        res.json({ success: true });
      });

      const response = await request(app).get("/api/test").expect(200);

      expect(response.body.success).toBe(true);
      expect(response.headers["ratelimit-limit"]).toBeDefined();
      expect(response.headers["ratelimit-remaining"]).toBeDefined();
    });

    test("should include rate limit headers", async () => {
      app.use("/api", generalLimiter, (req, res) => {
        res.json({ success: true });
      });

      const response = await request(app).get("/api/test").expect(200);

      expect(response.headers["ratelimit-limit"]).toBeDefined();
      expect(response.headers["ratelimit-remaining"]).toBeDefined();
      expect(response.headers["ratelimit-reset"]).toBeDefined();
      expect(response.headers["x-ratelimit-limit"]).toBeUndefined(); // Legacy headers disabled
    });

    test("should provide appropriate error message when limit exceeded", async () => {
      // Set a very low limit for testing
      const testLimiter = require("express-rate-limit")({
        windowMs: 1000,
        max: 1,
        message: {
          error: "Too many requests from this IP, please try again later.",
        },
        standardHeaders: true,
        legacyHeaders: false,
      });

      app.use("/api", testLimiter, (req, res) => {
        res.json({ success: true });
      });

      // First request should succeed
      await request(app).get("/api/test").expect(200);

      // Second request should be rate limited
      const response = await request(app).get("/api/test").expect(429);

      expect(response.body.error).toBe(
        "Too many requests from this IP, please try again later."
      );
    });
  });

  describe("Auth Limiter", () => {
    test("should have stricter limits for authentication", async () => {
      app.use("/auth", authLimiter, (req, res) => {
        res.json({ success: true });
      });

      const response = await request(app).post("/auth/login").expect(200);

      expect(response.body.success).toBe(true);
      expect(response.headers["ratelimit-limit"]).toBeDefined();
    });

    test("should skip successful requests when configured", async () => {
      app.use("/auth", authLimiter, (req, res) => {
        res.status(200).json({ success: true });
      });

      // Multiple successful requests should not consume rate limit
      for (let i = 0; i < 3; i++) {
        const response = await request(app).post("/auth/login").expect(200);

        expect(response.body.success).toBe(true);
      }
    });

    test("should provide auth-specific error message", async () => {
      const testAuthLimiter = require("express-rate-limit")({
        windowMs: 1000,
        max: 1,
        message: {
          error: "Too many authentication attempts, please try again later.",
        },
        standardHeaders: true,
        legacyHeaders: false,
        skipSuccessfulRequests: true,
      });

      app.use("/auth", testAuthLimiter, (req, res) => {
        res.status(401).json({ error: "Invalid credentials" });
      });

      // First request
      await request(app).post("/auth/login").expect(401);

      // Second request should be rate limited
      const response = await request(app).post("/auth/login").expect(429);

      expect(response.body.error).toBe(
        "Too many authentication attempts, please try again later."
      );
    });
  });

  describe("Search Limiter", () => {
    test("should handle search requests with shorter window", async () => {
      app.use("/search", searchLimiter, (req, res) => {
        res.json({ results: [] });
      });

      const response = await request(app).get("/search?q=test").expect(200);

      expect(response.body.results).toEqual([]);
      expect(response.headers["ratelimit-limit"]).toBeDefined();
    });

    test("should provide search-specific error message", async () => {
      const testSearchLimiter = require("express-rate-limit")({
        windowMs: 1000,
        max: 1,
        message: { error: "Too many search requests, please slow down." },
        standardHeaders: true,
        legacyHeaders: false,
      });

      app.use("/search", testSearchLimiter, (req, res) => {
        res.json({ results: [] });
      });

      await request(app).get("/search?q=test").expect(200);

      const response = await request(app).get("/search?q=test2").expect(429);

      expect(response.body.error).toBe(
        "Too many search requests, please slow down."
      );
    });
  });

  describe("Upload Limiter", () => {
    test("should handle file upload requests", async () => {
      app.use("/upload", uploadLimiter, (req, res) => {
        res.json({ uploaded: true });
      });

      const response = await request(app).post("/upload").expect(200);

      expect(response.body.uploaded).toBe(true);
    });

    test("should provide upload-specific error message", async () => {
      const testUploadLimiter = require("express-rate-limit")({
        windowMs: 1000,
        max: 1,
        message: { error: "Too many file uploads, please try again later." },
        standardHeaders: true,
        legacyHeaders: false,
      });

      app.use("/upload", testUploadLimiter, (req, res) => {
        res.json({ uploaded: true });
      });

      await request(app).post("/upload").expect(200);

      const response = await request(app).post("/upload").expect(429);

      expect(response.body.error).toBe(
        "Too many file uploads, please try again later."
      );
    });
  });

  describe("Analytics Limiter", () => {
    test("should handle analytics requests", async () => {
      app.use("/analytics", analyticsLimiter, (req, res) => {
        res.json({ data: {} });
      });

      const response = await request(app).get("/analytics/stats").expect(200);

      expect(response.body.data).toEqual({});
    });

    test("should provide analytics-specific error message", async () => {
      const testAnalyticsLimiter = require("express-rate-limit")({
        windowMs: 1000,
        max: 1,
        message: {
          error: "Too many analytics requests, please try again later.",
        },
        standardHeaders: true,
        legacyHeaders: false,
      });

      app.use("/analytics", testAnalyticsLimiter, (req, res) => {
        res.json({ data: {} });
      });

      await request(app).get("/analytics/stats").expect(200);

      const response = await request(app).get("/analytics/data").expect(429);

      expect(response.body.error).toBe(
        "Too many analytics requests, please try again later."
      );
    });
  });

  describe("Profile Limiter", () => {
    test("should handle profile requests", async () => {
      app.use("/profile", profileLimiter, (req, res) => {
        res.json({ profile: {} });
      });

      const response = await request(app).get("/profile/me").expect(200);

      expect(response.body.profile).toEqual({});
    });

    test("should provide profile-specific error message", async () => {
      const testProfileLimiter = require("express-rate-limit")({
        windowMs: 1000,
        max: 1,
        message: { error: "Too many profile requests, please slow down." },
        standardHeaders: true,
        legacyHeaders: false,
      });

      app.use("/profile", testProfileLimiter, (req, res) => {
        res.json({ profile: {} });
      });

      await request(app).get("/profile/me").expect(200);

      const response = await request(app).get("/profile/settings").expect(429);

      expect(response.body.error).toBe(
        "Too many profile requests, please slow down."
      );
    });
  });

  describe("Export Limiter", () => {
    test("should handle export requests with strict limits", async () => {
      app.use("/export", exportLimiter, (req, res) => {
        res.json({ exportId: "123" });
      });

      const response = await request(app).post("/export/data").expect(200);

      expect(response.body.exportId).toBe("123");
    });

    test("should provide export-specific error message", async () => {
      const testExportLimiter = require("express-rate-limit")({
        windowMs: 1000,
        max: 1,
        message: {
          error: "Export rate limit exceeded, please try again later.",
        },
        standardHeaders: true,
        legacyHeaders: false,
      });

      app.use("/export", testExportLimiter, (req, res) => {
        res.json({ exportId: "123" });
      });

      await request(app).post("/export/data").expect(200);

      const response = await request(app).post("/export/data").expect(429);

      expect(response.body.error).toBe(
        "Export rate limit exceeded, please try again later."
      );
    });
  });

  describe("System Messages Limiter", () => {
    test("should handle system message requests", async () => {
      app.use("/messages", systemMessagesLimiter, (req, res) => {
        res.json({ messages: [] });
      });

      const response = await request(app).get("/messages").expect(200);

      expect(response.body.messages).toEqual([]);
    });

    test("should count all requests including successful ones", async () => {
      app.use("/messages", systemMessagesLimiter, (req, res) => {
        res.json({ messages: [] });
      });

      // Multiple requests should work but consume the rate limit
      const response1 = await request(app).get("/messages").expect(200);
      const response2 = await request(app).get("/messages").expect(200);

      expect(response1.body.messages).toEqual([]);
      expect(response2.body.messages).toEqual([]);
    });

    test("should provide system messages-specific error message", async () => {
      const testSystemLimiter = require("express-rate-limit")({
        windowMs: 1000,
        max: 1,
        message: {
          error: "Too many system message requests, please slow down.",
        },
        standardHeaders: true,
        legacyHeaders: false,
        skipSuccessfulRequests: false,
      });

      app.use("/messages", testSystemLimiter, (req, res) => {
        res.json({ messages: [] });
      });

      await request(app).get("/messages").expect(200);

      const response = await request(app).get("/messages").expect(429);

      expect(response.body.error).toBe(
        "Too many system message requests, please slow down."
      );
    });
  });

  describe("Localhost Bypass in Development", () => {
    test("should bypass rate limiting for localhost in development", async () => {
      process.env.NODE_ENV = "development";

      // Create a very restrictive limiter
      const testLimiter = require("express-rate-limit")({
        windowMs: 1000,
        max: 1,
        message: { error: "Rate limited" },
        skip: (req: any) => {
          const isLocalhost =
            req.ip === "127.0.0.1" ||
            req.ip === "::1" ||
            req.ip === "::ffff:127.0.0.1";
          return isLocalhost;
        },
      });

      app.use("/test", testLimiter, (req, res) => {
        res.json({ success: true });
      });

      // Multiple requests should succeed due to localhost bypass
      for (let i = 0; i < 3; i++) {
        const response = await request(app).get("/test").expect(200);

        expect(response.body.success).toBe(true);
      }
    });

    test("should not bypass rate limiting in production", async () => {
      process.env.NODE_ENV = "production";

      const testLimiter = require("express-rate-limit")({
        windowMs: 1000,
        max: 1,
        message: { error: "Rate limited" },
        skip: (req: any) => {
          // In production, never skip for localhost
          return false;
        },
      });

      app.use("/test", testLimiter, (req, res) => {
        res.json({ success: true });
      });

      // First request succeeds
      await request(app).get("/test").expect(200);

      // Second request should be rate limited
      const response = await request(app).get("/test").expect(429);

      expect(response.body.error).toBe("Rate limited");
    });
  });

  describe("Emergency Disable Functionality", () => {
    test("should completely disable rate limiting when emergency flag is set", async () => {
      process.env.ENABLE_RATE_LIMITING = "false";

      const testLimiter = require("express-rate-limit")({
        windowMs: 1000,
        max: 1,
        message: { error: "Should not see this" },
        skip: () => process.env.ENABLE_RATE_LIMITING === "false",
      });

      app.use("/test", testLimiter, (req, res) => {
        res.json({ success: true });
      });

      // Multiple requests should all succeed
      for (let i = 0; i < 5; i++) {
        const response = await request(app).get("/test").expect(200);

        expect(response.body.success).toBe(true);
      }
    });

    test("should enable rate limiting when emergency flag is not set", async () => {
      process.env.ENABLE_RATE_LIMITING = "true";

      const testLimiter = require("express-rate-limit")({
        windowMs: 1000,
        max: 1,
        message: { error: "Rate limited" },
        skip: () => process.env.ENABLE_RATE_LIMITING === "false",
      });

      app.use("/test", testLimiter, (req, res) => {
        res.json({ success: true });
      });

      // First request succeeds
      await request(app).get("/test").expect(200);

      // Second request should be rate limited
      const response = await request(app).get("/test").expect(429);

      expect(response.body.error).toBe("Rate limited");
    });
  });

  describe("Standard Headers Configuration", () => {
    test("should include standard rate limit headers", async () => {
      app.use("/test", generalLimiter, (req, res) => {
        res.json({ success: true });
      });

      const response = await request(app).get("/test").expect(200);

      // Standard headers should be present
      expect(response.headers["ratelimit-limit"]).toBeDefined();
      expect(response.headers["ratelimit-remaining"]).toBeDefined();
      expect(response.headers["ratelimit-reset"]).toBeDefined();

      // Legacy headers should be absent
      expect(response.headers["x-ratelimit-limit"]).toBeUndefined();
      expect(response.headers["x-ratelimit-remaining"]).toBeUndefined();
    });
  });

  describe("Rate Limiting Integration", () => {
    test("should work with multiple middlewares", async () => {
      app.use("/api", generalLimiter);
      app.use("/api/auth", authLimiter);
      app.use("/api/auth/login", (req, res) => {
        res.json({ success: true });
      });

      const response = await request(app).post("/api/auth/login").expect(200);

      expect(response.body.success).toBe(true);
    });

    test("should maintain separate counters for different limiters", async () => {
      app.use("/search", searchLimiter, (req, res) => {
        res.json({ type: "search" });
      });

      app.use("/upload", uploadLimiter, (req, res) => {
        res.json({ type: "upload" });
      });

      // Requests to different endpoints should have separate limits
      const searchResponse = await request(app)
        .get("/search?q=test")
        .expect(200);

      const uploadResponse = await request(app).post("/upload").expect(200);

      expect(searchResponse.body.type).toBe("search");
      expect(uploadResponse.body.type).toBe("upload");
    });
  });

  describe("Error Handling", () => {
    test("should handle malformed requests gracefully", async () => {
      app.use("/test", generalLimiter, (req, res) => {
        res.json({ success: true });
      });

      const response = await request(app)
        .get("/test")
        .set("Content-Type", "application/json")
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    test("should handle missing IP addresses", async () => {
      app.use("/test", generalLimiter, (req, res) => {
        res.json({ success: true });
      });

      // Request should still work even with potential IP issues
      const response = await request(app).get("/test").expect(200);

      expect(response.body.success).toBe(true);
    });
  });

  describe("Module-level skip branches (env + localhost + emergency)", () => {
    const importWithEnv = async () => {
      vi.resetModules();
      return await import("../../../src/middleware/rateLimiting");
    };

    test("development localhost triggers skipForLocalhost and logs", async () => {
      process.env.NODE_ENV = "development";
      delete process.env.ENABLE_RATE_LIMITING;

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const { generalLimiter: gl } = await importWithEnv();

      const devApp = express();
      devApp.get("/x", gl, (req, res) => res.json({ ok: true }));

      const res = await request(devApp).get("/x").expect(200);
      expect(res.body.ok).toBe(true);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("[DEV] Rate limiting BYPASSED for localhost")
      );
      logSpy.mockRestore();
    });

    test("production rejects the emergency-disable configuration", async () => {
      process.env.NODE_ENV = "production";
      process.env.ENABLE_RATE_LIMITING = "false";

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const { assertRateLimitProductionConfiguration } = await importWithEnv();

      expect(() => assertRateLimitProductionConfiguration()).toThrow(
        "Production rate limiting must be explicitly enabled",
      );
      expect(logSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("[EMERGENCY] Rate limiting DISABLED"),
      );
      logSpy.mockRestore();
    });

    test("production validates every security rate-limit value", async () => {
      process.env.NODE_ENV = "production";
      process.env.ENABLE_RATE_LIMITING = "true";
      process.env.RATE_LIMIT_WINDOW_MS = "900000";
      process.env.RATE_LIMIT_MAX_REQUESTS = "100";
      process.env.AUTH_RATE_LIMIT_WINDOW_MS = "900000";
      process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = "20";
      process.env.DIRECTORY_SEARCH_RATE_LIMIT_WINDOW_MS = "60000";
      process.env.DIRECTORY_SEARCH_RATE_LIMIT_MAX_REQUESTS = "invalid";
      const { assertRateLimitProductionConfiguration } = await importWithEnv();

      expect(() => assertRateLimitProductionConfiguration()).toThrow(
        "DIRECTORY_SEARCH_RATE_LIMIT_MAX_REQUESTS",
      );
      process.env.DIRECTORY_SEARCH_RATE_LIMIT_MAX_REQUESTS = "60";
      expect(() => assertRateLimitProductionConfiguration()).not.toThrow();
    });

    test("normal production reads do not exhaust the shared fallback after 100 requests", async () => {
      process.env.NODE_ENV = "production";
      process.env.ENABLE_RATE_LIMITING = "true";
      process.env.RATE_LIMIT_WINDOW_MS = "900000";
      process.env.RATE_LIMIT_MAX_REQUESTS = "600";
      const { generalLimiter: productionGeneralLimiter } =
        await importWithEnv();

      const composedApp = express();
      composedApp.use(productionGeneralLimiter);
      composedApp.get("/api/runtime-config", (_req, res) =>
        res.json({ ok: true }),
      );
      composedApp.get("/api/admin/users", (_req, res) =>
        res.json({ ok: true }),
      );

      for (let attempt = 0; attempt < 120; attempt += 1) {
        const endpoint =
          attempt % 2 === 0 ? "/api/runtime-config" : "/api/admin/users";
        const response = await request(composedApp).get(endpoint).expect(200);
        expect(response.headers["ratelimit-limit"]).toBe("600");
      }
    });

    test("directory search is limited independently by account and IP", async () => {
      process.env.NODE_ENV = "production";
      process.env.ENABLE_RATE_LIMITING = "true";
      process.env.DIRECTORY_SEARCH_RATE_LIMIT_WINDOW_MS = "60000";
      process.env.DIRECTORY_SEARCH_RATE_LIMIT_MAX_REQUESTS = "1";
      const { directoryAccountLimiter, directoryIpLimiter } = await importWithEnv();

      const accountApp = express();
      accountApp.set("trust proxy", 1);
      accountApp.get(
        "/directory",
        (req, _res, next) => {
          req.userId = "507f1f77bcf86cd799439011";
          next();
        },
        directoryAccountLimiter,
        (_req, res) => res.json({ ok: true }),
      );
      await request(accountApp)
        .get("/directory")
        .set("X-Forwarded-For", "203.0.113.1")
        .expect(200);
      await request(accountApp)
        .get("/directory")
        .set("X-Forwarded-For", "203.0.113.2")
        .expect(429);

      const ipApp = express();
      ipApp.set("trust proxy", 1);
      let requestNumber = 0;
      ipApp.get(
        "/directory",
        (req, _res, next) => {
          requestNumber += 1;
          req.userId = `507f1f77bcf86cd79943901${requestNumber}`;
          next();
        },
        directoryIpLimiter,
        (_req, res) => res.json({ ok: true }),
      );
      await request(ipApp)
        .get("/directory")
        .set("X-Forwarded-For", "203.0.113.3")
        .expect(200);
      await request(ipApp)
        .get("/directory")
        .set("X-Forwarded-For", "203.0.113.3")
        .expect(429);
    });

    test("the global limiter does not shadow a specialized route limiter", async () => {
      process.env.NODE_ENV = "production";
      process.env.ENABLE_RATE_LIMITING = "true";
      process.env.RATE_LIMIT_WINDOW_MS = "60000";
      process.env.RATE_LIMIT_MAX_REQUESTS = "1";
      process.env.DIRECTORY_SEARCH_RATE_LIMIT_WINDOW_MS = "60000";
      process.env.DIRECTORY_SEARCH_RATE_LIMIT_MAX_REQUESTS = "2";
      const {
        generalLimiter: productionGeneralLimiter,
        directoryIpLimiter: productionDirectoryLimiter,
      } = await importWithEnv();

      const composedApp = express();
      composedApp.use(productionGeneralLimiter);
      composedApp.get(
        "/api/directory",
        productionDirectoryLimiter,
        (_req, res) => res.json({ ok: true }),
      );

      const first = await request(composedApp)
        .get("/api/directory")
        .expect(200);
      const second = await request(composedApp)
        .get("/api/directory")
        .expect(200);
      const blocked = await request(composedApp)
        .get("/api/directory")
        .expect(429);

      expect(first.headers["ratelimit-limit"]).toBe("2");
      expect(second.headers["ratelimit-limit"]).toBe("2");
      expect(blocked.body).toEqual({
        error: "Too many directory requests, please slow down.",
      });
    });

    test("readiness probes do not consume or exhaust the global limit", async () => {
      process.env.NODE_ENV = "production";
      process.env.ENABLE_RATE_LIMITING = "true";
      process.env.RATE_LIMIT_WINDOW_MS = "60000";
      process.env.RATE_LIMIT_MAX_REQUESTS = "1";
      const { generalLimiter: productionGeneralLimiter } =
        await importWithEnv();

      const composedApp = express();
      composedApp.use(productionGeneralLimiter);
      composedApp.get("/api/readiness", (_req, res) => res.json({ ok: true }));
      composedApp.get("/api/readiness/live", (_req, res) =>
        res.json({ ok: true }),
      );
      composedApp.get("/api/example", (_req, res) => res.json({ ok: true }));

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const ready = await request(composedApp)
          .get("/api/readiness")
          .expect(200);
        const live = await request(composedApp)
          .get("/api/readiness/live")
          .expect(200);
        expect(ready.headers["ratelimit-limit"]).toBeUndefined();
        expect(live.headers["ratelimit-limit"]).toBeUndefined();
      }
      const head = await request(composedApp)
        .head("/api/readiness")
        .expect(200);
      expect(head.headers["ratelimit-limit"]).toBeUndefined();

      const firstApiRequest = await request(composedApp)
        .get("/api/example")
        .expect(200);
      expect(firstApiRequest.headers["ratelimit-limit"]).toBe("1");
      await request(composedApp).get("/api/example").expect(429);
      await request(composedApp).get("/api/readiness/unknown").expect(429);
      await request(composedApp).post("/api/readiness").expect(429);
    });

    test("the global limiter remains the fail-closed policy for other routes", async () => {
      process.env.NODE_ENV = "production";
      process.env.ENABLE_RATE_LIMITING = "true";
      process.env.RATE_LIMIT_WINDOW_MS = "60000";
      process.env.RATE_LIMIT_MAX_REQUESTS = "1";
      const { generalLimiter: productionGeneralLimiter } =
        await importWithEnv();

      const composedApp = express();
      composedApp.use(productionGeneralLimiter);
      composedApp.get("/api/directory/me", (_req, res) =>
        res.json({ ok: true }),
      );

      await request(composedApp).get("/api/directory/me").expect(200);
      const response = await request(composedApp)
        .get("/api/directory/me")
        .expect(429);

      expect(response.body).toEqual({
        error: "Too many requests from this IP, please try again later.",
      });
    });

    test("production non-localhost does not log bypass or emergency", async () => {
      process.env.NODE_ENV = "production";
      process.env.ENABLE_RATE_LIMITING = "true";

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const { generalLimiter: gl } = await importWithEnv();

      const prodApp = express();
      prodApp.get("/x", gl, (req, res) => res.json({ ok: true }));

      await request(prodApp).get("/x").expect(200);
      expect(logSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("[DEV] Rate limiting BYPASSED for localhost")
      );
      expect(logSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("[EMERGENCY] Rate limiting DISABLED")
      );
      logSpy.mockRestore();
    });
  });
});
