import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";
import EmailVerificationController from "../../../../src/controllers/auth/EmailVerificationController";
import { User } from "../../../../src/models";
import { EmailService } from "../../../../src/services/infrastructure/EmailServiceFacade";
import { CachePatterns } from "../../../../src/services/infrastructure/CacheService";
import GuestMigrationService from "../../../../src/services/GuestMigrationService";

vi.mock("../../../../src/models");
vi.mock("../../../../src/services/infrastructure/EmailServiceFacade");
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
vi.mock(
  "../../../../src/services/programs/ProgramMembershipMutationSyncTrigger",
  () => ({
    programMembershipMutationSyncTrigger: {
      userEligibilityChanged: vi.fn(),
    },
  }),
);

import { programMembershipMutationSyncTrigger } from "../../../../src/services/programs/ProgramMembershipMutationSyncTrigger";

describe("EmailVerificationController", () => {
  let mockReq: any;
  let mockRes: Response;
  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockReq = {
      body: {},
      user: null,
    };

    statusMock = vi.fn().mockReturnThis();
    jsonMock = vi.fn();
    mockRes = {
      status: statusMock,
      json: jsonMock,
    } as unknown as Response;
  });

  describe("verifyEmail", () => {
    describe("validation", () => {
      it("should return 400 if user is not authenticated", async () => {
        mockReq.user = null;

        await EmailVerificationController.verifyEmail(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Invalid verification token.",
            errorType: "invalid_token",
          })
        );
      });

      it("should return 200 if user is already verified", async () => {
        const mockUser = {
          _id: "user-id",
          email: "test@example.com",
          isVerified: true,
          save: vi.fn().mockResolvedValue(undefined),
        };

        mockReq.user = mockUser;

        await EmailVerificationController.verifyEmail(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
            message: "Email is already verified.",
            alreadyVerified: true,
          })
        );
        expect(mockUser.save).not.toHaveBeenCalled();
      });
    });

    describe("successful verification", () => {
      it("should verify email successfully", async () => {
        const mockUser = {
          _id: "user-id",
          email: "test@example.com",
          firstName: "John",
          role: "Participant",
          isVerified: false,
          emailVerificationToken: "test-token",
          emailVerificationExpires: new Date(),
          save: vi.fn().mockResolvedValue(undefined),
        };

        mockReq.user = mockUser;
        mockReq.correlationId = "verify-email-1";
        process.env.ENABLE_GUEST_AUTO_MIGRATION = "false"; // Disable migration for this test

        vi.mocked(EmailService.sendWelcomeEmail).mockResolvedValue(true);

        await EmailVerificationController.verifyEmail(
          mockReq as Request,
          mockRes as Response
        );

        expect(mockUser.isVerified).toBe(true);
        expect(mockUser.emailVerificationToken).toBeUndefined();
        expect(mockUser.emailVerificationExpires).toBeUndefined();
        expect(mockUser.save).toHaveBeenCalled();
        expect(
          programMembershipMutationSyncTrigger.userEligibilityChanged,
        ).toHaveBeenCalledWith("user-id", {
          actor: {
            type: "user",
            id: "user-id",
            role: "Participant",
          },
          source: "http",
          correlationId: "verify-email-1",
        });
        expect(CachePatterns.invalidateUserCache).toHaveBeenCalledWith(
          "user-id"
        );
        expect(EmailService.sendWelcomeEmail).toHaveBeenCalledWith(
          "test@example.com",
          "John"
        );
        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
            message: "Email verified successfully! Welcome to @Cloud Ministry.",
            freshlyVerified: true,
          })
        );
      });

      it("should use username if firstName is not available", async () => {
        const mockUser = {
          _id: "user-id",
          email: "test@example.com",
          username: "testuser",
          isVerified: false,
          save: vi.fn().mockResolvedValue(undefined),
        };

        mockReq.user = mockUser;
        process.env.ENABLE_GUEST_AUTO_MIGRATION = "false";

        vi.mocked(EmailService.sendWelcomeEmail).mockResolvedValue(true);

        await EmailVerificationController.verifyEmail(
          mockReq as Request,
          mockRes as Response
        );

        expect(EmailService.sendWelcomeEmail).toHaveBeenCalledWith(
          "test@example.com",
          "testuser"
        );
      });

      it("should include migration summary when guest migration is enabled", async () => {
        const mockUser = {
          _id: "user-id",
          email: "test@example.com",
          firstName: "John",
          isVerified: false,
          save: vi.fn().mockResolvedValue(undefined),
        };

        mockReq.user = mockUser;
        process.env.ENABLE_GUEST_AUTO_MIGRATION = "true";
        process.env.NODE_ENV = "test";
        process.env.VITEST_SCOPE = "integration";

        vi.mocked(EmailService.sendWelcomeEmail).mockResolvedValue(true);
        vi.mocked(
          GuestMigrationService.performGuestToUserMigration
        ).mockResolvedValue({
          ok: true,
          modified: 2,
        });
        vi.mocked(
          GuestMigrationService.detectGuestRegistrationsByEmail
        ).mockResolvedValue([]);

        await EmailVerificationController.verifyEmail(
          mockReq as Request,
          mockRes as Response
        );

        expect(
          GuestMigrationService.performGuestToUserMigration
        ).toHaveBeenCalledWith("user-id", "test@example.com");
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
            freshlyVerified: true,
            migration: {
              modified: 2,
              remainingPending: 0,
            },
          })
        );
      });

      it("should not fail verification if guest migration fails", async () => {
        const mockUser = {
          _id: "user-id",
          email: "test@example.com",
          firstName: "John",
          isVerified: false,
          save: vi.fn().mockResolvedValue(undefined),
        };

        mockReq.user = mockUser;
        process.env.ENABLE_GUEST_AUTO_MIGRATION = "true";
        process.env.NODE_ENV = "test";
        process.env.VITEST_SCOPE = "integration";

        vi.mocked(EmailService.sendWelcomeEmail).mockResolvedValue(true);
        vi.mocked(
          GuestMigrationService.performGuestToUserMigration
        ).mockRejectedValue(new Error("Migration failed"));

        await EmailVerificationController.verifyEmail(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
            freshlyVerified: true,
          })
        );
      });
    });

    describe("error handling", () => {
      it("should handle save errors", async () => {
        const mockUser = {
          _id: "user-id",
          email: "test@example.com",
          firstName: "John",
          isVerified: false,
          save: vi.fn().mockRejectedValue(new Error("Save failed")),
        };

        mockReq.user = mockUser;

        await EmailVerificationController.verifyEmail(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Email verification failed.",
            errorType: "server_error",
          })
        );
      });
    });
  });

  describe("resendVerification", () => {
    describe("validation", () => {
      it("should return 400 if email is missing", async () => {
        mockReq.body = {};

        await EmailVerificationController.resendVerification(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Email address is required.",
          })
        );
      });

      it("should return 404 if user not found", async () => {
        mockReq.body = { email: "notfound@example.com" };

        vi.mocked(User.findOne).mockResolvedValue(null);

        await EmailVerificationController.resendVerification(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(404);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "User not found or already verified.",
          })
        );
      });
    });

    describe("successful resend", () => {
      it("should resend verification email successfully", async () => {
        const mockVerificationToken = "new-token-123";
        const mockUser = {
          _id: "user-id",
          email: "test@example.com",
          firstName: "John",
          username: "testuser",
          isActive: true,
          isVerified: false,
          generateEmailVerificationToken: vi
            .fn()
            .mockReturnValue(mockVerificationToken),
          save: vi.fn().mockResolvedValue(undefined),
        };

        mockReq.body = { email: "test@example.com" };

        vi.mocked(User.findOne).mockResolvedValue(mockUser as any);
        vi.mocked(EmailService.sendVerificationEmail).mockResolvedValue(true);

        await EmailVerificationController.resendVerification(
          mockReq as Request,
          mockRes as Response
        );

        expect(User.findOne).toHaveBeenCalledWith({
          email: "test@example.com",
          isActive: true,
          isVerified: false,
        });
        expect(mockUser.generateEmailVerificationToken).toHaveBeenCalled();
        expect(mockUser.save).toHaveBeenCalled();
        expect(EmailService.sendVerificationEmail).toHaveBeenCalledWith(
          "test@example.com",
          "John",
          mockVerificationToken
        );
        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
            message: "Verification email sent successfully.",
          })
        );
      });

      it("should handle email case insensitivity", async () => {
        const mockUser = {
          _id: "user-id",
          email: "test@example.com",
          firstName: "John",
          username: "testuser",
          isActive: true,
          isVerified: false,
          generateEmailVerificationToken: vi.fn().mockReturnValue("token-123"),
          save: vi.fn().mockResolvedValue(undefined),
        };

        mockReq.body = { email: "TEST@EXAMPLE.COM" };

        vi.mocked(User.findOne).mockResolvedValue(mockUser as any);
        vi.mocked(EmailService.sendVerificationEmail).mockResolvedValue(true);

        await EmailVerificationController.resendVerification(
          mockReq as Request,
          mockRes as Response
        );

        expect(User.findOne).toHaveBeenCalledWith({
          email: "test@example.com",
          isActive: true,
          isVerified: false,
        });
      });
    });

    describe("error handling", () => {
      it("should return 500 if email sending fails", async () => {
        const mockUser = {
          _id: "user-id",
          email: "test@example.com",
          firstName: "John",
          username: "testuser",
          isActive: true,
          isVerified: false,
          generateEmailVerificationToken: vi.fn().mockReturnValue("token-123"),
          save: vi.fn().mockResolvedValue(undefined),
        };

        mockReq.body = { email: "test@example.com" };

        vi.mocked(User.findOne).mockResolvedValue(mockUser as any);
        vi.mocked(EmailService.sendVerificationEmail).mockResolvedValue(false);

        await EmailVerificationController.resendVerification(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Failed to send verification email.",
          })
        );
      });

      it("should handle database errors", async () => {
        mockReq.body = { email: "test@example.com" };

        vi.mocked(User.findOne).mockRejectedValue(new Error("Database error"));

        await EmailVerificationController.resendVerification(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Failed to resend verification email.",
          })
        );
      });
    });
  });
});
