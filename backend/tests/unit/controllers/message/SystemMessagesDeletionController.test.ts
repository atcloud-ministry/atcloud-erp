import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Request, Response } from "express";
import SystemMessagesDeletionController from "../../../../src/controllers/message/SystemMessagesDeletionController";

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

describe("SystemMessagesDeletionController", () => {
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

  describe("deleteSystemMessage", () => {
    describe("Authentication", () => {
      it("should return 401 if user is not authenticated", async () => {
        mockReq.user = undefined;

        await SystemMessagesDeletionController.deleteSystemMessage(
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

        await SystemMessagesDeletionController.deleteSystemMessage(
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

        await SystemMessagesDeletionController.deleteSystemMessage(
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

    describe("Successful Deletion", () => {
      it("should delete message and emit updates when message was unread in system", async () => {
        const mockMessage = {
          _id: "507f1f77bcf86cd799439011",
          getUserState: vi.fn().mockReturnValue({
            isReadInSystem: false,
            isReadInBell: true,
          }),
          deleteFromSystem: vi.fn(),
          save: vi.fn().mockResolvedValue(true),
        };

        const mockCounts = {
          bellNotifications: 2,
          systemMessages: 1,
          total: 3,
        };

        vi.mocked(Message.findOne).mockResolvedValue(mockMessage);
        vi.mocked(Message.getUnreadCountsForUser).mockResolvedValue(mockCounts);

        await SystemMessagesDeletionController.deleteSystemMessage(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(mockMessage.getUserState).toHaveBeenCalledWith("user123");
        expect(mockMessage.deleteFromSystem).toHaveBeenCalledWith("user123");
        expect(mockMessage.save).toHaveBeenCalled();
        expect(CachePatterns.invalidateUserCache).toHaveBeenCalledWith(
          "user123",
        );

        // Verify system message deletion emitted
        expect(socketService.emitSystemMessageUpdate).toHaveBeenCalledWith(
          "user123",
          "message_deleted",
          { messageId: "507f1f77bcf86cd799439011" },
        );

        // Verify bell notification removal emitted
        expect(socketService.emitBellNotificationUpdate).toHaveBeenCalledWith(
          "user123",
          "notification_removed",
          { messageId: "507f1f77bcf86cd799439011" },
        );

        // Verify unread count update emitted (was unread)
        expect(socketService.emitUnreadCountUpdate).toHaveBeenCalledWith(
          "user123",
          mockCounts,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          message: "Message deleted from system messages",
        });
      });

      it("should delete message and emit unread count update when message was unread in bell", async () => {
        const mockMessage = {
          _id: "507f1f77bcf86cd799439011",
          getUserState: vi.fn().mockReturnValue({
            isReadInSystem: true,
            isReadInBell: false,
          }),
          deleteFromSystem: vi.fn(),
          save: vi.fn().mockResolvedValue(true),
        };

        const mockCounts = {
          bellNotifications: 1,
          systemMessages: 0,
          total: 1,
        };

        vi.mocked(Message.findOne).mockResolvedValue(mockMessage);
        vi.mocked(Message.getUnreadCountsForUser).mockResolvedValue(mockCounts);

        await SystemMessagesDeletionController.deleteSystemMessage(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        // Verify unread count update emitted (was unread in bell)
        expect(socketService.emitUnreadCountUpdate).toHaveBeenCalledWith(
          "user123",
          mockCounts,
        );
      });

      it("should delete message without unread count update when message was already read", async () => {
        const mockMessage = {
          _id: "507f1f77bcf86cd799439011",
          getUserState: vi.fn().mockReturnValue({
            isReadInSystem: true,
            isReadInBell: true,
          }),
          deleteFromSystem: vi.fn(),
          save: vi.fn().mockResolvedValue(true),
        };

        vi.mocked(Message.findOne).mockResolvedValue(mockMessage);

        await SystemMessagesDeletionController.deleteSystemMessage(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        // Verify deletion updates emitted
        expect(socketService.emitSystemMessageUpdate).toHaveBeenCalled();
        expect(socketService.emitBellNotificationUpdate).toHaveBeenCalled();

        // Verify unread count update NOT emitted (was already read)
        expect(socketService.emitUnreadCountUpdate).not.toHaveBeenCalled();
        expect(Message.getUnreadCountsForUser).not.toHaveBeenCalled();

        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should handle message with both unread states", async () => {
        const mockMessage = {
          _id: "507f1f77bcf86cd799439011",
          getUserState: vi.fn().mockReturnValue({
            isReadInSystem: false,
            isReadInBell: false,
          }),
          deleteFromSystem: vi.fn(),
          save: vi.fn().mockResolvedValue(true),
        };

        const mockCounts = {
          bellNotifications: 0,
          systemMessages: 0,
          total: 0,
        };

        vi.mocked(Message.findOne).mockResolvedValue(mockMessage);
        vi.mocked(Message.getUnreadCountsForUser).mockResolvedValue(mockCounts);

        await SystemMessagesDeletionController.deleteSystemMessage(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        // Verify unread count update emitted (was unread in both)
        expect(socketService.emitUnreadCountUpdate).toHaveBeenCalled();
      });
    });

    describe("Error Handling", () => {
      it("should return 500 on database error during find", async () => {
        vi.mocked(Message.findOne).mockRejectedValue(
          new Error("Database connection failed"),
        );

        await SystemMessagesDeletionController.deleteSystemMessage(
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
          getUserState: vi.fn().mockReturnValue({
            isReadInSystem: true,
            isReadInBell: true,
          }),
          deleteFromSystem: vi.fn(),
          save: vi.fn().mockRejectedValue(new Error("Save failed")),
        };

        vi.mocked(Message.findOne).mockResolvedValue(mockMessage);

        await SystemMessagesDeletionController.deleteSystemMessage(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(consoleErrorSpy).toHaveBeenCalled();
      });

      it("should log error details on failure", async () => {
        const testError = new Error("Test error");
        vi.mocked(Message.findOne).mockRejectedValue(testError);

        await SystemMessagesDeletionController.deleteSystemMessage(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          "Error in deleteSystemMessage:",
          testError,
        );
      });
    });
  });
});
