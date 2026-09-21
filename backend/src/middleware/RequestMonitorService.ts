import { Request, Response, NextFunction } from "express";
import { CorrelatedLogger } from "../services/CorrelatedLogger";
import { Logger } from "../services/LoggerService";

interface RequestStats {
  endpoint: string;
  method: string;
  userAgent: string;
  ip: string;
  userId?: string;
  timestamp: number;
  responseTime?: number;
  statusCode?: number;
}

interface EndpointMetrics {
  count: number;
  totalResponseTime: number;
  averageResponseTime: number;
  errorCount: number;
  lastAccessed: number;
  uniqueIPs: Set<string>;
  userAgents: Set<string>;
}

interface MinuteBucket {
  count: number;
  errorCount: number;
  uniqueIPs: Set<string>;
  userAgents: Set<string>;
}

const MAX_RECENT_REQUESTS = 5_000;
const MAX_ENDPOINTS = 250;
const MAX_UNIQUE_VALUES = 100;
const MAX_USER_AGENT_LENGTH = 160;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

class RequestMonitorService {
  private static instance: RequestMonitorService;
  private requestStats: RequestStats[] = [];
  private requestBuckets = new Map<number, MinuteBucket>();
  private endpointMetrics = new Map<string, EndpointMetrics>();
  private cleanupInterval?: NodeJS.Timeout;
  private alertInterval?: NodeJS.Timeout;
  private log = Logger.getInstance().child("RequestMonitor");
  private alertThresholds = {
    requestsPerMinute: 1000,
    requestsPerSecond: 50,
    duplicateRequestsFromSameIP: 100,
    suspiciousUserAgent: 20,
  };

  private constructor() {
    if (process.env.NODE_ENV === "test") return;

    this.cleanupInterval = setInterval(
      () => this.cleanupOldStats(),
      5 * MINUTE_MS,
    );
    this.alertInterval = setInterval(() => this.checkForAlerts(), MINUTE_MS);
    this.cleanupInterval.unref();
    this.alertInterval.unref();
  }

  public static getInstance(): RequestMonitorService {
    if (!RequestMonitorService.instance) {
      RequestMonitorService.instance = new RequestMonitorService();
    }
    return RequestMonitorService.instance;
  }

  public middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const startTime = Date.now();
      const endpointPath = this.normalizePath(req.path);
      const requestStat: RequestStats = {
        endpoint: `${req.method} ${endpointPath}`,
        method: req.method,
        userAgent: (req.get("User-Agent") || "Unknown").slice(
          0,
          MAX_USER_AGENT_LENGTH,
        ),
        ip: this.getClientIP(req),
        userId: (req as unknown as { user?: { id?: string } }).user?.id,
        timestamp: startTime,
      };

      this.recordRequest(requestStat);
      const correlatedLog = CorrelatedLogger.fromRequest(req, "RequestMonitor");
      let finalized = false;
      const finalize = () => {
        if (finalized) return;
        finalized = true;
        requestStat.responseTime = Date.now() - startTime;
        requestStat.statusCode = res.statusCode;
        this.updateEndpointMetrics(requestStat);

        try {
          correlatedLog.logRequest(
            req.method,
            endpointPath,
            res.statusCode,
            requestStat.responseTime,
            { userId: requestStat.userId },
          );
        } catch {
          // Monitoring must never interfere with a response.
        }
      };

      const responseWithEvents = res as unknown as {
        once?: (event: string, listener: () => void) => void;
        on?: (event: string, listener: () => void) => void;
        end?: (...args: unknown[]) => unknown;
      };
      if (typeof responseWithEvents.once === "function") {
        responseWithEvents.once("finish", finalize);
      } else if (typeof responseWithEvents.on === "function") {
        responseWithEvents.on("finish", finalize);
      } else if (typeof responseWithEvents.end === "function") {
        const originalEnd = responseWithEvents.end.bind(res);
        responseWithEvents.end = (...args: unknown[]) => {
          finalize();
          return originalEnd(...args);
        };
      } else {
        setImmediate(finalize);
      }

