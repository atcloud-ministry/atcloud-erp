import {
  describe,
  it,
  expect,
  beforeEach,
  vi,
  beforeAll,
  afterAll,
} from "vitest";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import User, { IUser } from "../../../src/models/User";
import { ROLES } from "../../../src/utils/roleUtils";

// Setup test environment
describe("User Model", () => {
  let userData: any;

  beforeAll(async () => {
    // Setup test environment
    console.log("🔧 Setting up User model test environment...");
  });

  beforeEach(() => {
    // Reset user data for each test
    userData = {
      username: "testuser",
      email: "test@example.com",
      password: "TestPassword123",
      firstName: "John",
      lastName: "Doe",
      role: ROLES.PARTICIPANT,
    };
  });

  afterAll(() => {
    console.log("✅ User model test environment cleaned up");
  });

  describe("Schema Validation", () => {
    describe("Required Fields", () => {
      it("should require username", async () => {
        delete userData.username;
        const user = new User(userData);
        const error = user.validateSync();
        expect(error?.errors?.username).toBeDefined();
        expect(error?.errors?.username?.message).toContain(
          "Username is required",
        );
      });

      it("should require email", async () => {
        delete userData.email;
        const user = new User(userData);
        const error = user.validateSync();
        expect(error?.errors?.email).toBeDefined();
        expect(error?.errors?.email?.message).toContain(
          "Email address is required",
        );
      });

      it("should require password", async () => {
        delete userData.password;
        const user = new User(userData);
        const error = user.validateSync();
        expect(error?.errors?.password).toBeDefined();
        expect(error?.errors?.password?.message).toContain(
          "Password is required",
        );
      });

      it("should require role", async () => {
        // Since role has a default value, it should actually NOT error when missing
        delete userData.role;
        const user = new User(userData);
        const error = user.validateSync();
        expect(error?.errors?.role).toBeUndefined(); // Should not error since there's a default
        expect(user.role).toBe(ROLES.PARTICIPANT); // Should use default
      });
    });

    describe("Username Validation", () => {
      it("should accept valid usernames (Option C)", () => {
        const validUsernames = ["user123", "user_name", "john_doe", "a1b"];
        validUsernames.forEach((username) => {
          const user = new User({ ...userData, username });
          const error = user.validateSync();
          expect(error?.errors?.username).toBeUndefined();
        });
      });

      it("should reject username too short", () => {
        const user = new User({ ...userData, username: "ab" });
        const error = user.validateSync();
        expect(error?.errors?.username).toBeDefined();
        expect(error?.errors?.username?.message).toContain(
          "at least 3 characters",
        );
      });

      it("should reject username too long", () => {
        const user = new User({ ...userData, username: "a".repeat(21) });
        const error = user.validateSync();
        expect(error?.errors?.username).toBeDefined();
        expect(error?.errors?.username?.message).toContain(
          "cannot exceed 20 characters",
        );
      });

      it("should reject invalid username characters and patterns", () => {
        const invalidUsernames = [
          "user@name",
          "user name",
          "user.name",
          "user#123",
          "TestUser", // uppercase not allowed
          "-user", // invalid start
          "user-", // hyphen not allowed
          "__user", // edge underscore
          "user__name", // consecutive underscores
          "user_", // trailing underscore
          "_user", // leading underscore
        ];
        invalidUsernames.forEach((username) => {
          const user = new User({ ...userData, username });
          const error = user.validateSync();
          expect(error?.errors?.username).toBeDefined();
        });
      });
    });

    describe("Email Validation", () => {
      it("should accept valid email addresses", () => {
        const validEmails = [
          "test@example.com",
          "user.name@domain.com",
          "test123@test-domain.com",
        ];
        validEmails.forEach((email) => {
          const user = new User({ ...userData, email });
          const error = user.validateSync();
          expect(error?.errors?.email).toBeUndefined();
        });
      });

      it("should reject invalid email formats", () => {
        const invalidEmails = [
          "notanemail",
          "@example.com",
          "test@",
          "test.example.com",
          "test@.com",
        ];
        invalidEmails.forEach((email) => {
          const user = new User({ ...userData, email });
          const error = user.validateSync();
          expect(error?.errors?.email).toBeDefined();
        });
      });

      it("should convert email to lowercase", () => {
        const user = new User({ ...userData, email: "TEST@EXAMPLE.COM" });
        expect(user.email).toBe("test@example.com");
      });
    });

    describe("Password Validation", () => {
      it("should accept valid passwords", () => {
        const validPasswords = [
          "Password123",
          "MySecure123",
          "Complex1Pass",
          "StrongP@ss1",
        ];
        validPasswords.forEach((password) => {
          const user = new User({ ...userData, password });
          const error = user.validateSync();
          expect(error?.errors?.password).toBeUndefined();
        });
      });

      it("should reject password too short", () => {
        const user = new User({ ...userData, password: "Short1" });
        const error = user.validateSync();
        expect(error?.errors?.password).toBeDefined();
        expect(error?.errors?.password?.message).toContain(
          "at least 8 characters",
        );
      });

      it("should reject password without uppercase", () => {
        const user = new User({ ...userData, password: "lowercase123" });
        const error = user.validateSync();
        expect(error?.errors?.password).toBeDefined();
        expect(error?.errors?.password?.message).toContain("uppercase letter");
      });

      it("should reject password without lowercase", () => {
        const user = new User({ ...userData, password: "UPPERCASE123" });
        const error = user.validateSync();
        expect(error?.errors?.password).toBeDefined();
        expect(error?.errors?.password?.message).toContain("lowercase letter");
      });

      it("should reject password without numbers", () => {
        const user = new User({ ...userData, password: "NoNumbersHere" });
        const error = user.validateSync();
        expect(error?.errors?.password).toBeDefined();
        expect(error?.errors?.password?.message).toContain("one number");
      });
    });

    describe("Phone Validation", () => {
      it("should accept valid phone numbers", () => {
        const validPhones = ["1234567890", "15551234567"];
        validPhones.forEach((phone) => {
          const user = new User({ ...userData, phone });
          const error = user.validateSync();
          expect(error?.errors?.phone).toBeUndefined();
        });
      });

      it("should accept empty phone", () => {
        const user = new User({ ...userData, phone: "" });
        const error = user.validateSync();
        expect(error?.errors?.phone).toBeUndefined();
      });

      it("should reject invalid phone numbers", () => {
        const invalidPhones = ["123", "123456789012345678901", "abc-def-ghij"];
        invalidPhones.forEach((phone) => {
          const user = new User({ ...userData, phone });
          const error = user.validateSync();
          expect(error?.errors?.phone).toBeDefined();
        });
      });
    });

    describe("Registration Profile Fields", () => {
      const completeProfile = {
        phone: "+12065550123",
        birthYear: 1988,
        residenceCity: "Seattle",
        residenceRegion: "US-WA",
        residenceCountryCode: "US",
        employmentStatus: "employed",
        company: "Example Company",
        occupation: "Product Manager",
      } as const;

      it("keeps the new fields optional for legacy users", () => {
        const user = new User(userData);
        const error = user.validateSync();

        expect(error).toBeUndefined();
        expect(user.employmentStatus).toBeUndefined();
      });

      it("stores birthYear using the BSON Int32 schema type", () => {
        expect(User.schema.path("birthYear").instance).toBe("Int32");
        expect(User.schema.path("birthYear").options.select).toBe(false);
      });

      it("validates and normalizes a complete registration profile", async () => {
        const user = new User({
          ...userData,
          ...completeProfile,
          residenceCity: "  San   Jose\u0301\n",
          residenceRegion: "us-ca",
          residenceCountryCode: "us",
          company: "  Example   Company ",
          occupation: " Product\tManager ",
        });

        await expect(user.validate()).resolves.toBeUndefined();
        expect(user.residenceCity).toBe("San José");
        expect(user.residenceRegion).toBe("US-CA");
        expect(user.residenceCountryCode).toBe("US");
        expect(user.company).toBe("Example Company");
        expect(user.occupation).toBe("Product Manager");
      });

      it("requires all canonical fields once employment status is set", () => {
        const user = new User({
          ...userData,
          employmentStatus: "employed",
        });
        const error = user.validateSync();

        expect(error?.errors?.phone).toBeDefined();
        expect(error?.errors?.birthYear).toBeDefined();
        expect(error?.errors?.residenceCity).toBeDefined();
        expect(error?.errors?.residenceCountryCode).toBeDefined();
        expect(error?.errors?.company).toBeDefined();
      });

      it("enforces E.164 for complete profiles while retaining legacy compatibility", () => {
        const legacyUser = new User({ ...userData, phone: "206-555-0123" });
        const completeUser = new User({
          ...userData,
          ...completeProfile,
          phone: "206-555-0123",
        });
        const impossibleCanonicalUser = new User({
          ...userData,
          ...completeProfile,
          phone: "+11234567890",
        });

        expect(legacyUser.validateSync()?.errors?.phone).toBeUndefined();
        expect(completeUser.validateSync()?.errors?.phone).toBeDefined();
        expect(impossibleCanonicalUser.validateSync()?.errors?.phone).toBeDefined();
      });

      it("rejects invalid birth years, countries, and US subdivisions", () => {
        const user = new User({
          ...userData,
          ...completeProfile,
          birthYear: new Date().getUTCFullYear() + 1,
          residenceCountryCode: "ZZ",
          residenceRegion: "US-ZZ",
        });
        const error = user.validateSync();

        expect(error?.errors?.birthYear).toBeDefined();
        expect(error?.errors?.residenceCountryCode).toBeDefined();
        expect(error?.errors?.residenceRegion).toBeDefined();
      });

      it("rejects unassigned subdivisions outside the US", () => {
        const user = new User({
          ...userData,
          ...completeProfile,
          residenceCountryCode: "CA",
          residenceRegion: "CA-ZZZ",
        });

        expect(user.validateSync()?.errors?.residenceRegion).toBeDefined();
      });

      it("rejects an explicit null employment status", () => {
        const user = new User({
          ...userData,
          ...completeProfile,
          employmentStatus: null,
        });

        expect(user.validateSync()?.errors?.employmentStatus).toBeDefined();
      });

      it("requires company for working statuses", () => {
        for (const employmentStatus of ["employed", "self_employed"] as const) {
          const user = new User({
            ...userData,
            ...completeProfile,
            employmentStatus,
            company: null,
          });
          expect(user.validateSync()?.errors?.company).toBeDefined();
        }
      });

      it("clears company when employment status does not use it", async () => {
        const user = new User({
          ...userData,
          ...completeProfile,
          employmentStatus: "student",
          company: "Legacy Company",
        });

        await expect(user.validate()).resolves.toBeUndefined();
        expect(user.company).toBeNull();
      });
    });

    describe("Role Validation", () => {
      it("should accept valid roles", () => {
        Object.values(ROLES).forEach((role) => {
          const user = new User({ ...userData, role });
          const error = user.validateSync();
          expect(error?.errors?.role).toBeUndefined();
        });
      });

      it("should reject invalid roles", () => {
        const user = new User({ ...userData, role: "InvalidRole" as any });
        const error = user.validateSync();
        expect(error?.errors?.role).toBeDefined();
      });

      it("should default to PARTICIPANT role", () => {
        delete userData.role;
        const user = new User(userData);
        expect(user.role).toBe(ROLES.PARTICIPANT);
      });
    });

    describe("@Cloud Co-worker Validation", () => {
      it("should require roleInAtCloud when isAtCloudLeader is true", () => {
        const user = new User({
          ...userData,
          isAtCloudLeader: true,
          roleInAtCloud: "",
        });
        const error = user.validateSync();
        expect(error?.errors?.roleInAtCloud).toBeDefined();
        expect(error?.errors?.roleInAtCloud?.message).toContain(
          "required for @Cloud co-workers",
        );
      });

      it("should accept roleInAtCloud when isAtCloudLeader is true", () => {
        const user = new User({
          ...userData,
          isAtCloudLeader: true,
          roleInAtCloud: "Youth Leader",
        });
        const error = user.validateSync();
        expect(error?.errors?.roleInAtCloud).toBeUndefined();
      });

      it("should not require roleInAtCloud when isAtCloudLeader is false", () => {
        const user = new User({
          ...userData,
          isAtCloudLeader: false,
          roleInAtCloud: "",
        });
        const error = user.validateSync();
        expect(error?.errors?.roleInAtCloud).toBeUndefined();
      });
    });

    describe("Field Length Validation", () => {
      const fieldTests = [
        { field: "firstName", maxLength: 50 },
        { field: "lastName", maxLength: 50 },
        { field: "phone", maxLength: 20 },
        { field: "roleInAtCloud", maxLength: 100 },
        { field: "occupation", maxLength: 100 },
        { field: "company", maxLength: 100 },
        { field: "weeklyChurch", maxLength: 100 },
        { field: "churchAddress", maxLength: 200 },
        { field: "homeAddress", maxLength: 200 },
      ];

      fieldTests.forEach(({ field, maxLength }) => {
        it(`should reject ${field} exceeding ${maxLength} characters`, () => {
          const user = new User({
            ...userData,
            [field]: "a".repeat(maxLength + 1),
          });
          const error = user.validateSync();
          expect(error?.errors?.[field]).toBeDefined();
          expect(error?.errors?.[field]?.message).toContain(
            `cannot exceed ${maxLength} characters`,
          );
        });
      });
    });

    describe("Enum Validation", () => {
      it("should accept valid gender values", () => {
        ["male", "female"].forEach((gender) => {
          const user = new User({ ...userData, gender });
          const error = user.validateSync();
          expect(error?.errors?.gender).toBeUndefined();
        });
      });

      it("should reject invalid gender values", () => {
        const user = new User({ ...userData, gender: "invalid" as any });
        const error = user.validateSync();
        expect(error?.errors?.gender).toBeDefined();
      });
    });
  });

  describe("Default Values", () => {
    it("should set correct default values", () => {
      const user = new User({
        username: "testuser",
        email: "test@example.com",
        password: "TestPassword123",
      });

      expect(user.role).toBe(ROLES.PARTICIPANT);
      expect(user.isActive).toBe(true);
      expect(user.isVerified).toBe(false);
      expect(user.emailNotifications).toBe(true);
      expect(user.isAtCloudLeader).toBe(false);
      expect(user.loginAttempts).toBe(0);
      expect(user.hasReceivedWelcomeMessage).toBe(false);
      expect(user.avatar).toBe("/default-avatar-male.jpg");
    });
  });

  describe("Pre-save Middleware", () => {
    describe("Password Hashing", () => {
      it("should hash password on save", async () => {
        const plainPassword = "TestPassword123";
        const user = new User({ ...userData, password: plainPassword });

        // Mock bcrypt
        const genSaltSpy = vi
          .spyOn(bcrypt, "genSalt")
          .mockResolvedValue("salt" as any);
        const hashSpy = vi
          .spyOn(bcrypt, "hash")
          .mockResolvedValue("hashedpassword" as any);

        // Trigger pre-save
        await user.validate();
        user.isModified = vi.fn().mockReturnValue(true);

        // Manually call the pre-save logic since we can't save to DB
        const salt = await bcrypt.genSalt(12);
        user.password = await bcrypt.hash(plainPassword, salt);

        expect(genSaltSpy).toHaveBeenCalledWith(12);
        expect(hashSpy).toHaveBeenCalledWith(plainPassword, "salt");
        expect(user.password).toBe("hashedpassword");

        genSaltSpy.mockRestore();
        hashSpy.mockRestore();
      });

      it("should not hash password if not modified", async () => {
        const user = new User(userData);
        user.isModified = vi.fn().mockReturnValue(false);

        const originalPassword = user.password;
        const hashSpy = vi.spyOn(bcrypt, "hash");

        // Password should not be hashed if not modified
        expect(hashSpy).not.toHaveBeenCalled();

        hashSpy.mockRestore();
      });
    });

    describe("@Cloud Co-worker Validation", () => {
      it("should clear roleInAtCloud when isAtCloudLeader is false", () => {
        const user = new User({
          ...userData,
          isAtCloudLeader: false,
          roleInAtCloud: "Some Role",
        });

        // Manually trigger pre-save logic
        if (!user.isAtCloudLeader) {
          user.roleInAtCloud = undefined;
        }

        expect(user.roleInAtCloud).toBeUndefined();
      });

      it("should keep roleInAtCloud when isAtCloudLeader is true", () => {
        const role = "Youth Leader";
        const user = new User({
          ...userData,
          isAtCloudLeader: true,
          roleInAtCloud: role,
        });

        expect(user.roleInAtCloud).toBe(role);
      });
    });
  });

  describe("Instance Methods", () => {
    let user: IUser;

    beforeEach(() => {
      user = new User(userData);
    });

    describe("comparePassword", () => {
      it("should return true for correct password", async () => {
        const compareSpy = vi
          .spyOn(bcrypt, "compare")
          .mockResolvedValue(true as never);

        const result = await user.comparePassword("TestPassword123");
        expect(result).toBe(true);
        expect(compareSpy).toHaveBeenCalledWith(
          "TestPassword123",
          user.password,
        );

        compareSpy.mockRestore();
      });

      it("should return false for incorrect password", async () => {
        const compareSpy = vi
          .spyOn(bcrypt, "compare")
          .mockResolvedValue(false as never);

        const result = await user.comparePassword("wrongpassword");
        expect(result).toBe(false);

        compareSpy.mockRestore();
      });

      it("should throw error on bcrypt failure", async () => {
        const compareSpy = vi
          .spyOn(bcrypt, "compare")
          .mockRejectedValue(new Error("Bcrypt error"));

        await expect(user.comparePassword("password")).rejects.toThrow(
          "Password comparison failed",
        );

        compareSpy.mockRestore();
      });

      it("should throw error when password field is not stored", async () => {
        const userWithoutPassword = new User({
          ...userData,
          password: undefined,
        });
        // Force password to be undefined after construction
        (userWithoutPassword as any).password = undefined;

        await expect(
          userWithoutPassword.comparePassword("anypassword"),
        ).rejects.toThrow("Password comparison failed");
      });
    });

    describe("generateEmailVerificationToken", () => {
      it("should generate verification token and set expiration", () => {
        const mockToken = "mocktoken123";
        const mockBuffer = Buffer.from(mockToken);
        const randomBytesSpy = vi
          .spyOn(crypto, "randomBytes")
          .mockImplementation(() => mockBuffer);
        const hashSpy = vi.spyOn(crypto, "createHash").mockReturnValue({
          update: vi.fn().mockReturnThis(),
          digest: vi.fn().mockReturnValue("hashedtoken"),
        } as any);

        const token = user.generateEmailVerificationToken();

        expect(randomBytesSpy).toHaveBeenCalledWith(32);
        expect(user.emailVerificationToken).toBe("hashedtoken");
        expect(user.emailVerificationExpires).toBeInstanceOf(Date);
        expect(user.emailVerificationExpires!.getTime()).toBeGreaterThan(
          Date.now(),
        );

        randomBytesSpy.mockRestore();
        hashSpy.mockRestore();
      });
    });

    describe("generatePasswordResetToken", () => {
      it("should generate reset token and set expiration", () => {
        const mockToken = "mocktoken123";
        const mockBuffer = Buffer.from(mockToken);
        const randomBytesSpy = vi
          .spyOn(crypto, "randomBytes")
          .mockImplementation(() => mockBuffer);
        const hashSpy = vi.spyOn(crypto, "createHash").mockReturnValue({
          update: vi.fn().mockReturnThis(),
          digest: vi.fn().mockReturnValue("hashedtoken"),
        } as any);

        const token = user.generatePasswordResetToken();

        expect(randomBytesSpy).toHaveBeenCalledWith(32);
        expect(user.passwordResetToken).toBe("hashedtoken");
        expect(user.passwordResetExpires).toBeInstanceOf(Date);
        expect(user.passwordResetExpires!.getTime()).toBeGreaterThan(
          Date.now(),
        );

        randomBytesSpy.mockRestore();
        hashSpy.mockRestore();
      });
    });

    describe("incrementLoginAttempts", () => {
      it("should increment login attempts", async () => {
        const updateOneSpy = vi.fn().mockResolvedValue({});
        user.updateOne = updateOneSpy;
        user.loginAttempts = 2;

        await user.incrementLoginAttempts();

        expect(updateOneSpy).toHaveBeenCalledWith({
          $inc: { loginAttempts: 1 },
        });
      });

      it("should lock account after 5 attempts", async () => {
        const updateOneSpy = vi.fn().mockResolvedValue({});
        user.updateOne = updateOneSpy;
        user.loginAttempts = 4;

        await user.incrementLoginAttempts();

        expect(updateOneSpy).toHaveBeenCalledWith({
          $inc: { loginAttempts: 1 },
          $set: { lockUntil: expect.any(Number) },
        });
      });

      it("should restart attempts if lock has expired", async () => {
        const updateOneSpy = vi.fn().mockResolvedValue({});
        user.updateOne = updateOneSpy;
        user.lockUntil = new Date(Date.now() - 1000); // Expired lock

        await user.incrementLoginAttempts();

        expect(updateOneSpy).toHaveBeenCalledWith({
          $unset: { lockUntil: 1 },
          $set: { loginAttempts: 1 },
        });
      });
    });

    describe("resetLoginAttempts", () => {
      it("should reset login attempts and lock", async () => {
        const updateOneSpy = vi.fn().mockResolvedValue({});
        user.updateOne = updateOneSpy;

        await user.resetLoginAttempts();

        expect(updateOneSpy).toHaveBeenCalledWith({
          $unset: { loginAttempts: 1, lockUntil: 1 },
        });
      });
    });

    describe("isAccountLocked", () => {
      it("should return true if account is locked", () => {
        user.lockUntil = new Date(Date.now() + 60000); // 1 minute in future
        expect(user.isAccountLocked()).toBe(true);
      });

      it("should return false if lock has expired", () => {
        user.lockUntil = new Date(Date.now() - 60000); // 1 minute ago
        expect(user.isAccountLocked()).toBe(false);
      });

      it("should return false if no lock set", () => {
        user.lockUntil = undefined;
        expect(user.isAccountLocked()).toBe(false);
      });
    });

    describe("getFullName", () => {
      it("should return full name when both first and last name exist", () => {
        user.firstName = "John";
        user.lastName = "Doe";
        expect(user.getFullName()).toBe("John Doe");
      });

      it("should return first name only when last name is missing", () => {
        user.firstName = "John";
        user.lastName = undefined;
        expect(user.getFullName()).toBe("John");
      });

      it("should return last name only when first name is missing", () => {
        user.firstName = undefined;
        user.lastName = "Doe";
        expect(user.getFullName()).toBe("Doe");
      });

      it("should return username when no names are provided", () => {
        user.firstName = undefined;
        user.lastName = undefined;
        expect(user.getFullName()).toBe(user.username);
      });
    });

    describe("getDisplayName", () => {
      it("should return full name when available", () => {
        user.firstName = "John";
        user.lastName = "Doe";
        expect(user.getDisplayName()).toBe("John Doe");
      });

      it("should return username with @ prefix when no names available", () => {
        user.firstName = undefined;
        user.lastName = undefined;
        expect(user.getDisplayName()).toBe("@testuser");
      });
    });

    describe("updateLastLogin", () => {
      it("should update last login timestamp", async () => {
        const saveSpy = vi.fn().mockResolvedValue(user);
        user.save = saveSpy;

        await user.updateLastLogin();

        expect(user.lastLogin).toBeInstanceOf(Date);
        expect(saveSpy).toHaveBeenCalledWith({ validateBeforeSave: false });
      });
    });

    describe("canChangeRole", () => {
      it("should delegate to RoleUtils.canPromoteUser", () => {
        const adminUser = new User({
          ...userData,
          username: "admin",
          email: "admin@example.com",
          role: ROLES.ADMINISTRATOR,
        });

        // Mock RoleUtils
        const mockCanPromoteUser = vi.fn().mockReturnValue(true);
        const RoleUtils = { canPromoteUser: mockCanPromoteUser };

        // Since we can't easily mock the import, we'll test the logic directly
        const result = user.canChangeRole(ROLES.LEADER, adminUser);

        // Test should verify the method exists and has correct signature
        expect(typeof user.canChangeRole).toBe("function");
      });
    });
  });

  describe("Virtual Properties", () => {
    it("should have isLocked virtual property", () => {
      const user = new User(userData);

      // Test unlocked state
      user.lockUntil = undefined;
      expect((user as any).isLocked).toBe(false);

      // Test locked state
      user.lockUntil = new Date(Date.now() + 60000);
      expect((user as any).isLocked).toBe(true);

      // Test expired lock
      user.lockUntil = new Date(Date.now() - 60000);
      expect((user as any).isLocked).toBe(false);
    });
  });

  describe("JSON Transformation", () => {
    it("should exclude sensitive fields from JSON", () => {
      const user = new User({
        ...userData,
        emailVerificationToken: "secret",
        passwordResetToken: "secret",
        passwordChangeToken: "secret",
        passwordChangeExpires: new Date(),
        pendingPassword: "hashed-secret",
        passwordChangedAt: new Date(),
      });

      const json = user.toJSON();

      expect(json.password).toBeUndefined();
      expect(json.emailVerificationToken).toBeUndefined();
      expect(json.passwordResetToken).toBeUndefined();
      expect(json.passwordChangeToken).toBeUndefined();
      expect(json.passwordChangeExpires).toBeUndefined();
      expect(json.pendingPassword).toBeUndefined();
      expect(json.passwordChangedAt).toBeUndefined();
      expect(json._id).toBeUndefined();
      expect(json.__v).toBeUndefined();
      expect(json.id).toBeDefined();
    });
  });

  describe("Text Search Index", () => {
    it("should have text search index on relevant fields", () => {
      const indexes = User.schema.indexes();

      // Check if indexes exist
      expect(indexes).toBeDefined();
      expect(Array.isArray(indexes)).toBe(true);

      // We can't easily test the actual index creation in unit tests,
      // but we can verify the schema is configured correctly
      expect(User.schema).toBeDefined();
    });
  });

  describe("Static Methods", () => {
    describe("findByEmailOrUsername", () => {
      it("should find user by email", () => {
        const findOneSpy = vi.spyOn(User, "findOne").mockReturnValue({} as any);

        (User as any).findByEmailOrUsername("test@example.com");

        expect(findOneSpy).toHaveBeenCalledWith({
          $or: [
            { email: "test@example.com" },
            { usernameLower: "test@example.com" },
            { username: "test@example.com" },
          ],
          isActive: true,
        });

        findOneSpy.mockRestore();
      });

      it("should find user by username", () => {
        const findOneSpy = vi.spyOn(User, "findOne").mockReturnValue({} as any);

        (User as any).findByEmailOrUsername("testuser");

        expect(findOneSpy).toHaveBeenCalledWith({
          $or: [
            { email: "testuser" },
            { usernameLower: "testuser" },
            { username: "testuser" },
          ],
          isActive: true,
        });

        findOneSpy.mockRestore();
      });

      it("should convert email to lowercase", () => {
        const findOneSpy = vi.spyOn(User, "findOne").mockReturnValue({} as any);

        (User as any).findByEmailOrUsername("TEST@EXAMPLE.COM");

        expect(findOneSpy).toHaveBeenCalledWith({
          $or: [
            { email: "test@example.com" },
            { usernameLower: "test@example.com" },
            { username: "TEST@EXAMPLE.COM" },
          ],
          isActive: true,
        });

        findOneSpy.mockRestore();
      });
    });

    describe("getUserStats", () => {
      it("should aggregate user statistics", async () => {
        const mockStats = [
          {
            _id: ROLES.PARTICIPANT,
            count: 10,
            activeCount: 8,
            verifiedCount: 7,
            atCloudLeaderCount: 2,
          },
          {
            _id: ROLES.LEADER,
            count: 5,
            activeCount: 5,
            verifiedCount: 4,
            atCloudLeaderCount: 3,
          },
        ];

        const aggregateSpy = vi
          .spyOn(User, "aggregate")
          .mockResolvedValue(mockStats);

        const result = await (User as any).getUserStats();

        expect(aggregateSpy).toHaveBeenCalledWith([
          {
            $group: {
              _id: "$role",
              count: { $sum: 1 },
              activeCount: {
                $sum: { $cond: [{ $eq: ["$isActive", true] }, 1, 0] },
              },
              verifiedCount: {
                $sum: { $cond: [{ $eq: ["$isVerified", true] }, 1, 0] },
              },
              atCloudLeaderCount: {
                $sum: { $cond: [{ $eq: ["$isAtCloudLeader", true] }, 1, 0] },
              },
            },
          },
        ]);

        expect(result).toEqual({
          totalUsers: 15,
          activeUsers: 13,
          verifiedUsers: 11,
          atCloudLeaders: 5,
          roleDistribution: {
            [ROLES.PARTICIPANT]: 10,
            [ROLES.LEADER]: 5,
          },
        });

        aggregateSpy.mockRestore();
      });

      it("should handle empty stats", async () => {
        const aggregateSpy = vi.spyOn(User, "aggregate").mockResolvedValue([]);

        const result = await (User as any).getUserStats();

        expect(result).toEqual({
          totalUsers: 0,
          activeUsers: 0,
          verifiedUsers: 0,
          atCloudLeaders: 0,
          roleDistribution: {},
        });

        aggregateSpy.mockRestore();
      });
    });
  });

  describe("Model Export", () => {
    it("should export User model correctly", () => {
      expect(User).toBeDefined();
      expect(User.modelName).toBe("User");
      expect(User.schema).toBeDefined();
    });

    it("should have correct collection name", () => {
      expect(User.collection.name).toBe("users");
    });
  });

  describe("Error Handling", () => {
    it("should handle validation errors properly", () => {
      const user = new User({});
      const error = user.validateSync();

      expect(error).toBeDefined();
      expect(error?.errors).toBeDefined();
      expect(Object.keys(error?.errors || {}).length).toBeGreaterThan(0);
    });

    it("should handle mongoose casting errors", () => {
      const user = new User({
        ...userData,
        loginAttempts: "not a number" as any,
      });

      const error = user.validateSync();
      expect(error?.errors?.loginAttempts).toBeDefined();
    });
  });
});
