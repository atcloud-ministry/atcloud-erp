/**
 * Tests for username validation rules in validation.ts
 * These tests cover the custom username validation logic
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Request, Response, NextFunction } from "express";

// Import the actual validation rules
import { validateUserRegistration } from "../../../src/middleware/validation";
import { validationResult } from "express-validator";

// Helper to run validation chain against mock request
async function runValidation(
  validationChain: unknown[],
  body: Record<string, unknown>,
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

  // Run each validator/middleware except the last (error handler)
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

describe("Username Validation Rules", () => {
  // Valid base user data
  const validUserData = {
    username: "validuser",
    email: "test@example.com",
    password: "Password123",
    firstName: "John",
    lastName: "Doe",
    gender: "male",
    isAtCloudLeader: false,
    acceptTerms: true,
    registrationNoticeVersion: "registration-privacy-v1",
  };

  describe("username custom validation", () => {
    it("should accept valid lowercase username", async () => {
      const result = await runValidation(
        validateUserRegistration,
        validUserData,
      );
      const usernameErrors = result.errors.filter((e) => e.path === "username");
      expect(usernameErrors).toHaveLength(0);
    });

    it("should reject uppercase characters in username", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        username: "UserName",
      });
      const usernameErrors = result.errors.filter((e) => e.path === "username");
      expect(usernameErrors.length).toBeGreaterThan(0);
      expect(usernameErrors[0].msg).toContain("lowercase");
    });

    it("should reject username not starting with a letter", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        username: "123user",
      });
      const usernameErrors = result.errors.filter((e) => e.path === "username");
      expect(usernameErrors.length).toBeGreaterThan(0);
      expect(usernameErrors[0].msg).toContain("start with a letter");
    });

    it("should reject username with invalid characters", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        username: "user@name",
      });
      const usernameErrors = result.errors.filter((e) => e.path === "username");
      expect(usernameErrors.length).toBeGreaterThan(0);
      expect(usernameErrors[0].msg).toContain(
        "lowercase letters, numbers, and underscores",
      );
    });

    it("should reject username with consecutive underscores", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        username: "user__name",
      });
      const usernameErrors = result.errors.filter((e) => e.path === "username");
      expect(usernameErrors.length).toBeGreaterThan(0);
      expect(usernameErrors[0].msg).toContain("consecutive underscores");
    });

    it("should reject username starting with underscore", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        username: "_username",
      });
      const usernameErrors = result.errors.filter((e) => e.path === "username");
      expect(usernameErrors.length).toBeGreaterThan(0);
    });

    it("should reject username ending with underscore", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        username: "username_",
      });
      const usernameErrors = result.errors.filter((e) => e.path === "username");
      expect(usernameErrors.length).toBeGreaterThan(0);
    });

    it("should reject reserved username 'admin'", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        username: "root",
      });
      const usernameErrors = result.errors.filter((e) => e.path === "username");
      expect(usernameErrors.length).toBeGreaterThan(0);
      expect(usernameErrors[0].msg).toContain("reserved");
    });

    it("should reject reserved username 'api'", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        username: "api",
      });
      const usernameErrors = result.errors.filter((e) => e.path === "username");
      expect(usernameErrors.length).toBeGreaterThan(0);
      expect(usernameErrors[0].msg).toContain("reserved");
    });

    it("should accept username with valid underscore", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        username: "user_name",
      });
      const usernameErrors = result.errors.filter((e) => e.path === "username");
      expect(usernameErrors).toHaveLength(0);
    });

    it("should accept username with numbers", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        username: "user123",
      });
      const usernameErrors = result.errors.filter((e) => e.path === "username");
      expect(usernameErrors).toHaveLength(0);
    });

    it("should reject non-string username", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        username: 12345,
      });
      const usernameErrors = result.errors.filter((e) => e.path === "username");
      expect(usernameErrors.length).toBeGreaterThan(0);
    });
  });
});
