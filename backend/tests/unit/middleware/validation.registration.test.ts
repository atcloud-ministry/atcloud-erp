/**
 * Tests for user registration validation rules in validation.ts
 * Covers: email, password, firstName, lastName, gender, isAtCloudLeader, roleInAtCloud
 * Complements validation.username.test.ts which covers username validation
 */
import { describe, it, expect, vi } from "vitest";
import { Request, Response, NextFunction } from "express";
import { validationResult } from "express-validator";

// Import the actual validation rules
import { validateUserRegistration } from "../../../src/middleware/validation";

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

describe("User Registration Validation Rules", () => {
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

  describe("email validation", () => {
    it("should accept valid email address", async () => {
      const result = await runValidation(
        validateUserRegistration,
        validUserData,
      );
      const emailErrors = result.errors.filter((e) => e.path === "email");
      expect(emailErrors).toHaveLength(0);
    });

    it("should accept email with subdomain", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        email: "user@mail.example.com",
      });
      const emailErrors = result.errors.filter((e) => e.path === "email");
      expect(emailErrors).toHaveLength(0);
    });

    it("should accept email with plus sign", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        email: "user+tag@example.com",
      });
      const emailErrors = result.errors.filter((e) => e.path === "email");
      expect(emailErrors).toHaveLength(0);
    });

    it("should reject email without @ symbol", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        email: "invalidemail.com",
      });
      const emailErrors = result.errors.filter((e) => e.path === "email");
      expect(emailErrors.length).toBeGreaterThan(0);
      expect(emailErrors[0].msg).toContain("email");
    });

    it("should reject email without domain", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        email: "user@",
      });
      const emailErrors = result.errors.filter((e) => e.path === "email");
      expect(emailErrors.length).toBeGreaterThan(0);
    });

    it("should reject email with invalid domain", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        email: "user@invalid",
      });
      const emailErrors = result.errors.filter((e) => e.path === "email");
      expect(emailErrors.length).toBeGreaterThan(0);
    });

    it("should reject empty email", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        email: "",
      });
      const emailErrors = result.errors.filter((e) => e.path === "email");
      expect(emailErrors.length).toBeGreaterThan(0);
    });

    it("should reject email with spaces", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        email: "user @example.com",
      });
      const emailErrors = result.errors.filter((e) => e.path === "email");
      expect(emailErrors.length).toBeGreaterThan(0);
    });
  });

  describe("password validation", () => {
    it("should accept valid password with uppercase, lowercase and number", async () => {
      const result = await runValidation(
        validateUserRegistration,
        validUserData,
      );
      const passwordErrors = result.errors.filter((e) => e.path === "password");
      expect(passwordErrors).toHaveLength(0);
    });

    it("should accept password with special characters", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        password: "Password123!@#",
      });
      const passwordErrors = result.errors.filter((e) => e.path === "password");
      expect(passwordErrors).toHaveLength(0);
    });

    it("should accept password exactly 8 characters", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        password: "Passwo1d",
      });
      const passwordErrors = result.errors.filter((e) => e.path === "password");
      expect(passwordErrors).toHaveLength(0);
    });

    it("should reject password shorter than 8 characters", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        password: "Pass1",
      });
      const passwordErrors = result.errors.filter((e) => e.path === "password");
      expect(passwordErrors.length).toBeGreaterThan(0);
      expect(passwordErrors[0].msg).toContain("8 characters");
    });

    it("should reject password without uppercase letter", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        password: "password123",
      });
      const passwordErrors = result.errors.filter((e) => e.path === "password");
      expect(passwordErrors.length).toBeGreaterThan(0);
      expect(passwordErrors[0].msg).toContain("uppercase");
    });

    it("should reject password without lowercase letter", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        password: "PASSWORD123",
      });
      const passwordErrors = result.errors.filter((e) => e.path === "password");
      expect(passwordErrors.length).toBeGreaterThan(0);
      expect(passwordErrors[0].msg).toContain("lowercase");
    });

    it("should reject password without number", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        password: "PasswordABC",
      });
      const passwordErrors = result.errors.filter((e) => e.path === "password");
      expect(passwordErrors.length).toBeGreaterThan(0);
      expect(passwordErrors[0].msg).toContain("number");
    });

    it("should reject empty password", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        password: "",
      });
      const passwordErrors = result.errors.filter((e) => e.path === "password");
      expect(passwordErrors.length).toBeGreaterThan(0);
    });

    it("should accept long password", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        password: "VeryLongPassword123WithManyCharacters",
      });
      const passwordErrors = result.errors.filter((e) => e.path === "password");
      expect(passwordErrors).toHaveLength(0);
    });
  });

  describe("firstName validation", () => {
    it("should accept valid first name", async () => {
      const result = await runValidation(
        validateUserRegistration,
        validUserData,
      );
      const firstNameErrors = result.errors.filter(
        (e) => e.path === "firstName",
      );
      expect(firstNameErrors).toHaveLength(0);
    });

    it("should accept first name with spaces", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        firstName: "Mary Jane",
      });
      const firstNameErrors = result.errors.filter(
        (e) => e.path === "firstName",
      );
      expect(firstNameErrors).toHaveLength(0);
    });

    it("should accept first name with hyphen", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        firstName: "Mary-Jane",
      });
      const firstNameErrors = result.errors.filter(
        (e) => e.path === "firstName",
      );
      expect(firstNameErrors).toHaveLength(0);
    });

    it("should accept single character first name", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        firstName: "J",
      });
      const firstNameErrors = result.errors.filter(
        (e) => e.path === "firstName",
      );
      expect(firstNameErrors).toHaveLength(0);
    });

    it("should accept first name at max length (50 chars)", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        firstName: "A".repeat(50),
      });
      const firstNameErrors = result.errors.filter(
        (e) => e.path === "firstName",
      );
      expect(firstNameErrors).toHaveLength(0);
    });

    it("should reject empty first name", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        firstName: "",
      });
      const firstNameErrors = result.errors.filter(
        (e) => e.path === "firstName",
      );
      expect(firstNameErrors.length).toBeGreaterThan(0);
    });

    it("should reject first name exceeding 50 characters", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        firstName: "A".repeat(51),
      });
      const firstNameErrors = result.errors.filter(
        (e) => e.path === "firstName",
      );
      expect(firstNameErrors.length).toBeGreaterThan(0);
      expect(firstNameErrors[0].msg).toContain("50 characters");
    });

    it("should trim whitespace from first name", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        firstName: "  John  ",
      });
      const firstNameErrors = result.errors.filter(
        (e) => e.path === "firstName",
      );
      expect(firstNameErrors).toHaveLength(0);
    });

    it("should reject whitespace-only first name", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        firstName: "   ",
      });
      const firstNameErrors = result.errors.filter(
        (e) => e.path === "firstName",
      );
      expect(firstNameErrors.length).toBeGreaterThan(0);
    });
  });

  describe("lastName validation", () => {
    it("should accept valid last name", async () => {
      const result = await runValidation(
        validateUserRegistration,
        validUserData,
      );
      const lastNameErrors = result.errors.filter((e) => e.path === "lastName");
      expect(lastNameErrors).toHaveLength(0);
    });

    it("should accept last name with apostrophe", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        lastName: "O'Brien",
      });
      const lastNameErrors = result.errors.filter((e) => e.path === "lastName");
      expect(lastNameErrors).toHaveLength(0);
    });

    it("should accept last name with hyphen", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        lastName: "Smith-Jones",
      });
      const lastNameErrors = result.errors.filter((e) => e.path === "lastName");
      expect(lastNameErrors).toHaveLength(0);
    });

    it("should accept single character last name", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        lastName: "D",
      });
      const lastNameErrors = result.errors.filter((e) => e.path === "lastName");
      expect(lastNameErrors).toHaveLength(0);
    });

    it("should accept last name at max length (50 chars)", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        lastName: "B".repeat(50),
      });
      const lastNameErrors = result.errors.filter((e) => e.path === "lastName");
      expect(lastNameErrors).toHaveLength(0);
    });

    it("should reject empty last name", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        lastName: "",
      });
      const lastNameErrors = result.errors.filter((e) => e.path === "lastName");
      expect(lastNameErrors.length).toBeGreaterThan(0);
    });

    it("should reject last name exceeding 50 characters", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        lastName: "B".repeat(51),
      });
      const lastNameErrors = result.errors.filter((e) => e.path === "lastName");
      expect(lastNameErrors.length).toBeGreaterThan(0);
      expect(lastNameErrors[0].msg).toContain("50 characters");
    });

    it("should trim whitespace from last name", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        lastName: "  Doe  ",
      });
      const lastNameErrors = result.errors.filter((e) => e.path === "lastName");
      expect(lastNameErrors).toHaveLength(0);
    });

    it("should reject whitespace-only last name", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        lastName: "   ",
      });
      const lastNameErrors = result.errors.filter((e) => e.path === "lastName");
      expect(lastNameErrors.length).toBeGreaterThan(0);
    });
  });

  describe("gender validation", () => {
    it("should accept male gender", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        gender: "male",
      });
      const genderErrors = result.errors.filter((e) => e.path === "gender");
      expect(genderErrors).toHaveLength(0);
    });

    it("should accept female gender", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        gender: "female",
      });
      const genderErrors = result.errors.filter((e) => e.path === "gender");
      expect(genderErrors).toHaveLength(0);
    });

    it("should reject other gender values", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        gender: "other",
      });
      const genderErrors = result.errors.filter((e) => e.path === "gender");
      expect(genderErrors.length).toBeGreaterThan(0);
      expect(genderErrors[0].msg).toContain("male");
      expect(genderErrors[0].msg).toContain("female");
    });

    it("should reject empty gender", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        gender: "",
      });
      const genderErrors = result.errors.filter((e) => e.path === "gender");
      expect(genderErrors.length).toBeGreaterThan(0);
    });

    it("should reject missing gender", async () => {
      const dataWithoutGender: Record<string, unknown> = { ...validUserData };
      delete dataWithoutGender.gender;

      const result = await runValidation(
        validateUserRegistration,
        dataWithoutGender,
      );

      const genderErrors = result.errors.filter((e) => e.path === "gender");
      expect(genderErrors.length).toBeGreaterThan(0);
      expect(genderErrors[0].msg).toContain("Gender is required");
    });

    it("should reject gender with different case", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        gender: "Male",
      });
      const genderErrors = result.errors.filter((e) => e.path === "gender");
      expect(genderErrors.length).toBeGreaterThan(0);
    });

    it("should reject invalid gender type", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        gender: "nonbinary",
      });
      const genderErrors = result.errors.filter((e) => e.path === "gender");
      expect(genderErrors.length).toBeGreaterThan(0);
    });
  });

  describe("isAtCloudLeader validation", () => {
    it("should accept true boolean", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        isAtCloudLeader: true,
      });
      const leaderErrors = result.errors.filter(
        (e) => e.path === "isAtCloudLeader",
      );
      expect(leaderErrors).toHaveLength(0);
    });

    it("should accept false boolean", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        isAtCloudLeader: false,
      });
      const leaderErrors = result.errors.filter(
        (e) => e.path === "isAtCloudLeader",
      );
      expect(leaderErrors).toHaveLength(0);
    });

    it("should reject non-boolean string value", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        isAtCloudLeader: "yes",
      });
      const leaderErrors = result.errors.filter(
        (e) => e.path === "isAtCloudLeader",
      );
      expect(leaderErrors.length).toBeGreaterThan(0);
      expect(leaderErrors[0].msg).toContain("boolean");
    });

    // Note: express-validator's isBoolean() accepts 0 and 1 as valid boolean values
    // This is expected behavior for form submissions where booleans are often sent as 0/1
    it("should accept number 0 as falsy boolean value", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        isAtCloudLeader: 0,
      });
      const leaderErrors = result.errors.filter(
        (e) => e.path === "isAtCloudLeader",
      );
      expect(leaderErrors).toHaveLength(0);
    });

    it("should accept number 1 as truthy boolean value", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        isAtCloudLeader: 1,
      });
      const leaderErrors = result.errors.filter(
        (e) => e.path === "isAtCloudLeader",
      );
      expect(leaderErrors).toHaveLength(0);
    });
  });

  describe("roleInAtCloud validation", () => {
    it("should accept valid role", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        roleInAtCloud: "Small Group Leader",
      });
      const roleErrors = result.errors.filter(
        (e) => e.path === "roleInAtCloud",
      );
      expect(roleErrors).toHaveLength(0);
    });

    it("should accept empty role (optional field)", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        roleInAtCloud: "",
      });
      const roleErrors = result.errors.filter(
        (e) => e.path === "roleInAtCloud",
      );
      expect(roleErrors).toHaveLength(0);
    });

    it("should accept undefined role (optional field)", async () => {
      const { roleInAtCloud, ...dataWithoutRole } = {
        ...validUserData,
        roleInAtCloud: undefined,
      };
      const result = await runValidation(
        validateUserRegistration,
        dataWithoutRole,
      );
      const roleErrors = result.errors.filter(
        (e) => e.path === "roleInAtCloud",
      );
      expect(roleErrors).toHaveLength(0);
    });

    it("should accept role at max length (100 chars)", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        roleInAtCloud: "R".repeat(100),
      });
      const roleErrors = result.errors.filter(
        (e) => e.path === "roleInAtCloud",
      );
      expect(roleErrors).toHaveLength(0);
    });

    it("should reject role exceeding 100 characters", async () => {
      const result = await runValidation(validateUserRegistration, {
        ...validUserData,
        roleInAtCloud: "R".repeat(101),
      });
      const roleErrors = result.errors.filter(
        (e) => e.path === "roleInAtCloud",
      );
      expect(roleErrors.length).toBeGreaterThan(0);
      expect(roleErrors[0].msg).toContain("100 characters");
    });
  });

  describe("combined field validation", () => {
    it("should report multiple errors for multiple invalid fields", async () => {
      const result = await runValidation(validateUserRegistration, {
        username: "validuser",
        email: "not-an-email",
        password: "weak",
        firstName: "",
        lastName: "A".repeat(60),
        gender: "invalid",
        isAtCloudLeader: "maybe",
      });

      // Should have errors for email, password, firstName, lastName, gender, isAtCloudLeader
      expect(result.errors.length).toBeGreaterThanOrEqual(5);

      const errorPaths = result.errors.map((e) => e.path);
      expect(errorPaths).toContain("email");
      expect(errorPaths).toContain("password");
      expect(errorPaths).toContain("firstName");
      expect(errorPaths).toContain("lastName");
      expect(errorPaths).toContain("gender");
    });

    it("should pass validation with all valid fields", async () => {
      const result = await runValidation(validateUserRegistration, {
        username: "validuser",
        email: "test@example.com",
        password: "Password123",
        firstName: "John",
        lastName: "Doe",
        gender: "male",
        isAtCloudLeader: true,
        roleInAtCloud: "Team Lead",
        acceptTerms: true,
        registrationNoticeVersion: "registration-privacy-v1",
      });

      expect(result.errors).toHaveLength(0);
    });

    it("should handle edge case values correctly", async () => {
      const result = await runValidation(validateUserRegistration, {
        username: "abc",
        email: "a@b.co",
        password: "Abcdefg1",
        firstName: "X",
        lastName: "Y",
        gender: "female",
        isAtCloudLeader: false,
        acceptTerms: true,
        registrationNoticeVersion: "registration-privacy-v1",
      });

      expect(result.errors).toHaveLength(0);
    });
  });
});
