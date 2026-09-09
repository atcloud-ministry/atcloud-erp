import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Request, Response } from "express";
import WelcomeNotificationController from "../../../../src/controllers/message/WelcomeNotificationController";

// Mock dependencies
vi.mock("../../../../src/models/Message", () => {
  const mockMessage = vi.fn().mockImplementation((data) => ({
    ...data,
    _id: "welcome-message-id",
    createdAt: new Date("2026-09-09T12:00:00.000Z"),
    userStates: new Map(),
    save: vi.fn().mockResolvedValue(true),
    toJSON: vi.fn(() => {
      throw new Error("raw document serialization must not be used for realtime");
    }),
  }));
  return { default: mockMessage };
});

vi.mock("../../../../src/models/User", () => ({
  default: {
    findById: vi.fn(),
  },
}));

vi.mock("../../../../src/services/infrastructure/SocketService", () => ({
  socketService: {
    emitSystemMessageUpdate: vi.fn(),
  },
}));

vi.mock("../../../../src/services/infrastructure/CacheService", () => ({
  CachePatterns: {
    invalidateUserCache: vi.fn(),
  },
}));

import User from "../../../../src/models/User";
import { socketService } from "../../../../src/services/infrastructure/SocketService";
import { CachePatterns } from "../../../../src/services/infrastructure/CacheService";

interface MockRequest {
  user?: { id?: string };
}

describe("WelcomeNotificationController", () => {
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

    mockReq = { user: { id: "user123" } };
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe("sendWelcomeNotification", () => {
    describe("Authentication", () => {
      it("should return 401 if user is not authenticated", async () => {
        mockReq.user = undefined;

        await WelcomeNotificationController.sendWelcomeNotification(
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

        await WelcomeNotificationController.sendWelcomeNotification(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(401);
      });
    });

    describe("User Not Found", () => {
      it("should return 404 if user is not found", async () => {
        vi.mocked(User.findById).mockResolvedValue(null);

        await WelcomeNotificationController.sendWelcomeNotification(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(404);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "User not found",
        });
      });
    });

    describe("Already Sent", () => {
      it("should return success with alreadySent flag if welcome message already sent", async () => {
        vi.mocked(User.findById).mockResolvedValue({
          _id: "user123",
          firstName: "Test",
          hasReceivedWelcomeMessage: true,
        });

        await WelcomeNotificationController.sendWelcomeNotification(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          message: "Welcome message already sent",
          data: { alreadySent: true },
        });
      });
    });

    describe("Successful Welcome Notification", () => {
      it("should create welcome message and send notification", async () => {
        const mockUser = {
          _id: "user123",
          firstName: "TestUser",
          hasReceivedWelcomeMessage: false,
          save: vi.fn().mockResolvedValue(true),
        };
        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(CachePatterns.invalidateUserCache).mockResolvedValue(
          undefined
        );

        await WelcomeNotificationController.sendWelcomeNotification(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(User.findById).toHaveBeenCalledWith("user123");
        expect(CachePatterns.invalidateUserCache).toHaveBeenCalledWith(
          "user123"
        );
        expect(mockUser.hasReceivedWelcomeMessage).toBe(true);
        expect(mockUser.save).toHaveBeenCalled();
        expect(socketService.emitSystemMessageUpdate).toHaveBeenCalledWith(
          "user123",
          "message_created",
          expect.any(Object)
        );
        const payload = vi.mocked(socketService.emitSystemMessageUpdate).mock
          .calls[0][2];
        expect(payload.message).not.toHaveProperty("creator");
        expect(JSON.stringify(payload)).not.toMatch(
          /userStates|createdBy|targetRoles|recipientIds|targetUserIds|"_id"|"__v"/,
        );
        expect(statusMock).toHaveBeenCalledWith(201);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          message: "Welcome notification sent successfully",
          data: expect.objectContaining({
            messageId: "welcome-message-id",
            sent: true,
          }),
        });
      });
    });

    describe("Error Handling", () => {
      it("should return 500 on error", async () => {
        vi.mocked(User.findById).mockRejectedValue(new Error("Database error"));

        await WelcomeNotificationController.sendWelcomeNotification(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Failed to send welcome notification",
        });
      });
    });
  });
});
