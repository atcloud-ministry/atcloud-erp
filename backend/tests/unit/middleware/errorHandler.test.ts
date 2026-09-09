import { describe, it, expect, vi, beforeEach } from "vitest";
import { Request, Response, NextFunction } from "express";
import { ErrorHandlerMiddleware } from "../../../src/middleware/errorHandler";

// Mock the API types
vi.mock("../../../src/types/api", () => ({
  createErrorResponse: vi.fn((message: string, statusCode: number = 500) => ({
    success: false,
    message,
    statusCode,
    meta: {
      timestamp: new Date().toISOString(),
    },
  })),
}));

// Test helpers
const createMockRequest = (): Partial<Request> => ({
  headers: {},
  body: {},
  params: {},
  query: {},
});

const createMockResponse = (): Partial<Response> => {
  const res: any = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res;
};

const createMockNext = (): NextFunction => vi.fn() as any;

// Test errors
const createCastError = (
  path: string = "id",
  value: string = "invalid_id"
) => ({
  name: "CastError",
  path,
  value,
  message: `Cast to ObjectId failed for value "${value}" at path "${path}"`,
});

const createValidationError = (errors: Record<string, any> = {}) => ({
  name: "ValidationError",
  message: "Validation failed",
  errors: {
    email: { message: "Email is required" },
    password: { message: "Password must be at least 6 characters" },
    ...errors,
  },
});

const createDuplicateKeyError = (
  keyValue: Record<string, any> = { email: "test@example.com" }
) => ({
  name: "MongoError",
  code: 11000,
  keyValue,
  message: "Duplicate key error",
});

const createJWTError = () => ({
  name: "JsonWebTokenError",
  message: "Invalid token",
});

const createJWTExpiredError = () => ({
  name: "TokenExpiredError",
  message: "Token expired",
});

