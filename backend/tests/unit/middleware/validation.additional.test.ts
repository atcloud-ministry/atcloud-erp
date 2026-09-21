/**
 * Additional tests for validation middleware covering:
 * - validateUserLogin
 * - validateUserUpdate
 * - validateSearch
 * - validateForgotPassword
 * - validateResetPassword
 * - validateSystemMessage
 */
import { describe, it, expect, vi } from "vitest";
import { Request, Response, NextFunction } from "express";
import { validationResult } from "express-validator";

// Import the actual validation rules
import {
  validateUserLogin,
  validateUserUpdate,
  validateSearch,
  validateForgotPassword,
  validateResetPassword,
  validateSystemMessage,
} from "../../../src/middleware/validation";

// Helper to run validation chain against mock request (for body validation)
async function runBodyValidation(
  validationChain: unknown[],
  body: Record<string, unknown>,
  hasErrorHandler = true,
): Promise<{ errors: Array<{ msg: string; path: string }> }> {
  const req = {
    body,
    query: {},
    params: {},
    cookies: {},
    get: () => undefined,
    headers: {},
  } as unknown as Request;
  const res = {} as Response;
  const next = vi.fn() as unknown as NextFunction;

  // Run each validator/middleware except the last (error handler) if present
  const endIndex = hasErrorHandler
    ? validationChain.length - 1
    : validationChain.length;
  for (let i = 0; i < endIndex; i++) {
    const middleware = validationChain[i] as (
      req: Request,
      res: Response,
      next: NextFunction,
    ) => Promise<void>;
    await middleware(req, res, next);
  }

  const result = validationResult(req);
  return {
    errors: result.array() as Array<{ msg: string; path: string }>,
  };
}

// Helper to run validation chain against mock request (for query validation)
async function runQueryValidation(
  validationChain: unknown[],
  query: Record<string, unknown>,
): Promise<{ errors: Array<{ msg: string; path: string }> }> {
  const req = {
    body: {},
    query,
    params: {},
    cookies: {},
    get: () => undefined,
    headers: {},
  } as unknown as Request;
  const res = {} as Response;
  const next = vi.fn() as unknown as NextFunction;

  for (let i = 0; i < validationChain.length - 1; i++) {
    const middleware = validationChain[i] as (
      req: Request,
      res: Response,
      next: NextFunction,
    ) => Promise<void>;
    await middleware(req, res, next);
  }

  const result = validationResult(req);
  return {
    errors: result.array() as Array<{ msg: string; path: string }>,
  };
}

describe("User Login Validation Rules", () => {
  describe("validateUserLogin", () => {
    it("should accept valid login with email", async () => {
      const result = await runBodyValidation(validateUserLogin, {
        emailOrUsername: "user@example.com",
        password: "Password123",
      });
      expect(result.errors).toHaveLength(0);
    });

    it("should accept valid login with username", async () => {
      const result = await runBodyValidation(validateUserLogin, {
        emailOrUsername: "validuser123",
        password: "Password123",
      });
      expect(result.errors).toHaveLength(0);
    });

    it("should accept emailOrUsername at minimum length (3 chars)", async () => {
      const result = await runBodyValidation(validateUserLogin, {
        emailOrUsername: "abc",
        password: "p",
      });
      const emailErrors = result.errors.filter(
        (e) => e.path === "emailOrUsername",
      );
      expect(emailErrors).toHaveLength(0);
    });

    it("should reject emailOrUsername shorter than 3 characters", async () => {
      const result = await runBodyValidation(validateUserLogin, {
        emailOrUsername: "ab",
        password: "Password123",
      });
      const emailErrors = result.errors.filter(
        (e) => e.path === "emailOrUsername",
      );
      expect(emailErrors.length).toBeGreaterThan(0);
    });

    it("should reject empty emailOrUsername", async () => {
      const result = await runBodyValidation(validateUserLogin, {
        emailOrUsername: "",
        password: "Password123",
      });
      const emailErrors = result.errors.filter(
        (e) => e.path === "emailOrUsername",
      );
      expect(emailErrors.length).toBeGreaterThan(0);
    });

    it("should accept any non-empty password", async () => {
      const result = await runBodyValidation(validateUserLogin, {
        emailOrUsername: "user@example.com",
        password: "x",
      });
      const passwordErrors = result.errors.filter((e) => e.path === "password");
      expect(passwordErrors).toHaveLength(0);
    });

    it("should reject empty password", async () => {
      const result = await runBodyValidation(validateUserLogin, {
        emailOrUsername: "user@example.com",
        password: "",
      });
      const passwordErrors = result.errors.filter((e) => e.path === "password");
      expect(passwordErrors.length).toBeGreaterThan(0);
    });

    it("should reject missing password", async () => {
      const result = await runBodyValidation(validateUserLogin, {
        emailOrUsername: "user@example.com",
      });
      const passwordErrors = result.errors.filter((e) => e.path === "password");
      expect(passwordErrors.length).toBeGreaterThan(0);
    });

    it("should reject missing emailOrUsername", async () => {
      const result = await runBodyValidation(validateUserLogin, {
        password: "Password123",
      });
      const emailErrors = result.errors.filter(
        (e) => e.path === "emailOrUsername",
      );
      expect(emailErrors.length).toBeGreaterThan(0);
    });
  });
});

