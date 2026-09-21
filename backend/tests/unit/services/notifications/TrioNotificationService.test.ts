/**
 * Unit Tests for TrioNotificationService
 *
 * Tests the core functionality of the enhanced trio notification system
 * including atomic operations, rollback mechanisms, and error handling.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TrioNotificationService } from "../../../../src/services/notifications/TrioNotificationService";
import { TrioTransaction } from "../../../../src/services/notifications/TrioTransaction";
import { NotificationErrorHandler } from "../../../../src/services/notifications/NotificationErrorHandler";
import { AuthEmailService } from "../../../../src/services/email/domains/AuthEmailService";
import { EventEmailService } from "../../../../src/services/email/domains/EventEmailService";
import { UnifiedMessageController } from "../../../../src/controllers/unifiedMessageController";
import { socketService } from "../../../../src/services/infrastructure/SocketService";

// Mock all models to prevent Mongoose compilation conflicts
vi.mock("../../../../src/models/User", () => ({
  default: {
    find: vi.fn().mockReturnValue({
      select: vi.fn().mockResolvedValue([]),
    }),
    findById: vi.fn().mockResolvedValue(null),
    findOne: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("../../../../src/models/Event", () => ({
  default: {
    find: vi.fn(),
    findById: vi.fn(),
    updateMany: vi.fn(),
    countDocuments: vi.fn(),
  },
}));

vi.mock("../../../../src/models/Registration", () => ({
  default: {
    find: vi.fn(),
    findById: vi.fn(),
    updateMany: vi.fn(),
    countDocuments: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

vi.mock("../../../../src/models/Message", () => ({
  default: {
    find: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    }),
    countDocuments: vi.fn().mockResolvedValue(0),
  },
}));

// Mock dependencies
vi.mock("../../../../src/controllers/unifiedMessageController");
vi.mock("../../../../src/services/infrastructure/SocketService");
vi.mock("../../../../src/services/notifications/NotificationErrorHandler");

function createMockMessage(id: string, recipientIds: string[]) {
  return {
    _id: { toString: () => id },
    title: "Test",
    content: "Test content",
    type: "announcement",
    priority: "medium",
    createdAt: new Date("2026-09-09T12:00:00.000Z"),
    creator: {
      id: "system",
      firstName: "System",
      lastName: "Administrator",
      username: "system",
      gender: "male",
      authLevel: "Super Admin",
    },
    hideCreator: false,
    userStates: new Map(recipientIds.map((userId) => [userId, {}])),
    toJSON: vi.fn(() => {
      throw new Error("raw document serialization must not be used for realtime");
    }),
    save: vi.fn().mockResolvedValue(undefined),
    isActive: true,
  };
}

describe("TrioNotificationService", () => {
  beforeEach(() => {
    // Reset metrics before each test
    TrioNotificationService.resetMetrics();
    vi.clearAllMocks();

    // Set up spies for AuthEmailService methods
    vi.spyOn(AuthEmailService, "sendWelcomeEmail").mockResolvedValue(true);
    vi.spyOn(
      AuthEmailService,
      "sendPasswordResetSuccessEmail"
    ).mockResolvedValue(true);

    // Set up spy for EventEmailService method
    vi.spyOn(EventEmailService, "sendEventReminderEmail").mockResolvedValue(
      true
    );
  });

  afterEach(() => {
    // Ensure real timers are restored after each test
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("createTrio", () => {
    it("should successfully create a complete trio with all components", async () => {
      // Arrange
      const mockMessageResult = createMockMessage("message-456", [
        "user1",
        "user2",
      ]);

      // Mock successful operations
      vi.mocked(AuthEmailService.sendWelcomeEmail).mockResolvedValue(true);
      vi.mocked(
        UnifiedMessageController.createTargetedSystemMessage
      ).mockResolvedValue(mockMessageResult as any);
      vi.mocked(socketService.emitSystemMessageUpdate).mockResolvedValue(
        undefined
      );

      const request = {
        email: {
          to: "test@example.com",
          template: "welcome" as const,
          data: { name: "Test User" },
          priority: "high" as const,
        },
        systemMessage: {
          title: "Welcome!",
          content: "Welcome to the system",
          type: "announcement",
          priority: "medium",
        },
        recipients: ["user1", "user2"],
      };

      // Act
      const result = await TrioNotificationService.createTrio(request);

      // Assert
      expect(result.success).toBe(true);
      expect(result.emailId).toBeUndefined(); // EmailService returns boolean, not object with id
      expect(result.messageId).toBe("message-456");
      expect(result.notificationsSent).toBe(2);
      expect(result.metrics).toMatchObject({
        duration: expect.any(Number),
        emailTime: expect.any(Number),
        messageTime: expect.any(Number),
        socketTime: expect.any(Number),
      });

      // Verify all services were called
      expect(AuthEmailService.sendWelcomeEmail).toHaveBeenCalledWith(
        "test@example.com",
        "Test User"
      );
      expect(
        UnifiedMessageController.createTargetedSystemMessage
      ).toHaveBeenCalledWith(
        request.systemMessage,
        request.recipients,
        undefined,
        { emitMessageCreatedEvent: false },
      );
      expect(socketService.emitSystemMessageUpdate).toHaveBeenCalledTimes(2);
    });

    it("should handle email-only trio (no email provided)", async () => {
      // Arrange
      const mockMessageResult = createMockMessage("message-456", ["user1"]);

      vi.mocked(
        UnifiedMessageController.createTargetedSystemMessage
      ).mockResolvedValue(mockMessageResult as any);
      vi.mocked(socketService.emitSystemMessageUpdate).mockResolvedValue(
        undefined
      );

      const request = {
        systemMessage: {
          title: "System Alert",
          content: "Important system message",
          type: "alert",
          priority: "high",
        },
        recipients: ["user1"],
      };

      // Act
      const result = await TrioNotificationService.createTrio(request);

      // Assert
      expect(result.success).toBe(true);
      expect(result.emailId).toBeUndefined();
      expect(result.messageId).toBe("message-456");
      expect(result.notificationsSent).toBe(1);

      // Verify email service was not called
      expect(AuthEmailService.sendWelcomeEmail).not.toHaveBeenCalled();
    });

    it("delivers once only to recipients present in persisted userStates", async () => {
      const mockMessageResult = createMockMessage("message-filtered", [
        "allowed-user",
      ]);
      vi.mocked(
        UnifiedMessageController.createTargetedSystemMessage,
      ).mockResolvedValue(mockMessageResult as any);
      vi.mocked(socketService.emitSystemMessageUpdate).mockResolvedValue(
        undefined,
      );

      const result = await TrioNotificationService.createTrio({
        systemMessage: {
          title: "Role-filtered",
          content: "Visible to one recipient",
          targetRoles: ["Administrator"],
        },
        recipients: ["allowed-user", "filtered-user", "allowed-user"],
      });

      expect(result.success).toBe(true);
      expect(result.notificationsSent).toBe(1);
      expect(socketService.emitSystemMessageUpdate).toHaveBeenCalledTimes(1);
      expect(socketService.emitSystemMessageUpdate).toHaveBeenCalledWith(
        "allowed-user",
        "message_created",
        expect.any(Object),
      );
      expect(socketService.emitSystemMessageUpdate).not.toHaveBeenCalledWith(
        "filtered-user",
        "message_created",
        expect.any(Object),
      );
      expect(mockMessageResult.toJSON).not.toHaveBeenCalled();
    });

    it("fails closed when persisted recipient state is unavailable", async () => {
      const mockMessageResult = createMockMessage("message-invalid", [
        "requested-user",
      ]) as any;
      delete mockMessageResult.userStates;
      vi.mocked(
        UnifiedMessageController.createTargetedSystemMessage,
      ).mockResolvedValue(mockMessageResult);
      vi.mocked(NotificationErrorHandler.handleTrioFailure).mockResolvedValue({
        success: false,
        action: "log-only",
        message: "Logged invariant failure",
      });

      const result = await TrioNotificationService.createTrio({
        systemMessage: { title: "Test", content: "Test" },
        recipients: ["requested-user"],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("TRIO_MESSAGE_RECIPIENT_STATE_MISSING");
      expect(socketService.emitSystemMessageUpdate).not.toHaveBeenCalled();
    });

    it("should rollback operations on failure when rollback is enabled", async () => {
      // Arrange
      const mockMessageResult = createMockMessage("message-456", ["user1"]);

      // Mock system message creation to fail after email succeeds
      vi.mocked(AuthEmailService.sendWelcomeEmail).mockResolvedValue(true);
      vi.mocked(
        UnifiedMessageController.createTargetedSystemMessage
      ).mockRejectedValue(new Error("Database error"));

      vi.mocked(NotificationErrorHandler.handleTrioFailure).mockResolvedValue({
        success: false,
        action: "log-only",
        message: "Logged error for manual review",
      });

      const request = {
        email: {
          to: "test@example.com",
          template: "welcome" as const,
          data: { name: "Test User" },
        },
        systemMessage: {
          title: "Welcome!",
          content: "Welcome to the system",
        },
        recipients: ["user1"],
        options: {
          enableRollback: true,
        },
      };

      // Act
      const result = await TrioNotificationService.createTrio(request);

      // Assert
      expect(result.success).toBe(false);
      expect(result.rollbackCompleted).toBe(true);
      expect(result.error).toContain("System message creation failed");

      // Verify error handler was called
      expect(NotificationErrorHandler.handleTrioFailure).toHaveBeenCalled();
    });

    it("should handle email timeout with retry logic", async () => {
      // Use fake timers to speed up retry delays
      vi.useFakeTimers();

      // Test that the service properly handles retries by expecting it to fail
      // after multiple attempts (testing the failure path with retry logic)
      vi.mocked(AuthEmailService.sendWelcomeEmail).mockRejectedValue(
        new Error("Service unavailable")
      );

      const mockMessageResult = createMockMessage("message-456", ["user1"]);
      vi.mocked(
        UnifiedMessageController.createTargetedSystemMessage
      ).mockResolvedValue(mockMessageResult as any);
      vi.mocked(socketService.emitSystemMessageUpdate).mockResolvedValue(
        undefined
      );

      const request = {
        email: {
          to: "test@example.com",
          template: "welcome" as const,
          data: { name: "Test User" },
        },
        systemMessage: {
          title: "Welcome!",
          content: "Welcome to the system",
        },
        recipients: ["user1"],
      };

      // Start the trio creation (this will use fake timers for retries)
      const resultPromise = TrioNotificationService.createTrio(request);

      // Fast-forward through all retry delays
      await vi.runAllTimersAsync();

      const result = await resultPromise;

      // Should fail due to email service being unavailable
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      // But should have attempted the email multiple times (retry logic)
      expect(AuthEmailService.sendWelcomeEmail).toHaveBeenCalledTimes(3);

      // Restore real timers
      vi.useRealTimers();
    });

    it("should update metrics correctly on success and failure", async () => {
      // Test successful trio
      const mockMessageResult = createMockMessage("message-456", ["user1"]);
      vi.mocked(
        UnifiedMessageController.createTargetedSystemMessage
      ).mockResolvedValue(mockMessageResult as any);
      vi.mocked(socketService.emitSystemMessageUpdate).mockResolvedValue(
        undefined
      );

      await TrioNotificationService.createTrio({
        systemMessage: { title: "Test", content: "Test" },
        recipients: ["user1"],
      });

      let metrics = TrioNotificationService.getMetrics();
      expect(metrics.totalRequests).toBe(1);
      expect(metrics.successfulTrios).toBe(1);
      expect(metrics.failedTrios).toBe(0);

      // Test failed trio
      vi.mocked(
        UnifiedMessageController.createTargetedSystemMessage
      ).mockRejectedValue(new Error("DB Error"));
      vi.mocked(NotificationErrorHandler.handleTrioFailure).mockResolvedValue({
        success: false,
        action: "log-only",
        message: "Logged database error for manual review",
      });

      await TrioNotificationService.createTrio({
        systemMessage: { title: "Test", content: "Test" },
        recipients: ["user1"],
      });

      metrics = TrioNotificationService.getMetrics();
      expect(metrics.totalRequests).toBe(2);
      expect(metrics.successfulTrios).toBe(1);
      expect(metrics.failedTrios).toBe(1);
      expect(metrics.rollbackCount).toBe(1); // Rollback should have been attempted
    });
  });

  describe("convenience methods", () => {
    beforeEach(() => {
      // Mock successful operations for convenience method tests
      vi.mocked(AuthEmailService.sendWelcomeEmail).mockResolvedValue(true);
      vi.mocked(AuthEmailService.sendPasswordResetSuccessEmail).mockResolvedValue(
        true
      );
      vi.mocked(EventEmailService.sendEventReminderEmail).mockResolvedValue(true);
      vi.mocked(
        UnifiedMessageController.createTargetedSystemMessage
      ).mockResolvedValue(createMockMessage("message-456", ["user123"]) as any);
      vi.mocked(socketService.emitSystemMessageUpdate).mockResolvedValue(
        undefined
      );
    });

    it("should create welcome trio with correct parameters", async () => {
      // Act
      const result = await TrioNotificationService.createWelcomeTrio(
        "test@example.com",
        "Test User",
        "user123"
      );

      // Assert
      expect(result.success).toBe(true);
      expect(AuthEmailService.sendWelcomeEmail).toHaveBeenCalledWith(
        "test@example.com",
        "Test User"
      );
      expect(
        UnifiedMessageController.createTargetedSystemMessage
      ).toHaveBeenCalledWith(
        {
          title: "Welcome to @Cloud!",
          content:
            "Welcome to the @Cloud Event Sign-up System! Your account has been verified and you can now participate in events.",
          type: "announcement",
          priority: "medium",
          hideCreator: true,
        },
        ["user123"],
        undefined,
        { emitMessageCreatedEvent: false },
      );
    });

    it("should create password reset success trio with correct parameters", async () => {
      // Act
      const result =
        await TrioNotificationService.createPasswordResetSuccessTrio(
          "test@example.com",
          "Test User",
          "user123"
        );

      // Assert
      expect(result.success).toBe(true);
      expect(AuthEmailService.sendPasswordResetSuccessEmail).toHaveBeenCalledWith(
        "test@example.com",
        "Test User"
      );
      expect(
        UnifiedMessageController.createTargetedSystemMessage
      ).toHaveBeenCalledWith(
        {
          title: "Password Reset Successful",
          content:
            "Your password has been successfully reset. You can now log in with your new password.",
          type: "update",
          priority: "high",
          hideCreator: true,
        },
        ["user123"],
        undefined,
        { emitMessageCreatedEvent: false },
      );
    });

    it("should create event reminder trio with correct parameters", async () => {
      // Arrange
      const mockEvent = {
        title: "Test Event",
        date: "2025-08-10",
        time: "14:00",
      };
      const mockUser = {
        _id: { toString: () => "user123" },
        email: "test@example.com",
        firstName: "Test",
        lastName: "User",
      };

      // Act
      const result = await TrioNotificationService.createEventReminderTrio(
        mockEvent,
        mockUser
      );

      // Assert
      expect(result.success).toBe(true);
      expect(EventEmailService.sendEventReminderEmail).toHaveBeenCalledWith(
        mockEvent,
        mockUser,
        "upcoming",
        "24 hours"
      );
      expect(
        UnifiedMessageController.createTargetedSystemMessage
      ).toHaveBeenCalledWith(
        {
          title: "Event Reminder",
          content:
            'Reminder: "Test Event" is coming up soon. Don\'t forget to prepare!',
          type: "announcement",
          priority: "medium",
          hideCreator: true,
        },
        ["user123"],
        undefined,
        { emitMessageCreatedEvent: false },
      );
    });
  });

  describe("metrics and monitoring", () => {
    it("should track performance metrics correctly", async () => {
      // Arrange
      const mockMessageResult = createMockMessage("message-456", ["user1"]);
      vi.mocked(
        UnifiedMessageController.createTargetedSystemMessage
      ).mockResolvedValue(mockMessageResult as any);
      vi.mocked(socketService.emitSystemMessageUpdate).mockResolvedValue(
        undefined
      );

      // Act
      const result = await TrioNotificationService.createTrio({
        systemMessage: { title: "Test", content: "Test" },
        recipients: ["user1"],
      });

      // Assert
      expect(result.metrics).toBeDefined();
      expect(result.metrics?.duration).toBeGreaterThanOrEqual(0);
      expect(result.metrics?.messageTime).toBeGreaterThanOrEqual(0);
      expect(result.metrics?.socketTime).toBeGreaterThanOrEqual(0);

      const metrics = TrioNotificationService.getMetrics();
      expect(metrics.averageLatency).toBeGreaterThanOrEqual(0);
      expect(metrics.totalRequests).toBe(1);
    });

    it("should reset metrics correctly", () => {
      // Create a trio to populate metrics
      TrioNotificationService.resetMetrics();

      const metrics = TrioNotificationService.getMetrics();
      expect(metrics.totalRequests).toBe(0);
      expect(metrics.successfulTrios).toBe(0);
      expect(metrics.failedTrios).toBe(0);
      expect(metrics.averageLatency).toBe(0);
      expect(metrics.rollbackCount).toBe(0);
      expect(Object.keys(metrics.errorsByType)).toHaveLength(0);
    });
  });
});
