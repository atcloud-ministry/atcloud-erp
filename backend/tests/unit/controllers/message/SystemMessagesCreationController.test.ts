import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Request, Response } from "express";
import SystemMessagesCreationController from "../../../../src/controllers/message/SystemMessagesCreationController";

// Mock dependencies
vi.mock("../../../../src/models/Message", () => {
  const MockMessage = vi.fn().mockImplementation((data) => ({
    ...data,
    _id: "msg123",
    userStates: new Map(),
    save: vi.fn().mockResolvedValue(true),
    toJSON: vi.fn(() => {
      throw new Error("raw document serialization must not be used for realtime");
    }),
    getBellDisplayTitle: vi.fn().mockReturnValue(data.title),
    createdAt: new Date(),
    createdBy: data.creator?.id,
  }));
  (MockMessage as any).getUnreadCountsForUser = vi.fn().mockResolvedValue({
    bellNotifications: 1,
    systemMessages: 1,
    total: 2,
  });
  return { default: MockMessage };
});

vi.mock("../../../../src/models/User", () => ({
  default: {
    findById: vi.fn(),
    find: vi.fn(),
  },
}));

vi.mock("../../../../src/services/infrastructure/SocketService", () => ({
  socketService: {
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

import User from "../../../../src/models/User";
import Message from "../../../../src/models/Message";
import { socketService } from "../../../../src/services/infrastructure/SocketService";
import { CachePatterns } from "../../../../src/services/infrastructure/CacheService";

const FORBIDDEN_REALTIME_KEYS = new Set([
  "_id",
  "__v",
  "createdBy",
  "userStates",
  "targetRoles",
  "recipients",
  "recipientIds",
  "targetUserIds",
]);

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectKeys(entry, keys));
    return keys;
  }
  if (!value || typeof value !== "object") return keys;
  Object.entries(value).forEach(([key, entry]) => {
    keys.add(key);
    collectKeys(entry, keys);
  });
  return keys;
}

interface MockRequest {
  user?: {
    id: string;
    _id: string;
  };
  body: {
    title?: string;
    content?: string;
    type?: string;
    priority?: string;
    targetRoles?: unknown;
    excludeUserIds?: unknown;
    includeCreator?: boolean;
    hideCreator?: boolean;
  };
}

const CREATOR_ID = "507f1f77bcf86cd799439010";
const USER_ID_1 = "507f1f77bcf86cd799439011";
const USER_ID_2 = "507f1f77bcf86cd799439012";
const USER_ID_3 = "507f1f77bcf86cd799439013";

describe("SystemMessagesCreationController", () => {
  let mockReq: MockRequest;
  let mockRes: Partial<Response>;
  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: any;
  let consoleLogSpy: any;

  const createMockCreator = (overrides = {}) => ({
    _id: CREATOR_ID,
    firstName: "Admin",
    lastName: "User",
    username: "admin",
    avatar: "/avatar.jpg",
    gender: "male",
    roleInAtCloud: "Ministry Leader",
    role: "Administrator",
    ...overrides,
  });

  const createMockUsers = () => [
    { _id: USER_ID_1, role: "Participant" },
    { _id: USER_ID_2, role: "Leader" },
    { _id: USER_ID_3, role: "Administrator" },
  ];

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
      user: {
        id: CREATOR_ID,
        _id: CREATOR_ID,
      },
      body: {
        title: "Test Announcement",
        content: "This is a test announcement",
        type: "announcement",
        priority: "medium",
      },
    };

    vi.mocked(CachePatterns.invalidateUserCache).mockResolvedValue(undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  describe("createSystemMessage", () => {
    describe("Authentication", () => {
      it("should return 401 if user is not authenticated", async () => {
        mockReq.user = undefined;

        await SystemMessagesCreationController.createSystemMessage(
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

    describe("Authorization", () => {
      it("should return 404 if creator user not found", async () => {
        vi.mocked(User.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue(null),
        } as any);

        await SystemMessagesCreationController.createSystemMessage(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(404);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "User not found",
        });
      });

      it("should return 403 if user is a Participant", async () => {
        const participantCreator = createMockCreator({ role: "Participant" });
        vi.mocked(User.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue(participantCreator),
        } as any);

        await SystemMessagesCreationController.createSystemMessage(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(403);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Insufficient permissions to create system messages",
        });
      });
    });

    describe("Recipient selector validation", () => {
      it.each([
        ["a scalar target role", "targetRoles", "Administrator"],
        ["a null target role", "targetRoles", null],
        ["an empty target role array", "targetRoles", []],
        ["an invalid target role", "targetRoles", ["Admin"]],
        ["a scalar excluded user", "excludeUserIds", USER_ID_2],
        ["an invalid excluded user", "excludeUserIds", ["not-an-object-id"]],
      ])("rejects %s without side effects", async (_label, field, value) => {
        (mockReq.body as Record<string, unknown>)[field] = value;

        await SystemMessagesCreationController.createSystemMessage(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(User.findById).not.toHaveBeenCalled();
        expect(User.find).not.toHaveBeenCalled();
        expect(Message).not.toHaveBeenCalled();
        expect(CachePatterns.invalidateUserCache).not.toHaveBeenCalled();
        expect(socketService.emitSystemMessageUpdate).not.toHaveBeenCalled();
        expect(socketService.emitUnreadCountUpdate).not.toHaveBeenCalled();
      });
    });

    describe("Successful Creation", () => {
      beforeEach(() => {
        vi.mocked(User.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue(createMockCreator()),
        } as any);
        vi.mocked(User.find).mockResolvedValue(createMockUsers() as any);
      });

      it("should create system message successfully", async () => {
        await SystemMessagesCreationController.createSystemMessage(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(201);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
            message: "System message created successfully",
          }),
        );
      });

      it("should emit socket updates to all users", async () => {
        await SystemMessagesCreationController.createSystemMessage(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(socketService.emitSystemMessageUpdate).toHaveBeenCalledTimes(3);
        expect(socketService.emitUnreadCountUpdate).toHaveBeenCalledTimes(3);
        vi.mocked(socketService.emitSystemMessageUpdate).mock.calls.forEach(
          ([, , payload]) => {
            const keys = collectKeys(payload);
            FORBIDDEN_REALTIME_KEYS.forEach((key) =>
              expect(keys.has(key)).toBe(false),
            );
          },
        );
        expect(Message.getUnreadCountsForUser).toHaveBeenCalledWith(
          USER_ID_1,
          "Participant",
        );
        expect(Message.getUnreadCountsForUser).toHaveBeenCalledWith(
          USER_ID_2,
          "Leader",
        );
      });

      it("should invalidate cache for all users", async () => {
        await SystemMessagesCreationController.createSystemMessage(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(CachePatterns.invalidateUserCache).toHaveBeenCalledTimes(3);
      });
    });

    describe("Targeting", () => {
      beforeEach(() => {
        vi.mocked(User.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue(createMockCreator()),
        } as any);
      });

      it("should target specific roles when targetRoles is provided", async () => {
        mockReq.body.targetRoles = ["Leader", "Administrator"];
        vi.mocked(User.find).mockResolvedValue(
          [{ _id: USER_ID_2, role: "Leader" }] as any,
        );

        await SystemMessagesCreationController.createSystemMessage(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(User.find).toHaveBeenCalledWith(
          { role: { $in: ["Leader", "Administrator"] } },
          "_id role",
        );
      });

      it("should canonicalize uppercase excludeUserIds before filtering", async () => {
        mockReq.body.excludeUserIds = [USER_ID_2.toUpperCase()];
        vi.mocked(User.find).mockResolvedValue(createMockUsers() as any);

        await SystemMessagesCreationController.createSystemMessage(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        // Should emit to user1 and user3, but not user2.
        expect(socketService.emitSystemMessageUpdate).toHaveBeenCalledTimes(2);
        expect(socketService.emitSystemMessageUpdate).not.toHaveBeenCalledWith(
          USER_ID_2,
          expect.anything(),
          expect.anything(),
        );
      });
    });

    describe("Creator Visibility", () => {
      beforeEach(() => {
        vi.mocked(User.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue(createMockCreator()),
        } as any);
        vi.mocked(User.find).mockResolvedValue(createMockUsers() as any);
      });

      it("should include creator by default", async () => {
        await SystemMessagesCreationController.createSystemMessage(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(201);
        // Creator should be included in response
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
            data: expect.objectContaining({
              message: expect.objectContaining({
                hideCreator: false,
              }),
            }),
          }),
        );
      });

      it("should hide creator when includeCreator is false", async () => {
        mockReq.body.includeCreator = false;

        await SystemMessagesCreationController.createSystemMessage(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(201);
        // hideCreator should be true
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
            data: expect.objectContaining({
              message: expect.objectContaining({
                hideCreator: true,
              }),
            }),
          }),
        );
      });

      it("should hide creator when hideCreator is true", async () => {
        mockReq.body.hideCreator = true;

        await SystemMessagesCreationController.createSystemMessage(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(201);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
            data: expect.objectContaining({
              message: expect.objectContaining({
                hideCreator: true,
              }),
            }),
          }),
        );
        vi.mocked(socketService.emitSystemMessageUpdate).mock.calls.forEach(
          ([, , payload]) => expect(payload.message).not.toHaveProperty("creator"),
        );
      });
    });

    describe("Error Handling", () => {
      it("should return 500 on database error", async () => {
        vi.mocked(User.findById).mockImplementation(() => {
          throw new Error("Database error");
        });

        await SystemMessagesCreationController.createSystemMessage(
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

      it("should return 400 on validation error", async () => {
        vi.mocked(User.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue(createMockCreator()),
        } as any);
        vi.mocked(User.find).mockImplementation(() => {
          const error = new Error("Validation failed");
          error.name = "ValidationError";
          throw error;
        });

        await SystemMessagesCreationController.createSystemMessage(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Title and content are required",
        });
      });
    });

    describe("Boolean String Parsing", () => {
      beforeEach(() => {
        vi.mocked(User.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue(createMockCreator()),
        } as any);
        vi.mocked(User.find).mockResolvedValue(createMockUsers() as any);
      });

      it("should parse includeCreator string 'false' as boolean false", async () => {
        (mockReq.body as Record<string, unknown>).includeCreator = "false";

        await SystemMessagesCreationController.createSystemMessage(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(201);
      });

      it("should parse includeCreator string 'true' as boolean true", async () => {
        (mockReq.body as Record<string, unknown>).includeCreator = "true";

        await SystemMessagesCreationController.createSystemMessage(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(201);
      });

      it("should parse hideCreator string 'true' as boolean true", async () => {
        (mockReq.body as Record<string, unknown>).hideCreator = "true";

        await SystemMessagesCreationController.createSystemMessage(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(201);
      });

      it("should parse hideCreator string 'false' as boolean false", async () => {
        (mockReq.body as Record<string, unknown>).hideCreator = "false";

        await SystemMessagesCreationController.createSystemMessage(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(201);
      });
    });
  });
});
