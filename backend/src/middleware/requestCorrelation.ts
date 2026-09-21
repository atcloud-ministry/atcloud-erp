/* eslint-disable @typescript-eslint/no-namespace */
import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { scrubSensitiveString } from "../utils/sensitiveString";

/**
 * Request Correlation Middleware
 * Adds a unique correlation ID to each request for distributed tracing
 */

declare global {
  namespace Express {
    interface Request {
      correlationId?: string;
    }
  }
}

export interface CorrelationOptions {
  headerName?: string;
  propertyName?: string;
  generator?: () => string;
}

const DEFAULT_OPTIONS: Required<CorrelationOptions> = {
  headerName: "x-correlation-id",
  propertyName: "correlationId",
  generator: () => randomUUID(),
};

export const CORRELATION_ID_MAX_LENGTH = 128;
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function isValidCorrelationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= CORRELATION_ID_MAX_LENGTH &&
    CORRELATION_ID_PATTERN.test(value) &&
    scrubSensitiveString(value) === value
  );
}

function generateSafeCorrelationId(generator: () => string): string {
  try {
    const generated = generator();
    if (isValidCorrelationId(generated)) return generated;
  } catch {
    // Fall through to a server-owned UUID when a custom generator fails.
  }
  return randomUUID();
}

/**
 * Middleware to add correlation ID to requests
 *
 * Features:
 * - Uses a valid correlation ID from the request header if present
 * - Generates a safe server-owned ID when the header is absent or invalid
 * - Adds correlation ID to response headers
 * - Attaches correlation ID to request object for use in controllers/services
 *
 * @param options Configuration options for correlation behavior
 */
export const requestCorrelation = (
  options: CorrelationOptions = {}
): ((req: Request, res: Response, next: NextFunction) => void) => {
  const config = { ...DEFAULT_OPTIONS, ...options };

  return (req: Request, res: Response, next: NextFunction): void => {
    // Check if correlation ID already exists in request headers (normalize header value)
    const headerVal = req.headers[config.headerName];
    const incomingId = Array.isArray(headerVal)
      ? headerVal[0]
      : (headerVal as string | undefined);
    const correlationId = isValidCorrelationId(incomingId)
      ? incomingId
      : generateSafeCorrelationId(config.generator);

    // Attach correlation ID to request object
    req.correlationId = correlationId;

    // Add correlation ID to response headers for client tracking
    res.setHeader(config.headerName, correlationId);

    next();
  };
};

/**
 * Helper function to get correlation ID from request
 */
export const getCorrelationId = (req: Request): string | undefined => {
  return req.correlationId;
};

/**
 * Helper function to create a correlation context for logging
 */
export const createCorrelationContext = (req: Request) => {
  return {
    correlationId: getCorrelationId(req),
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.get("User-Agent"),
  };
};
