import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Request, Response } from "express";
import BellNotificationsBulkReadController from "../../../../src/controllers/message/BellNotificationsBulkReadController";

// Mock dependencies
vi.mock("../../../../src/models/Message", () => {
  const mockMessage = {
    find: vi.fn(),
    getUnreadCountsForUser: vi.fn(),
  };
  return { default: mockMessage };
});

vi.mock("../../../../src/services/infrastructure/SocketService", () => ({
  socketService: {
    emitBellNotificationUpdate: vi.fn(),
    emitUnreadCountUpdate: vi.fn(),
  },
}));

vi.mock("../../../../src/services/infrastructure/CacheService", () => ({
  CachePatterns: {
    invalidateUserCache: vi.fn(),
  },
}));

import Message from "../../../../src/models/Message";
import { socketService } from "../../../../src/services/infrastructure/SocketService";
import { CachePatterns } from "../../../../src/services/infrastructure/CacheService";

interface MockRequest {
  user?: { id?: string; role?: string };
}

describe("BellNotificationsBulkReadController", () => {
  let mockReq: MockRequest;
  let mockRes: Partial<Response>;
  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;
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

    mockReq = { user: { id: "user123", role: "Participant" } };

    (Message as any).getUnreadCountsForUser = vi.fn().mockResolvedValue({
      bellNotifications: 0,
      systemMessages: 0,
      total: 0,
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe("markAllBellNotificationsAsRead", () => {
    describe("Authentication", () => {
      it("should return 401 if user is not authenticated", async () => {
        mockReq.user = undefined;

        await BellNotificationsBulkReadController.markAllBellNotificationsAsRead(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(401);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Authentication required",
        });
      });

      it("should return 401 if user id is missing", async () => {
        mockReq.user = { id: undefined };

        await BellNotificationsBulkReadController.markAllBellNotificationsAsRead(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(401);
      });
    });

    describe("Successful Bulk Read", () => {
      it("should mark all unread bell notifications as read", async () => {
        const mockMessages = [
          {
            _id: "msg1",
            markAsReadInBell: vi.fn(),
            save: vi.fn().mockResolvedValue(true),
          },
          {
            _id: "msg2",
            markAsReadInBell: vi.fn(),
            save: vi.fn().mockResolvedValue(true),
          },
        ];
        vi.mocked(Message.find).mockResolvedValue(mockMessages);

        await BellNotificationsBulkReadController.markAllBellNotificationsAsRead(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(mockMessages[0].markAsReadInBell).toHaveBeenCalledWith(
          "user123"
        );
        expect(mockMessages[1].markAsReadInBell).toHaveBeenCalledWith(
          "user123"
        );
        expect(mockMessages[0].save).toHaveBeenCalled();
        expect(mockMessages[1].save).toHaveBeenCalled();
        expect(Message.find).toHaveBeenCalledWith({
          isActive: true,
          "userStates.user123": { $exists: true },
          "userStates.user123.isRemovedFromBell": { $ne: true },
          "userStates.user123.isReadInBell": { $ne: true },
          $or: [
            { targetRoles: { $exists: false } },
            { targetRoles: { $size: 0 } },
            { targetRoles: "Participant" },
          ],
        });
        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          message: "All bell notifications marked as read",
          data: { markedCount: 2 },
        });
      });

      it("should emit socket events for each marked message", async () => {
        const mockMessages = [
          {
            _id: "msg1",
            markAsReadInBell: vi.fn(),
            save: vi.fn().mockResolvedValue(true),
          },
        ];
        vi.mocked(Message.find).mockResolvedValue(mockMessages);

        await BellNotificationsBulkReadController.markAllBellNotificationsAsRead(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(socketService.emitBellNotificationUpdate).toHaveBeenCalledWith(
          "user123",
          "notification_read",
          expect.objectContaining({
            messageId: "msg1",
            isRead: true,
          })
        );
      });

      it("should invalidate user cache when messages are marked", async () => {
        const mockMessages = [
          {
            _id: "msg1",
            markAsReadInBell: vi.fn(),
            save: vi.fn().mockResolvedValue(true),
          },
        ];
        vi.mocked(Message.find).mockResolvedValue(mockMessages);

        await BellNotificationsBulkReadController.markAllBellNotificationsAsRead(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(CachePatterns.invalidateUserCache).toHaveBeenCalledWith(
          "user123"
        );
      });

      it("should not invalidate cache when no messages to mark", async () => {
        vi.mocked(Message.find).mockResolvedValue([]);

        await BellNotificationsBulkReadController.markAllBellNotificationsAsRead(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(CachePatterns.invalidateUserCache).not.toHaveBeenCalled();
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          message: "All bell notifications marked as read",
          data: { markedCount: 0 },
        });
      });

      it("should emit unread count update after marking", async () => {
        vi.mocked(Message.find).mockResolvedValue([]);
        (Message as any).getUnreadCountsForUser.mockResolvedValue({
          bellNotifications: 0,
          systemMessages: 5,
          total: 5,
        });

        await BellNotificationsBulkReadController.markAllBellNotificationsAsRead(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(socketService.emitUnreadCountUpdate).toHaveBeenCalledWith(
          "user123",
          { bellNotifications: 0, systemMessages: 5, total: 5 }
        );
        expect(Message.getUnreadCountsForUser).toHaveBeenCalledWith(
          "user123",
          "Participant"
        );
      });
    });

    describe("Error Handling", () => {
      it("should return 500 on error", async () => {
        vi.mocked(Message.find).mockRejectedValue(new Error("Database error"));

        await BellNotificationsBulkReadController.markAllBellNotificationsAsRead(
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
