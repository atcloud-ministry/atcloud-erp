import rateLimit from "express-rate-limit";
import { RejectionMetricsService } from "../services/RejectionMetricsService";
import type { Request } from "express";

// Check if we're in development environment
const isDevelopment = process.env.NODE_ENV === "development";
const isProduction = process.env.NODE_ENV === "production";
const usesNonProductionLimits = !isProduction;

const SPECIALIZED_RATE_LIMIT_PREFIXES = [
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  "/api/auth/profile",
  "/api/auth/logout",
  "/api/notifications",
  "/api/search",
] as const;

const SPECIALIZED_RATE_LIMIT_ROUTES = new Set([
  "GET /api/events",
  "POST /api/users/avatar",
  "GET /api/users/community-stats",
  "GET /api/users/stats",
  "POST /api/uploads/image",
  "POST /api/uploads/avatar",
  "GET /api/analytics",
  "GET /api/analytics/users",
  "GET /api/analytics/events",
  "GET /api/analytics/engagement",
  "GET /api/analytics/attendance",
  "GET /api/analytics/programs",
  "GET /api/analytics/donations",
  "GET /api/analytics/financial-summary",
  "GET /api/analytics/trends",
  "GET /api/analytics/registration-profile-kpis/export",
  "GET /api/analytics/export",
  "POST /api/admin/alumni-imports/dry-run",
  "GET /api/role-assignments/reject/validate",
  "POST /api/role-assignments/reject/reject",
]);

