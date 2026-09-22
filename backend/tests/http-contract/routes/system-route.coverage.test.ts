import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const authMocks = vi.hoisted(() => ({ permissionCheck: vi.fn() }));

// Mock auth middlewares to no-op
vi.mock("../../../src/middleware/auth", () => ({
  authenticate: (req: any, res: any, next: any) => next(),
  requireAdmin: (req: any, res: any, next: any) => next(),
  authorizePermission:
    (permission: string) => (req: any, res: any, next: any) => {
      authMocks.permissionCheck(permission);
      next();
    },
}));

// Mock services.lockService
const mockGetLockStats = vi.fn();
vi.mock("../../../src/services/LockService", () => ({
  lockService: { getLockStats: (...args: any[]) => mockGetLockStats(...args) },
}));

// Mock RequestMonitorService
const mockGetStats = vi.fn();
vi.mock("../../../src/middleware/RequestMonitorService", () => ({
  default: {
    getInstance: () => ({ getStats: mockGetStats }),
  },
}));

// Mock EventReminderScheduler
const mockGetStatus = vi.fn();
const mockTriggerManualCheck = vi.fn();
vi.mock("../../../src/services/EventReminderScheduler", () => ({
  default: {
    getInstance: () => ({
      getStatus: mockGetStatus,
      triggerManualCheck: mockTriggerManualCheck,
    }),
  },
}));

// Import router after mocks
import systemRouter from "../../../src/routes/system";

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use("/", systemRouter);
  return app;
};

describe("system routes coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /health", () => {
    it("should return health status", async () => {
      const res = await request(makeApp()).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
      expect(res.body).toHaveProperty("timestamp");
      expect(res.body).toHaveProperty("uptime");
    });
  });

  describe("GET /metrics", () => {
    it("should return metrics on success", async () => {
      mockGetStats.mockReturnValueOnce({
        requestsPerSecond: 5,
        totalRequestsLastMinute: 50,
        totalRequestsLastHour: 500,
        globalUniqueIPsLastHour: 10,
        globalUniqueUserAgentsLastHour: 8,
        errorsLastHour: 2,
        errorRateLastHour: 0.4,
        endpointMetrics: [
          {
            endpoint: "/api/test",
            count: 100,
            averageResponseTime: 50,
            errorCount: 1,
          },
        ],
        suspiciousPatterns: [],
      });

      const res = await request(makeApp()).get("/metrics");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
      expect(res.body).toHaveProperty("requests");
      expect(res.body).toHaveProperty("endpointsTop5");
    });

    it("should return 500 on metrics error", async () => {
      mockGetStats.mockImplementationOnce(() => {
        throw new Error("metrics boom");
      });

      const res = await request(makeApp()).get("/metrics");
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ success: false });
    });
  });

  describe("GET /scheduler", () => {
    it("should return scheduler status", async () => {
      mockGetStatus.mockReturnValueOnce({
        isRunning: true,
        uptime: 1000,
        runs: 5,
      });

      const res = await request(makeApp()).get("/scheduler");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
      expect(res.body).toHaveProperty("status");
    });

    it("should return fallback status on scheduler error", async () => {
      mockGetStatus.mockImplementationOnce(() => {
        throw new Error("scheduler boom");
      });

      const res = await request(makeApp()).get("/scheduler");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
      expect(res.body.status).toEqual({ isRunning: false });
    });
  });

  describe("POST /scheduler/manual-trigger", () => {
    it("should trigger manual scheduler check", async () => {
      mockTriggerManualCheck.mockResolvedValueOnce(undefined);

      const res = await request(makeApp()).post("/scheduler/manual-trigger");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
      expect(mockTriggerManualCheck).toHaveBeenCalled();
      expect(authMocks.permissionCheck).toHaveBeenCalledWith(
        "manage_notifications",
      );
    });

    it("should return 500 on trigger error", async () => {
      mockTriggerManualCheck.mockRejectedValueOnce(new Error("trigger boom"));

      const res = await request(makeApp()).post("/scheduler/manual-trigger");
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ success: false });
    });
  });

  describe("GET /locks", () => {
    it("GET /locks success with performance and recommendations branches", async () => {
      mockGetLockStats.mockReturnValueOnce({
        totalLocks: 10,
        activeLocks: 7,
        averageWaitTime: 150.1234, // > 100 to trigger recommendations branch
      });

      const res = await request(makeApp()).get("/locks");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
      expect(res.body.data).toHaveProperty("performance");
      expect(res.body.data.performance.efficiency).toBe("high_contention");
      expect(Array.isArray(res.body.data.recommendations)).toBe(true);
    });

    it("GET /locks handles service error with 500", async () => {
      mockGetLockStats.mockImplementationOnce(() => {
        throw new Error("svc down");
      });

      const res = await request(makeApp()).get("/locks");
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ success: false });
    });

    it("GET /locks efficiency is good when activeLocks <= 5", async () => {
      mockGetLockStats.mockReturnValueOnce({
        totalLocks: 3,
        activeLocks: 5,
        averageWaitTime: 120, // > 100 still gives recommendations
      });
      const res = await request(makeApp()).get("/locks");
      expect(res.status).toBe(200);
      expect(res.body.data.performance.efficiency).toBe("good");
    });

    it("GET /locks efficiency is optimal when activeLocks = 0 and low wait triggers optimal-recommendation path", async () => {
      mockGetLockStats.mockReturnValueOnce({
        totalLocks: 0,
        activeLocks: 0,
        averageWaitTime: 50, // <= 100, alternate recommendations branch
      });
      const res = await request(makeApp()).get("/locks");
      expect(res.status).toBe(200);
      expect(res.body.data.performance.efficiency).toBe("optimal");
      expect(res.body.data.recommendations).toEqual([
        "System performing optimally",
      ]);
    });
  });
});
