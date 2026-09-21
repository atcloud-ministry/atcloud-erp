import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Request, Response } from "express";
import BellNotificationsRemovalController from "../../../../src/controllers/message/BellNotificationsRemovalController";

// Mock dependencies
vi.mock("../../../../src/models/Message", () => ({
  default: {
    findOne: vi.fn(),
  },
}));

vi.mock("../../../../src/services/infrastructure/SocketService", () => ({
  socketService: {
    emitBellNotificationUpdate: vi.fn(),
  },
}));

vi.mock("../../../../src/services/infrastructure/CacheService", () => ({
  CachePatterns: {
    invalidateUserCache: vi.fn().mockResolvedValue(undefined),
  },
}));

import Message from "../../../../src/models/Message";
import { socketService } from "../../../../src/services/infrastructure/SocketService";
import { CachePatterns } from "../../../../src/services/infrastructure/CacheService";

interface MockRequest {
  user?: { id: string; role: string };
  params: Record<string, string>;
}

describe("BellNotificationsRemovalController", () => {
  let mockReq: MockRequest;
  let mockRes: Partial<Response>;
  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let consoleErrorSpy: any;

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
      user: { id: "user123", role: "Participant" },
      params: { messageId: "507f1f77bcf86cd799439011" },
    };
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe("removeBellNotification", () => {
    describe("Authentication", () => {
      it("should return 401 if user is not authenticated", async () => {
        mockReq.user = undefined;

        await BellNotificationsRemovalController.removeBellNotification(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(401);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Authentication required",
        });
      });

      it("should return 401 if user.id is undefined", async () => {
        mockReq.user = {} as { id: string; role: string };

        await BellNotificationsRemovalController.removeBellNotification(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(401);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Authentication required",
        });
      });
    });

    describe("Not Found", () => {
      it("should return 404 if message not found", async () => {
        vi.mocked(Message.findOne).mockResolvedValue(null);

        await BellNotificationsRemovalController.removeBellNotification(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(Message.findOne).toHaveBeenCalledWith({
          _id: "507f1f77bcf86cd799439011",
          isActive: true,
          "userStates.user123": { $exists: true },
          $or: [
            { targetRoles: { $exists: false } },
            { targetRoles: { $size: 0 } },
            { targetRoles: "Participant" },
          ],
        });
        expect(statusMock).toHaveBeenCalledWith(404);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Notification not found",
        });
      });
    });

    describe("Successful Removal", () => {
      it("should remove notification from bell and emit update", async () => {
        const mockMessage = {
          _id: "507f1f77bcf86cd799439011",
          removeFromBell: vi.fn(),
          save: vi.fn().mockResolvedValue(true),
        };

        vi.mocked(Message.findOne).mockResolvedValue(mockMessage);

        await BellNotificationsRemovalController.removeBellNotification(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(mockMessage.removeFromBell).toHaveBeenCalledWith("user123");
        expect(mockMessage.save).toHaveBeenCalled();
        expect(CachePatterns.invalidateUserCache).toHaveBeenCalledWith(
          "user123",
        );
        expect(socketService.emitBellNotificationUpdate).toHaveBeenCalledWith(
          "user123",
          "notification_removed",
          { messageId: "507f1f77bcf86cd799439011" },
        );
        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          message: "Notification removed from bell",
        });
      });

      it("should call removeFromBell before save", async () => {
        const callOrder: string[] = [];
        const mockMessage = {
          _id: "507f1f77bcf86cd799439011",
          removeFromBell: vi.fn(() => callOrder.push("removeFromBell")),
          save: vi.fn().mockImplementation(() => {
            callOrder.push("save");
            return Promise.resolve(true);
          }),
        };

        vi.mocked(Message.findOne).mockResolvedValue(mockMessage);

        await BellNotificationsRemovalController.removeBellNotification(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(callOrder).toEqual(["removeFromBell", "save"]);
      });
    });

    describe("Error Handling", () => {
      it("should return 500 on database error during find", async () => {
        vi.mocked(Message.findOne).mockRejectedValue(
          new Error("Database connection failed"),
        );

        await BellNotificationsRemovalController.removeBellNotification(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Internal server error",
        });
        expect(consoleErrorSpy).toHaveBeenCalled();
      });

      it("should return 500 if save fails", async () => {
        const mockMessage = {
          _id: "507f1f77bcf86cd799439011",
          removeFromBell: vi.fn(),
          save: vi.fn().mockRejectedValue(new Error("Save failed")),
        };

        vi.mocked(Message.findOne).mockResolvedValue(mockMessage);

        await BellNotificationsRemovalController.removeBellNotification(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(consoleErrorSpy).toHaveBeenCalled();
      });

      it("should log error details on failure", async () => {
        const testError = new Error("Test error");
        vi.mocked(Message.findOne).mockRejectedValue(testError);

        await BellNotificationsRemovalController.removeBellNotification(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          "Error in removeBellNotification:",
          testError,
        );
      });
    });
  });
});
