import express from "express";
import cors from "cors";
import compression from "compression";
import cookieParser from "cookie-parser";
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import routes from "./routes";
import ShortLinkService from "./services/ShortLinkService";
import { ShortLinkMetricsService } from "./services/ShortLinkMetricsService";
import {
  shortLinkRedirectCounter,
  getMetrics as getPromMetrics,
  isPromEnabled,
} from "./services/PrometheusMetricsService";
import { Logger } from "./services/LoggerService";
import {
  generalLimiter,
  staticUploadReadLimiter,
  authLimiter,
  profileLimiter,
  systemMessagesLimiter,
} from "./middleware/rateLimiting";
import {
  securityHeaders,
  corsOptions,
  getAllowedFrontendOrigins,
  xssProtection,
  requestSizeLimit,
  ipSecurity,
  securityErrorHandler,
} from "./middleware/security";
import RequestMonitorService from "./middleware/RequestMonitorService";
import ErrorHandlerMiddleware from "./middleware/errorHandler";
import { requestCorrelation } from "./middleware/requestCorrelation";
import { operationalMonitoringService } from "./services/operations/OperationalMonitoringService";
import {
  CHAT_HTTP_PAYLOAD_MAX_BYTES,
  ChatRoomPayloadTooLargeError,
} from "./contracts/chatRoomFlow";

// Load environment variables
dotenv.config();

// Create Express app
const app = express();

// Note: Do not auto-connect to MongoDB here. Tests and server bootstrap manage connections explicitly.

// Trust proxy for accurate IP addresses behind reverse proxies
app.set("trust proxy", 1);

// Request correlation (early - before other middleware)
app.use(requestCorrelation());

// Security middleware
app.use(securityHeaders);
app.use(ipSecurity);
app.use(requestSizeLimit);

// CORS configuration
app.use(cors(corsOptions));

// HTTP response compression (balanced defaults)
app.use(
  compression({
    level: 6,
    threshold: 1024,
  }),
);

// Request monitoring (early)
const requestMonitor = RequestMonitorService.getInstance();
app.use(requestMonitor.middleware());

// Rate limiting middleware
app.use(generalLimiter);
app.use("/uploads", staticUploadReadLimiter);
// Apply specific limiters to critical endpoints
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);
app.use("/api/auth/forgot-password", authLimiter);
app.use("/api/auth/reset-password", authLimiter);
app.use("/api/auth/profile", profileLimiter);
app.use("/api/auth/logout", profileLimiter);
app.use("/api/notifications", systemMessagesLimiter);

// Stripe webhook endpoint needs raw body - must be before JSON parser
// In test environment, use JSON parser instead to make testing easier
const CHAT_MESSAGE_POST_PATH =
  /^\/api\/conversations\/[^/?#]+\/(?:messages|announcements)\/?(?:[?#]|$)/u;
const isChatMessagePost = (req: {
  readonly method?: string;
  readonly url?: string;
}): boolean =>
  req.method === "POST" && CHAT_MESSAGE_POST_PATH.test(req.url ?? "");
const jsonParser = express.json({
  limit: "10mb",
  // A chat-message POST is JSON-only and always passes through this parser,
  // regardless of a forged/missing Content-Type. This lets `verify` enforce
  // the approved raw 16 KiB envelope for chunked as well as fixed-length
  // requests before another body parser can consume it.
  type: (req) => {
    if (isChatMessagePost(req)) return true;
    const contentType = req.headers["content-type"]
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    return contentType === "application/json";
  },
  verify: (req, _res, body) => {
    if (isChatMessagePost(req) && body.byteLength > CHAT_HTTP_PAYLOAD_MAX_BYTES) {
      throw new ChatRoomPayloadTooLargeError();
    }
  },
});
if (process.env.NODE_ENV === "test") {
  app.use("/api/webhooks/stripe", jsonParser);
} else {
  app.use("/api/webhooks/stripe", express.raw({ type: "application/json" }));
}

// Body parsing middleware - SKIP webhook endpoint (already has raw body parsing)
app.use((req, res, next) => {
  if (req.originalUrl.includes("/api/webhooks/stripe")) {
    return next();
  }
  jsonParser(req, res, next);
});
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());

// Test helper auth injection (only in test environment)
if (process.env.NODE_ENV === "test") {
  app.use((req, _res, next) => {
    const auth = req.header("Authorization");
    if (auth) {
      if (auth.startsWith("Bearer test-admin-")) {
        const userId = auth.substring("Bearer test-admin-".length).trim();
        if (mongoose.Types.ObjectId.isValid(userId)) {
          (req as any).user = {
            id: userId,
            role: "Administrator",
            _id: userId,
          };
        }
      } else if (auth.startsWith("Bearer test-")) {
        const userId = auth.substring("Bearer test-".length).trim();
        if (mongoose.Types.ObjectId.isValid(userId)) {
          (req as any).user = { id: userId, role: "Participant", _id: userId };
        }
      }
    }
    next();
  });
}

// XSS Protection - SKIP for webhook endpoint (uses raw body)
app.use((req, res, next) => {
  if (req.originalUrl.includes("/api/webhooks/stripe")) {
    return next();
  }
  xssProtection(req, res, next);
});