describe("User Update Validation Rules", () => {
  describe("validateUserUpdate", () => {
    it("should accept empty body (all fields optional)", async () => {
      const result = await runBodyValidation(validateUserUpdate, {});
      expect(result.errors).toHaveLength(0);
    });

    it("should accept valid firstName", async () => {
      const result = await runBodyValidation(validateUserUpdate, {
        firstName: "John",
      });
      const firstNameErrors = result.errors.filter(
        (e) => e.path === "firstName",
      );
      expect(firstNameErrors).toHaveLength(0);
    });

    it("should accept empty firstName", async () => {
      const result = await runBodyValidation(validateUserUpdate, {
        firstName: "",
      });
      const firstNameErrors = result.errors.filter(
        (e) => e.path === "firstName",
      );
      expect(firstNameErrors).toHaveLength(0);
    });

    it("should reject firstName exceeding 50 characters", async () => {
      const result = await runBodyValidation(validateUserUpdate, {
        firstName: "A".repeat(51),
      });
      const firstNameErrors = result.errors.filter(
        (e) => e.path === "firstName",
      );
      expect(firstNameErrors.length).toBeGreaterThan(0);
    });

    it("should accept valid lastName", async () => {
      const result = await runBodyValidation(validateUserUpdate, {
        lastName: "Doe",
      });
      const lastNameErrors = result.errors.filter((e) => e.path === "lastName");
      expect(lastNameErrors).toHaveLength(0);
    });

    it("should accept empty lastName", async () => {
      const result = await runBodyValidation(validateUserUpdate, {
        lastName: "",
      });
      const lastNameErrors = result.errors.filter((e) => e.path === "lastName");
      expect(lastNameErrors).toHaveLength(0);
    });

    it("should reject lastName exceeding 50 characters", async () => {
      const result = await runBodyValidation(validateUserUpdate, {
        lastName: "B".repeat(51),
      });
      const lastNameErrors = result.errors.filter((e) => e.path === "lastName");
      expect(lastNameErrors.length).toBeGreaterThan(0);
    });

    it("should accept valid phone number", async () => {
      const result = await runBodyValidation(validateUserUpdate, {
        phone: "+1 (555) 123-4567",
      });
      const phoneErrors = result.errors.filter((e) => e.path === "phone");
      expect(phoneErrors).toHaveLength(0);
    });

    it("should accept empty phone", async () => {
      const result = await runBodyValidation(validateUserUpdate, {
        phone: "",
      });
      const phoneErrors = result.errors.filter((e) => e.path === "phone");
      expect(phoneErrors).toHaveLength(0);
    });

    it("should reject phone with too few digits", async () => {
      const result = await runBodyValidation(validateUserUpdate, {
        phone: "123456", // only 6 digits
      });
      const phoneErrors = result.errors.filter((e) => e.path === "phone");
      expect(phoneErrors.length).toBeGreaterThan(0);
    });

    it("should reject phone with too many digits", async () => {
      const result = await runBodyValidation(validateUserUpdate, {
        phone: "1234567890123456", // 16 digits
      });
      const phoneErrors = result.errors.filter((e) => e.path === "phone");
      expect(phoneErrors.length).toBeGreaterThan(0);
    });

    it("should accept male gender", async () => {
      const result = await runBodyValidation(validateUserUpdate, {
        gender: "male",
      });
      const genderErrors = result.errors.filter((e) => e.path === "gender");
      expect(genderErrors).toHaveLength(0);
    });

    it("should accept female gender", async () => {
      const result = await runBodyValidation(validateUserUpdate, {
        gender: "female",
      });
      const genderErrors = result.errors.filter((e) => e.path === "gender");
      expect(genderErrors).toHaveLength(0);
    });

    it("should accept empty gender", async () => {
      const result = await runBodyValidation(validateUserUpdate, {
        gender: "",
      });
      const genderErrors = result.errors.filter((e) => e.path === "gender");
      expect(genderErrors).toHaveLength(0);
    });

    it("should reject invalid gender value", async () => {
      const result = await runBodyValidation(validateUserUpdate, {
        gender: "other",
      });
      const genderErrors = result.errors.filter((e) => e.path === "gender");
      expect(genderErrors.length).toBeGreaterThan(0);
    });

    it("should accept valid occupation", async () => {
      const result = await runBodyValidation(validateUserUpdate, {
        occupation: "Software Engineer",
      });
      const occErrors = result.errors.filter((e) => e.path === "occupation");
      expect(occErrors).toHaveLength(0);
    });

    it("should reject occupation exceeding 100 characters", async () => {
      const result = await runBodyValidation(validateUserUpdate, {
        occupation: "O".repeat(101),
      });
      const occErrors = result.errors.filter((e) => e.path === "occupation");
      expect(occErrors.length).toBeGreaterThan(0);
    });

    it("should accept valid company", async () => {
      const result = await runBodyValidation(validateUserUpdate, {
        company: "Tech Corp",
      });
      const compErrors = result.errors.filter((e) => e.path === "company");
      expect(compErrors).toHaveLength(0);
    });

    it("should reject company exceeding 100 characters", async () => {
      const result = await runBodyValidation(validateUserUpdate, {
        company: "C".repeat(101),
      });
      const compErrors = result.errors.filter((e) => e.path === "company");
      expect(compErrors.length).toBeGreaterThan(0);
    });

    it("should accept valid weeklyChurch", async () => {
      const result = await runBodyValidation(validateUserUpdate, {
        weeklyChurch: "First Baptist Church",
      });
      const churchErrors = result.errors.filter(
        (e) => e.path === "weeklyChurch",
      );
      expect(churchErrors).toHaveLength(0);
    });

    it("should reject weeklyChurch exceeding 100 characters", async () => {
      const result = await runBodyValidation(validateUserUpdate, {
        weeklyChurch: "C".repeat(101),
      });
      const churchErrors = result.errors.filter(
        (e) => e.path === "weeklyChurch",
      );
      expect(churchErrors.length).toBeGreaterThan(0);
    });

    it("should accept valid roleInAtCloud", async () => {
      const result = await runBodyValidation(validateUserUpdate, {
        roleInAtCloud: "Small Group Leader",
      });
      const roleErrors = result.errors.filter(
        (e) => e.path === "roleInAtCloud",
      );
      expect(roleErrors).toHaveLength(0);
    });

    it("should reject roleInAtCloud exceeding 100 characters", async () => {
      const result = await runBodyValidation(validateUserUpdate, {
        roleInAtCloud: "R".repeat(101),
      });
      const roleErrors = result.errors.filter(
        (e) => e.path === "roleInAtCloud",
      );
      expect(roleErrors.length).toBeGreaterThan(0);
    });

    it("should accept isAtCloudLeader boolean", async () => {
      const result = await runBodyValidation(validateUserUpdate, {
        isAtCloudLeader: true,
      });
      const leaderErrors = result.errors.filter(
        (e) => e.path === "isAtCloudLeader",
      );
      expect(leaderErrors).toHaveLength(0);
    });

    it("should reject non-boolean isAtCloudLeader", async () => {
      const result = await runBodyValidation(validateUserUpdate, {
        isAtCloudLeader: "yes",
      });
      const leaderErrors = result.errors.filter(
        (e) => e.path === "isAtCloudLeader",
      );
      expect(leaderErrors.length).toBeGreaterThan(0);
    });
  });
});

