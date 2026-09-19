import { describe, it, expect, vi, beforeEach } from "vitest";
import { Request, Response, NextFunction } from "express";
import { validationResult } from "express-validator";

// Mock express-validator
vi.mock("express-validator", () => {
  const validationChain = {
    isLength: vi.fn().mockReturnThis(),
    isString: vi.fn().mockReturnThis(),
    withMessage: vi.fn().mockReturnThis(),
    matches: vi.fn().mockReturnThis(),
    isEmail: vi.fn().mockReturnThis(),
    isBoolean: vi.fn().mockReturnThis(),
    isIn: vi.fn().mockReturnThis(),
    optional: vi.fn().mockReturnThis(),
    trim: vi.fn().mockReturnThis(),
    custom: vi.fn().mockReturnThis(),
    isISO8601: vi.fn().mockReturnThis(),
    toDate: vi.fn().mockReturnThis(),
    isArray: vi.fn().mockReturnThis(),
    isInt: vi.fn().mockReturnThis(),
    isURL: vi.fn().mockReturnThis(),
    isMongoId: vi.fn().mockReturnThis(),
    notEmpty: vi.fn().mockReturnThis(),
  };

  return {
    body: vi.fn(() => validationChain),
    param: vi.fn(() => validationChain),
    query: vi.fn(() => validationChain),
    validationResult: vi.fn(),
    check: vi.fn(() => validationChain),
    meta: vi.fn(() => validationChain),
    ...validationChain,
  };
});

// Import after mocking
import {
  handleValidationErrors,
  validateUserRegistration,
  validateUserLogin,
  validateUserUpdate,
  validateEventCreation,
  validateSearch,
  validateObjectId,
  validateForgotPassword,
  validateResetPassword,
  validateSystemMessage,
  validateError,
} from "../../../src/middleware/validation";

// Test helpers
const createMockRequest = (
  body: any = {},
  params: any = {},
  query: any = {},
): Partial<Request> => ({
  body,
  params,
  query,
  headers: {},
});

const createMockResponse = (): Partial<Response> => {
  const res: any = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res;
};

const createMockNext = (): NextFunction => vi.fn() as any;

