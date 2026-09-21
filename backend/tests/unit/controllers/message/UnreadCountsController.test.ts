import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Request, Response } from "express";
import UnreadCountsController from "../../../../src/controllers/message/UnreadCountsController";

// Mock dependencies
vi.mock("../../../../src/models/Message", () => ({
  default: {
    getUnreadCountsForUser: vi.fn(),
  },
}));

import Message from "../../../../src/models/Message";

interface MockRequest {
  user?: { id: string; role: string };
}

describe("UnreadCountsController", () => {
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
    };
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe("getUnreadCounts", () => {
    describe("Authentication", () => {
      it("should return 401 if user is not authenticated", async () => {
        mockReq.user = undefined;

        await UnreadCountsController.getUnreadCounts(
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

        await UnreadCountsController.getUnreadCounts(
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

    describe("Successful Retrieval", () => {
      it("should return unread counts for authenticated user", async () => {
        const mockCounts = {
          bellNotifications: 5,
          systemMessages: 3,
          total: 8,
        };

        vi.mocked(Message.getUnreadCountsForUser).mockResolvedValue(mockCounts);

        await UnreadCountsController.getUnreadCounts(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(Message.getUnreadCountsForUser).toHaveBeenCalledWith(
          "user123",
          "Participant",
        );
        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          data: mockCounts,
        });
      });

      it("should return zero counts when user has no unread messages", async () => {
        const zeroCounts = {
          bellNotifications: 0,
          systemMessages: 0,
          total: 0,
        };

        vi.mocked(Message.getUnreadCountsForUser).mockResolvedValue(zeroCounts);

        await UnreadCountsController.getUnreadCounts(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          data: zeroCounts,
        });
      });
    });

    describe("Error Handling", () => {
      it("should return 500 on database error", async () => {
        vi.mocked(Message.getUnreadCountsForUser).mockRejectedValue(
          new Error("Database connection failed"),
        );

        await UnreadCountsController.getUnreadCounts(
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

      it("should log error details on failure", async () => {
        const testError = new Error("Test error");
        vi.mocked(Message.getUnreadCountsForUser).mockRejectedValue(testError);

        await UnreadCountsController.getUnreadCounts(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          "Error in getUnreadCounts:",
          testError,
        );
      });
    });
  });
});