// Static file serving for uploads with relaxed CORP and CORS for images
const appLogger = Logger.getInstance().child("App");
const getStaticUploadPath = (): string => {
  if (process.env.UPLOAD_DESTINATION) {
    const p = process.env.UPLOAD_DESTINATION.replace(/\/$/, "");
    appLogger.info(`📁 Using UPLOAD_DESTINATION for static files: ${p}`);
    return p;
  }
  if (process.env.NODE_ENV === "production") {
    appLogger.info(`📁 Using production upload path: /uploads`);
    return "/uploads";
  }
  const devPath = path.join(__dirname, "../uploads");
  appLogger.info(`📁 Using development upload path: ${devPath}`);
  return devPath;
};

const staticUploadPath = getStaticUploadPath();
appLogger.info(`🔗 Serving static files from: ${staticUploadPath}`);

app.use(
  "/uploads",
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const allowedOrigins = getAllowedFrontendOrigins();
    const origin = req.headers.origin as string | undefined;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Accept",
    );
    if (!res.getHeader("Cache-Control")) {
      res.setHeader(
        "Cache-Control",
        "public, max-age=3600, stale-while-revalidate=300",
      );
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(200);
      return;
    }
    next();
  },
);
app.use("/uploads", express.static(staticUploadPath));

// Routes
app.use("/api", routes);

// Root endpoint - simple health check for infrastructure probes
app.get("/", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "atcloud-backend",
    timestamp: new Date().toISOString(),
  });
});

// Root short redirect: /s/:key -> 302 to public event slug page
app.get("/s/:key", async (req, res) => {
  try {
    const { key } = req.params;
    const result = await ShortLinkService.resolveKey(key);
    if (result.status === "active") {
      ShortLinkMetricsService.increment("redirect_active");
      try {
        shortLinkRedirectCounter.inc({ status: "active" });
      } catch {}
      // Redirect to the frontend hash route so static HashRouter deployments hydrate on the public event page.
      const targetPath = `/#/p/${encodeURIComponent(result.slug)}`;
      // Prefer explicit FRONTEND_URL for absolute redirect to avoid white page when user hits backend port directly.
      // If not set (dev), and request host looks like backend (e.g. :5001), attempt common Vite dev port 5176 fallback.
      const configuredFrontend = process.env.FRONTEND_URL?.replace(/\/$/, "");
      let redirectTarget = targetPath; // default relative
      if (configuredFrontend) {
        redirectTarget = `${configuredFrontend}${targetPath}`;
      } else {
        const host = req.get("host") || "";
        const isBackendPort = /:(5001|8080)$/.test(host);
        if (isBackendPort && process.env.NODE_ENV !== "production") {
          // Heuristic: choose 5176 if in use, else 5173 base guess. We cannot probe ports synchronously here,
          // so we favor the higher dev port commonly auto-selected after collisions.
          const devBase =
            process.env.VITE_DEV_FRONTEND || "http://localhost:5176";
          redirectTarget = `${devBase.replace(/\/$/, "")}${targetPath}`;
        }
      }
      res.redirect(302, redirectTarget);
      return;
    }
    ShortLinkMetricsService.increment("redirect_not_found");
    try {
      shortLinkRedirectCounter.inc({ status: "not_found" });
    } catch {}
    res.status(404).send("Short link not found");
  } catch {
    res.status(500).send("Failed to resolve short link");
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Lightweight metrics endpoint (non-auth) for short links (can be restricted later)
// Unified metrics endpoint: returns Prometheus exposition (text) when Accept header prefers text/plain
// Otherwise returns JSON with legacy in-memory short link counters plus an indicator of Prometheus enablement.
app.get("/metrics", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  // New behavior: Always expose Prometheus text format when enabled by env, unless
  // client explicitly requests JSON via query (?format=json) for backwards compatibility.
  // This change ensures tests that do not set an Accept: text/plain header still receive
  // the counter/gauge exposition they parse line-by-line.
  const wantJson = req.query.format === "json";

  if (isPromEnabled() && !wantJson) {
    try {
      await operationalMonitoringService.refresh();
      const text = await getPromMetrics();
      res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      res.status(200).send(text);
      return;
    } catch (e) {
      // Fall through to JSON legacy structure if collection fails
    }
  }
  try {
    const metrics = ShortLinkMetricsService.getAll();
    res.status(200).json({
      success: true,
      metrics: { shortLinks: metrics },
      prometheus: {
        enabled: isPromEnabled(),
        format: wantJson ? "json" : "fallback-json",
      },
    });
  } catch (e) {
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch metrics" });
  }
});

// Backwards compatible old short links metrics path (JSON only)
app.get("/metrics/short-links", (req, res) => {
  try {
    const metrics = ShortLinkMetricsService.getAll();
    res.status(200).json({ success: true, metrics });
  } catch (e) {
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch metrics" });
  }
});

// Global error handlers (security first, then application)
app.use(securityErrorHandler);
app.use(ErrorHandlerMiddleware.globalErrorHandler);

// Default export for testing and server bootstrap
export default app;