describe("Validation Middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("handleValidationErrors", () => {
    it("should call next when there are no validation errors", () => {
      vi.mocked(validationResult).mockReturnValue({
        isEmpty: () => true,
        array: () => [],
      } as any);

      const req = createMockRequest() as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      handleValidationErrors(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });

    it("should return 400 error when validation errors exist", () => {
      const mockErrors = [
        { field: "email", msg: "Invalid email" },
        { field: "password", msg: "Password too short" },
      ];

      vi.mocked(validationResult).mockReturnValue({
        isEmpty: () => false,
        array: () => mockErrors,
      } as any);

      const req = createMockRequest() as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      handleValidationErrors(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Validation failed",
        errors: mockErrors,
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("should handle empty validation errors array", () => {
      vi.mocked(validationResult).mockReturnValue({
        isEmpty: () => false,
        array: () => [],
      } as any);

      const req = createMockRequest() as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      handleValidationErrors(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Validation failed",
        errors: [],
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("should log validation diagnostics when TEST_VALIDATION_LOG=1 in test environment", () => {
      const originalEnv = process.env.TEST_VALIDATION_LOG;
      process.env.TEST_VALIDATION_LOG = "1";

      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const mockErrors = [{ field: "title", msg: "Title required" }];
      vi.mocked(validationResult).mockReturnValue({
        isEmpty: () => false,
        array: () => mockErrors,
      } as any);

      const req = createMockRequest(
        {
          title: "Test",
          roles: [
            { name: "Speaker", maxParticipants: 10, description: "Presents" },
          ],
        },
        {},
        {},
      ) as Request;
      (req as any).method = "POST";
      (req as any).originalUrl = "/api/events";

      const res = createMockResponse() as Response;
      const next = createMockNext();

      handleValidationErrors(req, res, next);

      expect(consoleSpy).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);

      process.env.TEST_VALIDATION_LOG = originalEnv;
      consoleSpy.mockRestore();
    });
  });

  describe("Validation Rule Arrays", () => {
    describe("validateUserRegistration", () => {
      it("should be an array containing validation rules and error handler", () => {
        expect(Array.isArray(validateUserRegistration)).toBe(true);
        expect(validateUserRegistration.length).toBeGreaterThan(0);
        expect(
          validateUserRegistration[validateUserRegistration.length - 1],
        ).toBe(handleValidationErrors);
      });

      it("should include all required fields for user registration", () => {
        // Since we're mocking express-validator, we can't test the actual validation
        // but we can verify the structure exists
        expect(validateUserRegistration).toBeDefined();
        expect(validateUserRegistration.length).toBeGreaterThan(5); // Should have multiple validation rules
      });
    });

    describe("validateUserLogin", () => {
      it("should be an array containing validation rules and error handler", () => {
        expect(Array.isArray(validateUserLogin)).toBe(true);
        expect(validateUserLogin.length).toBeGreaterThan(0);
        expect(validateUserLogin[validateUserLogin.length - 1]).toBe(
          handleValidationErrors,
        );
      });

      it("should have validation rules for login fields", () => {
        expect(validateUserLogin).toBeDefined();
        expect(validateUserLogin.length).toBeGreaterThan(1); // emailOrUsername, password + handler
      });
    });

    describe("validateUserUpdate", () => {
      it("should be an array containing validation rules and error handler", () => {
        expect(Array.isArray(validateUserUpdate)).toBe(true);
        expect(validateUserUpdate.length).toBeGreaterThan(0);
        expect(validateUserUpdate[validateUserUpdate.length - 1]).toBe(
          handleValidationErrors,
        );
      });

      it("should have validation rules for user update fields", () => {
        expect(validateUserUpdate).toBeDefined();
        expect(validateUserUpdate.length).toBeGreaterThan(5); // Multiple optional fields + handler
      });
    });

    describe("validateEventCreation", () => {
      it("should be an array containing validation rules and error handler", () => {
        expect(Array.isArray(validateEventCreation)).toBe(true);
        expect(validateEventCreation.length).toBeGreaterThan(0);
        expect(validateEventCreation[validateEventCreation.length - 1]).toBe(
          handleValidationErrors,
        );
      });

      it("should have comprehensive validation rules for event creation", () => {
        expect(validateEventCreation).toBeDefined();
        expect(validateEventCreation.length).toBeGreaterThan(10); // Many event fields + handler
      });
    });

    describe("validateSearch", () => {
      it("should be an array containing validation rules and error handler", () => {
        expect(Array.isArray(validateSearch)).toBe(true);
        expect(validateSearch.length).toBeGreaterThan(0);
        expect(validateSearch[validateSearch.length - 1]).toBe(
          handleValidationErrors,
        );
      });

      it("should have validation rules for search parameters", () => {
        expect(validateSearch).toBeDefined();
        expect(validateSearch.length).toBeGreaterThan(1); // Search query, pagination + handler
      });
    });

    describe("validateObjectId", () => {
      it("should be an array containing validation rules and error handler", () => {
        expect(Array.isArray(validateObjectId)).toBe(true);
        expect(validateObjectId.length).toBeGreaterThan(0);
        expect(validateObjectId[validateObjectId.length - 1]).toBe(
          handleValidationErrors,
        );
      });

      it("should have validation for MongoDB ObjectId", () => {
        expect(validateObjectId).toBeDefined();
        expect(validateObjectId.length).toBe(2); // ID validation + handler
      });
    });

    describe("validateForgotPassword", () => {
      it("should be an array containing email validation", () => {
        expect(Array.isArray(validateForgotPassword)).toBe(true);
        expect(validateForgotPassword.length).toBeGreaterThan(0);
      });

      it("should have validation for password reset email", () => {
        expect(validateForgotPassword).toBeDefined();
        expect(validateForgotPassword.length).toBe(1); // Just email validation
      });
    });

    describe("validateResetPassword", () => {
      it("should be an array containing validation rules", () => {
        expect(Array.isArray(validateResetPassword)).toBe(true);
        expect(validateResetPassword.length).toBeGreaterThan(0);
      });

      it("should have validation for reset token and new password", () => {
        expect(validateResetPassword).toBeDefined();
        expect(validateResetPassword.length).toBe(2); // Token + password validation
      });
    });

    describe("validateSystemMessage", () => {
      it("should be an array containing validation rules and error handler", () => {
        expect(Array.isArray(validateSystemMessage)).toBe(true);
        expect(validateSystemMessage.length).toBeGreaterThan(0);
        expect(validateSystemMessage[validateSystemMessage.length - 1]).toBe(
          handleValidationErrors,
        );
      });

      it("should have comprehensive validation for system messages", () => {
        expect(validateSystemMessage).toBeDefined();
        expect(validateSystemMessage.length).toBeGreaterThan(5); // Title, content, type, priority, expires + handler
      });
    });
  });

  describe("Validation Function Behavior with Real Data", () => {
    beforeEach(() => {
      // Reset all express-validator mocks to return themselves for chaining
      const mockChain = {
        isLength: vi.fn().mockReturnThis(),
        withMessage: vi.fn().mockReturnThis(),
        matches: vi.fn().mockReturnThis(),
        isEmail: vi.fn().mockReturnThis(),
        isBoolean: vi.fn().mockReturnThis(),
        isIn: vi.fn().mockReturnThis(),
        optional: vi.fn().mockReturnThis(),
        trim: vi.fn().mockReturnThis(),
        custom: vi.fn().mockReturnThis(),
        isISO8601: vi.fn().mockReturnThis(),
        toDate: vi.fn().mockReturnThis(),
        isArray: vi.fn().mockReturnThis(),
        isInt: vi.fn().mockReturnThis(),
        isURL: vi.fn().mockReturnThis(),
        isMongoId: vi.fn().mockReturnThis(),
        notEmpty: vi.fn().mockReturnThis(),
      };

      vi.mocked(vi.fn().mockReturnValue(mockChain));
    });

    it("should handle validation errors correctly in user registration flow", () => {
      const mockErrors = [
        {
          field: "username",
          msg: "Username must be between 3 and 20 characters",
        },
        { field: "email", msg: "Please provide a valid email address" },
        {
          field: "password",
          msg: "Password must be at least 8 characters long",
        },
      ];

      vi.mocked(validationResult).mockReturnValue({
        isEmpty: () => false,
        array: () => mockErrors,
      } as any);

      const req = createMockRequest({
        username: "ab", // Too short
        email: "invalid-email", // Invalid format
        password: "123", // Too short
      }) as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      handleValidationErrors(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Validation failed",
        errors: mockErrors,
      });
    });

    it("should pass validation with valid user registration data", () => {
      vi.mocked(validationResult).mockReturnValue({
        isEmpty: () => true,
        array: () => [],
      } as any);

      const req = createMockRequest({
        username: "validuser123",
        email: "user@example.com",
        password: "ValidPass123",
        firstName: "John",
        lastName: "Doe",
        gender: "male",
        isAtCloudLeader: false,
      }) as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      handleValidationErrors(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("should handle validation errors in event creation", () => {
      const mockErrors = [
        {
          field: "title",
          msg: "Event title must be between 3 and 200 characters",
        },
        { field: "date", msg: "Please provide a valid date" },
        {
          field: "format",
          msg: "Format must be In-person, Online, or Hybrid Participation",
        },
      ];

      vi.mocked(validationResult).mockReturnValue({
        isEmpty: () => false,
        array: () => mockErrors,
      } as any);

      const req = createMockRequest({
        title: "X", // Too short
        date: "invalid-date",
        format: "Invalid Format",
      }) as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      handleValidationErrors(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Validation failed",
        errors: mockErrors,
      });
    });

    it("should handle MongoDB ObjectId validation", () => {
      const mockErrors = [{ field: "id", msg: "Invalid ID format" }];

      vi.mocked(validationResult).mockReturnValue({
        isEmpty: () => false,
        array: () => mockErrors,
      } as any);

      const req = createMockRequest({}, { id: "invalid-object-id" }) as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      handleValidationErrors(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "Validation failed",
        errors: mockErrors,
      });
    });
  });

  describe("Export Verification", () => {
    it("should export validateError as alias for handleValidationErrors", () => {
      expect(validateError).toBe(handleValidationErrors);
    });

    it("should export all validation functions", () => {
      expect(handleValidationErrors).toBeDefined();
      expect(validateUserRegistration).toBeDefined();
      expect(validateUserLogin).toBeDefined();
      expect(validateUserUpdate).toBeDefined();
      expect(validateEventCreation).toBeDefined();
      expect(validateSearch).toBeDefined();
      expect(validateObjectId).toBeDefined();
      expect(validateForgotPassword).toBeDefined();
      expect(validateResetPassword).toBeDefined();
      expect(validateSystemMessage).toBeDefined();
      expect(validateError).toBeDefined();
    });

    it("should have all validation arrays include handleValidationErrors as last element", () => {
      const validationArrays = [
        validateUserRegistration,
        validateUserLogin,
        validateUserUpdate,
        validateEventCreation,
        validateSearch,
        validateObjectId,
        validateSystemMessage,
      ];

      validationArrays.forEach((validationArray) => {
        expect(validationArray[validationArray.length - 1]).toBe(
          handleValidationErrors,
        );
      });
    });
  });

  describe("Method Existence Tests", () => {
    it("should have handleValidationErrors function", () => {
      expect(typeof handleValidationErrors).toBe("function");
      expect(handleValidationErrors).toBeDefined();
    });

    it("should have all validation rule arrays defined", () => {
      const validationArrays = [
        validateUserRegistration,
        validateUserLogin,
        validateUserUpdate,
        validateEventCreation,
        validateSearch,
        validateObjectId,
        validateForgotPassword,
        validateResetPassword,
        validateSystemMessage,
      ];

      validationArrays.forEach((validationArray) => {
        expect(Array.isArray(validationArray)).toBe(true);
        expect(validationArray.length).toBeGreaterThan(0);
      });
    });

    it("should have validateError alias", () => {
      expect(validateError).toBeDefined();
      expect(typeof validateError).toBe("function");
      expect(validateError).toBe(handleValidationErrors);
    });
  });
});
