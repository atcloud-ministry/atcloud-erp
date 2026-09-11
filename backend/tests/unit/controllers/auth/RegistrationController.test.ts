import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";
import RegistrationController from "../../../../src/controllers/auth/RegistrationController";
import { User } from "../../../../src/models";
import { EmailService } from "../../../../src/services/infrastructure/EmailServiceFacade";
import { AutoEmailNotificationService } from "../../../../src/services/infrastructure/autoEmailNotificationService";
import { CachePatterns } from "../../../../src/services/infrastructure/CacheService";
import GuestMigrationService from "../../../../src/services/GuestMigrationService";

vi.mock("../../../../src/models");
vi.mock("../../../../src/services/infrastructure/EmailServiceFacade");
vi.mock("../../../../src/services/infrastructure/autoEmailNotificationService");
vi.mock("../../../../src/services/infrastructure/CacheService", async () => {
  const actual = await vi.importActual("../../../../src/services/infrastructure/CacheService");
  return {
    ...actual,
    CachePatterns: {
      invalidateUserCache: vi.fn().mockResolvedValue(undefined),
    },
    createLogger: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
    })),
  };
});
vi.mock("../../../../src/services/GuestMigrationService");

describe("RegistrationController", () => {
  let mockReq: any;
  let mockRes: Response;
  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockReq = {
      body: {},
    };

    statusMock = vi.fn().mockReturnThis();
    jsonMock = vi.fn();
    mockRes = {
      status: statusMock,
      json: jsonMock,
    } as unknown as Response;

    // Default env setup
    process.env.ENABLE_GUEST_AUTO_MIGRATION = "false";
    process.env.NODE_ENV = "test";
  });

  describe("register", () => {
    describe("validation", () => {
      it("should return 400 if acceptTerms is false", async () => {
        mockReq.body = {
          username: "testuser",
          email: "test@example.com",
          password: "password123",
          confirmPassword: "password123",
          acceptTerms: false,
        };

        await RegistrationController.register(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "You must accept the terms and conditions to register",
            statusCode: 400,
          })
        );
      });

      it("should return 400 if passwords do not match", async () => {
        mockReq.body = {
          username: "testuser",
          email: "test@example.com",
          password: "password123",
          confirmPassword: "differentpassword",
          acceptTerms: true,
        };

        await RegistrationController.register(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Passwords do not match",
            statusCode: 400,
          })
        );
      });

      it("should return 409 if email is already registered", async () => {
        mockReq.body = {
          username: "testuser",
          email: "existing@example.com",
          password: "password123",
          confirmPassword: "password123",
          gender: "male",
          acceptTerms: true,
        };

        vi.mocked(User.findOne).mockResolvedValue({
          email: "existing@example.com",
          username: "otheruser",
        } as any);

        await RegistrationController.register(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(409);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Email address is already registered",
            statusCode: 409,
          })
        );
      });

      it("should return 409 if username is already taken", async () => {
        mockReq.body = {
          username: "existinguser",
          email: "new@example.com",
          password: "password123",
          confirmPassword: "password123",
          gender: "male",
          acceptTerms: true,
        };

        vi.mocked(User.findOne).mockResolvedValue({
          email: "other@example.com",
          username: "existinguser",
        } as any);

        await RegistrationController.register(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(409);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Username is already taken",
            statusCode: 409,
          })
        );
      });

      it("should return 400 if isAtCloudLeader is true but roleInAtCloud is missing", async () => {
        mockReq.body = {
          username: "testuser",
          email: "test@example.com",
          password: "password123",
          confirmPassword: "password123",
          gender: "male",
          acceptTerms: true,
          isAtCloudLeader: true,
          // roleInAtCloud is missing
        };

        vi.mocked(User.findOne).mockResolvedValue(null);

        await RegistrationController.register(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Role in @Cloud is required for @Cloud co-workers",
            statusCode: 400,
          })
        );
      });

      it("should return 400 if gender is missing or invalid", async () => {
        mockReq.body = {
          username: "testuser",
          email: "test@example.com",
          password: "password123",
          confirmPassword: "password123",
          acceptTerms: true,
        };

        await RegistrationController.register(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Gender must be either 'male' or 'female'",
            statusCode: 400,
          })
        );
      });

      it("should reject an incomplete structured registration profile", async () => {
        mockReq.body = {
          username: "testuser",
          email: "test@example.com",
          password: "password123",
          confirmPassword: "password123",
          gender: "male",
          isAtCloudLeader: false,
          acceptTerms: true,
          birthYear: 1988,
        };

        await RegistrationController.register(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            statusCode: 400,
            message: expect.stringContaining("phone: phone is required"),
          }),
        );
        expect(User.findOne).not.toHaveBeenCalled();
      });

      it("should check for existing users case-insensitively", async () => {
        mockReq.body = {
          username: "testuser",
          email: "TEST@EXAMPLE.COM",
          password: "password123",
          confirmPassword: "password123",
          gender: "male",
          acceptTerms: true,
        };

        vi.mocked(User.findOne).mockResolvedValue(null);

        const mockSave = vi.fn().mockResolvedValue({});
        const mockGenerateToken = vi.fn().mockReturnValue("token-123");

        vi.mocked(User).mockReturnValue({
          _id: "user-id",
          email: "test@example.com",
          username: "testuser",
          role: "Participant",
          isAtCloudLeader: false,
          isVerified: false,
          save: mockSave,
          generateEmailVerificationToken: mockGenerateToken,
        } as any);

        vi.mocked(EmailService.sendVerificationEmail).mockResolvedValue(true);

        await RegistrationController.register(
          mockReq as Request,
          mockRes as Response
        );

        expect(User.findOne).toHaveBeenCalledWith({
          $or: [{ email: "test@example.com" }, { username: "testuser" }],
        });
        expect(statusMock).toHaveBeenCalledWith(201);
      });
    });

    describe("successful registration", () => {
      it("should register a user and send verification email", async () => {
        mockReq.body = {
          username: "newuser",
          email: "new@example.com",
          password: "password123",
          confirmPassword: "password123",
          firstName: "John",
          lastName: "Doe",
          gender: "male",
          acceptTerms: true,
        };

        vi.mocked(User.findOne).mockResolvedValue(null);

        const mockSave = vi.fn().mockResolvedValue({});
        const mockGenerateToken = vi.fn().mockReturnValue("verification-token");

        vi.mocked(User).mockReturnValue({
          _id: "user-id",
          email: "new@example.com",
          username: "newuser",
          firstName: "John",
          lastName: "Doe",
          role: "Participant",
          isAtCloudLeader: false,
          isVerified: false,
          save: mockSave,
          generateEmailVerificationToken: mockGenerateToken,
        } as any);

        vi.mocked(EmailService.sendVerificationEmail).mockResolvedValue(true);

        await RegistrationController.register(
          mockReq as Request,
          mockRes as Response
        );

        expect(mockSave).toHaveBeenCalled();
        expect(mockGenerateToken).toHaveBeenCalled();
        expect(EmailService.sendVerificationEmail).toHaveBeenCalledWith(
          "new@example.com",
          "John",
          "verification-token"
        );
        expect(CachePatterns.invalidateUserCache).toHaveBeenCalledWith(
          "user-id"
        );
        expect(statusMock).toHaveBeenCalledWith(201);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
            message:
              "Registration successful! Please check your email to verify your account",
            data: expect.objectContaining({
              user: expect.objectContaining({
                id: "user-id",
                username: "newuser",
                email: "new@example.com",
              }),
            }),
          })
        );
      });

      it("should normalize and persist a complete structured profile", async () => {
        mockReq.body = {
          username: "profileuser",
          email: "profile@example.com",
          phone: " +12065550123 ",
          birthYear: "1988",
          residenceCity: " San   José ",
          residenceRegion: "us-wa",
          residenceCountryCode: "us",
          employmentStatus: "employed",
          occupation: " Product\tManager ",
          company: " Example   Company ",
          homeAddress: "Legacy address that must be cleared",
          password: "password123",
          confirmPassword: "password123",
          firstName: "Profile",
          lastName: "User",
          gender: "female",
          isAtCloudLeader: false,
          acceptTerms: true,
        };

        vi.mocked(User.findOne).mockResolvedValue(null);
        const mockSave = vi.fn().mockResolvedValue({});
        vi.mocked(User).mockReturnValue({
          _id: "profile-user-id",
          email: "profile@example.com",
          username: "profileuser",
          firstName: "Profile",
          lastName: "User",
          role: "Participant",
          isAtCloudLeader: false,
          isVerified: false,
          save: mockSave,
          generateEmailVerificationToken: vi.fn().mockReturnValue("token"),
        } as any);
        vi.mocked(EmailService.sendVerificationEmail).mockResolvedValue(true);

        await RegistrationController.register(
          mockReq as Request,
          mockRes as Response,
        );

        expect(User).toHaveBeenCalledWith(
          expect.objectContaining({
            phone: "+12065550123",
            birthYear: 1988,
            residenceCity: "San José",
            residenceRegion: "US-WA",
            residenceCountryCode: "US",
            employmentStatus: "employed",
            occupation: "Product Manager",
            company: "Example Company",
            homeAddress: undefined,
          }),
        );
        expect(mockSave).toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(201);
      });

      it("should send admin notification for @Cloud co-worker signup", async () => {
        mockReq.body = {
          username: "cloudworker",
          email: "worker@example.com",
          password: "password123",
          confirmPassword: "password123",
          gender: "male",
          isAtCloudLeader: true,
          roleInAtCloud: "IT Support",
          acceptTerms: true,
        };

        vi.mocked(User.findOne).mockResolvedValue(null);

        const mockSave = vi.fn().mockResolvedValue({});
        const mockGenerateToken = vi.fn().mockReturnValue("verification-token");

        vi.mocked(User).mockReturnValue({
          _id: "user-id",
          email: "worker@example.com",
          username: "cloudworker",
          firstName: "Cloud",
          lastName: "Worker",
          role: "Participant",
          isAtCloudLeader: true,
          roleInAtCloud: "IT Support",
          isVerified: false,
          save: mockSave,
          generateEmailVerificationToken: mockGenerateToken,
        } as any);

        vi.mocked(EmailService.sendVerificationEmail).mockResolvedValue(true);
        vi.mocked(
          AutoEmailNotificationService.sendAtCloudRoleChangeNotification
        ).mockResolvedValue({
          emailsSent: 1,
          messagesCreated: 1,
          success: true,
        });

        await RegistrationController.register(
          mockReq as Request,
          mockRes as Response
        );

        expect(
          AutoEmailNotificationService.sendAtCloudRoleChangeNotification
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            userData: expect.objectContaining({
              email: "worker@example.com",
              roleInAtCloud: "IT Support",
            }),
            changeType: "signup",
          })
        );
        expect(statusMock).toHaveBeenCalledWith(201);
      });

      it("should still succeed if admin notification fails", async () => {
        mockReq.body = {
          username: "cloudworker",
          email: "worker@example.com",
          password: "password123",
          confirmPassword: "password123",
          gender: "male",
          isAtCloudLeader: true,
          roleInAtCloud: "IT Support",
          acceptTerms: true,
        };

        vi.mocked(User.findOne).mockResolvedValue(null);

        const mockSave = vi.fn().mockResolvedValue({});
        const mockGenerateToken = vi.fn().mockReturnValue("verification-token");

        vi.mocked(User).mockReturnValue({
          _id: "user-id",
          email: "worker@example.com",
          username: "cloudworker",
          role: "Participant",
          isAtCloudLeader: true,
          roleInAtCloud: "IT Support",
          isVerified: false,
          save: mockSave,
          generateEmailVerificationToken: mockGenerateToken,
        } as any);

        vi.mocked(EmailService.sendVerificationEmail).mockResolvedValue(true);
        vi.mocked(
          AutoEmailNotificationService.sendAtCloudRoleChangeNotification
        ).mockRejectedValue(new Error("Notification failed"));

        await RegistrationController.register(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(201);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
          })
        );
      });

      it("should still succeed if verification email fails to send", async () => {
        mockReq.body = {
          username: "newuser",
          email: "new@example.com",
          password: "password123",
          confirmPassword: "password123",
          gender: "male",
          acceptTerms: true,
        };

        vi.mocked(User.findOne).mockResolvedValue(null);

        const mockSave = vi.fn().mockResolvedValue({});
        const mockGenerateToken = vi.fn().mockReturnValue("verification-token");

        vi.mocked(User).mockReturnValue({
          _id: "user-id",
          email: "new@example.com",
          username: "newuser",
          role: "Participant",
          isAtCloudLeader: false,
          isVerified: false,
          save: mockSave,
          generateEmailVerificationToken: mockGenerateToken,
        } as any);

        vi.mocked(EmailService.sendVerificationEmail).mockResolvedValue(false);

        await RegistrationController.register(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(201);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
          })
        );
      });

      it("should perform guest migration when enabled", async () => {
        process.env.ENABLE_GUEST_AUTO_MIGRATION = "true";
        process.env.NODE_ENV = "test";
        process.env.VITEST_SCOPE = "integration";

        mockReq.body = {
          username: "newuser",
          email: "new@example.com",
          password: "password123",
          confirmPassword: "password123",
          gender: "male",
          acceptTerms: true,
        };

        vi.mocked(User.findOne).mockResolvedValue(null);

        const mockSave = vi.fn().mockResolvedValue({});
        const mockGenerateToken = vi.fn().mockReturnValue("verification-token");

        vi.mocked(User).mockReturnValue({
          _id: "user-id",
          email: "new@example.com",
          username: "newuser",
          role: "Participant",
          isAtCloudLeader: false,
          isVerified: false,
          save: mockSave,
          generateEmailVerificationToken: mockGenerateToken,
        } as any);

        vi.mocked(EmailService.sendVerificationEmail).mockResolvedValue(true);
        vi.mocked(
          GuestMigrationService.performGuestToUserMigration
        ).mockResolvedValue({ ok: true, modified: 2 });

        await RegistrationController.register(
          mockReq as Request,
          mockRes as Response
        );

        expect(
          GuestMigrationService.performGuestToUserMigration
        ).toHaveBeenCalledWith("user-id", "new@example.com");
        expect(statusMock).toHaveBeenCalledWith(201);
      });

      it("should still succeed if guest migration fails", async () => {
        process.env.ENABLE_GUEST_AUTO_MIGRATION = "true";
        process.env.NODE_ENV = "test";
        process.env.VITEST_SCOPE = "integration";

        mockReq.body = {
          username: "newuser",
          email: "new@example.com",
          password: "password123",
          confirmPassword: "password123",
          gender: "male",
          acceptTerms: true,
        };

        vi.mocked(User.findOne).mockResolvedValue(null);

        const mockSave = vi.fn().mockResolvedValue({});
        const mockGenerateToken = vi.fn().mockReturnValue("verification-token");

        vi.mocked(User).mockReturnValue({
          _id: "user-id",
          email: "new@example.com",
          username: "newuser",
          role: "Participant",
          isAtCloudLeader: false,
          isVerified: false,
          save: mockSave,
          generateEmailVerificationToken: mockGenerateToken,
        } as any);

        vi.mocked(EmailService.sendVerificationEmail).mockResolvedValue(true);
        vi.mocked(
          GuestMigrationService.performGuestToUserMigration
        ).mockRejectedValue(new Error("Migration failed"));

        await RegistrationController.register(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(201);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
          })
        );
      });
    });

    describe("error handling", () => {
      it("should handle duplicate key errors (11000)", async () => {
        mockReq.body = {
          username: "duplicateuser",
          email: "duplicate@example.com",
          password: "password123",
          confirmPassword: "password123",
          gender: "male",
          acceptTerms: true,
        };

        vi.mocked(User.findOne).mockResolvedValue(null);

        const mockSave = vi.fn().mockRejectedValue({
          code: 11000,
          keyPattern: { email: 1 },
        });

        vi.mocked(User).mockReturnValue({
          _id: "user-id",
          save: mockSave,
          generateEmailVerificationToken: vi.fn().mockReturnValue("token"),
        } as any);

        await RegistrationController.register(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(409);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "email is already registered",
            statusCode: 409,
          })
        );
      });

      it("should handle validation errors", async () => {
        mockReq.body = {
          username: "newuser",
          email: "new@example.com",
          password: "password123",
          confirmPassword: "password123",
          gender: "male",
          acceptTerms: true,
        };

        vi.mocked(User.findOne).mockResolvedValue(null);

        const mockSave = vi.fn().mockRejectedValue({
          name: "ValidationError",
          errors: {
            email: { message: "Invalid email format" },
          },
        });

        vi.mocked(User).mockReturnValue({
          _id: "user-id",
          save: mockSave,
          generateEmailVerificationToken: vi.fn().mockReturnValue("token"),
        } as any);

        await RegistrationController.register(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "email: Invalid email format",
            statusCode: 400,
          })
        );
      });

      it("should handle generic database errors", async () => {
        mockReq.body = {
          username: "newuser",
          email: "new@example.com",
          password: "password123",
          confirmPassword: "password123",
          gender: "male",
          acceptTerms: true,
        };

        vi.mocked(User.findOne).mockResolvedValue(null);

        const mockSave = vi
          .fn()
          .mockRejectedValue(new Error("Database connection lost"));

        vi.mocked(User).mockReturnValue({
          _id: "user-id",
          save: mockSave,
          generateEmailVerificationToken: vi.fn().mockReturnValue("token"),
        } as any);

        await RegistrationController.register(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Registration failed. Please try again",
          })
        );
      });
    });
  });
});
