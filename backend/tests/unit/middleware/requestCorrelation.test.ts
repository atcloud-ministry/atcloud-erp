import { describe, it, expect, vi, beforeEach } from "vitest";
import { Request, Response, NextFunction } from "express";
import {
  requestCorrelation,
  getCorrelationId,
  createCorrelationContext,
} from "../../../src/middleware/requestCorrelation";

describe("Request Correlation Middleware", () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockRequest = {
      headers: {},
      method: "GET",
      path: "/test",
      ip: "127.0.0.1",
      get: vi
        .fn()
        .mockImplementation((header: string) =>
          header === "User-Agent" ? "test-agent" : undefined,
        ) as any,
    };
    mockResponse = {
      setHeader: vi.fn(),
    };
    mockNext = vi.fn() as any;
  });

  it("should generate correlation ID when none provided", () => {
    const middleware = requestCorrelation();
    middleware(mockRequest as Request, mockResponse as Response, mockNext);

    expect((mockRequest as any).correlationId).toBeDefined();
    expect(typeof (mockRequest as any).correlationId).toBe("string");
    expect((mockRequest as any).correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(mockResponse.setHeader).toHaveBeenCalledWith(
      "x-correlation-id",
      (mockRequest as any).correlationId,
    );
    expect(mockNext).toHaveBeenCalled();
  });

  it("should use existing correlation ID from headers", () => {
    const existingId = "existing-correlation-id";
    mockRequest.headers = { "x-correlation-id": existingId };

    const middleware = requestCorrelation();
    middleware(mockRequest as Request, mockResponse as Response, mockNext);

    expect((mockRequest as any).correlationId).toBe(existingId);
    expect(mockResponse.setHeader).toHaveBeenCalledWith(
      "x-correlation-id",
      existingId,
    );
    expect(mockNext).toHaveBeenCalled();
  });

  it("should use first value when correlation ID header is an array", () => {
    const firstId = "first-correlation-id";
    const secondId = "second-correlation-id";
    mockRequest.headers = { "x-correlation-id": [firstId, secondId] };

    const middleware = requestCorrelation();
    middleware(mockRequest as Request, mockResponse as Response, mockNext);

    expect((mockRequest as any).correlationId).toBe(firstId);
    expect(mockResponse.setHeader).toHaveBeenCalledWith(
      "x-correlation-id",
      firstId,
    );
    expect(mockNext).toHaveBeenCalled();
  });

  it.each([
    ["whitespace", "request id with spaces"],
    ["an email address", "person@example.com"],
    ["an IPv4 address", "203.0.113.10"],
    ["an IPv6 address", "2001:db8::1"],
    ["an embedded IPv4 address", "trace-203.0.113.10"],
    ["an IPv4 address adjacent to a prefix", "trace203.0.113.10"],
    ["an IPv4 address adjacent to a suffix", "203.0.113.10trace"],
    ["an embedded IPv6 address", "run-2001:db8::1"],
    ["an IPv6 address adjacent to a prefix", "trace2001:db8::1face"],
    ["an IPv6 address adjacent to a suffix", "2001:db8::1trace"],
    ["an oversized value", "x".repeat(129)],
  ])("should replace %s in a client correlation ID", (_label, invalidId) => {
    mockRequest.headers = { "x-correlation-id": invalidId };
    const generator = vi.fn(() => "server-generated-id");

    const middleware = requestCorrelation({ generator });
    middleware(mockRequest as Request, mockResponse as Response, mockNext);

    expect(generator).toHaveBeenCalledTimes(1);
    expect((mockRequest as any).correlationId).toBe("server-generated-id");
    expect(mockResponse.setHeader).toHaveBeenCalledWith(
      "x-correlation-id",
      "server-generated-id",
    );
    expect(mockNext).toHaveBeenCalled();
  });

  it("should reject an invalid first array value instead of trusting a later value", () => {
    mockRequest.headers = {
      "x-correlation-id": ["person@example.com", "valid-later-id"],
    };

    const middleware = requestCorrelation({
      generator: () => "server-generated-id",
    });
    middleware(mockRequest as Request, mockResponse as Response, mockNext);

    expect((mockRequest as any).correlationId).toBe("server-generated-id");
    expect(mockResponse.setHeader).toHaveBeenCalledWith(
      "x-correlation-id",
      "server-generated-id",
    );
  });

  it("should support custom header name", () => {
    const customId = "custom-id";
    mockRequest.headers = { "x-custom-trace-id": customId };

    const middleware = requestCorrelation({ headerName: "x-custom-trace-id" });
    middleware(mockRequest as Request, mockResponse as Response, mockNext);

    expect((mockRequest as any).correlationId).toBe(customId);
    expect(mockResponse.setHeader).toHaveBeenCalledWith(
      "x-custom-trace-id",
      customId,
    );
  });

  it("should support custom generator", () => {
    const customGenerator = () => "custom-generated-id";

    const middleware = requestCorrelation({ generator: customGenerator });
    middleware(mockRequest as Request, mockResponse as Response, mockNext);

    expect((mockRequest as any).correlationId).toBe("custom-generated-id");
    expect(mockResponse.setHeader).toHaveBeenCalledWith(
      "x-correlation-id",
      "custom-generated-id",
    );
  });

  it.each([
    ["returns an invalid value", () => "invalid generated@example.com"],
    ["throws", () => {
      throw new Error("generator failed");
    }],
  ])("should use a UUID when a custom generator %s", (_label, generator) => {
    const middleware = requestCorrelation({ generator });
    middleware(mockRequest as Request, mockResponse as Response, mockNext);

    expect((mockRequest as any).correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(mockResponse.setHeader).toHaveBeenCalledWith(
      "x-correlation-id",
      (mockRequest as any).correlationId,
    );
  });

  describe("Helper functions", () => {
    it("getCorrelationId should return correlation ID from request", () => {
      (mockRequest as any).correlationId = "test-id";
      expect(getCorrelationId(mockRequest as Request)).toBe("test-id");
    });

    it("getCorrelationId should return undefined when no correlation ID", () => {
      expect(getCorrelationId(mockRequest as Request)).toBeUndefined();
    });

    it("createCorrelationContext should create context object", () => {
      (mockRequest as any).correlationId = "test-id";

      const context = createCorrelationContext(mockRequest as Request);

      expect(context).toEqual({
        correlationId: "test-id",
        method: "GET",
        path: "/test",
        ip: "127.0.0.1",
        userAgent: "test-agent",
      });
    });
  });
});