const SECURITY_RATE_LIMIT_ENV = [
  "RATE_LIMIT_WINDOW_MS",
  "RATE_LIMIT_MAX_REQUESTS",
  "AUTH_RATE_LIMIT_WINDOW_MS",
  "AUTH_RATE_LIMIT_MAX_REQUESTS",
  "DIRECTORY_SEARCH_RATE_LIMIT_WINDOW_MS",
  "DIRECTORY_SEARCH_RATE_LIMIT_MAX_REQUESTS",
] as const;

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function assertRateLimitProductionConfiguration(): void {
  if (!isProduction) return;
  if (process.env.ENABLE_RATE_LIMITING !== "true") {
    throw new Error("Production rate limiting must be explicitly enabled.");
  }
  for (const name of SECURITY_RATE_LIMIT_ENV) {
    const raw = process.env[name];
    const value = Number(raw);
    if (!raw || !Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Production rate limit configuration ${name} is invalid.`);
    }
  }
}

// Check if rate limiting is emergency disabled
const isEmergencyDisabled = () => {
  return !isProduction && process.env.ENABLE_RATE_LIMITING === "false";
};

// Skip rate limiting for localhost in development
const skipForLocalhost = (req: Request) => {
  if (isDevelopment) {
    const isLocalhost =
      req.ip === "127.0.0.1" ||
      req.ip === "::1" ||
      req.ip === "::ffff:127.0.0.1" ||
      req.connection.remoteAddress === "127.0.0.1";
    if (isLocalhost) {
      console.log(
        `[DEV] Rate limiting BYPASSED for localhost: ${req.ip} - ${req.method} ${req.path}`
      );
      return true;
    }
  }
  return false;
};

// Combined skip function that checks both localhost and emergency disable
const skipRateLimit = (req: Request) => {
  if (isEmergencyDisabled()) {
    console.log(
      `[EMERGENCY] Rate limiting DISABLED: ${req.ip} - ${req.method} ${req.path}`
    );
    return true;
  }
  return skipForLocalhost(req);
};

function hasPathPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * The global limiter is the fallback policy. Requests covered by a route-level
 * policy must not also consume the smaller production fallback bucket, or the
 * fallback can return a 429 before the route's intended limiter does.
 */
export function hasSpecializedRateLimit(req: Request): boolean {
  const pathname =
    req.path.length > 1 ? req.path.replace(/\/+$/u, "") : req.path;
  if (
    SPECIALIZED_RATE_LIMIT_PREFIXES.some((prefix) =>
      hasPathPrefix(pathname, prefix),
    )
  ) {
    return true;
  }
  if (SPECIALIZED_RATE_LIMIT_ROUTES.has(`${req.method} ${pathname}`)) {
    return true;
  }

  if (req.method !== "GET") return false;
  if (pathname === "/api/directory") return true;
  const directoryProfileMatch = /^\/api\/directory\/([^/]+)$/u.exec(pathname);
  return (
    directoryProfileMatch?.[1] !== undefined &&
    directoryProfileMatch[1] !== "me"
  );
}

const skipGeneralRateLimit = (req: Request): boolean =>
  skipRateLimit(req) || hasSpecializedRateLimit(req);

// Development mode: much more generous limits
// Production mode: strict limits for security

// General API rate limiting
export const generalLimiter = rateLimit({
  windowMs: positiveIntegerEnvironment("RATE_LIMIT_WINDOW_MS", 15 * 60 * 1000),
  max: usesNonProductionLimits
    ? 10000
    : positiveIntegerEnvironment("RATE_LIMIT_MAX_REQUESTS", 100),
  message: {
    error: "Too many requests from this IP, please try again later.",
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  skip: skipGeneralRateLimit,
});

// Strict rate limiting for authentication endpoints
export const authLimiter = rateLimit({
  windowMs: positiveIntegerEnvironment(
    "AUTH_RATE_LIMIT_WINDOW_MS",
    15 * 60 * 1000,
  ),
  max: usesNonProductionLimits
    ? 5000
    : positiveIntegerEnvironment("AUTH_RATE_LIMIT_MAX_REQUESTS", 20),
  message: {
    error: "Too many authentication attempts, please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Don't count successful requests
  skip: skipRateLimit, // Skip rate limiting for localhost in development and emergency disable
});

// Moderate rate limiting for search endpoints
export const searchLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: isDevelopment ? 300 : 60, // 300 in dev, 60 in prod
  message: {
    error: "Too many search requests, please slow down.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipRateLimit,
});

const directorySearchWindowMs = positiveIntegerEnvironment(
  "DIRECTORY_SEARCH_RATE_LIMIT_WINDOW_MS",
  60_000,
);
const directorySearchMax = usesNonProductionLimits
  ? 300
  : positiveIntegerEnvironment("DIRECTORY_SEARCH_RATE_LIMIT_MAX_REQUESTS", 60);
const directorySearchMessage = {
  error: "Too many directory requests, please slow down.",
};

/** Independent network-level control for directory enumeration. */
export const directoryIpLimiter = rateLimit({
  windowMs: directorySearchWindowMs,
  max: directorySearchMax,
  message: directorySearchMessage,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipRateLimit,
});

/** Account-level control prevents rotating IPs from bypassing enumeration limits. */
export const directoryAccountLimiter = rateLimit({
  windowMs: directorySearchWindowMs,
  max: directorySearchMax,
  message: directorySearchMessage,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `account:${req.userId ?? "missing"}`,
  skip: skipRateLimit,
});

// Strict rate limiting for file upload endpoints
export const uploadLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: isDevelopment ? 100 : 20, // 100 in dev, 20 in prod
  message: {
    error: "Too many file uploads, please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipRateLimit,
});

// Analytics rate limiting (more restrictive)
export const analyticsLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: isDevelopment ? 1000 : 200, // 1000 in dev, 200 in prod
  message: {
    error: "Too many analytics requests, please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipRateLimit,
});

// Moderate rate limiting for profile endpoints
export const profileLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: isDevelopment ? 1000 : 200, // 1000 in dev, 200 in prod
  message: {
    error: "Too many profile requests, please slow down.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipRateLimit,
});

// Export rate limiting (very restrictive)
export const exportLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: isDevelopment ? 30 : 15, // 30 in dev, 15 in prod
  message: {
    error: "Export rate limit exceeded, please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipRateLimit,
});

// System messages rate limiting (generous for frequent polling)
export const systemMessagesLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isDevelopment ? 5000 : 1000, // 5000 in dev, 1000 in prod
  message: {
    error: "Too many system message requests, please slow down.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false, // Count all requests to prevent abuse
  skip: skipRateLimit,
});

// Role assignment rejection flow limiter (token-based, very low per window to mitigate brute force)
export const roleAssignmentRejectionLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: isDevelopment ? 50 : 20, // allow a bit more in dev
  message: {
    error: "Too many assignment rejection requests, please try again later.",
    code: "ASSIGNMENT_REJECTION_RATE_LIMIT",
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req: Request) => {
    if (process.env.NODE_ENV === "test") {
      if (process.env.TEST_ENABLE_REJECTION_RATE_LIMIT === "true") return false;
      return true; // skip by default in tests
    }
    return skipRateLimit(req);
  },
  handler: (req, res, next, options) => {
    RejectionMetricsService.increment("rate_limited");
    res.status(options.statusCode || 429).json(options.message);
  },
});
