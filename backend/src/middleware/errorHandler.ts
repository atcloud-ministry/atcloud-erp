import { Request, Response, NextFunction } from "express";
import { ApiResponse, createErrorResponse } from "../types/api";

const RELIABILITY_ERROR_RESPONSES: Readonly<
  Record<string, { readonly statusCode: number; readonly message: string }>
> = Object.freeze({
  CAS_VALIDATION_ERROR: {
    statusCode: 400,
    message: "Invalid concurrency control request.",
  },
  CAS_RESOURCE_NOT_FOUND: { statusCode: 404, message: "Resource not found." },
  CAS_CONFLICT: {
    statusCode: 409,
    message: "The resource changed. Refresh it and try again.",
  },
  IDEMPOTENCY_VALIDATION_ERROR: {
    statusCode: 400,
    message: "Invalid idempotency request.",
  },
  IDEMPOTENCY_PAYLOAD_TOO_LARGE: {
    statusCode: 413,
    message: "The idempotency payload is too large.",
  },
  IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST: {
    statusCode: 409,
    message: "This idempotency key was already used for a different request.",
  },
  IDEMPOTENCY_OPERATION_IN_PROGRESS: {
    statusCode: 409,
    message: "This request is still being processed. Try again shortly.",
  },
  IDEMPOTENCY_PERSISTENCE_ERROR: {
    statusCode: 503,
    message: "The request result could not be saved. Retry with the same idempotency key.",
  },
  MONGO_TRANSACTIONS_UNAVAILABLE: {
    statusCode: 503,
    message: "Reliable writes are temporarily unavailable.",
  },
  MONGO_TRANSACTION_RETRY_EXHAUSTED: {
    statusCode: 503,
    message: "The write could not be completed. Retry with the same idempotency key.",
  },
  MONGO_TRANSACTION_COMMIT_UNCERTAIN: {
    statusCode: 503,
    message: "The write result is uncertain. Retry with the same idempotency key.",
  },
});

function logUnhandledError(error: unknown): void {
  if (process.env.NODE_ENV !== "production") {
    console.error("Error:", error);
    return;
  }

  const candidate = error as { name?: unknown; code?: unknown };
  console.error("Error:", {
    name:
      typeof candidate?.name === "string" ? candidate.name : "UnknownError",
    ...(typeof candidate?.code === "string" ||
    typeof candidate?.code === "number"
      ? { code: candidate.code }
      : {}),
  });
}

export class ErrorHandlerMiddleware {
  static async handleAsyncError(
    fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
  ) {
    return (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve(fn(req, res, next)).catch(next);
    };
  }

  static handleValidationError(error: unknown): ApiResponse {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { name?: string }).name === "ValidationError"
    ) {
      const errObj = error as {
        errors: Record<string, { message: string }>;
      };
      const messages = Object.values(errObj.errors).map((e) => e.message);
      return createErrorResponse(
        `Validation failed: ${messages.join(", ")}`,
        400
      );
    }
    return createErrorResponse("Validation error", 400);
  }

  static handleDuplicateKeyError(error: unknown): ApiResponse {
    const field =
      typeof error === "object" &&
      error !== null &&
      "keyValue" in error &&
      error.keyValue &&
      typeof (error as { keyValue: Record<string, unknown> }).keyValue ===
        "object"
        ? Object.keys(
            (error as { keyValue: Record<string, unknown> }).keyValue
          )[0]
        : "unknown";
    return createErrorResponse(
      `Duplicate value for field: ${field}. Please use another value.`,
      400
    );
  }

  static handleCastError(error: unknown): ApiResponse {
    const err = error as { path?: string; value?: unknown };
    return createErrorResponse(
      `Invalid ${err.path}: ${String(err.value)}`,
      400
    );
  }

  static handleJWTError(): ApiResponse {
    return createErrorResponse("Invalid token. Please log in again.", 401);
  }

  static handleJWTExpiredError(): ApiResponse {
    return createErrorResponse("Token expired. Please log in again.", 401);
  }

  static globalErrorHandler(
    err: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction
  ): void {
    const base = (
      err !== null && typeof err === "object" ? err : {}
    ) as {
      [k: string]: unknown;
      message?: string;
      name?: string;
      code?: number | string;
      stack?: string;
    };
    let statusCode: number | undefined;
    let message: string | undefined =
      typeof base.message === "string" ? base.message : undefined;
    let publicErrorCode: string | undefined;

    // Production logs expose only stable classification fields; request data,
    // database causes, and credentials must never be serialized here.
    logUnhandledError(err);

    // Mongoose bad ObjectId
    if (base.name === "CastError") {
      const resp = ErrorHandlerMiddleware.handleCastError(base);
      statusCode = resp.statusCode;
      message = resp.message;
    }

    // Mongoose duplicate key
    if (base.code === 11000) {
      const resp = ErrorHandlerMiddleware.handleDuplicateKeyError(base);
      statusCode = resp.statusCode;
      message = resp.message;
    }

    // Mongoose validation error
    if (base.name === "ValidationError") {
      const resp = ErrorHandlerMiddleware.handleValidationError(base);
      statusCode = resp.statusCode;
      message = resp.message;
    }

    // JWT errors
    if (base.name === "JsonWebTokenError") {
      const resp = ErrorHandlerMiddleware.handleJWTError();
      statusCode = resp.statusCode;
      message = resp.message;
    }

    if (base.name === "TokenExpiredError") {
      const resp = ErrorHandlerMiddleware.handleJWTExpiredError();
      statusCode = resp.statusCode;
      message = resp.message;
    }

    if (typeof base.code === "string") {
      const reliabilityResponse = RELIABILITY_ERROR_RESPONSES[base.code];
      if (reliabilityResponse) {
        statusCode = reliabilityResponse.statusCode;
        message = reliabilityResponse.message;
        publicErrorCode = base.code;
      }
    }

    const responseStatus = statusCode || 500;
    const responseMessage =
      process.env.NODE_ENV === "production" &&
      responseStatus >= 500 &&
      !publicErrorCode
        ? "Server Error"
        : message || "Server Error";

    res.status(responseStatus).json({
      success: false,
      message: responseMessage,
      ...(publicErrorCode ? { code: publicErrorCode } : {}),
      ...(process.env.NODE_ENV === "development" && {
        stack: base.stack,
      }),
    });
  }
}

export default ErrorHandlerMiddleware;
