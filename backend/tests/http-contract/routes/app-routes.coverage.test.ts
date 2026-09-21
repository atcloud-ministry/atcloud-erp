/**
 * app-routes.coverage.test.ts
 * Tests to improve branch coverage in app.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import app from "../../../src/app";

// Mock ShortLinkService for the /s/:key endpoint
vi.mock("../../../src/services/ShortLinkService", () => ({
  default: {
    resolveKey: vi.fn(),
  },
}));

// Mock ShortLinkMetricsService
vi.mock("../../../src/services/ShortLinkMetricsService", () => ({
  ShortLinkMetricsService: {
    increment: vi.fn(),
    getAll: vi.fn().mockReturnValue({
      redirect_active: 0,
      redirect_expired: 0,
      redirect_not_found: 0,
    }),
  },
}));

// Mock PrometheusMetricsService
vi.mock("../../../src/services/PrometheusMetricsService", () => ({
  shortLinkRedirectCounter: { inc: vi.fn() },
  getMetrics: vi.fn().mockResolvedValue("# HELP test_metric\ntest_metric 1\n"),
  isPromEnabled: vi.fn(),
}));

import ShortLinkService from "../../../src/services/ShortLinkService";
import {
  isPromEnabled,
  getMetrics,
} from "../../../src/services/PrometheusMetricsService";
import { ShortLinkMetricsService } from "../../../src/services/ShortLinkMetricsService";

describe("app.ts branch coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Root endpoint", () => {
    it("GET / returns service info", async () => {
      const res = await request(app).get("/");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: "ok",
        service: "atcloud-backend",
      });
      expect(res.body.timestamp).toBeDefined();
    });
  });

  describe("Short link redirect /s/:key", () => {
    it("redirects to frontend for active short link", async () => {
      vi.mocked(ShortLinkService.resolveKey).mockResolvedValue({
        status: "active",
        slug: "test-event-slug",
        eventId: "event123",
      });

      const res = await request(app).get("/s/abc123");
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain("/#/p/test-event-slug");
      expect(ShortLinkMetricsService.increment).toHaveBeenCalledWith(
        "redirect_active",
      );
    });

    it("returns 404 for previously-expired short link (no expiration check)", async () => {
      vi.mocked(ShortLinkService.resolveKey).mockResolvedValue({
        status: "not_found",
      });

      const res = await request(app).get("/s/expired123");
      expect(res.status).toBe(404);
      expect(res.text).toBe("Short link not found");
      expect(ShortLinkMetricsService.increment).toHaveBeenCalledWith(
        "redirect_not_found",
      );
    });

    it("returns 404 for not found short link", async () => {
      vi.mocked(ShortLinkService.resolveKey).mockResolvedValue({
        status: "not_found",
      });

      const res = await request(app).get("/s/notfound");
      expect(res.status).toBe(404);
      expect(res.text).toBe("Short link not found");
      expect(ShortLinkMetricsService.increment).toHaveBeenCalledWith(
        "redirect_not_found",
      );
    });

    it("returns 500 on service error", async () => {
      vi.mocked(ShortLinkService.resolveKey).mockRejectedValue(
        new Error("DB error"),
      );

      const res = await request(app).get("/s/broken");
      expect(res.status).toBe(500);
      expect(res.text).toBe("Failed to resolve short link");
    });
  });

  describe("Metrics endpoint /metrics", () => {
    it("returns Prometheus text format when enabled", async () => {
      vi.mocked(isPromEnabled).mockReturnValue(true);
      vi.mocked(getMetrics).mockResolvedValue("# HELP test\ntest_counter 42\n");

      const res = await request(app).get("/metrics");
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["content-type"]).toContain("text/plain");
      expect(res.text).toContain("test_counter");
    });

    it("returns JSON when format=json query param is set", async () => {
      vi.mocked(isPromEnabled).mockReturnValue(true);

      const res = await request(app).get("/metrics?format=json");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        prometheus: { format: "json" },
      });
    });

    it("returns fallback JSON when Prometheus is disabled", async () => {
      vi.mocked(isPromEnabled).mockReturnValue(false);

      const res = await request(app).get("/metrics");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        prometheus: {
          enabled: false,
          format: "fallback-json",
        },
      });
    });

    it("falls back to JSON if Prometheus collection fails", async () => {
      vi.mocked(isPromEnabled).mockReturnValue(true);
      vi.mocked(getMetrics).mockRejectedValue(new Error("Collection failed"));

      const res = await request(app).get("/metrics");
      expect(res.status).toBe(200);
      // Should fall through to JSON fallback
      expect(res.body).toHaveProperty("success", true);
    });
  });

  describe("Short links legacy metrics /metrics/short-links", () => {
    it("returns short link metrics in JSON", async () => {
      const res = await request(app).get("/metrics/short-links");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        metrics: expect.any(Object),
      });
    });
  });

  describe("Uploads CORS middleware", () => {
    it("handles OPTIONS preflight request", async () => {
      const res = await request(app)
        .options("/uploads/test.png")
        .set("Origin", "http://localhost:5173");
      // OPTIONS returns 200 from our handler or 204 from CORS
      expect([200, 204]).toContain(res.status);
    });

    it("sets CORS headers for allowed origin", async () => {
      const res = await request(app)
        .get("/uploads/test.png")
        .set("Origin", "http://localhost:5173");
      // The file may not exist, but headers should be set
      expect(res.headers["access-control-allow-origin"]).toBe(
        "http://localhost:5173",
      );
      expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    });

    it("does not set CORS origin for disallowed origin", async () => {
      const res = await request(app)
        .get("/uploads/test.png")
        .set("Origin", "http://malicious-site.com");
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    });
  });
});