      next();
    };
  }

  private normalizePath(rawPath: string): string {
    let normalized = (rawPath || "/").split("?", 1)[0];
    normalized = normalized.replace(/\/api\/v1\b/, "/api");
    normalized = normalized.replace(/\/api\/api\b/, "/api");
    normalized = normalized.replace(/\/{2,}/g, "/");
    normalized = normalized.replace(
      /\/[0-9a-f]{24}(?=\/|$)/gi,
      "/:id",
    );
    normalized = normalized.replace(
      /\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi,
      "/:id",
    );
    normalized = normalized.replace(/\/\d+(?=\/|$)/g, "/:id");
    normalized = normalized.replace(
      /^(\/api\/public\/events)\/[^/]+/,
      "$1/:slug",
    );
    normalized = normalized.replace(/^\/s\/[^/]+/, "/s/:key");
    normalized = normalized.replace(
      /(\/manage|\/decline|\/verify|\/reset-password)\/[^/]+/,
      "$1/:token",
    );
    return normalized;
  }

  private getClientIP(req: Request): string {
    const forwarded = req.headers["x-forwarded-for"];
    const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return (
      forwardedValue?.split(",", 1)[0].trim() ||
      (req.headers["x-real-ip"] as string | undefined) ||
      req.socket?.remoteAddress ||
      req.connection?.remoteAddress ||
      "unknown"
    );
  }

  private recordRequest(requestStat: RequestStats): void {
    if (this.requestStats.length >= MAX_RECENT_REQUESTS) {
      this.requestStats.splice(0, Math.min(250, this.requestStats.length));
    }
    this.requestStats.push(requestStat);

    const minute = Math.floor(requestStat.timestamp / MINUTE_MS);
    let bucket = this.requestBuckets.get(minute);
    if (!bucket) {
      bucket = {
        count: 0,
        errorCount: 0,
        uniqueIPs: new Set(),
        userAgents: new Set(),
      };
      this.requestBuckets.set(minute, bucket);
    }
    bucket.count += 1;
    this.addBounded(bucket.uniqueIPs, requestStat.ip);
    this.addBounded(bucket.userAgents, requestStat.userAgent);
    this.cleanupBuckets(minute);
  }

  private addBounded(target: Set<string>, value: string): void {
    if (target.has(value) || target.size < MAX_UNIQUE_VALUES) {
      target.add(value);
    }
  }

  private isCountedError(requestStat: RequestStats): boolean {
    if (!requestStat.statusCode || requestStat.statusCode < 400) return false;
    const isAuthEndpoint = requestStat.endpoint.includes("/auth/");
    const isExpectedAuthFailure =
      requestStat.statusCode === 401 || requestStat.statusCode === 403;
    return !(isAuthEndpoint && isExpectedAuthFailure);
  }

  private updateEndpointMetrics(requestStat: RequestStats): void {
    let key = requestStat.endpoint;
    if (!this.endpointMetrics.has(key) && this.endpointMetrics.size >= MAX_ENDPOINTS) {
      key = `${requestStat.method} /:other`;
      if (!this.endpointMetrics.has(key)) {
        const oldestKey = [...this.endpointMetrics.entries()].reduce(
          (oldest, entry) =>
            !oldest || entry[1].lastAccessed < oldest[1].lastAccessed
              ? entry
              : oldest,
          undefined as [string, EndpointMetrics] | undefined,
        )?.[0];
        if (oldestKey) this.endpointMetrics.delete(oldestKey);
      }
    }

    let metrics = this.endpointMetrics.get(key);
    if (!metrics) {
      metrics = {
        count: 0,
        totalResponseTime: 0,
        averageResponseTime: 0,
        errorCount: 0,
        lastAccessed: 0,
        uniqueIPs: new Set(),
        userAgents: new Set(),
      };
      this.endpointMetrics.set(key, metrics);
    }

    metrics.count += 1;
    metrics.lastAccessed = requestStat.timestamp;
    this.addBounded(metrics.uniqueIPs, requestStat.ip);
    this.addBounded(metrics.userAgents, requestStat.userAgent);
    if (requestStat.responseTime !== undefined) {
      metrics.totalResponseTime += requestStat.responseTime;
      metrics.averageResponseTime = metrics.totalResponseTime / metrics.count;
    }

    if (this.isCountedError(requestStat)) {
      metrics.errorCount += 1;
      const bucket = this.requestBuckets.get(
        Math.floor(requestStat.timestamp / MINUTE_MS),
      );
      if (bucket) bucket.errorCount += 1;
    }
  }

  private cleanupBuckets(currentMinute: number): void {
    for (const minute of this.requestBuckets.keys()) {
      if (minute < currentMinute - 60) this.requestBuckets.delete(minute);
    }
  }

  private cleanupOldStats(): void {
    const oneHourAgo = Date.now() - HOUR_MS;
    this.requestStats = this.requestStats.filter(
      (stat) => stat.timestamp > oneHourAgo,
    );
    this.cleanupBuckets(Math.floor(Date.now() / MINUTE_MS));
  }

  private checkForAlerts(): void {
    const now = Date.now();
    const recentRequests = this.requestStats.filter(
      (stat) => stat.timestamp > now - MINUTE_MS,
    );
    const veryRecentRequests = this.requestStats.filter(
      (stat) => stat.timestamp > now - 1000,
    );

    if (recentRequests.length > this.alertThresholds.requestsPerMinute) {
      this.logAlert(
        "HIGH_REQUEST_RATE",
        `${recentRequests.length} requests in the last minute`,
      );
    }
    if (veryRecentRequests.length > this.alertThresholds.requestsPerSecond) {
      this.logAlert(
        "VERY_HIGH_REQUEST_RATE",
        `${veryRecentRequests.length} requests in the last second`,
      );
    }

    this.alertOnDimension(
      recentRequests,
      (request) => request.ip,
      this.alertThresholds.duplicateRequestsFromSameIP,
      "SUSPICIOUS_IP_ACTIVITY",
    );
    this.alertOnDimension(
      recentRequests,
      (request) => request.userAgent,
      this.alertThresholds.suspiciousUserAgent,
      "SUSPICIOUS_USER_AGENT",
    );
  }

  private alertOnDimension(
    requests: RequestStats[],
    getKey: (request: RequestStats) => string,
    threshold: number,
    type: string,
  ): void {
    const counts = new Map<string, number>();
    for (const request of requests) {
      const key = getKey(request);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const [key, count] of counts) {
      if (count > threshold) {
        this.logAlert(type, `${key.slice(0, 100)}: ${count} requests`);
      }
    }
  }

  private logAlert(type: string, message: string): void {
    // Structured logging is asynchronous/non-blocking from this service's
    // perspective and replaces synchronous request-alert file appends.
    this.log.warn("Request monitor alert", "Ops", { type, message });
  }

  public getStats() {
    const now = Date.now();
    const oneHourAgo = now - HOUR_MS;
    const oneMinuteAgo = now - MINUTE_MS;
    const recentRequests = this.requestStats.filter(
      (stat) => stat.timestamp > oneHourAgo,
    );
    const lastMinuteRequests = recentRequests.filter(
      (stat) => stat.timestamp > oneMinuteAgo,
    );

    const firstMinute = Math.floor(oneHourAgo / MINUTE_MS);
    const hourBuckets = [...this.requestBuckets.entries()].filter(
      ([minute]) => minute >= firstMinute,
    );
    const totalRequestsLastHour = hourBuckets.reduce(
      (total, [, bucket]) => total + bucket.count,
      0,
    );
    const errorsLastHour = hourBuckets.reduce(
      (total, [, bucket]) => total + bucket.errorCount,
      0,
    );
    const uniqueIPs = new Set<string>();
    const uniqueUserAgents = new Set<string>();
    for (const [, bucket] of hourBuckets) {
      for (const ip of bucket.uniqueIPs) this.addBounded(uniqueIPs, ip);
      for (const agent of bucket.userAgents) {
        this.addBounded(uniqueUserAgents, agent);
      }
    }

    const endpointMetrics = [...this.endpointMetrics.entries()]
      .map(([endpoint, metrics]) => ({
        endpoint: this.normalizeEndpoint(endpoint),
        count: metrics.count,
        averageResponseTime: Math.round(metrics.averageResponseTime),
        errorCount: metrics.errorCount,
        uniqueIPs: metrics.uniqueIPs.size,
        uniqueUserAgents: metrics.userAgents.size,
      }))
      .sort((left, right) => right.count - left.count);

    return {
      totalRequestsLastHour,
      totalRequestsLastMinute: lastMinuteRequests.length,
      requestsPerSecond: Math.round(lastMinuteRequests.length / 60),
      globalUniqueIPsLastHour: uniqueIPs.size,
      globalUniqueUserAgentsLastHour: uniqueUserAgents.size,
      errorsLastHour,
      errorRateLastHour:
        totalRequestsLastHour > 0
          ? Math.round((errorsLastHour / totalRequestsLastHour) * 1000) / 1000
          : 0,
      endpointMetrics: this.mergeEndpointMetrics(endpointMetrics),
      topIPs: this.getTopValues(recentRequests, (request) => request.ip).map(
        ([ip, count]) => ({ ip, count }),
      ),
      topUserAgents: this.getTopValues(
        recentRequests,
        (request) => request.userAgent,
      ).map(([userAgent, count]) => ({ userAgent, count })),
      suspiciousPatterns: this.detectSuspiciousPatterns(recentRequests),
      limits: {
        recentRequests: MAX_RECENT_REQUESTS,
        endpoints: MAX_ENDPOINTS,
        uniqueValuesPerMetric: MAX_UNIQUE_VALUES,
      },
    };
  }

  private normalizeEndpoint(endpoint: string): string {
    const separator = endpoint.indexOf(" ");
    const method = separator > 0 ? endpoint.slice(0, separator) : "GET";
    const path = separator > 0 ? endpoint.slice(separator + 1) : endpoint;
    return `${method} ${this.normalizePath(path)}`;
  }

  private mergeEndpointMetrics<
    T extends {
      endpoint: string;
      count: number;
      averageResponseTime: number;
      errorCount: number;
      uniqueIPs: number;
      uniqueUserAgents: number;
    },
  >(metrics: T[]): T[] {
    const merged = new Map<string, T>();
    for (const metric of metrics) {
      const current = merged.get(metric.endpoint);
      if (!current) {
        merged.set(metric.endpoint, { ...metric });
        continue;
      }
      const totalCount = current.count + metric.count;
      current.averageResponseTime = Math.round(
        (current.averageResponseTime * current.count +
          metric.averageResponseTime * metric.count) /
          totalCount,
      );
      current.count = totalCount;
      current.errorCount += metric.errorCount;
      current.uniqueIPs = Math.min(
        MAX_UNIQUE_VALUES,
        current.uniqueIPs + metric.uniqueIPs,
      );
      current.uniqueUserAgents = Math.min(
        MAX_UNIQUE_VALUES,
        current.uniqueUserAgents + metric.uniqueUserAgents,
      );
    }
    return [...merged.values()].sort((left, right) => right.count - left.count);
  }

  private getTopValues(
    requests: RequestStats[],
    getKey: (request: RequestStats) => string,
  ): Array<[string, number]> {
    const counts = new Map<string, number>();
    for (const request of requests) {
      const key = getKey(request);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 10);
  }

  private detectSuspiciousPatterns(
    requests: RequestStats[],
  ): Array<{ type: string; description: string; severity: string }> {
    const endpointCounts = new Map<string, number>();
    for (const request of requests) {
      endpointCounts.set(
        request.endpoint,
        (endpointCounts.get(request.endpoint) || 0) + 1,
      );
    }

    return [...endpointCounts.entries()]
      .filter(([, count]) => count > 100)
      .map(([endpoint, count]) => ({
        type: "POTENTIAL_POLLING_LOOP",
        description: `Endpoint ${endpoint} received ${count} requests in the retained window`,
        severity: count > 500 ? "HIGH" : "MEDIUM",
      }));
  }

  public emergencyDisableRateLimit(): void {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Production rate limiting cannot be disabled at runtime.");
    }
    process.env.ENABLE_RATE_LIMITING = "false";
    this.log.error("Rate limiting emergency disabled", undefined, "Ops", {
      enableRateLimiting: false,
    });
  }

  public emergencyEnableRateLimit(): void {
    process.env.ENABLE_RATE_LIMITING = "true";
    this.log.info("Rate limiting re-enabled after emergency", "Ops", {
      enableRateLimiting: true,
    });
  }

  public getRateLimitingStatus() {
    const enabled =
      process.env.NODE_ENV === "production" ||
      process.env.ENABLE_RATE_LIMITING !== "false";
    return { enabled, status: enabled ? "enabled" : "emergency_disabled" };
  }
}

export default RequestMonitorService;
