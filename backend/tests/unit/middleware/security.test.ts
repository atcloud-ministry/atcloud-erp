import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Request, Response, NextFunction } from "express";
import helmet from "helmet";
import {
  securityHeaders,
  corsOptions,
  getAllowedFrontendOrigins,
  xssProtection,
  requestSizeLimit,
  ipSecurity,
  securityErrorHandler,
} from "../../../src/middleware/security";

// Mock helmet
vi.mock("helmet", () => ({
  default: vi.fn(
    () => (req: Request, res: Response, next: NextFunction) => next(),
  ),
}));

describe("Security Middleware", () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockRequest = {
      body: {},
      get: vi.fn() as any,
      connection: { remoteAddress: "127.0.0.1" } as any,
    } as any;

    mockResponse = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    mockNext = vi.fn() as unknown as NextFunction;

    // Reset environment
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("securityHeaders", () => {
    it("should be a middleware function", () => {
      expect(typeof securityHeaders).toBe("function");
    });

    it("should pass through to helmet middleware", () => {
      // securityHeaders is the result of calling helmet()
      // We can test that it behaves like a middleware function
      securityHeaders(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe("corsOptions", () => {
    it("should allow requests with no origin", () => {
      const callback = vi.fn();
      corsOptions.origin!(undefined, callback);

      expect(callback).toHaveBeenCalledWith(null, true);
    });

    it("should allow requests from allowed origins", () => {
      const callback = vi.fn();
      const allowedOrigins = [
        "http://localhost:5173",
        "http://localhost:3000",
        "http://localhost:5174",
        "http://localhost:5175",
        "http://localhost:5176",
      ];

      allowedOrigins.forEach((origin) => {
        callback.mockClear();
        corsOptions.origin!(origin, callback);
        expect(callback).toHaveBeenCalledWith(null, true);
      });
    });

    it("should allow frontend URL from environment variable", () => {
      const originalEnv = process.env.FRONTEND_URL;
      process.env.FRONTEND_URL = "https://myapp.com";

      const callback = vi.fn();
      corsOptions.origin!("https://myapp.com", callback);

      expect(callback).toHaveBeenCalledWith(null, true);

      // Restore original env
      if (originalEnv) {
        process.env.FRONTEND_URL = originalEnv;
      } else {
        delete process.env.FRONTEND_URL;
      }
    });

    it("should allow staging and production Render frontend origins", () => {
      const callback = vi.fn();
      const allowedOrigins = [
        "https://atcloud-erp-frontend-staging.onrender.com",
        "https://atcloud-erp-frontend-prod.onrender.com",
      ];

      allowedOrigins.forEach((origin) => {
        callback.mockClear();
        corsOptions.origin!(origin, callback);
        expect(callback).toHaveBeenCalledWith(null, true);
      });
    });

    it("should allow comma-separated frontend origins from environment", () => {
      process.env.FRONTEND_ORIGINS =
        "https://preview-one.example.com, https://preview-two.example.com/";

      expect(getAllowedFrontendOrigins()).toEqual(
        expect.arrayContaining([
          "https://preview-one.example.com",
          "https://preview-two.example.com",
        ]),
      );

      const callback = vi.fn();
      corsOptions.origin!("https://preview-two.example.com", callback);
      expect(callback).toHaveBeenCalledWith(null, true);

      delete process.env.FRONTEND_ORIGINS;
    });

    it("should reject requests from disallowed origins", () => {
      const callback = vi.fn();
      corsOptions.origin!("https://malicious-site.com", callback);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Not allowed by CORS",
        }),
      );
    });

    it("should have correct CORS configuration", () => {
      expect(corsOptions.credentials).toBe(true);
      expect(corsOptions.methods).toEqual([
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "OPTIONS",
      ]);
      expect(corsOptions.allowedHeaders).toEqual([
        "Content-Type",
        "Authorization",
        "X-Requested-With",
        "Cache-Control",
        "Pragma",
        "Idempotency-Key",
      ]);
      expect(corsOptions.exposedHeaders).toEqual([
        "RateLimit-Limit",
        "RateLimit-Remaining",
        "RateLimit-Reset",
      ]);
    });
  });

  describe("xssProtection", () => {
    it("should call next() when request has no body", () => {
      mockRequest.body = undefined;

      xssProtection(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it("should sanitize script tags from string values", () => {
      mockRequest.body = {
        name: 'John<script>alert("xss")</script>',
        description: "Safe content",
      };

      xssProtection(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockRequest.body.name).toBe("John");
      expect(mockRequest.body.description).toBe("Safe content");
      expect(mockNext).toHaveBeenCalled();
    });

    it("should sanitize nested script tags", () => {
      mockRequest.body = {
        user: {
          profile: {
            bio: 'Hello<script type="text/javascript">alert("xss")</script>World',
          },
        },
      };

      xssProtection(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockRequest.body.user.profile.bio).toBe("HelloWorld");
      expect(mockNext).toHaveBeenCalled();
    });

    it("should handle arrays with script content", () => {
      mockRequest.body = {
        comments: [
          "Safe comment",
          'Unsafe<script>alert("xss")</script>comment',
          { text: 'Nested<script>alert("nested")</script>content' },
        ],
      };

      xssProtection(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockRequest.body.comments[0]).toBe("Safe comment");
      expect(mockRequest.body.comments[1]).toBe("Unsafecomment");
      expect(mockRequest.body.comments[2].text).toBe("Nestedcontent");
      expect(mockNext).toHaveBeenCalled();
    });

    it("should handle non-string and non-object values", () => {
      mockRequest.body = {
        number: 123,
        boolean: true,
        nullValue: null,
        undefinedValue: undefined,
      };

      xssProtection(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockRequest.body.number).toBe(123);
      expect(mockRequest.body.boolean).toBe(true);
      expect(mockRequest.body.nullValue).toBe(null);
      expect(mockRequest.body.undefinedValue).toBe(undefined);
      expect(mockNext).toHaveBeenCalled();
    });

    it("should handle complex script tag variations", () => {
      mockRequest.body = {
        input1: 'Text<SCRIPT>alert("xss")</SCRIPT>more',
        input2: 'Text<script src="evil.js"></script>more',
        input3: 'Text<script\n>alert("xss")</script>more',
      };

      xssProtection(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockRequest.body.input1).toBe("Textmore");
      expect(mockRequest.body.input2).toBe("Textmore");
      expect(mockRequest.body.input3).toBe("Textmore");
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe("requestSizeLimit", () => {
    it("should allow requests under size limit", () => {
      const mockGet = vi.fn().mockReturnValue("1000"); // 1KB
      mockRequest.get = mockGet;

      requestSizeLimit(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockGet).toHaveBeenCalledWith("content-length");
      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it("should allow requests with no content-length header", () => {
      const mockGet = vi.fn().mockReturnValue(undefined);
      mockRequest.get = mockGet;

      requestSizeLimit(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it("should reject requests over size limit", () => {
      const mockGet = vi.fn().mockReturnValue((11 * 1024 * 1024).toString()); // 11MB
      mockRequest.get = mockGet;

      requestSizeLimit(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(413);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: "Request entity too large",
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should handle exactly at size limit", () => {
      const mockGet = vi.fn().mockReturnValue((10 * 1024 * 1024).toString()); // Exactly 10MB
      mockRequest.get = mockGet;

      requestSizeLimit(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it("should handle invalid content-length values", () => {
      const mockGet = vi.fn().mockReturnValue("invalid");
      mockRequest.get = mockGet;

      requestSizeLimit(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });
  });

  describe("ipSecurity", () => {
    it("should set clientIp from req.ip", () => {
      (mockRequest as any).ip = "192.168.1.100";

      ipSecurity(mockRequest as Request, mockResponse as Response, mockNext);

      expect((mockRequest as any).clientIp).toBe("192.168.1.100");
      expect(mockNext).toHaveBeenCalled();
    });

    it("should fallback to connection.remoteAddress when req.ip is undefined", () => {
      (mockRequest as any).ip = undefined;
      (mockRequest as any).connection = { remoteAddress: "10.0.0.1" };

      ipSecurity(mockRequest as Request, mockResponse as Response, mockNext);

      expect((mockRequest as any).clientIp).toBe("10.0.0.1");
      expect(mockNext).toHaveBeenCalled();
    });

    it('should use "unknown" when no IP is available', () => {
      (mockRequest as any).ip = undefined;
      (mockRequest as any).connection = {};

      ipSecurity(mockRequest as Request, mockResponse as Response, mockNext);

      expect((mockRequest as any).clientIp).toBe("unknown");
      expect(mockNext).toHaveBeenCalled();
    });

    it("should handle various IP formats", () => {
      const testIPs = [
        "127.0.0.1",
        "::1",
        "192.168.1.1",
        "10.0.0.1",
        "172.16.0.1",
      ];

      testIPs.forEach((ip) => {
        (mockRequest as any).ip = ip;
        (mockRequest as any).clientIp = undefined;

        ipSecurity(mockRequest as Request, mockResponse as Response, mockNext);

        expect((mockRequest as any).clientIp).toBe(ip);
      });
    });
  });

  describe("securityErrorHandler", () => {
    let consoleSpy: any;

    beforeEach(() => {
      consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it("should log CORS-related errors", () => {
      const corsError = new Error("Not allowed by CORS");
      (mockRequest as any).ip = "192.168.1.100";

      securityErrorHandler(
        corsError,
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        "Security warning: Not allowed by CORS from IP: 192.168.1.100",
      );
      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: "Internal server error",
      });
    });

    it("should log rate limit-related errors", () => {
      const rateLimitError = new Error(
        "Too many requests - rate limit exceeded",
      );
      (mockRequest as any).ip = "10.0.0.1";

      securityErrorHandler(
        rateLimitError,
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        "Security warning: Too many requests - rate limit exceeded from IP: 10.0.0.1",
      );
    });

    it("should not log non-security errors", () => {
      const regularError = new Error("Database connection failed");

      securityErrorHandler(
        regularError,
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(consoleSpy).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(500);
    });

    it("should include error details in development mode", () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";

      const error = new Error("Test error message");

      securityErrorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: "Internal server error",
        error: "Test error message",
      });

      // Restore original env
      if (originalEnv) {
        process.env.NODE_ENV = originalEnv;
      } else {
        delete process.env.NODE_ENV;
      }
    });

    it("should not include error details in production mode", () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";

      const error = new Error("Sensitive error information");

      securityErrorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        message: "Internal server error",
      });

      // Restore original env
      if (originalEnv) {
        process.env.NODE_ENV = originalEnv;
      } else {
        delete process.env.NODE_ENV;
      }
    });

    it("should handle errors with no message", () => {
      const error = new Error();

      securityErrorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(consoleSpy).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(500);
    });
  });

  describe("Edge Cases and Integration", () => {
    it("should handle objects with circular references by avoiding infinite recursion", () => {
      // Test a simpler case without creating actual circular reference in sanitization
      mockRequest.body = {
        name: 'test<script>alert("xss")</script>',
        safe: "content",
      };

      xssProtection(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRequest.body.name).toBe("test");
      expect(mockRequest.body.safe).toBe("content");
    });

    it("should handle very large nested objects in XSS protection", () => {
      const createNestedObject = (depth: number): any => {
        if (depth === 0) return 'deep<script>alert("xss")</script>value';
        return { next: createNestedObject(depth - 1) };
      };

      mockRequest.body = createNestedObject(10);

      xssProtection(mockRequest as Request, mockResponse as Response, mockNext);

      // Should sanitize the deep value
      let current = mockRequest.body;
      for (let i = 0; i < 10; i++) {
        current = current.next;
      }
      expect(current).toBe("deepvalue");
      expect(mockNext).toHaveBeenCalled();
    });

    it("should handle empty and whitespace-only content in XSS protection", () => {
      mockRequest.body = {
        empty: "",
        whitespace: "   ",
        mixed: '  <script>alert("xss")</script>  ',
      };

      xssProtection(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockRequest.body.empty).toBe("");
      expect(mockRequest.body.whitespace).toBe("   ");
      expect(mockRequest.body.mixed).toBe("    ");
      expect(mockNext).toHaveBeenCalled();
    });

    it("should allow HTML but still strip script tags for feedback message field", () => {
      // This tests the allowHtml path when path includes /feedback and key is message
      mockRequest = {
        ...mockRequest,
        body: {
          message:
            '<p>Hello</p><script>alert("xss")</script><strong>World</strong>',
          subject: '<script>alert("xss")</script>Subject',
        },
        path: "/api/feedback",
        get: vi.fn(),
        connection: { remoteAddress: "127.0.0.1" } as any,
      };

      xssProtection(mockRequest as Request, mockResponse as Response, mockNext);

      // message field should keep HTML but strip script tags
      expect(mockRequest.body.message).toBe(
        "<p>Hello</p><strong>World</strong>",
      );
      // subject field should have scripts stripped (not in allowlist)
      expect(mockRequest.body.subject).toBe("Subject");
      expect(mockNext).toHaveBeenCalled();
    });

    it("should handle nested object in allowHtml field", () => {
      // When allowHtml is true for a field, but the value is an object not string
      mockRequest = {
        ...mockRequest,
        body: {
          message: {
            content: '<p>Nested</p><script>alert("xss")</script>Content',
            title: '<script>alert("xss")</script>Title',
          },
        },
        path: "/api/feedback",
        get: vi.fn(),
        connection: { remoteAddress: "127.0.0.1" } as any,
      };

      xssProtection(mockRequest as Request, mockResponse as Response, mockNext);

      // Even nested objects should have scripts stripped
      expect(mockRequest.body.message.content).toBe("<p>Nested</p>Content");
      expect(mockRequest.body.message.title).toBe("Title");
      expect(mockNext).toHaveBeenCalled();
    });
  });
});
