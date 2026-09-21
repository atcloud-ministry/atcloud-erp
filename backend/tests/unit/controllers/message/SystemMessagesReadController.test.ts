import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Request, Response } from "express";
import SystemMessagesReadController from "../../../../src/controllers/message/SystemMessagesReadController";

// Mock dependencies
vi.mock("../../../../src/models/Message", () => ({
  default: {
    findOne: vi.fn(),
    getUnreadCountsForUser: vi.fn(),
  },
}));

vi.mock("../../../../src/services/infrastructure/SocketService", () => ({
  socketService: {
    emitBellNotificationUpdate: vi.fn(),
    emitSystemMessageUpdate: vi.fn(),
    emitUnreadCountUpdate: vi.fn(),
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

describe("SystemMessagesReadController", () => {
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

  describe("markSystemMessageAsRead", () => {
    describe("Authentication", () => {
      it("should return 401 if user is not authenticated", async () => {
        mockReq.user = undefined;

        await SystemMessagesReadController.markSystemMessageAsRead(
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

        await SystemMessagesReadController.markSystemMessageAsRead(
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

        await SystemMessagesReadController.markSystemMessageAsRead(
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
          message: "Message not found",
        });
      });
    });

    describe("Successful Read", () => {
      it("should mark message as read and emit updates", async () => {
        const mockMessage = {
          _id: "507f1f77bcf86cd799439011",
          markAsReadEverywhere: vi.fn(),
          save: vi.fn().mockResolvedValue(true),
        };

        const mockCounts = {
          bellNotifications: 2,
          systemMessages: 1,
          total: 3,
        };

        vi.mocked(Message.findOne).mockResolvedValue(mockMessage);
        vi.mocked(Message.getUnreadCountsForUser).mockResolvedValue(mockCounts);

        await SystemMessagesReadController.markSystemMessageAsRead(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(mockMessage.markAsReadEverywhere).toHaveBeenCalledWith(
          "user123",
        );
        expect(mockMessage.save).toHaveBeenCalled();
        expect(CachePatterns.invalidateUserCache).toHaveBeenCalledWith(
          "user123",
        );
        expect(Message.getUnreadCountsForUser).toHaveBeenCalledWith(
          "user123",
          "Participant",
        );

        // Verify system message update emitted
        expect(socketService.emitSystemMessageUpdate).toHaveBeenCalledWith(
          "user123",
          "message_read",
          expect.objectContaining({
            messageId: "507f1f77bcf86cd799439011",
            isRead: true,
          }),
        );

        // Verify bell notification update emitted for consistency
        expect(socketService.emitBellNotificationUpdate).toHaveBeenCalledWith(
          "user123",
          "notification_read",
          expect.objectContaining({
            messageId: "507f1f77bcf86cd799439011",
            isRead: true,
          }),
        );

        expect(socketService.emitUnreadCountUpdate).toHaveBeenCalledWith(
          "user123",
          mockCounts,
        );
        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          message: "Message marked as read",
        });
      });

      it("should include readAt timestamp in emitted updates", async () => {
        const mockMessage = {
          _id: "507f1f77bcf86cd799439011",
          markAsReadEverywhere: vi.fn(),
          save: vi.fn().mockResolvedValue(true),
        };

        const mockCounts = {
          bellNotifications: 0,
          systemMessages: 0,
          total: 0,
        };

        vi.mocked(Message.findOne).mockResolvedValue(mockMessage);
        vi.mocked(Message.getUnreadCountsForUser).mockResolvedValue(mockCounts);

        await SystemMessagesReadController.markSystemMessageAsRead(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(socketService.emitSystemMessageUpdate).toHaveBeenCalledWith(
          "user123",
          "message_read",
          expect.objectContaining({
            readAt: expect.any(Date),
          }),
        );
        expect(socketService.emitBellNotificationUpdate).toHaveBeenCalledWith(
          "user123",
          "notification_read",
          expect.objectContaining({
            readAt: expect.any(Date),
          }),
        );
      });
    });

    describe("Error Handling", () => {
      it("should return 500 on database error", async () => {
        vi.mocked(Message.findOne).mockRejectedValue(
          new Error("Database connection failed"),
        );

        await SystemMessagesReadController.markSystemMessageAsRead(
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
          markAsReadEverywhere: vi.fn(),
          save: vi.fn().mockRejectedValue(new Error("Save failed")),
        };

        vi.mocked(Message.findOne).mockResolvedValue(mockMessage);

        await SystemMessagesReadController.markSystemMessageAsRead(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(consoleErrorSpy).toHaveBeenCalled();
      });

      it("should log error details on failure", async () => {
        const testError = new Error("Test error");
        vi.mocked(Message.findOne).mockRejectedValue(testError);

        await SystemMessagesReadController.markSystemMessageAsRead(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          "Error in markSystemMessageAsRead:",
          testError,
        );
      });
    });
  });
});
