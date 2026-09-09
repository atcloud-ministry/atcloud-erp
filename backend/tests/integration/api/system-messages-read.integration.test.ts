import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { ensureIntegrationDB } from "../setup/connect";
import { TokenService } from "../../../src/middleware/auth";

// Socket service mock - MUST be before app import
vi.mock("../../../src/services/infrastructure/SocketService", () => ({
  socketService: {
    emitSystemMessageUpdate: vi.fn(),
    emitBellNotificationUpdate: vi.fn(),
    emitUnreadCountUpdate: vi.fn(),
  },
}));

import app from "../../../src/app";
import User from "../../../src/models/User";
import Message from "../../../src/models/Message";
import { socketService } from "../../../src/services/infrastructure/SocketService";
import { CachePatterns } from "../../../src/services/infrastructure/CacheService";

describe("System Messages Read Integration Tests", () => {
  let authToken: string;
  let userId: string;
  let messageId: string;

  beforeEach(async () => {
    await ensureIntegrationDB();
    await User.deleteMany({});
    await Message.deleteMany({});

    // Reset mocks
    vi.mocked(socketService.emitSystemMessageUpdate).mockClear();
    vi.mocked(socketService.emitBellNotificationUpdate).mockClear();
    vi.mocked(socketService.emitUnreadCountUpdate).mockClear();

    // Create test user
    const user = await User.create({
      username: "testuser_sysmsgread",
      email: "testuser-sysmsgread@example.com",
      password: "Password123",
      role: "Participant",
      isActive: true,
      isVerified: true,
    });
    userId = user._id.toString();
    authToken = TokenService.generateTokenPair(user).accessToken;

    // Create test message
    const message = await Message.create({
      type: "announcement",
      title: "Test Message",
      content: "Test body",
      priority: "medium",
      creator: {
        id: "admin123",
        firstName: "Admin",
        lastName: "User",
        username: "admin",
        gender: "male",
        authLevel: "Administrator",
      },
      userStates: {
        [userId]: {
          isReadInBell: false,
          isReadInSystem: false,
          isRemovedFromBell: false,
          isDeletedFromSystem: false,
        },
      },
      isActive: true,
    });
    messageId = message._id.toString();
  });

  // ===== Authentication Tests =====
  describe("Authentication", () => {
    it("should return 401 when no auth token provided", async () => {
      const response = await request(app)
        .patch(`/api/notifications/system/${messageId}/read`)
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe(
        "Access denied. No token provided or invalid format."
      );
    });

    it("should return 401 when invalid auth token provided", async () => {
      const response = await request(app)
        .patch(`/api/notifications/system/${messageId}/read`)
        .set("Authorization", "Bearer invalid-token")
        .expect(401);

      expect(response.body.success).toBe(false);
    });
  });

  // ===== Success Cases =====
  describe("Success Cases", () => {
    it("should mark system message as read", async () => {
      const response = await request(app)
        .patch(`/api/notifications/system/${messageId}/read`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe("Message marked as read");

      // Verify message marked as read in system
      const updatedMessage = await Message.findById(messageId);
      expect(updatedMessage?.userStates.get(userId)?.isReadInSystem).toBe(true);
    });

    it("should also mark bell notification as read for consistency", async () => {
      await request(app)
        .patch(`/api/notifications/system/${messageId}/read`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      // Verify both system and bell marked as read
      const updatedMessage = await Message.findById(messageId);
      expect(updatedMessage?.userStates.get(userId)?.isReadInSystem).toBe(true);
      expect(updatedMessage?.userStates.get(userId)?.isReadInBell).toBe(true);
    });

    it("should emit system message update event", async () => {
      await request(app)
        .patch(`/api/notifications/system/${messageId}/read`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(
        vi.mocked(socketService.emitSystemMessageUpdate)
      ).toHaveBeenCalledWith(
        userId,
        "message_read",
        expect.objectContaining({
          messageId: expect.any(Object),
          isRead: true,
          readAt: expect.any(Date),
        })
      );
    });

    it("should emit bell notification update event", async () => {
      await request(app)
        .patch(`/api/notifications/system/${messageId}/read`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(
        vi.mocked(socketService.emitBellNotificationUpdate)
      ).toHaveBeenCalledWith(
        userId,
        "notification_read",
        expect.objectContaining({
          messageId: expect.any(Object),
          isRead: true,
          readAt: expect.any(Date),
        })
      );
    });

    it("should emit unread count update", async () => {
      await request(app)
        .patch(`/api/notifications/system/${messageId}/read`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(
        vi.mocked(socketService.emitUnreadCountUpdate)
      ).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          bellNotifications: expect.any(Number),
          systemMessages: expect.any(Number),
          total: expect.any(Number),
        })
      );
    });

    it("should handle message that was already read", async () => {
      // Mark as already read
      await Message.findByIdAndUpdate(messageId, {
        [`userStates.${userId}.isReadInSystem`]: true,
        [`userStates.${userId}.isReadInBell`]: true,
      });

      const response = await request(app)
        .patch(`/api/notifications/system/${messageId}/read`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe("Message marked as read");
    });

    it("should handle message with partial read state", async () => {
      // Mark bell as read but system as unread
      await Message.findByIdAndUpdate(messageId, {
        [`userStates.${userId}.isReadInSystem`]: false,
        [`userStates.${userId}.isReadInBell`]: true,
      });

      const response = await request(app)
        .patch(`/api/notifications/system/${messageId}/read`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);

      // Both should be marked as read
      const updatedMessage = await Message.findById(messageId);
      expect(updatedMessage?.userStates.get(userId)?.isReadInSystem).toBe(true);
      expect(updatedMessage?.userStates.get(userId)?.isReadInBell).toBe(true);
    });
  });

  // ===== Edge Cases =====
  describe("Edge Cases", () => {
    it("should return 404 when message not found", async () => {
      const fakeMessageId = new mongoose.Types.ObjectId().toString();

      const response = await request(app)
        .patch(`/api/notifications/system/${fakeMessageId}/read`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe("Message not found");
    });

    it("should return 400 when invalid message ID format", async () => {
      const response = await request(app)
        .patch("/api/notifications/system/invalid-id/read")
        .set("Authorization", `Bearer ${authToken}`)
        .expect(400);

      expect(response.body.success).toBe(false);
    });

    it("should conceal a message from a non-recipient without creating state", async () => {
      const invalidateSpy = vi
        .spyOn(CachePatterns, "invalidateUserCache")
        .mockResolvedValue(undefined);
      const noStateMessage = await Message.create({
        type: "announcement",
        title: "No State",
        content: "Body",
        priority: "medium",
        creator: {
          id: "admin123",
          firstName: "Admin",
          lastName: "User",
          username: "admin",
          gender: "male",
          authLevel: "Administrator",
        },
        userStates: {},
        isActive: true,
      });

      const response = await request(app)
        .patch(
          `/api/notifications/system/${noStateMessage._id.toString()}/read`
        )
        .set("Authorization", `Bearer ${authToken}`)
        .expect(404);

      expect(response.body).toEqual({
        success: false,
        message: "Message not found",
      });
      const unchangedMessage = await Message.findById(noStateMessage._id);
      expect(unchangedMessage?.userStates.has(userId)).toBe(false);
      expect(invalidateSpy).not.toHaveBeenCalled();
      expect(socketService.emitSystemMessageUpdate).not.toHaveBeenCalled();
      expect(socketService.emitBellNotificationUpdate).not.toHaveBeenCalled();
      expect(socketService.emitUnreadCountUpdate).not.toHaveBeenCalled();
      invalidateSpy.mockRestore();
    });

    it("should not affect other users' message states", async () => {
      // Create another user
      const otherUser = await User.create({
        username: "otheruser_sysmsgread",
        email: "otheruser-sysmsgread@example.com",
        password: "Password123",
        role: "Participant",
        isActive: true,
        isVerified: true,
      });
      const otherUserId = otherUser._id.toString();

      // Update message to have state for both users
      await Message.findByIdAndUpdate(messageId, {
        [`userStates.${otherUserId}`]: {
          isReadInBell: false,
          isReadInSystem: false,
          isRemovedFromBell: false,
          isRemovedFromSystem: false,
        },
      });

      // Mark as read for first user
      await request(app)
        .patch(`/api/notifications/system/${messageId}/read`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      // Check other user's state unchanged
      const updatedMessage = await Message.findById(messageId);
      expect(updatedMessage?.userStates.get(userId)?.isReadInSystem).toBe(true);
      expect(updatedMessage?.userStates.get(otherUserId)?.isReadInSystem).toBe(
        false
      );
    });

    it("should reject an inactive message without changing recipient state", async () => {
      // Create inactive message
      const inactiveMessage = await Message.create({
        type: "announcement",
        title: "Inactive",
        content: "Body",
        priority: "medium",
        creator: {
          id: "admin123",
          firstName: "Admin",
          lastName: "User",
          username: "admin",
          gender: "male",
          authLevel: "Administrator",
        },
        userStates: {
          [userId]: {
            isReadInBell: false,
            isReadInSystem: false,
            isRemovedFromBell: false,
            isDeletedFromSystem: false,
          },
        },
        isActive: false,
      });

      const response = await request(app)
        .patch(
          `/api/notifications/system/${inactiveMessage._id.toString()}/read`
        )
        .set("Authorization", `Bearer ${authToken}`)
        .expect(404);

      expect(response.body.success).toBe(false);
      const unchangedMessage = await Message.findById(inactiveMessage._id);
      expect(unchangedMessage?.userStates.get(userId)?.isReadInSystem).toBe(
        false,
      );
    });
  });

  // ===== Response Format Tests =====
  describe("Response Format", () => {
    it("should return proper success response structure", async () => {
      const response = await request(app)
        .patch(`/api/notifications/system/${messageId}/read`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        message: "Message marked as read",
      });
    });

    it("should return proper error response structure", async () => {
      const fakeMessageId = new mongoose.Types.ObjectId().toString();

      const response = await request(app)
        .patch(`/api/notifications/system/${fakeMessageId}/read`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(404);

      expect(response.body).toMatchObject({
        success: false,
        message: expect.any(String),
      });
    });
  });
});
