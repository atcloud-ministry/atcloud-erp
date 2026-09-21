import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Request, Response } from "express";
import mongoose from "mongoose";
import BellNotificationsReadController from "../../../../src/controllers/message/BellNotificationsReadController";
import SystemMessagesReadController from "../../../../src/controllers/message/SystemMessagesReadController";
import SystemMessagesDeletionController from "../../../../src/controllers/message/SystemMessagesDeletionController";

// Mock dependencies
vi.mock("../../../../src/models/Message", () => {
  const mockMessage = {
    findOne: vi.fn(),
    getUnreadCountsForUser: vi.fn(),
  };
  return { default: mockMessage };
});

vi.mock("../../../../src/services/infrastructure/SocketService", () => ({
  socketService: {
    emitBellNotificationUpdate: vi.fn(),
    emitSystemMessageUpdate: vi.fn(),
    emitUnreadCountUpdate: vi.fn(),
  },
}));

vi.mock("../../../../src/services/infrastructure/CacheService", () => ({
  CachePatterns: {
    invalidateUserCache: vi.fn(),
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

import Message from "../../../../src/models/Message";
import { socketService } from "../../../../src/services/infrastructure/SocketService";
import { CachePatterns } from "../../../../src/services/infrastructure/CacheService";

interface MockRequest {
  user?: {
    id: string;
    role: string;
  };
  params: {
    messageId?: string;
  };
}

describe("Message Read/Delete Controllers", () => {
  let mockReq: MockRequest;
  let mockRes: Partial<Response>;
  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: any;

  const userId = "user123";
  const validMessageId = new mongoose.Types.ObjectId().toString();

  const createMockMessage = () => ({
    _id: validMessageId,
    title: "Test Message",
    markAsReadEverywhere: vi.fn(),
    deleteFromSystem: vi.fn(),
    getUserState: vi.fn().mockReturnValue({
      isReadInSystem: false,
      isReadInBell: false,
    }),
    save: vi.fn().mockResolvedValue(true),
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
      user: { id: userId, role: "Participant" },
      params: { messageId: validMessageId },
    };

    vi.mocked(CachePatterns.invalidateUserCache).mockResolvedValue(undefined);
    (Message as any).getUnreadCountsForUser = vi.fn().mockResolvedValue({
      bellNotifications: 0,
      systemMessages: 0,
      total: 0,
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe("BellNotificationsReadController", () => {
    describe("markBellNotificationAsRead", () => {
      it("should return 401 if user is not authenticated", async () => {
        mockReq.user = undefined;

        await BellNotificationsReadController.markBellNotificationAsRead(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(401);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Authentication required",
        });
      });

      it("should return 400 for invalid message ID", async () => {
        mockReq.params.messageId = "invalid-id";

        await BellNotificationsReadController.markBellNotificationAsRead(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Invalid message ID",
        });
      });

      it("should return 404 if message not found", async () => {
        vi.mocked(Message.findOne).mockResolvedValue(null);

        await BellNotificationsReadController.markBellNotificationAsRead(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(404);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Notification not found",
        });
      });

      it("should mark notification as read successfully", async () => {
        const mockMessage = createMockMessage();
        vi.mocked(Message.findOne).mockResolvedValue(mockMessage as any);

        await BellNotificationsReadController.markBellNotificationAsRead(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(mockMessage.markAsReadEverywhere).toHaveBeenCalledWith(userId);
        expect(mockMessage.save).toHaveBeenCalled();
        expect(socketService.emitBellNotificationUpdate).toHaveBeenCalled();
        expect(socketService.emitSystemMessageUpdate).toHaveBeenCalled();
        expect(socketService.emitUnreadCountUpdate).toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          message: "Notification marked as read",
        });
      });

      it("should return 500 on database error", async () => {
        vi.mocked(Message.findOne).mockRejectedValue(
          new Error("Database error")
        );

        await BellNotificationsReadController.markBellNotificationAsRead(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Internal server error",
        });
      });
    });
  });

  describe("SystemMessagesReadController", () => {
    describe("markSystemMessageAsRead", () => {
      it("should return 401 if user is not authenticated", async () => {
        mockReq.user = undefined;

        await SystemMessagesReadController.markSystemMessageAsRead(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(401);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Authentication required",
        });
      });

      it("should return 404 if message not found", async () => {
        vi.mocked(Message.findOne).mockResolvedValue(null);

        await SystemMessagesReadController.markSystemMessageAsRead(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(404);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Message not found",
        });
      });

      it("should mark message as read successfully", async () => {
        const mockMessage = createMockMessage();
        vi.mocked(Message.findOne).mockResolvedValue(mockMessage as any);

        await SystemMessagesReadController.markSystemMessageAsRead(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(mockMessage.markAsReadEverywhere).toHaveBeenCalledWith(userId);
        expect(mockMessage.save).toHaveBeenCalled();
        expect(socketService.emitSystemMessageUpdate).toHaveBeenCalled();
        expect(socketService.emitBellNotificationUpdate).toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          message: "Message marked as read",
        });
      });

      it("should return 500 on database error", async () => {
        vi.mocked(Message.findOne).mockRejectedValue(
          new Error("Database error")
        );

        await SystemMessagesReadController.markSystemMessageAsRead(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Internal server error",
        });
      });
    });
  });

  describe("SystemMessagesDeletionController", () => {
    describe("deleteSystemMessage", () => {
      it("should return 401 if user is not authenticated", async () => {
        mockReq.user = undefined;

        await SystemMessagesDeletionController.deleteSystemMessage(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(401);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Authentication required",
        });
      });

      it("should return 404 if message not found", async () => {
        vi.mocked(Message.findOne).mockResolvedValue(null);

        await SystemMessagesDeletionController.deleteSystemMessage(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(404);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Message not found",
        });
      });

      it("should delete message successfully", async () => {
        const mockMessage = createMockMessage();
        vi.mocked(Message.findOne).mockResolvedValue(mockMessage as any);

        await SystemMessagesDeletionController.deleteSystemMessage(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(mockMessage.deleteFromSystem).toHaveBeenCalledWith(userId);
        expect(mockMessage.save).toHaveBeenCalled();
        expect(socketService.emitSystemMessageUpdate).toHaveBeenCalledWith(
          userId,
          "message_deleted",
          expect.any(Object)
        );
        expect(socketService.emitBellNotificationUpdate).toHaveBeenCalledWith(
          userId,
          "notification_removed",
          expect.any(Object)
        );
        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          message: "Message deleted from system messages",
        });
      });

      it("should update unread counts if message was unread", async () => {
        const mockMessage = createMockMessage();
        mockMessage.getUserState.mockReturnValue({
          isReadInSystem: false,
          isReadInBell: false,
        });
        vi.mocked(Message.findOne).mockResolvedValue(mockMessage as any);

        await SystemMessagesDeletionController.deleteSystemMessage(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(socketService.emitUnreadCountUpdate).toHaveBeenCalled();
      });

      it("should return 500 on database error", async () => {
        vi.mocked(Message.findOne).mockRejectedValue(
          new Error("Database error")
        );

        await SystemMessagesDeletionController.deleteSystemMessage(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Internal server error",
        });
      });
    });
  });
});