describe("Search Validation Rules", () => {
  describe("validateSearch", () => {
    it("should accept valid search query", async () => {
      const result = await runQueryValidation(validateSearch, {
        q: "search term",
      });
      const qErrors = result.errors.filter((e) => e.path === "q");
      expect(qErrors).toHaveLength(0);
    });

    it("should accept query at minimum length (2 chars)", async () => {
      const result = await runQueryValidation(validateSearch, {
        q: "ab",
      });
      const qErrors = result.errors.filter((e) => e.path === "q");
      expect(qErrors).toHaveLength(0);
    });

    it("should accept query at maximum length (100 chars)", async () => {
      const result = await runQueryValidation(validateSearch, {
        q: "Q".repeat(100),
      });
      const qErrors = result.errors.filter((e) => e.path === "q");
      expect(qErrors).toHaveLength(0);
    });

    it("should reject query shorter than 2 characters", async () => {
      const result = await runQueryValidation(validateSearch, {
        q: "a",
      });
      const qErrors = result.errors.filter((e) => e.path === "q");
      expect(qErrors.length).toBeGreaterThan(0);
      expect(qErrors[0].msg).toContain("2");
    });

    it("should reject query exceeding 100 characters", async () => {
      const result = await runQueryValidation(validateSearch, {
        q: "Q".repeat(101),
      });
      const qErrors = result.errors.filter((e) => e.path === "q");
      expect(qErrors.length).toBeGreaterThan(0);
    });

    it("should reject empty query", async () => {
      const result = await runQueryValidation(validateSearch, {
        q: "",
      });
      const qErrors = result.errors.filter((e) => e.path === "q");
      expect(qErrors.length).toBeGreaterThan(0);
    });

    it("should accept valid page number", async () => {
      const result = await runQueryValidation(validateSearch, {
        q: "test",
        page: "5",
      });
      const pageErrors = result.errors.filter((e) => e.path === "page");
      expect(pageErrors).toHaveLength(0);
    });

    it("should accept page 1", async () => {
      const result = await runQueryValidation(validateSearch, {
        q: "test",
        page: "1",
      });
      const pageErrors = result.errors.filter((e) => e.path === "page");
      expect(pageErrors).toHaveLength(0);
    });

    it("should reject page 0", async () => {
      const result = await runQueryValidation(validateSearch, {
        q: "test",
        page: "0",
      });
      const pageErrors = result.errors.filter((e) => e.path === "page");
      expect(pageErrors.length).toBeGreaterThan(0);
    });

    it("should reject negative page", async () => {
      const result = await runQueryValidation(validateSearch, {
        q: "test",
        page: "-1",
      });
      const pageErrors = result.errors.filter((e) => e.path === "page");
      expect(pageErrors.length).toBeGreaterThan(0);
    });

    it("should accept valid limit", async () => {
      const result = await runQueryValidation(validateSearch, {
        q: "test",
        limit: "25",
      });
      const limitErrors = result.errors.filter((e) => e.path === "limit");
      expect(limitErrors).toHaveLength(0);
    });

    it("should accept limit at minimum (1)", async () => {
      const result = await runQueryValidation(validateSearch, {
        q: "test",
        limit: "1",
      });
      const limitErrors = result.errors.filter((e) => e.path === "limit");
      expect(limitErrors).toHaveLength(0);
    });

    it("should accept limit at maximum (100)", async () => {
      const result = await runQueryValidation(validateSearch, {
        q: "test",
        limit: "100",
      });
      const limitErrors = result.errors.filter((e) => e.path === "limit");
      expect(limitErrors).toHaveLength(0);
    });

    it("should reject limit exceeding 100", async () => {
      const result = await runQueryValidation(validateSearch, {
        q: "test",
        limit: "101",
      });
      const limitErrors = result.errors.filter((e) => e.path === "limit");
      expect(limitErrors.length).toBeGreaterThan(0);
    });

    it("should reject limit of 0", async () => {
      const result = await runQueryValidation(validateSearch, {
        q: "test",
        limit: "0",
      });
      const limitErrors = result.errors.filter((e) => e.path === "limit");
      expect(limitErrors.length).toBeGreaterThan(0);
    });
  });
});

