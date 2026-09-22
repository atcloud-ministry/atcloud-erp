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

describe("System Messages Deletion Integration Tests", () => {
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
    vi.mocked(socketService.emitUnreadCountUpdate).mockClear(); // Create test user
    const user = await User.create({
      username: "testuser_sysmsgdel",
      email: "testuser-sysmsgdel@example.com",
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
        .delete(`/api/notifications/system/${messageId}`)
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe(
        "Access denied. No token provided or invalid format."
      );
    });

    it("should return 401 when invalid auth token provided", async () => {
      const response = await request(app)
        .delete(`/api/notifications/system/${messageId}`)
        .set("Authorization", "Bearer invalid-token")
        .expect(401);

      expect(response.body.success).toBe(false);
    });
  });

  // ===== Success Cases =====
  describe("Success Cases", () => {
    it("should successfully delete system message", async () => {
      const response = await request(app)
        .delete(`/api/notifications/system/${messageId}`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe(
        "Message deleted from system messages"
      );

      // Verify message marked as removed from system
      const updatedMessage = await Message.findById(messageId);
      expect(updatedMessage?.userStates.get(userId)?.isDeletedFromSystem).toBe(
        true
      );
    });

    it("should emit system message update event", async () => {
      await request(app)
        .delete(`/api/notifications/system/${messageId}`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(
        vi.mocked(socketService.emitSystemMessageUpdate)
      ).toHaveBeenCalledWith(userId, "message_deleted", {
        messageId: expect.any(Object),
      });
    });

    it("should emit bell notification update event", async () => {
      await request(app)
        .delete(`/api/notifications/system/${messageId}`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(
        vi.mocked(socketService.emitBellNotificationUpdate)
      ).toHaveBeenCalledWith(userId, "notification_removed", {
        messageId: expect.any(Object),
      });
    });

    it("should emit unread count update when message was unread in system", async () => {
      await request(app)
        .delete(`/api/notifications/system/${messageId}`)
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

    it("should emit unread count update when message was unread in bell", async () => {
      // Update message to be read in system but unread in bell
      await Message.findByIdAndUpdate(messageId, {
        [`userStates.${userId}.isReadInSystem`]: true,
        [`userStates.${userId}.isReadInBell`]: false,
      });

      await request(app)
        .delete(`/api/notifications/system/${messageId}`)
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

    it("should delete from system messages and also remove from bell (REQ 9)", async () => {
      await request(app)
        .delete(`/api/notifications/system/${messageId}`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      const updatedMessage = await Message.findById(messageId);
      expect(updatedMessage?.userStates.get(userId)?.isDeletedFromSystem).toBe(
        true
      );
      // REQ 9: Auto-remove from bell when deleted from system
      expect(updatedMessage?.userStates.get(userId)?.isRemovedFromBell).toBe(
        true
      );
    });

    it("should handle message that was already read", async () => {
      // Mark message as read
      await Message.findByIdAndUpdate(messageId, {
        [`userStates.${userId}.isReadInSystem`]: true,
        [`userStates.${userId}.isReadInBell`]: true,
      });

      const response = await request(app)
        .delete(`/api/notifications/system/${messageId}`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      // Should not emit unread count update for already read messages
      // (the controller checks wasUnreadInSystem || wasUnreadInBell)
    });
  });

  // ===== Edge Cases =====
  describe("Edge Cases", () => {
    it("should return 404 when message not found", async () => {
      const fakeMessageId = new mongoose.Types.ObjectId().toString();

      const response = await request(app)
        .delete(`/api/notifications/system/${fakeMessageId}`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe("Message not found");
    });

    it("should return 400 when invalid message ID format", async () => {
      const response = await request(app)
        .delete("/api/notifications/system/invalid-id")
        .set("Authorization", `Bearer ${authToken}`)
        .expect(400);

      expect(response.body.success).toBe(false);
    });

    it("should handle message that was already deleted from system", async () => {
      // Mark as already removed from system
      await Message.findByIdAndUpdate(messageId, {
        [`userStates.${userId}.isDeletedFromSystem`]: true,
      });

      const response = await request(app)
        .delete(`/api/notifications/system/${messageId}`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe(
        "Message deleted from system messages"
      );
    });

    it("should not affect other users' message states", async () => {
      // Create another user
      const otherUser = await User.create({
        username: "otheruser_sysmsgdel",
        email: "otheruser-sysmsgdel@example.com",
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
          isDeletedFromSystem: false,
        },
      });

      // Delete for first user
      await request(app)
        .delete(`/api/notifications/system/${messageId}`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      // Check other user's state unchanged
      const updatedMessage = await Message.findById(messageId);
      expect(
        updatedMessage?.userStates.get(otherUserId)?.isDeletedFromSystem
      ).toBe(false);
    });

    it("should conceal a message from a non-recipient without creating state", async () => {
      const invalidateSpy = vi
        .spyOn(CachePatterns, "invalidateUserCache")
        .mockResolvedValue(undefined);
      const emptyStateMessage = await Message.create({
        type: "announcement",
        title: "Empty State Message",
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
        userStates: {},
        isActive: true,
      });

      const response = await request(app)
        .delete(`/api/notifications/system/${emptyStateMessage._id.toString()}`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(404);

      expect(response.body).toEqual({
        success: false,
        message: "Message not found",
      });
      const unchangedMessage = await Message.findById(emptyStateMessage._id);
      expect(unchangedMessage?.userStates.has(userId)).toBe(false);
      expect(invalidateSpy).not.toHaveBeenCalled();
      expect(socketService.emitSystemMessageUpdate).not.toHaveBeenCalled();
      expect(socketService.emitBellNotificationUpdate).not.toHaveBeenCalled();
      expect(socketService.emitUnreadCountUpdate).not.toHaveBeenCalled();
      invalidateSpy.mockRestore();
    });
  });

  // ===== Response Format Tests =====
  describe("Response Format", () => {
    it("should return proper success response structure", async () => {
      const response = await request(app)
        .delete(`/api/notifications/system/${messageId}`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        message: "Message deleted from system messages",
      });
    });

    it("should return proper error response structure", async () => {
      const fakeMessageId = new mongoose.Types.ObjectId().toString();

      const response = await request(app)
        .delete(`/api/notifications/system/${fakeMessageId}`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(404);

      expect(response.body).toMatchObject({
        success: false,
        message: expect.any(String),
      });
    });
  });
});
