import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";
import PasswordChangeController from "../../../../src/controllers/auth/PasswordChangeController";
import { User } from "../../../../src/models";
import { EmailService } from "../../../../src/services/infrastructure/EmailServiceFacade";
import { CachePatterns } from "../../../../src/services/infrastructure/CacheService";
import { UnifiedMessageController } from "../../../../src/controllers/unifiedMessageController";
import bcrypt from "bcryptjs";
import crypto from "crypto";
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
vi.mock("bcryptjs");
vi.mock("crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("crypto")>();
  return {
    ...actual,
    default: {
      ...actual,
      randomBytes: vi.fn(),
      createHash: vi.fn(),
    },
  };
});

describe("PasswordChangeController", () => {
  let mockReq: any;
  let mockRes: Response;
  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockReq = {
      body: {},
      params: {},
      user: null,
    };

    statusMock = vi.fn().mockReturnThis();
    jsonMock = vi.fn();
    mockRes = {
      status: statusMock,
      json: jsonMock,
    } as unknown as Response;
  });

  describe("requestPasswordChange", () => {
    describe("validation", () => {
      it("should return 400 if currentPassword is missing", async () => {
        mockReq.body = { newPassword: "newpassword123" };
        mockReq.user = { _id: "user-id" };

        await PasswordChangeController.requestPasswordChange(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Current password and new password are required.",
          })
        );
      });

      it("should return 400 if newPassword is missing", async () => {
        mockReq.body = { currentPassword: "currentpassword" };
        mockReq.user = { _id: "user-id" };

        await PasswordChangeController.requestPasswordChange(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Current password and new password are required.",
          })
        );
      });

      it("should return 400 if newPassword is less than 8 characters", async () => {
        mockReq.body = {
          currentPassword: "currentpassword",
          newPassword: "short",
        };
        mockReq.user = { _id: "user-id" };

        await PasswordChangeController.requestPasswordChange(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "New password must be at least 8 characters long.",
          })
        );
      });

      it("should return 404 if user not found", async () => {
        mockReq.body = {
          currentPassword: "currentpassword",
          newPassword: "newpassword123",
        };
        mockReq.user = { _id: "user-id" };

        const mockSelect = vi.fn().mockResolvedValue(null);
        vi.mocked(User.findById).mockReturnValue({ select: mockSelect } as any);

        await PasswordChangeController.requestPasswordChange(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(404);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "User not found.",
          })
        );
      });

      it("should return 400 if current password is incorrect", async () => {
        mockReq.body = {
          currentPassword: "wrongpassword",
          newPassword: "newpassword123",
        };
        mockReq.user = { _id: "user-id" };

        const mockUser: any = {
          _id: "user-id",
          email: "test@example.com",
          username: "testuser",
          password: "hashedcurrentpassword",
          save: vi.fn().mockResolvedValue(undefined),
        };

        const mockSelect = vi.fn().mockResolvedValue(mockUser);
        vi.mocked(User.findById).mockReturnValue({ select: mockSelect } as any);
        vi.mocked(bcrypt.compare).mockResolvedValue(false as never);

        await PasswordChangeController.requestPasswordChange(
          mockReq as Request,
          mockRes as Response
        );

        expect(bcrypt.compare).toHaveBeenCalledWith(
          "wrongpassword",
          "hashedcurrentpassword"
        );
        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Current password is incorrect.",
          })
        );
      });
    });

    describe("successful request", () => {
      it("should request password change successfully", async () => {
        mockReq.body = {
          currentPassword: "currentpassword",
          newPassword: "newpassword123",
        };
        mockReq.user = { _id: "user-id" };

        const mockUser: any = {
          _id: "user-id",
          email: "test@example.com",
          firstName: "John",
          username: "testuser",
          password: "hashedcurrentpassword",
          save: vi.fn().mockResolvedValue(undefined),
        };

        const mockSelect = vi.fn().mockResolvedValue(mockUser);
        vi.mocked(User.findById).mockReturnValue({ select: mockSelect } as any);
        vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
        vi.mocked(bcrypt.hash).mockResolvedValue("hashednewpassword" as never);

        // Mock crypto
        const mockRandomBytes = vi.fn().mockReturnValue({
          toString: vi.fn().mockReturnValue("token123"),
        });
        const mockCreateHash = vi.fn().mockReturnValue({
          update: vi.fn().mockReturnValue({
            digest: vi.fn().mockReturnValue("hashedtoken123"),
          }),
        });
        vi.mocked(crypto.randomBytes).mockImplementation(
          mockRandomBytes as any
        );
        vi.mocked(crypto.createHash).mockImplementation(mockCreateHash as any);

        vi.mocked(
          EmailService.sendPasswordChangeRequestEmail
        ).mockResolvedValue(true);
        vi.mocked(
          UnifiedMessageController.createTargetedSystemMessage
        ).mockResolvedValue({ _id: "message-id" } as any);

        await PasswordChangeController.requestPasswordChange(
          mockReq as Request,
          mockRes as Response
        );

        expect(mockUser.save).toHaveBeenCalled();
        expect(mockUser.passwordChangeToken).toBe("hashedtoken123");
        expect(mockUser.pendingPassword).toBe("hashednewpassword");
        expect(mockUser.passwordChangeExpires).toBeInstanceOf(Date);
        expect(
          EmailService.sendPasswordChangeRequestEmail
        ).toHaveBeenCalledWith("test@example.com", "John", "token123");
        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
            message:
              "Password change request sent. Please check your email to confirm.",
          })
        );
      });

      it("should create system message for password change request", async () => {
        mockReq.body = {
          currentPassword: "currentpassword",
          newPassword: "newpassword123",
        };
        mockReq.user = { _id: "user-id" };

        const mockUser: any = {
          _id: "user-id",
          email: "test@example.com",
          firstName: "John",
          username: "testuser",
          password: "hashedcurrentpassword",
          save: vi.fn().mockResolvedValue(undefined),
        };

        const mockSelect = vi.fn().mockResolvedValue(mockUser);
        vi.mocked(User.findById).mockReturnValue({ select: mockSelect } as any);
        vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
        vi.mocked(bcrypt.hash).mockResolvedValue("hashednewpassword" as never);

        const mockRandomBytes = vi.fn().mockReturnValue({
          toString: vi.fn().mockReturnValue("token123"),
        });
        const mockCreateHash = vi.fn().mockReturnValue({
          update: vi.fn().mockReturnValue({
            digest: vi.fn().mockReturnValue("hashedtoken123"),
          }),
        });
        vi.mocked(crypto.randomBytes).mockImplementation(
          mockRandomBytes as any
        );
        vi.mocked(crypto.createHash).mockImplementation(mockCreateHash as any);

        vi.mocked(
          EmailService.sendPasswordChangeRequestEmail
        ).mockResolvedValue(true);
        vi.mocked(
          UnifiedMessageController.createTargetedSystemMessage
        ).mockResolvedValue({ _id: "message-id" } as any);

        await PasswordChangeController.requestPasswordChange(
          mockReq as Request,
          mockRes as Response
        );

        expect(
          UnifiedMessageController.createTargetedSystemMessage
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Password Change Request",
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

      it("should still succeed if notification sending fails", async () => {
        mockReq.body = {
          currentPassword: "currentpassword",
          newPassword: "newpassword123",
        };
        mockReq.user = { _id: "user-id" };

        const mockUser: any = {
          _id: "user-id",
          email: "test@example.com",
          firstName: "John",
          username: "testuser",
          password: "hashedcurrentpassword",
          save: vi.fn().mockResolvedValue(undefined),
        };

        const mockSelect = vi.fn().mockResolvedValue(mockUser);
        vi.mocked(User.findById).mockReturnValue({ select: mockSelect } as any);
        vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
        vi.mocked(bcrypt.hash).mockResolvedValue("hashednewpassword" as never);

        const mockRandomBytes = vi.fn().mockReturnValue({
          toString: vi.fn().mockReturnValue("token123"),
        });
        const mockCreateHash = vi.fn().mockReturnValue({
          update: vi.fn().mockReturnValue({
            digest: vi.fn().mockReturnValue("hashedtoken123"),
          }),
        });
        vi.mocked(crypto.randomBytes).mockImplementation(
          mockRandomBytes as any
        );
        vi.mocked(crypto.createHash).mockImplementation(mockCreateHash as any);

        vi.mocked(
          EmailService.sendPasswordChangeRequestEmail
        ).mockRejectedValue(new Error("Email failed"));

        await PasswordChangeController.requestPasswordChange(
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
        mockReq.body = {
          currentPassword: "currentpassword",
          newPassword: "newpassword123",
        };
        mockReq.user = { _id: "user-id" };

        const mockSelect = vi
          .fn()
          .mockRejectedValue(new Error("Database error"));
        vi.mocked(User.findById).mockReturnValue({ select: mockSelect } as any);

        await PasswordChangeController.requestPasswordChange(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Password change request failed.",
          })
        );
      });
    });
  });

  describe("completePasswordChange", () => {
    describe("validation", () => {
      it("should return 400 if token is missing", async () => {
        mockReq.params = {};

        await PasswordChangeController.completePasswordChange(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Password change token is required.",
          })
        );
      });

      it("should return 400 if token is invalid or expired", async () => {
        mockReq.params = { token: "invalidtoken" };

        const mockCreateHash = vi.fn().mockReturnValue({
          update: vi.fn().mockReturnValue({
            digest: vi.fn().mockReturnValue("hashedinvalidtoken"),
          }),
        });
        vi.mocked(crypto.createHash).mockImplementation(mockCreateHash as any);

        const mockSelect = vi.fn().mockResolvedValue(null);
        vi.mocked(User.findOne).mockReturnValue({ select: mockSelect } as any);

        await PasswordChangeController.completePasswordChange(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Password change token is invalid or has expired.",
          })
        );
      });

      it("should return 400 if no pending password found", async () => {
        mockReq.params = { token: "validtoken" };

        const mockCreateHash = vi.fn().mockReturnValue({
          update: vi.fn().mockReturnValue({
            digest: vi.fn().mockReturnValue("hashedvalidtoken"),
          }),
        });
        vi.mocked(crypto.createHash).mockImplementation(mockCreateHash as any);

        const mockUser: any = {
          _id: "user-id",
          email: "test@example.com",
          username: "testuser",
          password: "currenthashedpassword",
          passwordChangeToken: "hashedvalidtoken",
          passwordChangeExpires: new Date(Date.now() + 10 * 60 * 1000),
          // pendingPassword is missing
        };

        const mockSelect = vi.fn().mockResolvedValue(mockUser);
        vi.mocked(User.findOne).mockReturnValue({ select: mockSelect } as any);

        await PasswordChangeController.completePasswordChange(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "No pending password change found.",
          })
        );
      });
    });

    describe("successful completion", () => {
      it("should complete password change successfully", async () => {
        mockReq.params = { token: "validtoken" };

        const mockCreateHash = vi.fn().mockReturnValue({
          update: vi.fn().mockReturnValue({
            digest: vi.fn().mockReturnValue("hashedvalidtoken"),
          }),
        });
        vi.mocked(crypto.createHash).mockImplementation(mockCreateHash as any);

        const mockUser: any = {
          _id: "user-id",
          email: "test@example.com",
          firstName: "John",
          username: "testuser",
          password: "currenthashedpassword",
          pendingPassword: "newhashedpassword",
          passwordChangeToken: "hashedvalidtoken",
          passwordChangeExpires: new Date(Date.now() + 10 * 60 * 1000),
        };

        const mockSelect = vi.fn().mockResolvedValue(mockUser);
        vi.mocked(User.findOne).mockReturnValue({ select: mockSelect } as any);

        vi.mocked(User.updateOne).mockResolvedValue({
          acknowledged: true,
          modifiedCount: 1,
          matchedCount: 1,
          upsertedCount: 0,
        } as any);

        vi.mocked(User.findById).mockResolvedValue({
          _id: "user-id",
          password: "newhashedpassword",
          passwordChangedAt: new Date(),
        } as any);

        vi.mocked(EmailService.sendPasswordResetSuccessEmail).mockResolvedValue(
          true
        );
        vi.mocked(
          UnifiedMessageController.createTargetedSystemMessage
        ).mockResolvedValue({ _id: "message-id" } as any);

        await PasswordChangeController.completePasswordChange(
          mockReq as Request,
          mockRes as Response
        );

        expect(User.updateOne).toHaveBeenCalledWith(
          {
            _id: "user-id",
            passwordChangeToken: "hashedvalidtoken",
            passwordChangeExpires: { $gt: expect.any(Date) },
          },
          expect.objectContaining({
            $set: expect.objectContaining({
              password: "newhashedpassword",
              passwordChangedAt: expect.any(Date),
            }),
            $unset: expect.objectContaining({
              passwordChangeToken: 1,
              passwordChangeExpires: 1,
              pendingPassword: 1,
            }),
          })
        );
        expect(CachePatterns.invalidateUserCache).toHaveBeenCalledWith(
          "user-id"
        );
        expect(RefreshSessionService.revokeAllForUser).toHaveBeenCalledWith(
          "user-id",
          "password_changed",
        );
        expect(EmailService.sendPasswordResetSuccessEmail).toHaveBeenCalledWith(
          "test@example.com",
          "John"
        );
        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
            message: "Password changed successfully!",
          })
        );
      });

      it("should create system message for password change completion", async () => {
        mockReq.params = { token: "validtoken" };

        const mockCreateHash = vi.fn().mockReturnValue({
          update: vi.fn().mockReturnValue({
            digest: vi.fn().mockReturnValue("hashedvalidtoken"),
          }),
        });
        vi.mocked(crypto.createHash).mockImplementation(mockCreateHash as any);

        const mockUser: any = {
          _id: "user-id",
          email: "test@example.com",
          firstName: "John",
          username: "testuser",
          password: "currenthashedpassword",
          pendingPassword: "newhashedpassword",
          passwordChangeToken: "hashedvalidtoken",
          passwordChangeExpires: new Date(Date.now() + 10 * 60 * 1000),
        };

        const mockSelect = vi.fn().mockResolvedValue(mockUser);
        vi.mocked(User.findOne).mockReturnValue({ select: mockSelect } as any);

        vi.mocked(User.updateOne).mockResolvedValue({
          acknowledged: true,
          modifiedCount: 1,
          matchedCount: 1,
          upsertedCount: 0,
        } as any);

        vi.mocked(User.findById).mockResolvedValue({
          _id: "user-id",
          password: "newhashedpassword",
        } as any);

        vi.mocked(EmailService.sendPasswordResetSuccessEmail).mockResolvedValue(
          true
        );
        vi.mocked(
          UnifiedMessageController.createTargetedSystemMessage
        ).mockResolvedValue({ _id: "message-id" } as any);

        await PasswordChangeController.completePasswordChange(
          mockReq as Request,
          mockRes as Response
        );

        expect(
          UnifiedMessageController.createTargetedSystemMessage
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Password Changed Successfully",
            type: "update",
            priority: "medium",
          }),
          ["user-id"],
          expect.objectContaining({
            username: "system",
            authLevel: "Super Admin",
          })
        );
      });

      it("should still succeed if notification sending fails", async () => {
        mockReq.params = { token: "validtoken" };

        const mockCreateHash = vi.fn().mockReturnValue({
          update: vi.fn().mockReturnValue({
            digest: vi.fn().mockReturnValue("hashedvalidtoken"),
          }),
        });
        vi.mocked(crypto.createHash).mockImplementation(mockCreateHash as any);

        const mockUser: any = {
          _id: "user-id",
          email: "test@example.com",
          firstName: "John",
          username: "testuser",
          password: "currenthashedpassword",
          pendingPassword: "newhashedpassword",
          passwordChangeToken: "hashedvalidtoken",
          passwordChangeExpires: new Date(Date.now() + 10 * 60 * 1000),
        };

        const mockSelect = vi.fn().mockResolvedValue(mockUser);
        vi.mocked(User.findOne).mockReturnValue({ select: mockSelect } as any);

        vi.mocked(User.updateOne).mockResolvedValue({
          acknowledged: true,
          modifiedCount: 1,
          matchedCount: 1,
          upsertedCount: 0,
        } as any);

        vi.mocked(User.findById).mockResolvedValue({
          _id: "user-id",
          password: "newhashedpassword",
        } as any);

        vi.mocked(EmailService.sendPasswordResetSuccessEmail).mockRejectedValue(
          new Error("Email failed")
        );

        await PasswordChangeController.completePasswordChange(
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

      it("does not write tokens, email addresses, or password hashes to logs", async () => {
        const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
        const consoleError = vi
          .spyOn(console, "error")
          .mockImplementation(() => {});
        mockReq.params = { token: "private-valid-token" };
        vi.mocked(crypto.createHash).mockReturnValue({
          update: vi.fn().mockReturnValue({
            digest: vi.fn().mockReturnValue("private-token-hash"),
          }),
        } as any);
        const mockUser: any = {
          _id: "user-id",
          email: "private@example.com",
          firstName: "Private",
          username: "private-user",
          password: "private-old-password-hash",
          pendingPassword: "private-new-password-hash",
          passwordChangeExpires: new Date(Date.now() + 60_000),
        };
        vi.mocked(User.findOne).mockReturnValue({
          select: vi.fn().mockResolvedValue(mockUser),
        } as any);
        vi.mocked(User.updateOne).mockResolvedValue({ modifiedCount: 1 } as any);
        vi.mocked(EmailService.sendPasswordResetSuccessEmail).mockResolvedValue(
          true,
        );
        vi.mocked(
          UnifiedMessageController.createTargetedSystemMessage,
        ).mockResolvedValue({ _id: "message-id" } as any);

        await PasswordChangeController.completePasswordChange(
          mockReq as Request,
          mockRes as Response,
        );

        const output = JSON.stringify([
          ...consoleLog.mock.calls,
          ...consoleError.mock.calls,
        ]);
        expect(output).not.toContain("private-valid-token");
        expect(output).not.toContain("private-token-hash");
        expect(output).not.toContain("private@example.com");
        expect(output).not.toContain("private-old-password-hash");
        expect(output).not.toContain("private-new-password-hash");
        consoleLog.mockRestore();
        consoleError.mockRestore();
      });
    });

    describe("error handling", () => {
      it("should handle database errors", async () => {
        mockReq.params = { token: "validtoken" };

        const mockCreateHash = vi.fn().mockReturnValue({
          update: vi.fn().mockReturnValue({
            digest: vi.fn().mockReturnValue("hashedvalidtoken"),
          }),
        });
        vi.mocked(crypto.createHash).mockImplementation(mockCreateHash as any);

        const mockSelect = vi
          .fn()
          .mockRejectedValue(new Error("Database error"));
        vi.mocked(User.findOne).mockReturnValue({ select: mockSelect } as any);

        await PasswordChangeController.completePasswordChange(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            message: "Password change completion failed.",
          })
        );
      });
    });
  });
});
