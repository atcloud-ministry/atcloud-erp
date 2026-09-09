import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Request, Response } from "express";
import BellNotificationsRetrievalController from "../../../../src/controllers/message/BellNotificationsRetrievalController";

// Mock dependencies
vi.mock("../../../../src/models/Message", () => ({
  default: {
    find: vi.fn(),
  },
}));

vi.mock("../../../../src/models/User", () => ({
  default: {
    findById: vi.fn(),
  },
}));

import Message from "../../../../src/models/Message";
import User from "../../../../src/models/User";

interface MockRequest {
  user?: { id?: string };
}

describe("BellNotificationsRetrievalController", () => {
  let mockReq: MockRequest;
  let mockRes: Partial<Response>;
  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: any;
  let consoleLogSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();

    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

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
    consoleLogSpy.mockRestore();
  });

  describe("getBellNotifications", () => {
    describe("Authentication", () => {
      it("should return 401 if user is not authenticated", async () => {
        mockReq.user = undefined;

        await BellNotificationsRetrievalController.getBellNotifications(
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

        await BellNotificationsRetrievalController.getBellNotifications(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(401);
      });
    });

    describe("User Not Found", () => {
      it("should return 404 if user is not found", async () => {
        vi.mocked(User.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue(null),
        } as any);

        await BellNotificationsRetrievalController.getBellNotifications(
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

    describe("Successful Retrieval", () => {
      const mockUser = { _id: "user123", role: "Viewer" };

      beforeEach(() => {
        vi.mocked(User.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue(mockUser),
        } as any);
      });

      it("should return empty notifications when no messages", async () => {
        vi.mocked(Message.find).mockReturnValue({
          sort: vi.fn().mockResolvedValue([]),
        } as any);

        await BellNotificationsRetrievalController.getBellNotifications(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          data: {
            notifications: [],
            unreadCount: 0,
          },
        });
      });

      it("should return notifications for user with Map userStates", async () => {
        const mockMessages = [
          {
            _id: "msg1",
            title: "Test Notification",
            content: "Content",
            type: "announcement",
            priority: "high",
            creator: {
              firstName: "Admin",
              lastName: "User",
              authLevel: "Admin",
            },
            userStates: new Map([
              ["user123", { isReadInBell: false, isRemovedFromBell: false }],
            ]),
            createdAt: new Date(),
            getBellDisplayTitle: vi.fn().mockReturnValue("Bell Title"),
            canRemoveFromBell: vi.fn().mockReturnValue(true),
          },
        ];
        vi.mocked(Message.find).mockReturnValue({
          sort: vi.fn().mockResolvedValue(mockMessages),
        } as any);

        await BellNotificationsRetrievalController.getBellNotifications(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          data: {
            notifications: [
              expect.objectContaining({
                id: "msg1",
                title: "Bell Title",
                isRead: false,
              }),
            ],
            unreadCount: 1,
          },
        });
      });

      it("should omit the creator when creator visibility is disabled", async () => {
        const mockMessages = [
          {
            _id: "msg-hidden",
            title: "Private sender",
            content: "Content",
            type: "announcement",
            priority: "high",
            hideCreator: true,
            creator: {
              firstName: "Hidden",
              lastName: "Admin",
              authLevel: "Administrator",
              roleInAtCloud: "Mentor",
            },
            userStates: new Map([
              ["user123", { isReadInBell: false, isRemovedFromBell: false }],
            ]),
            createdAt: new Date(),
          },
        ];
        vi.mocked(Message.find).mockReturnValue({
          sort: vi.fn().mockResolvedValue(mockMessages),
        } as any);

        await BellNotificationsRetrievalController.getBellNotifications(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        const response = jsonMock.mock.calls[0][0];
        expect(response.data.notifications[0]).not.toHaveProperty("creator");
      });

      it("returns only the allowed creator display fields", async () => {
        const mockMessages = [
          {
            _id: "msg-visible",
            title: "Visible sender",
            content: "Content",
            type: "announcement",
            priority: "high",
            hideCreator: false,
            creator: {
              id: "private-id",
              firstName: "Visible",
              lastName: "Admin",
              username: "private-username",
              email: "private@example.com",
              authLevel: "Administrator",
              roleInAtCloud: "Mentor",
            },
            userStates: new Map([
              ["user123", { isReadInBell: false, isRemovedFromBell: false }],
            ]),
            createdAt: new Date(),
          },
        ];
        vi.mocked(Message.find).mockReturnValue({
          sort: vi.fn().mockResolvedValue(mockMessages),
        } as any);

        await BellNotificationsRetrievalController.getBellNotifications(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        const response = jsonMock.mock.calls[0][0];
        expect(response.data.notifications[0].creator).toEqual({
          firstName: "Visible",
          lastName: "Admin",
          authLevel: "Administrator",
          roleInAtCloud: "Mentor",
        });
      });

      it("should exclude notifications removed from bell", async () => {
        const mockMessages = [
          {
            _id: "msg1",
            title: "Removed",
            userStates: new Map([["user123", { isRemovedFromBell: true }]]),
          },
        ];
        vi.mocked(Message.find).mockReturnValue({
          sort: vi.fn().mockResolvedValue(mockMessages),
        } as any);

        await BellNotificationsRetrievalController.getBellNotifications(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          data: {
            notifications: [],
            unreadCount: 0,
          },
        });
      });

      it("should count unread notifications correctly", async () => {
        const mockMessages = [
          {
            _id: "msg1",
            title: "Unread",
            content: "c",
            type: "t",
            priority: "high",
            creator: {},
            userStates: new Map([["user123", { isReadInBell: false }]]),
            createdAt: new Date(),
          },
          {
            _id: "msg2",
            title: "Read",
            content: "c",
            type: "t",
            priority: "high",
            creator: {},
            userStates: new Map([["user123", { isReadInBell: true }]]),
            createdAt: new Date(),
          },
          {
            _id: "msg3",
            title: "Unread 2",
            content: "c",
            type: "t",
            priority: "high",
            creator: {},
            userStates: new Map([["user123", { isReadInBell: false }]]),
            createdAt: new Date(),
          },
        ];
        vi.mocked(Message.find).mockReturnValue({
          sort: vi.fn().mockResolvedValue(mockMessages),
        } as any);

        await BellNotificationsRetrievalController.getBellNotifications(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          data: {
            notifications: expect.any(Array),
            unreadCount: 2,
          },
        });
      });

      it("should handle Object-style userStates", async () => {
        const mockMessages = [
          {
            _id: "msg1",
            title: "Test",
            content: "c",
            type: "t",
            priority: "high",
            creator: {},
            userStates: {
              user123: { isReadInBell: false },
            },
            createdAt: new Date(),
          },
        ];
        vi.mocked(Message.find).mockReturnValue({
          sort: vi.fn().mockResolvedValue(mockMessages),
        } as any);

        await BellNotificationsRetrievalController.getBellNotifications(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          data: {
            notifications: expect.arrayContaining([
              expect.objectContaining({ id: "msg1" }),
            ]),
            unreadCount: 1,
          },
        });
      });

      it("should filter by targetRoles when specified", async () => {
        const mockMessages = [
          {
            _id: "msg1",
            title: "Admin Only",
            content: "c",
            type: "t",
            priority: "high",
            creator: {},
            userStates: new Map([["user123", { isReadInBell: false }]]),
            targetRoles: ["Administrator"],
            createdAt: new Date(),
          },
        ];
        vi.mocked(Message.find).mockReturnValue({
          sort: vi.fn().mockResolvedValue(mockMessages),
        } as any);

        await BellNotificationsRetrievalController.getBellNotifications(
          mockReq as unknown as Request,
          mockRes as Response
        );

        // User role is "Viewer", shouldn't see "Administrator" targeted message
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          data: {
            notifications: [],
            unreadCount: 0,
          },
        });
      });

      it.each([null, [null, "Administrator"]])(
        "should fail closed for malformed targetRoles %j",
        async (targetRoles) => {
          vi.mocked(Message.find).mockReturnValue({
            sort: vi.fn().mockResolvedValue([
              {
                _id: "msg-malformed",
                title: "Malformed roles",
                content: "Content",
                type: "announcement",
                priority: "high",
                creator: {},
                userStates: new Map([[
                  "user123",
                  { isReadInBell: false, isRemovedFromBell: false },
                ]]),
                targetRoles,
                createdAt: new Date(),
              },
            ]),
          } as any);

          await BellNotificationsRetrievalController.getBellNotifications(
            mockReq as unknown as Request,
            mockRes as Response,
          );

          expect(jsonMock).toHaveBeenCalledWith({
            success: true,
            data: { notifications: [], unreadCount: 0 },
          });
        },
      );

      it("should use title when getBellDisplayTitle not available", async () => {
        const mockMessages = [
          {
            _id: "msg1",
            title: "Fallback Title",
            content: "c",
            type: "t",
            priority: "high",
            creator: {},
            userStates: new Map([["user123", { isReadInBell: false }]]),
            createdAt: new Date(),
            // No getBellDisplayTitle method
          },
        ];
        vi.mocked(Message.find).mockReturnValue({
          sort: vi.fn().mockResolvedValue(mockMessages),
        } as any);

        await BellNotificationsRetrievalController.getBellNotifications(
          mockReq as unknown as Request,
          mockRes as Response
        );

        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          data: {
            notifications: expect.arrayContaining([
              expect.objectContaining({ title: "Fallback Title" }),
            ]),
            unreadCount: 1,
          },
        });
      });
    });

    describe("Error Handling", () => {
      it("should return 500 on error", async () => {
        vi.mocked(User.findById).mockReturnValue({
          select: vi.fn().mockRejectedValue(new Error("Database error")),
        } as any);

        await BellNotificationsRetrievalController.getBellNotifications(
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