describe("ErrorHandlerMiddleware", () => {
  let consoleSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  describe("handleAsyncError", () => {
    it("should catch async errors and call next", async () => {
      const asyncFn = vi.fn().mockRejectedValue(new Error("Async error"));
      const req = createMockRequest() as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      const wrappedFn = await ErrorHandlerMiddleware.handleAsyncError(asyncFn);
      wrappedFn(req, res, next);

      // Wait for the async operation to complete
      await vi.waitFor(() => {
        expect(next).toHaveBeenCalled();
      });

      expect(asyncFn).toHaveBeenCalledWith(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Async error",
        })
      );
    });

    it("should not call next for successful async functions", async () => {
      const asyncFn = vi.fn().mockResolvedValue(undefined);
      const req = createMockRequest() as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      const wrappedFn = await ErrorHandlerMiddleware.handleAsyncError(asyncFn);
      await wrappedFn(req, res, next);

      expect(asyncFn).toHaveBeenCalledWith(req, res, next);
      expect(next).not.toHaveBeenCalled();
    });

    it("should handle functions that return rejected promises", async () => {
      const rejectingFn = vi
        .fn()
        .mockReturnValue(Promise.reject(new Error("Promise rejection")));
      const req = createMockRequest() as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      const wrappedFn = await ErrorHandlerMiddleware.handleAsyncError(
        rejectingFn
      );
      wrappedFn(req, res, next);

      // Wait for the async operation to complete
      await vi.waitFor(() => {
        expect(next).toHaveBeenCalled();
      });

      expect(rejectingFn).toHaveBeenCalledWith(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Promise rejection",
        })
      );
    });
  });

  describe("handleValidationError", () => {
    it("should handle ValidationError with multiple field errors", () => {
      const validationError = createValidationError();
      const result =
        ErrorHandlerMiddleware.handleValidationError(validationError);

      expect(result).toEqual({
        success: false,
        message:
          "Validation failed: Email is required, Password must be at least 6 characters",
        statusCode: 400,
        meta: {
          timestamp: expect.any(String),
        },
      });
    });

    it("should handle ValidationError with single field error", () => {
      const validationError = {
        name: "ValidationError",
        message: "Validation failed",
        errors: {
          username: { message: "Username is required" },
        },
      };

      const result =
        ErrorHandlerMiddleware.handleValidationError(validationError);

      expect(result).toEqual({
        success: false,
        message: "Validation failed: Username is required",
        statusCode: 400,
        meta: {
          timestamp: expect.any(String),
        },
      });
    });

    it("should handle non-ValidationError objects", () => {
      const nonValidationError = {
        name: "SomeOtherError",
        message: "Other error",
      };
      const result =
        ErrorHandlerMiddleware.handleValidationError(nonValidationError);

      expect(result).toEqual({
        success: false,
        message: "Validation error",
        statusCode: 400,
        meta: {
          timestamp: expect.any(String),
        },
      });
    });
  });

  describe("handleDuplicateKeyError", () => {
    it("should handle duplicate key error with email field", () => {
      const duplicateError = createDuplicateKeyError({
        email: "test@example.com",
      });
      const result =
        ErrorHandlerMiddleware.handleDuplicateKeyError(duplicateError);

      expect(result).toEqual({
        success: false,
        message: "Duplicate value for field: email. Please use another value.",
        statusCode: 400,
        meta: {
          timestamp: expect.any(String),
        },
      });
    });

    it("should handle duplicate key error with username field", () => {
      const duplicateError = createDuplicateKeyError({ username: "testuser" });
      const result =
        ErrorHandlerMiddleware.handleDuplicateKeyError(duplicateError);

      expect(result).toEqual({
        success: false,
        message:
          "Duplicate value for field: username. Please use another value.",
        statusCode: 400,
        meta: {
          timestamp: expect.any(String),
        },
      });
    });

    it("should handle duplicate key error with multiple fields", () => {
      const duplicateError = createDuplicateKeyError({
        email: "test@example.com",
        phone: "123456789",
      });
      const result =
        ErrorHandlerMiddleware.handleDuplicateKeyError(duplicateError);

      expect(result).toEqual({
        success: false,
        message: "Duplicate value for field: email. Please use another value.",
        statusCode: 400,
        meta: {
          timestamp: expect.any(String),
        },
      });
    });

    it("should handle error without keyValue property", () => {
      const error = { code: 11000, name: "MongoError" }; // No keyValue
      const result = ErrorHandlerMiddleware.handleDuplicateKeyError(error);

      expect(result).toEqual({
        success: false,
        message:
          "Duplicate value for field: unknown. Please use another value.",
        statusCode: 400,
        meta: {
          timestamp: expect.any(String),
        },
      });
    });
  });

  describe("handleCastError", () => {
    it("should handle CastError with default values", () => {
      const castError = createCastError();
      const result = ErrorHandlerMiddleware.handleCastError(castError);

      expect(result).toEqual({
        success: false,
        message: "Invalid id: invalid_id",
        statusCode: 400,
        meta: {
          timestamp: expect.any(String),
        },
      });
    });

    it("should handle CastError with custom path and value", () => {
      const castError = createCastError("userId", "abc123");
      const result = ErrorHandlerMiddleware.handleCastError(castError);

      expect(result).toEqual({
        success: false,
        message: "Invalid userId: abc123",
        statusCode: 400,
        meta: {
          timestamp: expect.any(String),
        },
      });
    });
  });

  describe("handleJWTError", () => {
    it("should return correct JWT error response", () => {
      const result = ErrorHandlerMiddleware.handleJWTError();

      expect(result).toEqual({
        success: false,
        message: "Invalid token. Please log in again.",
        statusCode: 401,
        meta: {
          timestamp: expect.any(String),
        },
      });
    });
  });

  describe("handleJWTExpiredError", () => {
    it("should return correct JWT expired error response", () => {
      const result = ErrorHandlerMiddleware.handleJWTExpiredError();

      expect(result).toEqual({
        success: false,
        message: "Token expired. Please log in again.",
        statusCode: 401,
        meta: {
          timestamp: expect.any(String),
        },
      });
    });
  });

  describe("globalErrorHandler", () => {
    it("should handle CastError and return appropriate response", () => {
      const castError = createCastError("eventId", "12345");
      const req = createMockRequest() as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      ErrorHandlerMiddleware.globalErrorHandler(castError, req, res, next);

      expect(consoleSpy).toHaveBeenCalledWith("Error:", castError);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Invalid eventId: 12345",
      });
    });

    it("should handle duplicate key error (code 11000)", () => {
      const duplicateError = createDuplicateKeyError({ username: "duplicate" });
      const req = createMockRequest() as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      ErrorHandlerMiddleware.globalErrorHandler(duplicateError, req, res, next);

      expect(consoleSpy).toHaveBeenCalledWith("Error:", duplicateError);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message:
          "Duplicate value for field: username. Please use another value.",
      });
    });

    it("should handle ValidationError", () => {
      const validationError = createValidationError();
      const req = createMockRequest() as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      ErrorHandlerMiddleware.globalErrorHandler(
        validationError,
        req,
        res,
        next
      );

      expect(consoleSpy).toHaveBeenCalledWith("Error:", validationError);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message:
          "Validation failed: Email is required, Password must be at least 6 characters",
      });
    });

    it("should handle JsonWebTokenError", () => {
      const jwtError = createJWTError();
      const req = createMockRequest() as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      ErrorHandlerMiddleware.globalErrorHandler(jwtError, req, res, next);

      expect(consoleSpy).toHaveBeenCalledWith("Error:", jwtError);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Invalid token. Please log in again.",
      });
    });

    it("should handle TokenExpiredError", () => {
      const expiredError = createJWTExpiredError();
      const req = createMockRequest() as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      ErrorHandlerMiddleware.globalErrorHandler(expiredError, req, res, next);

      expect(consoleSpy).toHaveBeenCalledWith("Error:", expiredError);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Token expired. Please log in again.",
      });
    });

    it("should handle generic errors with default 500 status", () => {
      const genericError = new Error("Something went wrong");
      const req = createMockRequest() as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      ErrorHandlerMiddleware.globalErrorHandler(genericError, req, res, next);

      expect(consoleSpy).toHaveBeenCalledWith("Error:", genericError);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Something went wrong",
      });
    });

    it.each([
      [
        "CAS_CONFLICT",
        409,
        "The resource changed. Refresh it and try again.",
      ],
      [
        "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST",
        409,
        "This idempotency key was already used for a different request.",
      ],
      [
        "IDEMPOTENCY_PAYLOAD_TOO_LARGE",
        413,
        "The idempotency payload is too large.",
      ],
      [
        "MONGO_TRANSACTION_COMMIT_UNCERTAIN",
        503,
        "The write result is uncertain. Retry with the same idempotency key.",
      ],
      [
        "IDEMPOTENCY_PERSISTENCE_ERROR",
        503,
        "The request result could not be saved. Retry with the same idempotency key.",
      ],
    ])(
      "maps reliability error %s to a stable HTTP response",
      (code, expectedStatus, expectedMessage) => {
        const error = Object.assign(new Error("internal detail"), { code });
        const req = createMockRequest() as Request;
        const res = createMockResponse() as Response;

        ErrorHandlerMiddleware.globalErrorHandler(
          error,
          req,
          res,
          createMockNext(),
        );

        expect(res.status).toHaveBeenCalledWith(expectedStatus);
        expect(res.json).toHaveBeenCalledWith({
          success: false,
          message: expectedMessage,
          code,
        });
      },
    );

    it("should include stack trace in development environment", () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";

      const error = new Error("Development error");
      error.stack = "Error stack trace";
      const req = createMockRequest() as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      ErrorHandlerMiddleware.globalErrorHandler(error, req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Development error",
        stack: "Error stack trace",
      });

      process.env.NODE_ENV = originalEnv;
    });

    it("should not include stack trace in production environment", () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";

      const error = new Error("Production error");
      error.stack = "Error stack trace";
      const req = createMockRequest() as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      ErrorHandlerMiddleware.globalErrorHandler(error, req, res, next);

      expect(consoleSpy).toHaveBeenCalledWith("Error:", {
        name: "Error",
      });
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Server Error",
      });

      process.env.NODE_ENV = originalEnv;
    });

    it("should use default message for errors without message", () => {
      const errorWithoutMessage = { name: "CustomError" };
      const req = createMockRequest() as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      ErrorHandlerMiddleware.globalErrorHandler(
        errorWithoutMessage,
        req,
        res,
        next
      );

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Server Error",
      });
    });

    it.each([null, undefined, "string rejection"])(
      "should safely handle non-object rejection %s",
      (errorWithoutObjectShape) => {
        const res = createMockResponse() as Response;

        expect(() =>
          ErrorHandlerMiddleware.globalErrorHandler(
            errorWithoutObjectShape,
            createMockRequest() as Request,
            res,
            createMockNext(),
          ),
        ).not.toThrow();
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({
          success: false,
          message: "Server Error",
        });
      },
    );
  });

  describe("Method Existence Tests", () => {
    it("should have handleAsyncError method", () => {
      expect(typeof ErrorHandlerMiddleware.handleAsyncError).toBe("function");
      expect(ErrorHandlerMiddleware.handleAsyncError).toBeDefined();
    });

    it("should have handleValidationError method", () => {
      expect(typeof ErrorHandlerMiddleware.handleValidationError).toBe(
        "function"
      );
      expect(ErrorHandlerMiddleware.handleValidationError).toBeDefined();
    });

    it("should have handleDuplicateKeyError method", () => {
      expect(typeof ErrorHandlerMiddleware.handleDuplicateKeyError).toBe(
        "function"
      );
      expect(ErrorHandlerMiddleware.handleDuplicateKeyError).toBeDefined();
    });

    it("should have handleCastError method", () => {
      expect(typeof ErrorHandlerMiddleware.handleCastError).toBe("function");
      expect(ErrorHandlerMiddleware.handleCastError).toBeDefined();
    });

    it("should have handleJWTError method", () => {
      expect(typeof ErrorHandlerMiddleware.handleJWTError).toBe("function");
      expect(ErrorHandlerMiddleware.handleJWTError).toBeDefined();
    });

    it("should have handleJWTExpiredError method", () => {
      expect(typeof ErrorHandlerMiddleware.handleJWTExpiredError).toBe(
        "function"
      );
      expect(ErrorHandlerMiddleware.handleJWTExpiredError).toBeDefined();
    });

    it("should have globalErrorHandler method", () => {
      expect(typeof ErrorHandlerMiddleware.globalErrorHandler).toBe("function");
      expect(ErrorHandlerMiddleware.globalErrorHandler).toBeDefined();
    });
  });
});
