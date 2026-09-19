import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

const logRequest = vi.fn();
const monitorLog = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
};

vi.mock("../../../src/services/CorrelatedLogger", () => ({
  CorrelatedLogger: {
    fromRequest: vi.fn(() => ({ logRequest })),
  },
}));
vi.mock("../../../src/services/LoggerService", () => ({
  Logger: {
    getInstance: vi.fn(() => ({ child: vi.fn(() => monitorLog) })),
  },
}));

import RequestMonitorService from "../../../src/middleware/RequestMonitorService";

describe("RequestMonitorService", () => {
  const service = RequestMonitorService.getInstance();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
    (service as any).requestStats = [];
    (service as any).requestBuckets = new Map();
    (service as any).endpointMetrics = new Map();
    (service as any).alertThresholds = {
      requestsPerMinute: 1000,
      requestsPerSecond: 50,
      duplicateRequestsFromSameIP: 100,
      suspiciousUserAgent: 20,
    };
    delete process.env.ENABLE_RATE_LIMITING;
    process.env.NODE_ENV = "test";
  });

  function completeRequest(options: {
    path?: string;
    method?: string;
    status?: number;
    ip?: string;
    userAgent?: string;
  } = {}) {
    const req = {
      method: options.method || "GET",
      path: options.path || "/api/test",
      headers: options.ip ? { "x-forwarded-for": options.ip } : {},
      socket: { remoteAddress: "127.0.0.1" },
      connection: { remoteAddress: "127.0.0.1" },
      get: vi.fn((header: string) =>
        header === "User-Agent" ? options.userAgent || "Test Agent" : undefined,
      ),
    } as unknown as Request;
    const res = {
      statusCode: options.status || 200,
      end: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    service.middleware()(req, res, next);
    (res.end as unknown as () => void)();
    return { next };
  }

  it("is a singleton and records one structured completion log", () => {
    expect(RequestMonitorService.getInstance()).toBe(service);

    const { next } = completeRequest();

    expect(next).toHaveBeenCalledOnce();
    expect(logRequest).toHaveBeenCalledOnce();
    expect(service.getStats().totalRequestsLastHour).toBe(1);
  });

  it("counts request errors but excludes expected auth failures", () => {
    completeRequest({ path: "/api/fail", status: 500 });
    completeRequest({ path: "/api/auth/login", status: 401 });
    completeRequest({ path: "/api/auth/register", status: 400 });

    const stats = service.getStats();
    expect(stats.errorsLastHour).toBe(2);
    expect(stats.errorRateLastHour).toBeCloseTo(2 / 3);
  });

  it("normalizes resource IDs and public slugs to bounded endpoint keys", () => {
    completeRequest({ path: "/api/programs/507f1f77bcf86cd799439011" });
    completeRequest({ path: "/api/programs/507f1f77bcf86cd799439012" });
    completeRequest({ path: "/api/public/events/summer-retreat" });
    completeRequest({ path: "/api/public/events/winter-retreat" });

    const endpoints = service
      .getStats()
      .endpointMetrics.map((metric) => [metric.endpoint, metric.count]);
    expect(endpoints).toContainEqual(["GET /api/programs/:id", 2]);
    expect(endpoints).toContainEqual(["GET /api/public/events/:slug", 2]);
  });

  it("caps retained raw requests while minute buckets preserve totals", () => {
    for (let index = 0; index < 5_100; index += 1) completeRequest();

    const stats = service.getStats();
    expect((service as any).requestStats.length).toBeLessThanOrEqual(
      stats.limits.recentRequests,
    );
    expect(stats.totalRequestsLastHour).toBe(5_100);
  });

  it("caps endpoint cardinality and aggregates overflow", () => {
    for (let index = 0; index < 300; index += 1) {
      completeRequest({ path: `/api/custom/path-${index}` });
    }

    const stats = service.getStats();
    expect(stats.endpointMetrics.length).toBeLessThanOrEqual(
      stats.limits.endpoints,
    );
    expect(
      stats.endpointMetrics.some((entry) =>
        entry.endpoint.endsWith("/:other"),
      ),
    ).toBe(true);
  });

  it("caps unique IP and user-agent dimensions", () => {
    for (let index = 0; index < 150; index += 1) {
      completeRequest({
        ip: `192.0.2.${index}`,
        userAgent: `Agent ${index}`,
      });
    }

    const [metric] = service.getStats().endpointMetrics;
    expect(metric.uniqueIPs).toBe(100);
    expect(metric.uniqueUserAgents).toBe(100);
  });

  it("uses only the first forwarded IP and truncates user agents", () => {
    completeRequest({
      ip: "203.0.113.1, 10.0.0.1",
      userAgent: "x".repeat(300),
    });

    const request = (service as any).requestStats[0];
    expect(request.ip).toBe("203.0.113.1");
    expect(request.userAgent).toHaveLength(160);
  });

  it("removes expired raw stats and minute buckets", () => {
    completeRequest();
    vi.advanceTimersByTime(61 * 60 * 1000);

    (service as any).cleanupOldStats();

    expect((service as any).requestStats).toEqual([]);
    expect(service.getStats().totalRequestsLastHour).toBe(0);
  });

  it("reports polling patterns from the retained bounded window", () => {
    for (let index = 0; index < 101; index += 1) completeRequest();

    expect(service.getStats().suspiciousPatterns).toEqual([
      expect.objectContaining({ type: "POTENTIAL_POLLING_LOOP" }),
    ]);
  });

  it("emits alerts through structured logging without filesystem writes", () => {
    (service as any).alertThresholds.requestsPerMinute = 1;
    completeRequest();
    completeRequest();

    (service as any).checkForAlerts();

    expect(monitorLog.warn).toHaveBeenCalledWith(
      "Request monitor alert",
      "Ops",
      expect.objectContaining({ type: "HIGH_REQUEST_RATE" }),
    );
  });

  it("toggles emergency rate limiting state", () => {
    service.emergencyDisableRateLimit();
    expect(service.getRateLimitingStatus()).toEqual({
      enabled: false,
      status: "emergency_disabled",
    });

    service.emergencyEnableRateLimit();
    expect(service.getRateLimitingStatus()).toEqual({
      enabled: true,
      status: "enabled",
    });
  });

  it("cannot disable rate limiting at runtime in production", () => {
    process.env.NODE_ENV = "production";
    process.env.ENABLE_RATE_LIMITING = "true";

    expect(() => service.emergencyDisableRateLimit()).toThrow(
      "Production rate limiting cannot be disabled",
    );
    expect(service.getRateLimitingStatus()).toEqual({
      enabled: true,
      status: "enabled",
    });
  });
});
