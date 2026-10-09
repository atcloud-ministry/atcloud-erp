import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";
import PasswordResetController from "../../../../src/controllers/auth/PasswordResetController";
import { User } from "../../../../src/models";
import { EmailService } from "../../../../src/services/infrastructure/EmailServiceFacade";
import { CachePatterns } from "../../../../src/services/infrastructure/CacheService";
import { UnifiedMessageController } from "../../../../src/controllers/unifiedMessageController";
import { RefreshSessionService } from "../../../../src/services/auth/RefreshSessionService";

vi.mock("../../../../src/models");
vi.mock("../../../../src/services/infrastructure/EmailServiceFacade");
vi.mock("../../../../src/services/infrastructure/CacheService", async () => {
  const actual = await vi.importActual("../../../../src/services/infrastructure/CacheService");
  return {
    ...actual,
    CachePatterns: {
      invalidateUserCache: vi.fn().mockResolvedValue(undefined),
    },
  };
});
vi.mock("../../../../src/controllers/unifiedMessageController");
vi.mock("../../../../src/services/auth/RefreshSessionService", () => ({
  RefreshSessionService: {
    revokeAllForUser: vi.fn().mockResolvedValue(1),
  },
}));

describe("PasswordResetController", () => {
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

  describe("forgotPassword", () => {
    const resetTokenHash = "a".repeat(64);
    const resetTokenExpiry = new Date(Date.now() + 10 * 60 * 1000);

    beforeEach(() => {
      vi.mocked(User.updateOne).mockResolvedValue({ matchedCount: 1 } as any);
    });

    describe("validation", () => {
      it("should return 400 if email is missing", async () => {
        mockReq.body = {};

        await PasswordResetController.forgotPassword(
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

      it("should return success even if user not found (email enumeration prevention)", async () => {
        mockReq.body = { email: "notfound@example.com" };

        vi.mocked(User.findOne).mockResolvedValue(null);

        await PasswordResetController.forgotPassword(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
            message:
              "If that email address is in our system, you will receive a password reset email shortly.",
          })
        );
      });
    });

    describe("successful request", () => {
      it("should send password reset email for valid user", async () => {
        const mockResetToken = "reset-token-123";
        const mockUser = {
          _id: "user-id",
          email: "test@example.com",
          firstName: "John",
          username: "testuser",
          isActive: true,
          passwordResetToken: resetTokenHash,
          passwordResetExpires: resetTokenExpiry,
          generatePasswordResetToken: vi.fn().mockReturnValue(mockResetToken),
          save: vi.fn().mockResolvedValue(undefined),
        };

        mockReq.body = { email: "test@example.com" };

        vi.mocked(User.findOne).mockResolvedValue(mockUser as any);
        vi.mocked(EmailService.sendPasswordResetEmail).mockResolvedValue(true);
        vi.mocked(
          UnifiedMessageController.createTargetedSystemMessage
        ).mockResolvedValue({} as any);

        await PasswordResetController.forgotPassword(
          mockReq as Request,
          mockRes as Response
        );

        expect(User.findOne).toHaveBeenCalledWith({
          email: "test@example.com",
          isActive: true,
        });
        expect(mockUser.generatePasswordResetToken).toHaveBeenCalled();
        expect(User.updateOne).toHaveBeenCalledWith(
          { _id: "user-id", isActive: true },
          {
            $set: {
              passwordResetToken: resetTokenHash,
              passwordResetExpires: resetTokenExpiry,
            },
          },
          { runValidators: false }
        );
        expect(mockUser.save).not.toHaveBeenCalled();
        expect(EmailService.sendPasswordResetEmail).toHaveBeenCalledWith(
          "test@example.com",
          "John",
          mockResetToken
        );
        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
            message:
              "If that email address is in our system, you will receive a password reset email shortly.",
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
          passwordResetToken: resetTokenHash,
          passwordResetExpires: resetTokenExpiry,
          generatePasswordResetToken: vi.fn().mockReturnValue("token-123"),
          save: vi.fn().mockResolvedValue(undefined),
        };

        mockReq.body = { email: "TEST@EXAMPLE.COM" };

        vi.mocked(User.findOne).mockResolvedValue(mockUser as any);
        vi.mocked(EmailService.sendPasswordResetEmail).mockResolvedValue(true);
        vi.mocked(
          UnifiedMessageController.createTargetedSystemMessage
        ).mockResolvedValue({} as any);

        await PasswordResetController.forgotPassword(
          mockReq as Request,
          mockRes as Response
        );

        expect(User.findOne).toHaveBeenCalledWith({
          email: "test@example.com",
          isActive: true,
        });
      });

      it("should create system message for password reset", async () => {
        const mockUser = {
          _id: "user-id",
          email: "test@example.com",
          firstName: "John",
          username: "testuser",
          isActive: true,
          passwordResetToken: resetTokenHash,
          passwordResetExpires: resetTokenExpiry,
          generatePasswordResetToken: vi.fn().mockReturnValue("token-123"),
          save: vi.fn().mockResolvedValue(undefined),
        };

        mockReq.body = { email: "test@example.com" };

        vi.mocked(User.findOne).mockResolvedValue(mockUser as any);
        vi.mocked(EmailService.sendPasswordResetEmail).mockResolvedValue(true);
        vi.mocked(
          UnifiedMessageController.createTargetedSystemMessage
        ).mockResolvedValue({} as any);

        await PasswordResetController.forgotPassword(
          mockReq as Request,
          mockRes as Response
        );

        expect(
          UnifiedMessageController.createTargetedSystemMessage
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Password Reset Requested",
            type: "warning",
            priority: "high",
          }),
          ["user-id"],
          expect.objectContaining({
            username: "system",
            authLevel: "Super Admin",
          })
        );
      });

      it("should still succeed if email sending fails", async () => {
        const mockUser = {
          _id: "user-id",
          email: "test@example.com",
          firstName: "John",
          username: "testuser",
          isActive: true,
          passwordResetToken: resetTokenHash,
          passwordResetExpires: resetTokenExpiry,
          generatePasswordResetToken: vi.fn().mockReturnValue("token-123"),
          save: vi.fn().mockResolvedValue(undefined),
        };

        mockReq.body = { email: "test@example.com" };

        vi.mocked(User.findOne).mockResolvedValue(mockUser as any);
        vi.mocked(EmailService.sendPasswordResetEmail).mockResolvedValue(false);
        vi.mocked(
          UnifiedMessageController.createTargetedSystemMessage
        ).mockResolvedValue({} as any);

        await PasswordResetController.forgotPassword(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
          })
        );
      });

      it("should still succeed if system message creation fails", async () => {
        const mockUser = {
          _id: "user-id",
          email: "test@example.com",
          firstName: "John",
          username: "testuser",
          isActive: true,
          passwordResetToken: resetTokenHash,
          passwordResetExpires: resetTokenExpiry,
          generatePasswordResetToken: vi.fn().mockReturnValue("token-123"),
          save: vi.fn().mockResolvedValue(undefined),
        };

        mockReq.body = { email: "test@example.com" };

        vi.mocked(User.findOne).mockResolvedValue(mockUser as any);
        vi.mocked(EmailService.sendPasswordResetEmail).mockResolvedValue(true);
        vi.mocked(
          UnifiedMessageController.createTargetedSystemMessage
        ).mockRejectedValue(new Error("Message creation failed"));

        await PasswordResetController.forgotPassword(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
          })
        );
      });

      it("should issue a reset link without validating an incomplete legacy profile", async () => {
        const rawToken = "legacy-reset-token";
        const legacyValidationError = new Error("Legacy profile is incomplete");
        legacyValidationError.name = "ValidationError";
        const mockUser = {
          _id: "legacy-user-id",
          email: "legacy@example.com",
          firstName: "Legacy",
          username: "legacyuser",
          isActive: true,
          employmentStatus: "employed",
          phone: undefined,
          passwordResetToken: resetTokenHash,
          passwordResetExpires: resetTokenExpiry,
          generatePasswordResetToken: vi.fn().mockReturnValue(rawToken),
          save: vi.fn().mockRejectedValue(legacyValidationError),
        };

        mockReq.body = { email: "legacy@example.com" };
        vi.mocked(User.findOne).mockResolvedValue(mockUser as any);
        vi.mocked(EmailService.sendPasswordResetEmail).mockResolvedValue(true);
        vi.mocked(
          UnifiedMessageController.createTargetedSystemMessage
        ).mockResolvedValue({} as any);

        await PasswordResetController.forgotPassword(
          mockReq as Request,
          mockRes as Response
        );

        expect(mockUser.generatePasswordResetToken).toHaveBeenCalledOnce();
        expect(mockUser.save).not.toHaveBeenCalled();
        expect(User.updateOne).toHaveBeenCalledWith(
          { _id: "legacy-user-id", isActive: true },
          {
            $set: {
              passwordResetToken: resetTokenHash,
              passwordResetExpires: resetTokenExpiry,
            },
          },
          { runValidators: false }
        );
        expect(EmailService.sendPasswordResetEmail).toHaveBeenCalledWith(
          "legacy@example.com",
          "Legacy",
          rawToken
        );
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should not email a reset link when the account is no longer active", async () => {
        const mockUser = {
          _id: "inactive-user-id",
          email: "inactive@example.com",
          firstName: "Inactive",
          isActive: true,
          passwordResetToken: resetTokenHash,
          passwordResetExpires: resetTokenExpiry,
          generatePasswordResetToken: vi.fn().mockReturnValue("unused-token"),
          save: vi.fn(),
        };

        mockReq.body = { email: "inactive@example.com" };
        vi.mocked(User.findOne).mockResolvedValue(mockUser as any);
        vi.mocked(User.updateOne).mockResolvedValue({ matchedCount: 0 } as any);

        await PasswordResetController.forgotPassword(
          mockReq as Request,
          mockRes as Response
        );

        expect(mockUser.save).not.toHaveBeenCalled();
        expect(EmailService.sendPasswordResetEmail).not.toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
            message:
              "If that email address is in our system, you will receive a password reset email shortly.",
          })
        );
      });
    });

    describe("error handling", () => {
      it("should handle database errors", async () => {
        mockReq.body = { email: "test@example.com" };

        vi.mocked(User.findOne).mockRejectedValue(new Error("Database error"));

        await PasswordResetController.forgotPassword(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Password reset request failed.",
          })
        );
      });
    });
  });

  describe("resetPassword", () => {
    describe("validation", () => {
      it("should return 400 if newPassword is missing", async () => {
        mockReq.body = { confirmPassword: "password123" };

        await PasswordResetController.resetPassword(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "New password and confirmation are required.",
          })
        );
      });

      it("should return 400 if confirmPassword is missing", async () => {
        mockReq.body = { newPassword: "password123" };

        await PasswordResetController.resetPassword(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "New password and confirmation are required.",
          })
        );
      });

      it("should return 400 if passwords do not match", async () => {
        mockReq.body = {
          newPassword: "password123",
          confirmPassword: "differentpassword",
        };

        await PasswordResetController.resetPassword(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Passwords do not match.",
          })
        );
      });

      it("should return 400 if user is not authenticated (invalid token)", async () => {
        mockReq.body = {
          newPassword: "password123",
          confirmPassword: "password123",
        };
        mockReq.user = null;

        await PasswordResetController.resetPassword(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Invalid or expired reset token.",
          })
        );
      });
    });

    describe("successful reset", () => {
      it("should reset password successfully", async () => {
        const mockUser = {
          _id: "user-id",
          email: "test@example.com",
          firstName: "John",
          username: "testuser",
          password: "oldpassword",
          passwordResetToken: "reset-token",
          passwordResetExpires: new Date(),
          save: vi.fn().mockResolvedValue(undefined),
        };

        mockReq.body = {
          newPassword: "newpassword123",
          confirmPassword: "newpassword123",
        };
        mockReq.user = mockUser;

        vi.mocked(
          UnifiedMessageController.createTargetedSystemMessage
        ).mockResolvedValue({} as any);
        vi.mocked(EmailService.sendPasswordResetSuccessEmail).mockResolvedValue(
          true
        );

        await PasswordResetController.resetPassword(
          mockReq as Request,
          mockRes as Response
        );

        expect(mockUser.password).toBe("newpassword123");
        expect(mockUser.passwordResetToken).toBeUndefined();
        expect(mockUser.passwordResetExpires).toBeUndefined();
        expect(mockUser.passwordChangedAt).toBeInstanceOf(Date);
        expect(mockUser.save).toHaveBeenCalledWith({
          validateBeforeSave: false,
        });
        expect(RefreshSessionService.revokeAllForUser).toHaveBeenCalledWith(
          "user-id",
          "password_reset",
        );
        expect(CachePatterns.invalidateUserCache).toHaveBeenCalledWith(
          "user-id"
        );
        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
            message: "Password reset successfully!",
          })
        );
      });

      it("should complete reset despite unrelated legacy profile validation errors", async () => {
        const legacyValidationError = new Error("Legacy profile is incomplete");
        legacyValidationError.name = "ValidationError";
        const mockUser = {
          _id: "legacy-user-id",
          email: "legacy@example.com",
          firstName: "Legacy",
          username: "legacyuser",
          employmentStatus: "employed",
          phone: undefined,
          password: "oldpassword",
          passwordResetToken: "reset-token",
          passwordResetExpires: new Date(Date.now() + 60_000),
          save: vi.fn().mockImplementation(async (options?: {
            validateBeforeSave?: boolean;
          }) => {
            if (options?.validateBeforeSave !== false) {
              throw legacyValidationError;
            }
          }),
        };

        mockReq.body = {
          newPassword: "NewLegacyPass123!",
          confirmPassword: "NewLegacyPass123!",
        };
        mockReq.user = mockUser;
        vi.mocked(
          UnifiedMessageController.createTargetedSystemMessage
        ).mockResolvedValue({} as any);
        vi.mocked(EmailService.sendPasswordResetSuccessEmail).mockResolvedValue(
          true
        );

        await PasswordResetController.resetPassword(
          mockReq as Request,
          mockRes as Response
        );

        expect(mockUser.save).toHaveBeenCalledWith({
          validateBeforeSave: false,
        });
        expect(mockUser.password).toBe("NewLegacyPass123!");
        expect(mockUser.passwordResetToken).toBeUndefined();
        expect(mockUser.passwordResetExpires).toBeUndefined();
        expect(mockUser.passwordChangedAt).toBeInstanceOf(Date);
        expect(RefreshSessionService.revokeAllForUser).toHaveBeenCalledWith(
          "legacy-user-id",
          "password_reset"
        );
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should send success notifications after password reset", async () => {
        const mockUser = {
          _id: "user-id",
          email: "test@example.com",
          firstName: "John",
          username: "testuser",
          password: "oldpassword",
          save: vi.fn().mockResolvedValue(undefined),
        };

        mockReq.body = {
          newPassword: "newpassword123",
          confirmPassword: "newpassword123",
        };
        mockReq.user = mockUser;

        vi.mocked(
          UnifiedMessageController.createTargetedSystemMessage
        ).mockResolvedValue({} as any);
        vi.mocked(EmailService.sendPasswordResetSuccessEmail).mockResolvedValue(
          true
        );

        await PasswordResetController.resetPassword(
          mockReq as Request,
          mockRes as Response
        );

        expect(
          UnifiedMessageController.createTargetedSystemMessage
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Password Reset Successful",
            type: "update",
            priority: "high",
          }),
          ["user-id"],
          expect.objectContaining({
            username: "system",
            authLevel: "Super Admin",
          })
        );
        expect(EmailService.sendPasswordResetSuccessEmail).toHaveBeenCalledWith(
          "test@example.com",
          "John"
        );
      });

      it("should still succeed if notification sending fails", async () => {
        const mockUser = {
          _id: "user-id",
          email: "test@example.com",
          firstName: "John",
          username: "testuser",
          password: "oldpassword",
          save: vi.fn().mockResolvedValue(undefined),
        };

        mockReq.body = {
          newPassword: "newpassword123",
          confirmPassword: "newpassword123",
        };
        mockReq.user = mockUser;

        vi.mocked(
          UnifiedMessageController.createTargetedSystemMessage
        ).mockRejectedValue(new Error("Notification failed"));
        vi.mocked(EmailService.sendPasswordResetSuccessEmail).mockResolvedValue(
          false
        );

        await PasswordResetController.resetPassword(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
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
          username: "testuser",
          password: "oldpassword",
          save: vi.fn().mockRejectedValue(new Error("Save failed")),
        };

        mockReq.body = {
          newPassword: "newpassword123",
          confirmPassword: "newpassword123",
        };
        mockReq.user = mockUser;

        await PasswordResetController.resetPassword(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Password reset failed.",
          })
        );
      });
    });
  });
});
