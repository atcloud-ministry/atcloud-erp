import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Request, Response } from "express";
import ChangePasswordController from "../../../../src/controllers/profile/ChangePasswordController";
import { RefreshSessionService } from "../../../../src/services/auth/RefreshSessionService";

// Mock dependencies
vi.mock("../../../../src/models", () => ({
  User: {
    findById: vi.fn(),
  },
}));
vi.mock("../../../../src/services/auth/RefreshSessionService", () => ({
  RefreshSessionService: {
    revokeAllForUser: vi.fn().mockResolvedValue(1),
  },
}));

vi.mock("../../../../src/services/LoggerService", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { User } from "../../../../src/models";

interface MockRequest {
  user?: {
    _id: {
      toString: () => string;
    };
  };
  params: {
    id?: string;
  };
  body: {
    currentPassword?: string;
    newPassword?: string;
    confirmPassword?: string;
  };
}

describe("ChangePasswordController", () => {
  let mockReq: MockRequest;
  let mockRes: Partial<Response>;
  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: any;

  const userId = "user123";

  const createMockUser = () => ({
    _id: userId,
    password: "hashedOldPassword",
    comparePassword: vi.fn(),
    save: vi.fn(),
    passwordChangedAt: null,
  });

  beforeEach(() => {
    vi.clearAllMocks();

    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    mockRes = {
      status: statusMock as unknown as Response["status"],
      json: jsonMock as unknown as Response["json"],
    };

    mockReq = {
      user: {
        _id: { toString: () => userId },
      },
      params: { id: userId },
      body: {
        currentPassword: "oldPassword123",
        newPassword: "newPassword456",
        confirmPassword: "newPassword456",
      },
    };
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe("changePassword", () => {
    describe("Validation", () => {
      it("should return 400 if currentPassword is missing", async () => {
        mockReq.body.currentPassword = undefined;

        await ChangePasswordController.changePassword(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          error:
            "Current password, new password, and confirmation are required",
        });
      });

      it("should return 400 if newPassword is missing", async () => {
        mockReq.body.newPassword = undefined;

        await ChangePasswordController.changePassword(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          error:
            "Current password, new password, and confirmation are required",
        });
      });

      it("should return 400 if confirmPassword is missing", async () => {
        mockReq.body.confirmPassword = undefined;

        await ChangePasswordController.changePassword(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          error:
            "Current password, new password, and confirmation are required",
        });
      });

      it("should return 400 if passwords do not match", async () => {
        mockReq.body.confirmPassword = "differentPassword";

        await ChangePasswordController.changePassword(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          error: "New password and confirmation do not match",
        });
      });

      it("should return 400 if new password is too short", async () => {
        mockReq.body.newPassword = "short";
        mockReq.body.confirmPassword = "short";

        await ChangePasswordController.changePassword(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          error: "New password must be at least 8 characters long",
        });
      });
    });

    describe("Authorization", () => {
      it("should return 403 if user tries to change another user's password", async () => {
        mockReq.params.id = "differentUser";

        await ChangePasswordController.changePassword(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(403);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          error: "You can only change your own password",
        });
      });
    });

    describe("User Lookup", () => {
      it("should return 404 if user not found", async () => {
        vi.mocked(User.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue(null),
        } as any);

        await ChangePasswordController.changePassword(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(404);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          error: "User not found",
        });
      });
    });

    describe("Password Verification", () => {
      it("should return 400 if current password is incorrect", async () => {
        const mockUser = createMockUser();
        mockUser.comparePassword.mockResolvedValue(false);
        vi.mocked(User.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue(mockUser),
        } as any);

        await ChangePasswordController.changePassword(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          error: "Current password is incorrect",
        });
      });

      it("should return 500 if password comparison fails", async () => {
        const mockUser = createMockUser();
        mockUser.comparePassword.mockRejectedValue(new Error("Compare failed"));
        vi.mocked(User.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue(mockUser),
        } as any);

        await ChangePasswordController.changePassword(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          error: "Password verification failed",
        });
      });
    });

    describe("Successful Password Change", () => {
      it("should change password successfully", async () => {
        const mockUser = createMockUser();
        mockUser.comparePassword.mockResolvedValue(true);
        mockUser.save.mockResolvedValue(mockUser);
        vi.mocked(User.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue(mockUser),
        } as any);

        await ChangePasswordController.changePassword(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(mockUser.password).toBe("newPassword456");
        expect(mockUser.passwordChangedAt).toBeInstanceOf(Date);
        expect(mockUser.save).toHaveBeenCalled();
        expect(RefreshSessionService.revokeAllForUser).toHaveBeenCalledWith(
          userId,
          "password_changed",
        );
        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          message: "Password changed successfully",
        });
      });
    });

    describe("Error Handling", () => {
      it("should return 500 on database error", async () => {
        vi.mocked(User.findById).mockImplementation(() => {
          throw new Error("Database error");
        });

        await ChangePasswordController.changePassword(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          error: "Failed to change password",
        });
        expect(consoleErrorSpy).toHaveBeenCalled();
      });

      it("should return 500 if save fails", async () => {
        const mockUser = createMockUser();
        mockUser.comparePassword.mockResolvedValue(true);
        mockUser.save.mockRejectedValue(new Error("Save failed"));
        vi.mocked(User.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue(mockUser),
        } as any);

        await ChangePasswordController.changePassword(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          error: "Failed to change password",
        });
      });
    });
  });
});