describe("Password Reset Validation Rules", () => {
  describe("validateForgotPassword", () => {
    // Note: validateForgotPassword does not include handleValidationErrors
    it("should accept valid email", async () => {
      const result = await runBodyValidation(
        validateForgotPassword,
        {
          email: "user@example.com",
        },
        false,
      );
      const emailErrors = result.errors.filter((e) => e.path === "email");
      expect(emailErrors).toHaveLength(0);
    });

    it("should reject invalid email format", async () => {
      const result = await runBodyValidation(
        validateForgotPassword,
        {
          email: "not-an-email",
        },
        false,
      );
      const emailErrors = result.errors.filter((e) => e.path === "email");
      expect(emailErrors.length).toBeGreaterThan(0);
    });

    it("should reject empty email", async () => {
      const result = await runBodyValidation(
        validateForgotPassword,
        {
          email: "",
        },
        false,
      );
      const emailErrors = result.errors.filter((e) => e.path === "email");
      expect(emailErrors.length).toBeGreaterThan(0);
    });

    it("should reject missing email", async () => {
      const result = await runBodyValidation(validateForgotPassword, {}, false);
      const emailErrors = result.errors.filter((e) => e.path === "email");
      expect(emailErrors.length).toBeGreaterThan(0);
    });
  });

  describe("validateResetPassword", () => {
    // Note: validateResetPassword does not include handleValidationErrors
    it("should accept valid token and password", async () => {
      const result = await runBodyValidation(
        validateResetPassword,
        {
          token: "valid-reset-token-123",
          newPassword: "NewPassword123",
        },
        false,
      );
      expect(result.errors).toHaveLength(0);
    });

    it("should reject empty token", async () => {
      const result = await runBodyValidation(
        validateResetPassword,
        {
          token: "",
          newPassword: "NewPassword123",
        },
        false,
      );
      const tokenErrors = result.errors.filter((e) => e.path === "token");
      expect(tokenErrors.length).toBeGreaterThan(0);
    });

    it("should reject missing token", async () => {
      const result = await runBodyValidation(
        validateResetPassword,
        {
          newPassword: "NewPassword123",
        },
        false,
      );
      const tokenErrors = result.errors.filter((e) => e.path === "token");
      expect(tokenErrors.length).toBeGreaterThan(0);
    });

    it("should reject password shorter than 8 characters", async () => {
      const result = await runBodyValidation(
        validateResetPassword,
        {
          token: "valid-token",
          newPassword: "Pass1",
        },
        false,
      );
      const passwordErrors = result.errors.filter(
        (e) => e.path === "newPassword",
      );
      expect(passwordErrors.length).toBeGreaterThan(0);
      expect(passwordErrors[0].msg).toContain("8 characters");
    });

    it("should reject password without uppercase letter", async () => {
      const result = await runBodyValidation(
        validateResetPassword,
        {
          token: "valid-token",
          newPassword: "password123",
        },
        false,
      );
      const passwordErrors = result.errors.filter(
        (e) => e.path === "newPassword",
      );
      expect(passwordErrors.length).toBeGreaterThan(0);
      expect(passwordErrors[0].msg).toContain("uppercase");
    });

    it("should reject password without lowercase letter", async () => {
      const result = await runBodyValidation(
        validateResetPassword,
        {
          token: "valid-token",
          newPassword: "PASSWORD123",
        },
        false,
      );
      const passwordErrors = result.errors.filter(
        (e) => e.path === "newPassword",
      );
      expect(passwordErrors.length).toBeGreaterThan(0);
      expect(passwordErrors[0].msg).toContain("lowercase");
    });

    it("should reject password without number", async () => {
      const result = await runBodyValidation(
        validateResetPassword,
        {
          token: "valid-token",
          newPassword: "PasswordABC",
        },
        false,
      );
      const passwordErrors = result.errors.filter(
        (e) => e.path === "newPassword",
      );
      expect(passwordErrors.length).toBeGreaterThan(0);
      expect(passwordErrors[0].msg).toContain("number");
    });
  });
});

