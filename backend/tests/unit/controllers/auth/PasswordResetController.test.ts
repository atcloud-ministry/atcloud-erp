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
        expect(mockUser.save).toHaveBeenCalled();
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
        expect(mockUser.save).toHaveBeenCalled();
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
