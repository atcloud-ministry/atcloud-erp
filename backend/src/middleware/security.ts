import helmet from "helmet";
/* eslint-disable @typescript-eslint/no-namespace */
import { Request, Response, NextFunction } from "express";
import { createLogger } from "../services/LoggerService";
const log = createLogger("Security");

const DEFAULT_FRONTEND_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:5174",
  "http://localhost:5175",
  "http://localhost:5176",
  "https://at-cloud-sign-up-system.onrender.com",
  "https://atcloud-erp-frontend-prod.onrender.com",
  "https://atcloud-erp-frontend-staging.onrender.com",
];

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "");
}

function parseOrigins(value: string | undefined): string[] {
  return (value || "").split(",").map(normalizeOrigin).filter(Boolean);
}

export function getAllowedFrontendOrigins(): string[] {
  return Array.from(
    new Set([
      ...DEFAULT_FRONTEND_ORIGINS,
      ...parseOrigins(process.env.FRONTEND_URL),
      ...parseOrigins(process.env.FRONTEND_ORIGINS),
    ]),
  );
}

// Security headers middleware
export const securityHeaders = helmet({
  // Keep tight CSP but allow images from any https origin so avatars can load
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      scriptSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false, // Needed for file uploads / socket usage
  // IMPORTANT: Allow cross-origin resource policy so frontend (different subdomain) can load avatar images
  crossOriginResourcePolicy: { policy: "cross-origin" },
  // Optionally relax opener policy to avoid blocking popups while keeping isolation
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
});

// CORS configuration
export const corsOptions = {
  origin: function (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void,
  ) {
    const allowedOrigins = getAllowedFrontendOrigins();

    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);

    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.log(`CORS: Blocking origin: ${origin}`);
      log.warn("CORS: Blocking origin", undefined, { origin });
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "Cache-Control",
    "Pragma",
    "Idempotency-Key",
  ],
  exposedHeaders: ["RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"],
};

// XSS Protection middleware
export const xssProtection = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  // Basic XSS protection for request body
  if (req.body) {
    // Allowlist: permit HTML in specific fields
    const allowHtml = (path: string, key: string): boolean => {
      // Permit rich HTML for feedback message only
      const safePath = typeof path === "string" ? path : "";
      if (safePath.includes("/feedback") && key === "message") return true;
      return false;
    };

    const sanitizeObject = (obj: unknown, parentPath = ""): unknown => {
      if (typeof obj === "string") {
        return obj.replace(
          /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
          "",
        );
      }
      if (typeof obj === "object" && obj !== null) {
        const rec: Record<string, unknown> = obj as Record<string, unknown>;
        for (const key in rec) {
          if (allowHtml(req.path, key)) {
            // still strip <script> tags but keep HTML
            const v = rec[key];
            if (typeof v === "string") {
              rec[key] = v.replace(
                /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
                "",
              );
            } else {
              rec[key] = sanitizeObject(
                v,
                parentPath ? `${parentPath}.${key}` : key,
              );
            }
          } else {
            rec[key] = sanitizeObject(
              rec[key],
              parentPath ? `${parentPath}.${key}` : key,
            );
          }
        }
        return rec;
      }
      return obj;
    };

    req.body = sanitizeObject(req.body) as typeof req.body;
  }

  next();
};

// Request size limitation
export const requestSizeLimit = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const contentLength = parseInt(req.get("content-length") || "0");
  const maxSize = 10 * 1024 * 1024; // 10MB limit

  if (contentLength > maxSize) {
    res.status(413).json({
      success: false,
      message: "Request entity too large",
    });
    return;
  }

  next();
};

// IP-based security middleware
export const ipSecurity = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const clientIp = req.ip || req.connection.remoteAddress || "unknown";

  // Placeholder for future suspicious pattern checks (kept minimal to avoid false positives)

  // In production, you might want to implement a more sophisticated
  // IP reputation system here

  req.clientIp = clientIp;
  next();
};

// Error handling middleware for security
export const securityErrorHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  // Log security-related errors
  if (err.message.includes("CORS") || err.message.includes("rate limit")) {
    console.warn(`Security warning: ${err.message} from IP: ${req.ip}`);
    log.warn("Security warning", undefined, {
      message: err.message,
      ip: req.ip,
    });
  }

  // Don't expose internal error details in production
  const isDevelopment = process.env.NODE_ENV === "development";

  res.status(500).json({
    success: false,
    message: "Internal server error",
    ...(isDevelopment && { error: err.message }),
  });
};

// Declare additional Express Request properties
declare global {
  namespace Express {
    interface Request {
      clientIp?: string;
    }
  }
}