describe("System Message Validation Rules", () => {
  describe("validateSystemMessage", () => {
    const validMessage = {
      title: "System Maintenance Notice",
      content: "The system will be under maintenance tonight.",
      type: "announcement",
    };

    it("should accept valid system message", async () => {
      const result = await runBodyValidation(
        validateSystemMessage,
        validMessage,
      );
      expect(result.errors).toHaveLength(0);
    });

    it("should accept title at minimum length (5 chars)", async () => {
      const result = await runBodyValidation(validateSystemMessage, {
        ...validMessage,
        title: "ABCDE",
      });
      const titleErrors = result.errors.filter((e) => e.path === "title");
      expect(titleErrors).toHaveLength(0);
    });

    it("should accept title at maximum length (200 chars)", async () => {
      const result = await runBodyValidation(validateSystemMessage, {
        ...validMessage,
        title: "T".repeat(200),
      });
      const titleErrors = result.errors.filter((e) => e.path === "title");
      expect(titleErrors).toHaveLength(0);
    });

    it("should reject title shorter than 5 characters", async () => {
      const result = await runBodyValidation(validateSystemMessage, {
        ...validMessage,
        title: "ABCD",
      });
      const titleErrors = result.errors.filter((e) => e.path === "title");
      expect(titleErrors.length).toBeGreaterThan(0);
      expect(titleErrors[0].msg).toContain("5");
    });

    it("should reject title exceeding 200 characters", async () => {
      const result = await runBodyValidation(validateSystemMessage, {
        ...validMessage,
        title: "T".repeat(201),
      });
      const titleErrors = result.errors.filter((e) => e.path === "title");
      expect(titleErrors.length).toBeGreaterThan(0);
    });

    it("should accept content at minimum length (5 chars)", async () => {
      const result = await runBodyValidation(validateSystemMessage, {
        ...validMessage,
        content: "ABCDE",
      });
      const contentErrors = result.errors.filter((e) => e.path === "content");
      expect(contentErrors).toHaveLength(0);
    });

    it("should accept content at maximum length (3500 chars)", async () => {
      const result = await runBodyValidation(validateSystemMessage, {
        ...validMessage,
        content: "C".repeat(3500),
      });
      const contentErrors = result.errors.filter((e) => e.path === "content");
      expect(contentErrors).toHaveLength(0);
    });

    it("should reject content shorter than 5 characters", async () => {
      const result = await runBodyValidation(validateSystemMessage, {
        ...validMessage,
        content: "ABCD",
      });
      const contentErrors = result.errors.filter((e) => e.path === "content");
      expect(contentErrors.length).toBeGreaterThan(0);
    });

    it("should reject content exceeding 3500 characters", async () => {
      const result = await runBodyValidation(validateSystemMessage, {
        ...validMessage,
        content: "C".repeat(3501),
      });
      const contentErrors = result.errors.filter((e) => e.path === "content");
      expect(contentErrors.length).toBeGreaterThan(0);
    });

    it("should accept announcement type", async () => {
      const result = await runBodyValidation(validateSystemMessage, {
        ...validMessage,
        type: "announcement",
      });
      const typeErrors = result.errors.filter((e) => e.path === "type");
      expect(typeErrors).toHaveLength(0);
    });

    it("should accept maintenance type", async () => {
      const result = await runBodyValidation(validateSystemMessage, {
        ...validMessage,
        type: "maintenance",
      });
      const typeErrors = result.errors.filter((e) => e.path === "type");
      expect(typeErrors).toHaveLength(0);
    });

    it("should accept update type", async () => {
      const result = await runBodyValidation(validateSystemMessage, {
        ...validMessage,
        type: "update",
      });
      const typeErrors = result.errors.filter((e) => e.path === "type");
      expect(typeErrors).toHaveLength(0);
    });

    it("should accept warning type", async () => {
      const result = await runBodyValidation(validateSystemMessage, {
        ...validMessage,
        type: "warning",
      });
      const typeErrors = result.errors.filter((e) => e.path === "type");
      expect(typeErrors).toHaveLength(0);
    });

    it("should accept auth_level_change type", async () => {
      const result = await runBodyValidation(validateSystemMessage, {
        ...validMessage,
        type: "auth_level_change",
      });
      const typeErrors = result.errors.filter((e) => e.path === "type");
      expect(typeErrors).toHaveLength(0);
    });

    it("should reject invalid type", async () => {
      const result = await runBodyValidation(validateSystemMessage, {
        ...validMessage,
        type: "invalid-type",
      });
      const typeErrors = result.errors.filter((e) => e.path === "type");
      expect(typeErrors.length).toBeGreaterThan(0);
    });

    it("should accept low priority", async () => {
      const result = await runBodyValidation(validateSystemMessage, {
        ...validMessage,
        priority: "low",
      });
      const priorityErrors = result.errors.filter((e) => e.path === "priority");
      expect(priorityErrors).toHaveLength(0);
    });

    it("should accept medium priority", async () => {
      const result = await runBodyValidation(validateSystemMessage, {
        ...validMessage,
        priority: "medium",
      });
      const priorityErrors = result.errors.filter((e) => e.path === "priority");
      expect(priorityErrors).toHaveLength(0);
    });

    it("should accept high priority", async () => {
      const result = await runBodyValidation(validateSystemMessage, {
        ...validMessage,
        priority: "high",
      });
      const priorityErrors = result.errors.filter((e) => e.path === "priority");
      expect(priorityErrors).toHaveLength(0);
    });

    it("should reject invalid priority", async () => {
      const result = await runBodyValidation(validateSystemMessage, {
        ...validMessage,
        priority: "urgent",
      });
      const priorityErrors = result.errors.filter((e) => e.path === "priority");
      expect(priorityErrors.length).toBeGreaterThan(0);
    });

    it("should accept valid future expiresAt date", async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 7);
      const result = await runBodyValidation(validateSystemMessage, {
        ...validMessage,
        expiresAt: futureDate.toISOString(),
      });
      const expiresErrors = result.errors.filter((e) => e.path === "expiresAt");
      expect(expiresErrors).toHaveLength(0);
    });

    it("should reject past expiresAt date", async () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);
      const result = await runBodyValidation(validateSystemMessage, {
        ...validMessage,
        expiresAt: pastDate.toISOString(),
      });
      const expiresErrors = result.errors.filter((e) => e.path === "expiresAt");
      expect(expiresErrors.length).toBeGreaterThan(0);
      expect(expiresErrors[0].msg).toContain("future");
    });

    it("should reject invalid expiresAt format", async () => {
      const result = await runBodyValidation(validateSystemMessage, {
        ...validMessage,
        expiresAt: "not-a-date",
      });
      const expiresErrors = result.errors.filter((e) => e.path === "expiresAt");
      expect(expiresErrors.length).toBeGreaterThan(0);
    });

    it("should accept includeCreator boolean", async () => {
      const result = await runBodyValidation(validateSystemMessage, {
        ...validMessage,
        includeCreator: true,
      });
      const creatorErrors = result.errors.filter(
        (e) => e.path === "includeCreator",
      );
      expect(creatorErrors).toHaveLength(0);
    });

    it("should reject non-boolean includeCreator", async () => {
      const result = await runBodyValidation(validateSystemMessage, {
        ...validMessage,
        includeCreator: "yes",
      });
      const creatorErrors = result.errors.filter(
        (e) => e.path === "includeCreator",
      );
      expect(creatorErrors.length).toBeGreaterThan(0);
    });

    it("should accept hideCreator boolean", async () => {
      const result = await runBodyValidation(validateSystemMessage, {
        ...validMessage,
        hideCreator: false,
      });
      const hideErrors = result.errors.filter((e) => e.path === "hideCreator");
      expect(hideErrors).toHaveLength(0);
    });

    it("should reject non-boolean hideCreator", async () => {
      const result = await runBodyValidation(validateSystemMessage, {
        ...validMessage,
        hideCreator: "no",
      });
      const hideErrors = result.errors.filter((e) => e.path === "hideCreator");
      expect(hideErrors.length).toBeGreaterThan(0);
    });

    it("should accept valid recipient selectors", async () => {
      const result = await runBodyValidation(validateSystemMessage, {
        ...validMessage,
        targetRoles: ["Leader", "Administrator"],
        excludeUserIds: ["507F1F77BCF86CD799439011"],
      });

      expect(result.errors).toHaveLength(0);
    });

    it("should accept an empty excluded-user list", async () => {
      const result = await runBodyValidation(validateSystemMessage, {
        ...validMessage,
        excludeUserIds: [],
      });

      expect(result.errors).toHaveLength(0);
    });

    it.each([
      ["scalar targetRoles", { targetRoles: "Administrator" }],
      ["null targetRoles", { targetRoles: null }],
      ["empty targetRoles", { targetRoles: [] }],
      ["invalid targetRoles", { targetRoles: ["Admin"] }],
      [
        "too many targetRoles",
        {
          targetRoles: [
            "Participant",
            "Guest Expert",
            "Leader",
            "Administrator",
            "Super Admin",
            "Leader",
          ],
        },
      ],
      ["scalar excludeUserIds", { excludeUserIds: "507f1f77bcf86cd799439011" }],
      ["null excludeUserIds", { excludeUserIds: null }],
      ["invalid excludeUserIds", { excludeUserIds: ["not-an-object-id"] }],
    ])("should reject %s", async (_label, selectors) => {
      const result = await runBodyValidation(validateSystemMessage, {
        ...validMessage,
        ...selectors,
      });

      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});
