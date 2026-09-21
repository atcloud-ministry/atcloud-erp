import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";
import LogoutController from "../../../../src/controllers/auth/LogoutController";

describe("LogoutController", () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;
  let clearCookieMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });
    clearCookieMock = vi.fn();

    mockReq = {};

    mockRes = {
      status: statusMock as any,
      json: jsonMock as any,
      clearCookie: clearCookieMock as any,
    };

    // Mock console.error
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  describe("logout", () => {
    it("should clear refresh token cookie", async () => {
      await LogoutController.logout(mockReq as Request, mockRes as Response);

      expect(clearCookieMock).toHaveBeenCalledWith("refreshToken", {
        httpOnly: true,
        secure: false,
        sameSite: "strict",
        path: "/api/auth",
      });
    });

    it("should return 200 with success message", async () => {
      await LogoutController.logout(mockReq as Request, mockRes as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        message: "Logged out successfully!",
      });
    });

    it("should handle errors gracefully", async () => {
      // Simulate error by making clearCookie throw
      clearCookieMock.mockImplementation(() => {
        throw new Error("Cookie clear failed");
      });

      await LogoutController.logout(mockReq as Request, mockRes as Response);

      expect(statusMock).toHaveBeenCalledWith(500);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Logout failed.",
      });
    });
  });
});
