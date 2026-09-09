import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import TargetedSystemMessagesController from "../../../../src/controllers/message/TargetedSystemMessagesController";

// Mock dependencies
const mockSave = vi.fn().mockResolvedValue(true);
const mockToJSON = vi.fn(() => {
  throw new Error("raw document serialization must not be used for realtime");
});
const mockGetBellDisplayTitle = vi.fn().mockReturnValue("Test Title");
const { mockUserFind } = vi.hoisted(() => ({
  mockUserFind: vi.fn(),
}));

vi.mock("../../../../src/models/Message", () => {
  const mockMessage = vi.fn().mockImplementation(function (data) {
    return {
      ...data,
      _id: "message-id",
      createdAt: new Date("2026-09-09T12:00:00.000Z"),
      userStates: new Map(),
      save: mockSave,
      toJSON: mockToJSON,
      getBellDisplayTitle: mockGetBellDisplayTitle,
      metadata: data.metadata,
    };
  });
  (mockMessage as any).getUnreadCountsForUser = vi.fn();
  return { default: mockMessage };
});

vi.mock("../../../../src/models/User", () => ({
  default: {
    find: mockUserFind,
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

function expectRecipientSafe(value: unknown): void {
  const keys = collectKeys(value);
  FORBIDDEN_REALTIME_KEYS.forEach((key) => expect(keys.has(key)).toBe(false));
}

describe("TargetedSystemMessagesController", () => {
  let consoleErrorSpy: any;
  let consoleLogSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockSave.mockResolvedValue(true);
    mockUserFind.mockImplementation((query: { _id?: { $in?: string[] } }) => ({
      select: vi.fn().mockResolvedValue(
        (query._id?.$in ?? []).map((_id) => ({
          _id,
          role: "Participant",
        })),
      ),
    }));
    (Message as any).getUnreadCountsForUser = vi.fn().mockResolvedValue({
      bellNotifications: 1,
      systemMessages: 1,
      total: 2,
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  describe("createTargetedSystemMessage", () => {
    const validMessageData = {
      title: "Test Notification",
      content: "This is a test message content",
    };

    const validTargetUserIds = ["user1", "user2"];

    const validCreator = {
      id: "admin1",
      firstName: "Admin",
      lastName: "User",
      username: "adminuser",
      avatar: "/avatar.jpg",
      gender: "male",
      authLevel: "Super Admin",
      roleInAtCloud: "Administrator",
    };

    describe("Successful Creation", () => {
      it("should create targeted message for multiple users", async () => {
        const result =
          await TargetedSystemMessagesController.createTargetedSystemMessage(
            validMessageData,
            validTargetUserIds,
            validCreator
          );

        expect(Message).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Test Notification",
            content: "This is a test message content",
            type: "assignment",
            priority: "high",
            hideCreator: false,
            isActive: true,
          })
        );
        expect(mockSave).toHaveBeenCalled();
        expect(result).toBeDefined();
      });

      it("should invalidate cache for all target users", async () => {
        await TargetedSystemMessagesController.createTargetedSystemMessage(
          validMessageData,
          validTargetUserIds,
          validCreator
        );

        expect(CachePatterns.invalidateUserCache).toHaveBeenCalledWith("user1");
        expect(CachePatterns.invalidateUserCache).toHaveBeenCalledWith("user2");
        expect(CachePatterns.invalidateUserCache).toHaveBeenCalledTimes(2);
      });

      it("should emit socket events to all target users", async () => {
        await TargetedSystemMessagesController.createTargetedSystemMessage(
          validMessageData,
          validTargetUserIds,
          validCreator
        );

        expect(socketService.emitSystemMessageUpdate).toHaveBeenCalledTimes(2);
        expect(socketService.emitSystemMessageUpdate).toHaveBeenCalledWith(
          "user1",
          "message_created",
          expect.any(Object)
        );
        expect(socketService.emitSystemMessageUpdate).toHaveBeenCalledWith(
          "user2",
          "message_created",
          expect.any(Object)
        );
        vi.mocked(socketService.emitSystemMessageUpdate).mock.calls.forEach(
          ([, , payload]) => expectRecipientSafe(payload),
        );
        expect(mockToJSON).not.toHaveBeenCalled();
      });

      it("should emit once for each unique recipient", async () => {
        await TargetedSystemMessagesController.createTargetedSystemMessage(
          validMessageData,
          ["user1", "user1", "user2"],
          validCreator,
        );

        expect(socketService.emitSystemMessageUpdate).toHaveBeenCalledTimes(2);
        expect(CachePatterns.invalidateUserCache).toHaveBeenCalledTimes(2);
      });

      it("can delegate only message-created delivery while preserving unread updates", async () => {
        await TargetedSystemMessagesController.createTargetedSystemMessage(
          validMessageData,
          validTargetUserIds,
          validCreator,
          { emitMessageCreatedEvent: false },
        );

        expect(socketService.emitSystemMessageUpdate).not.toHaveBeenCalled();
        expect(socketService.emitUnreadCountUpdate).toHaveBeenCalledTimes(2);
      });

      it("should emit unread count updates to all target users", async () => {
        await TargetedSystemMessagesController.createTargetedSystemMessage(
          validMessageData,
          validTargetUserIds,
          validCreator
        );

        expect(socketService.emitUnreadCountUpdate).toHaveBeenCalledTimes(2);
        expect(Message.getUnreadCountsForUser).toHaveBeenCalledWith(
          "user1",
          "Participant",
        );
        expect(Message.getUnreadCountsForUser).toHaveBeenCalledWith(
          "user2",
          "Participant",
        );
      });

      it("should use system creator when none provided", async () => {
        await TargetedSystemMessagesController.createTargetedSystemMessage(
          validMessageData,
          validTargetUserIds
        );

        expect(Message).toHaveBeenCalledWith(
          expect.objectContaining({
            creator: expect.objectContaining({
              id: "system",
              firstName: "System",
              lastName: "Administrator",
              authLevel: "Super Admin",
            }),
          })
        );
      });

      it("should use custom type and priority when provided", async () => {
        await TargetedSystemMessagesController.createTargetedSystemMessage(
          {
            ...validMessageData,
            type: "admin_alert",
            priority: "medium",
          },
          validTargetUserIds,
          validCreator
        );

        expect(Message).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "admin_alert",
            priority: "medium",
          })
        );
      });

      it("should set hideCreator when specified", async () => {
        await TargetedSystemMessagesController.createTargetedSystemMessage(
          {
            ...validMessageData,
            hideCreator: true,
          },
          validTargetUserIds,
          validCreator
        );

        expect(Message).toHaveBeenCalledWith(
          expect.objectContaining({
            hideCreator: true,
          })
        );
        const payload = vi.mocked(socketService.emitSystemMessageUpdate).mock
          .calls[0][2];
        expect(payload.message).not.toHaveProperty("creator");
        expectRecipientSafe(payload);
      });

      it("should include metadata when provided", async () => {
        const metadata = { eventId: "event123", action: "assignment" };

        await TargetedSystemMessagesController.createTargetedSystemMessage(
          {
            ...validMessageData,
            metadata,
          },
          validTargetUserIds,
          validCreator
        );

        expect(Message).toHaveBeenCalledWith(
          expect.objectContaining({
            metadata,
          })
        );
      });

      it("should restrict targetRole messages to matching user ids", async () => {
        mockUserFind.mockReturnValueOnce({
          select: vi
            .fn()
            .mockResolvedValue([{ _id: "user1", role: "Administrator" }]),
        });

        const result =
          await TargetedSystemMessagesController.createTargetedSystemMessage(
            {
              ...validMessageData,
              targetRoles: ["Super Admin", "Administrator"],
            },
            validTargetUserIds,
            validCreator
          );

        expect(mockUserFind).toHaveBeenCalledWith({
          _id: { $in: validTargetUserIds },
          role: { $in: ["Super Admin", "Administrator"] },
        });
        expect(Message).toHaveBeenCalledWith(
          expect.objectContaining({
            targetRoles: ["Super Admin", "Administrator"],
          })
        );
        expect((result as any).userStates.has("user1")).toBe(true);
        expect((result as any).userStates.has("user2")).toBe(false);
        expect(CachePatterns.invalidateUserCache).toHaveBeenCalledWith("user1");
        expect(CachePatterns.invalidateUserCache).not.toHaveBeenCalledWith(
          "user2"
        );
        expect(socketService.emitSystemMessageUpdate).toHaveBeenCalledTimes(1);
        expect(socketService.emitSystemMessageUpdate).toHaveBeenCalledWith(
          "user1",
          "message_created",
          expect.any(Object)
        );
        expect(socketService.emitSystemMessageUpdate).not.toHaveBeenCalledWith(
          "user2",
          "message_created",
          expect.any(Object),
        );
      });

      it("should set targetUserId for single-recipient auth_level_change", async () => {
        await TargetedSystemMessagesController.createTargetedSystemMessage(
          {
            ...validMessageData,
            type: "auth_level_change",
          },
          ["singleUser"],
          validCreator
        );

        expect(Message).toHaveBeenCalledWith(
          expect.objectContaining({
            targetUserId: "singleUser",
          })
        );
      });

      it("should handle unread count update failure gracefully", async () => {
        (Message as any).getUnreadCountsForUser = vi
          .fn()
          .mockRejectedValue(new Error("Count failed"));

        await TargetedSystemMessagesController.createTargetedSystemMessage(
          validMessageData,
          ["user1"],
          validCreator
        );

        // Should not throw, just log error
        expect(consoleErrorSpy).toHaveBeenCalled();
      });
    });

    describe("Error Handling", () => {
      it("should throw error when save fails", async () => {
        mockSave.mockRejectedValueOnce(new Error("Save failed"));

        await expect(
          TargetedSystemMessagesController.createTargetedSystemMessage(
            validMessageData,
            validTargetUserIds,
            validCreator
          )
        ).rejects.toThrow("Save failed");
      });
    });
  });
});
