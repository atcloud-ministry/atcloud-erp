import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Request, Response } from "express";
import SystemMessagesRetrievalController from "../../../../src/controllers/message/SystemMessagesRetrievalController";

// Mock dependencies
vi.mock("../../../../src/models/Message", () => ({
  default: {
    find: vi.fn(),
    getUnreadCountsForUser: vi.fn(),
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
  query: {
    page?: string;
    limit?: string;
    type?: string;
  };
}

describe("SystemMessagesRetrievalController", () => {
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

    mockReq = {
      user: { id: "user123" },
      query: {},
    };
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  describe("getSystemMessages", () => {
    describe("Authentication", () => {
      it("should return 401 if user is not authenticated", async () => {
        mockReq.user = undefined;

        await SystemMessagesRetrievalController.getSystemMessages(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(401);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Authentication required",
        });
      });

      it("should return 401 if user id is missing", async () => {
        mockReq.user = { id: undefined };

        await SystemMessagesRetrievalController.getSystemMessages(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(401);
      });
    });

    describe("User Not Found", () => {
      it("should return 404 if user is not found", async () => {
        vi.mocked(User.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue(null),
        } as any);

        await SystemMessagesRetrievalController.getSystemMessages(
          mockReq as unknown as Request,
          mockRes as Response,
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

      it("should return empty array when no messages exist", async () => {
        vi.mocked(Message.find).mockReturnValue({
          sort: vi.fn().mockResolvedValue([]),
        } as any);

        await SystemMessagesRetrievalController.getSystemMessages(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          data: {
            messages: [],
            unreadCount: 0,
            pagination: {
              currentPage: 1,
              totalPages: 0,
              totalCount: 0,
              hasNext: false,
              hasPrev: false,
            },
          },
        });
      });

      it("should filter messages by user in userStates Map", async () => {
        const mockMessages = [
          {
            _id: "msg1",
            title: "Test Message",
            content: "Content",
            type: "announcement",
            priority: "high",
            creator: { firstName: "Admin", lastName: "User" },
            userStates: new Map([
              [
                "user123",
                { isReadInSystem: false, isDeletedFromSystem: false },
              ],
            ]),
            createdAt: new Date(),
            hideCreator: false,
          },
        ];
        vi.mocked(Message.find).mockReturnValue({
          sort: vi.fn().mockResolvedValue(mockMessages),
        } as any);

        await SystemMessagesRetrievalController.getSystemMessages(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
            data: expect.objectContaining({
              pagination: expect.objectContaining({
                totalCount: 1,
              }),
            }),
          }),
        );
      });

      it("should exclude messages deleted from system", async () => {
        const mockMessages = [
          {
            _id: "msg1",
            title: "Deleted Message",
            userStates: new Map([["user123", { isDeletedFromSystem: true }]]),
          },
        ];
        vi.mocked(Message.find).mockReturnValue({
          sort: vi.fn().mockResolvedValue(mockMessages),
        } as any);

        await SystemMessagesRetrievalController.getSystemMessages(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              messages: [],
              pagination: expect.objectContaining({ totalCount: 0 }),
            }),
          }),
        );
      });

      it("should filter by type when provided", async () => {
        mockReq.query.type = "announcement";
        vi.mocked(Message.find).mockReturnValue({
          sort: vi.fn().mockResolvedValue([]),
        } as any);

        await SystemMessagesRetrievalController.getSystemMessages(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(Message.find).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "announcement",
          }),
        );
      });

      it("should respect pagination parameters", async () => {
        mockReq.query.page = "2";
        mockReq.query.limit = "5";
        const mockMessages = Array(10)
          .fill(null)
          .map((_, i) => ({
            _id: `msg${i}`,
            title: `Message ${i}`,
            content: "Content",
            type: "announcement",
            priority: "medium",
            creator: { firstName: "Admin" },
            userStates: new Map([["user123", { isReadInSystem: false }]]),
            createdAt: new Date(),
          }));
        vi.mocked(Message.find).mockReturnValue({
          sort: vi.fn().mockResolvedValue(mockMessages),
        } as any);

        await SystemMessagesRetrievalController.getSystemMessages(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              pagination: expect.objectContaining({
                currentPage: 2,
                totalPages: 2,
                totalCount: 10,
              }),
            }),
          }),
        );
      });

      it("should handle Object-style userStates", async () => {
        const mockMessages = [
          {
            _id: "msg1",
            title: "Test",
            content: "Content",
            type: "announcement",
            priority: "high",
            creator: {},
            userStates: {
              user123: { isReadInSystem: false },
            },
            createdAt: new Date(),
          },
        ];
        vi.mocked(Message.find).mockReturnValue({
          sort: vi.fn().mockResolvedValue(mockMessages),
        } as any);

        await SystemMessagesRetrievalController.getSystemMessages(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
            data: expect.objectContaining({
              pagination: expect.objectContaining({ totalCount: 1 }),
            }),
          }),
        );
      });

      it("should filter by targetRoles when specified", async () => {
        const mockMessages = [
          {
            _id: "msg1",
            title: "Admin Only",
            content: "Content",
            type: "announcement",
            priority: "high",
            creator: {},
            userStates: new Map([["user123", { isReadInSystem: false }]]),
            targetRoles: ["Administrator"],
            createdAt: new Date(),
          },
        ];
        vi.mocked(Message.find).mockReturnValue({
          sort: vi.fn().mockResolvedValue(mockMessages),
        } as any);

        await SystemMessagesRetrievalController.getSystemMessages(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        // User role is "Viewer", so shouldn't see "Administrator" targeted message
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              messages: [],
            }),
          }),
        );
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
                userStates: new Map([
                  ["user123", { isReadInSystem: false }],
                ]),
                targetRoles,
                createdAt: new Date(),
              },
            ]),
          } as any);

          await SystemMessagesRetrievalController.getSystemMessages(
            mockReq as unknown as Request,
            mockRes as Response,
          );

          expect(jsonMock).toHaveBeenCalledWith(
            expect.objectContaining({
              data: expect.objectContaining({ messages: [] }),
            }),
          );
        },
      );
    });

    describe("Legacy targetUserId Inference", () => {
      it("should infer targetUserId from Map userStates with single key for auth_level_change", async () => {
        const mockMessage = {
          _id: "msg1",
          title: "Auth Level Change",
          content: "Your auth level changed",
          type: "auth_level_change",
          priority: "medium",
          creator: { firstName: "Admin" },
          userStates: new Map([["user123", { isReadInSystem: false }]]),
          createdAt: new Date(),
          // targetUserId intentionally missing to trigger legacy inference
        };
        vi.mocked(Message.find).mockReturnValue({
          sort: vi.fn().mockResolvedValue([mockMessage]),
        } as any);

        await SystemMessagesRetrievalController.getSystemMessages(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              messages: expect.arrayContaining([
                expect.objectContaining({
                  targetUserId: "user123",
                }),
              ]),
            }),
          }),
        );
      });

      it("should infer targetUserId from object userStates with single key for event_role_change", async () => {
        const mockMessage = {
          _id: "msg2",
          title: "Role Change",
          content: "Your role changed",
          type: "event_role_change",
          priority: "medium",
          creator: { firstName: "Admin" },
          userStates: { user123: { isReadInSystem: false } }, // Plain object, not Map
          createdAt: new Date(),
          // targetUserId intentionally missing
        };
        vi.mocked(Message.find).mockReturnValue({
          sort: vi.fn().mockResolvedValue([mockMessage]),
        } as any);

        await SystemMessagesRetrievalController.getSystemMessages(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              messages: expect.arrayContaining([
                expect.objectContaining({
                  targetUserId: "user123",
                }),
              ]),
            }),
          }),
        );
      });

      it("should not infer targetUserId when userStates has multiple keys", async () => {
        const mockMessage = {
          _id: "msg3",
          title: "Auth Level Change",
          content: "Content",
          type: "auth_level_change",
          priority: "medium",
          creator: {},
          userStates: new Map([
            ["user123", { isReadInSystem: false }],
            ["user456", { isReadInSystem: true }],
          ]),
          createdAt: new Date(),
        };
        vi.mocked(Message.find).mockReturnValue({
          sort: vi.fn().mockResolvedValue([mockMessage]),
        } as any);

        await SystemMessagesRetrievalController.getSystemMessages(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              messages: expect.arrayContaining([
                expect.objectContaining({
                  targetUserId: undefined,
                }),
              ]),
            }),
          }),
        );
      });

      it("should not expose another recipient's explicit targetUserId", async () => {
        const mockMessage = {
          _id: "msg4",
          title: "Role Change",
          content: "Content",
          type: "event_role_change",
          priority: "medium",
          creator: {},
          userStates: new Map([
            ["user123", { isReadInSystem: false }],
            ["user456", { isReadInSystem: false }],
          ]),
          targetUserId: "user456",
          createdAt: new Date(),
        };
        vi.mocked(Message.find).mockReturnValue({
          sort: vi.fn().mockResolvedValue([mockMessage]),
        } as any);

        await SystemMessagesRetrievalController.getSystemMessages(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              messages: expect.arrayContaining([
                expect.objectContaining({
                  targetUserId: undefined,
                }),
              ]),
            }),
          }),
        );
      });
    });

    describe("Error Handling", () => {
      it("should return 500 on error", async () => {
        vi.mocked(User.findById).mockReturnValue({
          select: vi.fn().mockRejectedValue(new Error("Database error")),
        } as any);

        await SystemMessagesRetrievalController.getSystemMessages(
          mockReq as unknown as Request,
          mockRes as Response,
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
