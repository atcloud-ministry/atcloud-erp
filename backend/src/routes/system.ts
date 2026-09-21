/**
 * System Health and Monitoring Routes
 *
 * Provides endpoints for monitoring system health, including
 * thread safety statistics and performance metrics.
 */

import { Router, Request, Response } from "express";
import { lockService } from "../services/LockService";
import RequestMonitorService from "../middleware/RequestMonitorService";
import EventReminderScheduler from "../services/EventReminderScheduler";
import {
  authenticate,
  authorizePermission,
  requireAdmin,
} from "../middleware/auth";
import { Logger } from "../services/LoggerService";
import { CorrelatedLogger } from "../services/CorrelatedLogger";
import { PERMISSIONS } from "../utils/roleUtils";
import { isSchedulerEnabled } from "../config/scheduler";

const router = Router();

/**
 * GET /api/system/health
 * Basic system health check
 */
router.get("/health", (_req: Request, res: Response) => {
  const impl =
    (lockService &&
      (lockService as { constructor: { name?: string } }).constructor?.name) ||
    "Unknown";
  const usingInMemory = impl === "InMemoryLockService";
  const webConcurrency = parseInt(process.env.WEB_CONCURRENCY || "1", 10);
  const pm2Cluster = process.env.PM2_CLUSTER_MODE === "true";
  const nodeAppInstance = process.env.NODE_APP_INSTANCE;
  const inferredConcurrency = Math.max(
    1,
    isNaN(webConcurrency) ? 1 : webConcurrency,
    pm2Cluster ? 2 : 1,
    nodeAppInstance ? 2 : 1
  );

  res.status(200).json({
    success: true,
    message: "System is healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    lock: {
      implementation: impl,
      singleInstanceRequired: usingInMemory,
      inferredConcurrency,
      enforce: process.env.SINGLE_INSTANCE_ENFORCE === "true",
    },
  });
});

/**
 * GET /api/system/metrics
 * Public, PII-safe operational metrics snapshot
 */
router.get("/metrics", (_req: Request, res: Response) => {
  try {
    const monitor = RequestMonitorService.getInstance();
    const stats = monitor.getStats();

    // Build a minimal, PII-safe summary
    const endpointsTop5 = stats.endpointMetrics.slice(0, 5).map((e) => ({
      endpoint: e.endpoint,
      count: e.count,
      averageResponseTime: e.averageResponseTime,
      errorCount: e.errorCount,
    }));

    res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      requests: {
        perSecond: stats.requestsPerSecond,
        lastMinute: stats.totalRequestsLastMinute,
        lastHour: stats.totalRequestsLastHour,
      },
      uniques: {
        ipsLastHour: stats.globalUniqueIPsLastHour,
        userAgentsLastHour: stats.globalUniqueUserAgentsLastHour,
      },
      errors: {
        lastHour: stats.errorsLastHour,
        rateLastHour: stats.errorRateLastHour,
      },
      endpointsTop5,
      suspiciousPatterns: stats.suspiciousPatterns.length,
    });
  } catch (err) {
    const log = Logger.getInstance().child("SystemRoutes");
    // Preserve existing structured log and add correlated entry for richer context
    log.error("Error building system metrics", err as Error, "System");
    try {
      const clog = CorrelatedLogger.fromRequest(_req, "SystemRoutes");
      clog.error("Error building system metrics", err as Error, "System");
    } catch {}
    res.status(500).json({ success: false, message: "Failed to get metrics" });
  }
});

/**
 * GET /api/system/locks
 * Thread safety lock statistics (Admin only)
 */
router.get(
  "/locks",
  authenticate,
  requireAdmin,
  (_req: Request, res: Response) => {
    try {
      const stats = lockService.getLockStats();

      res.status(200).json({
        success: true,
        message: "Lock statistics retrieved successfully",
        data: {
          lockStats: stats,
          performance: {
            averageWaitTimeMs: Math.round(stats.averageWaitTime * 100) / 100,
            efficiency:
              stats.activeLocks === 0
                ? "optimal"
                : stats.activeLocks <= 5
                ? "good"
                : "high_contention",
          },
          recommendations:
            stats.averageWaitTime > 100
              ? [
                  "Consider optimizing operation duration",
                  "Monitor for potential deadlocks",
                ]
              : ["System performing optimally"],
        },
      });
    } catch (err: unknown) {
      const log = Logger.getInstance().child("SystemRoutes");
      log.error("Error getting lock stats", err as Error, "System");
      try {
        const clog = CorrelatedLogger.fromRequest(_req, "SystemRoutes");
        clog.error("Error getting lock stats", err as Error, "System");
      } catch {}
      res.status(500).json({
        success: false,
        message: "Failed to retrieve lock statistics",
      });
    }
  }
);

export default router;

// Scheduler health (non-admin; informational)
router.get("/scheduler", (_req: Request, res: Response) => {
  try {
    const scheduler = EventReminderScheduler.getInstance();
    const status = scheduler.getStatus() as unknown as {
      isRunning: boolean;
      uptime?: number;
      lastRunAt?: number;
      lastProcessedCount?: number;
      runs?: number;
      lastErrorAt?: number;
    };
    const schedulerEnabled = isSchedulerEnabled();

    res.status(200).json({
      success: true,
      schedulerEnabled,
      status,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    try {
      const clog = CorrelatedLogger.fromRequest(_req, "SystemRoutes");
      clog.error("Error getting scheduler status", err as Error, "System");
    } catch {}
    const schedulerEnabled = isSchedulerEnabled();
    res.status(200).json({
      success: true,
      schedulerEnabled,
      status: { isRunning: false },
    });
  }
});

// Manual trigger for scheduler
router.post(
  "/scheduler/manual-trigger",
  authenticate,
  authorizePermission(PERMISSIONS.MANAGE_NOTIFICATIONS),
  async (_req: Request, res: Response) => {
    try {
      const scheduler = EventReminderScheduler.getInstance();
      await scheduler.triggerManualCheck(_req.userId);
      res.status(200).json({
        success: true,
        message: "Manual scheduler check executed",
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      const log = Logger.getInstance().child("SystemRoutes");
      log.error("Failed manual scheduler trigger", err as Error, "System");
      try {
        const clog = CorrelatedLogger.fromRequest(_req, "SystemRoutes");
        clog.error("Failed manual scheduler trigger", err as Error, "System");
      } catch {}
      res
        .status(500)
        .json({ success: false, message: "Manual trigger failed" });
    }
  }
);
