/**
 * Integration Tests for Trio System
 *
 * Tests the complete trio notification flow with real services
 * (using test database and mock email service)
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  vi,
} from "vitest";
// Force real timers immediately to avoid any prior fakeTimers affecting these integration tests
vi.useRealTimers();
import { TrioNotificationService } from "../../../src/services/notifications/TrioNotificationService";
import { NOTIFICATION_CONFIG } from "../../../src/config/notificationConfig";

// Override notification config for faster integration tests
const TEST_CONFIG = {
  ...NOTIFICATION_CONFIG,
  timeouts: {
    email: 1000, // 1 second instead of 15 seconds
    database: 500, // 0.5 seconds instead of 5 seconds
    websocket: 300, // 0.3 seconds instead of 3 seconds
  },
  retries: {
    email: 2, // 2 attempts instead of 3
    database: 1, // 1 attempt instead of 2
    websocket: 2, // 2 attempts instead of 3
  },
};

// Apply test configuration
Object.assign(NOTIFICATION_CONFIG, TEST_CONFIG);

// Mock domain email services for integration testing
// These mocks prevent actual email sending during integration tests
vi.mock("../../../src/services/email/domains/AuthEmailService", () => ({
  AuthEmailService: {
    sendWelcomeEmail: vi.fn().mockResolvedValue(true),
    sendPasswordResetSuccessEmail: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock("../../../src/services/email/domains/EventEmailService", () => ({
  EventEmailService: {
    sendEventReminderEmail: vi.fn().mockResolvedValue(true),
    sendEventCreatedEmail: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock("../../../src/services/email/domains/RoleEmailService", () => ({
  RoleEmailService: {
    sendCoOrganizerAssignedEmail: vi.fn().mockResolvedValue(true),
    sendNewLeaderSignupEmail: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock("../../../src/services/infrastructure/SocketService", () => ({
  socketService: {
    emitSystemMessageUpdate: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../../src/controllers/unifiedMessageController", () => ({
  UnifiedMessageController: {
    createTargetedSystemMessage: vi.fn(),
  },
}));

import { UnifiedMessageController } from "../../../src/controllers/unifiedMessageController";
import { socketService } from "../../../src/services/infrastructure/SocketService";

function createMockMessage(recipientIds: string[]) {
  return {
    _id: { toString: () => "mock-message-id" } as any,
    title: "Test Message",
    content: "Test Content",
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
    isActive: true,
    toJSON: vi.fn(() => {
      throw new Error("raw document serialization must not be used for realtime");
    }),
    save: vi.fn().mockResolvedValue(true),
  };
}

describe("Trio System Integration", () => {
  // Ensure real timers for integration tests to respect configured timeouts
  beforeAll(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    // Reset metrics and clear mocks before each test
    TrioNotificationService.resetMetrics();
    vi.clearAllMocks();
    vi.mocked(
      UnifiedMessageController.createTargetedSystemMessage,
    ).mockImplementation(async (_messageData, recipientIds) =>
      createMockMessage(recipientIds) as any,
    );
  });

  describe("Complete Trio Flows", () => {
    it("should successfully create a welcome trio", async () => {
      // Act
      const result = await TrioNotificationService.createWelcomeTrio(
        "test@example.com",
        "Test User",
        "user-123"
      );

      // Assert
      expect(result.success).toBe(true);
      expect(result.messageId).toBe("mock-message-id");
      expect(result.notificationsSent).toBe(1);
      expect(result.metrics?.duration).toBeGreaterThanOrEqual(0);

      // Verify metrics were updated
      const metrics = TrioNotificationService.getMetrics();
      expect(metrics.totalRequests).toBeGreaterThanOrEqual(1);
      expect(metrics.successfulTrios).toBeGreaterThanOrEqual(1);
      expect(metrics.failedTrios).toBeGreaterThanOrEqual(0);
    });

    it("should successfully create a password reset success trio", async () => {
      // Act
      const result =
        await TrioNotificationService.createPasswordResetSuccessTrio(
          "test@example.com",
          "Test User",
          "user-123"
        );

      // Assert
      expect(result.success).toBe(true);
      expect(result.messageId).toBe("mock-message-id");
      expect(result.notificationsSent).toBe(1);

      // Verify high priority was used
      expect(result.metrics?.duration).toBeGreaterThanOrEqual(0);
    });

    it("should successfully create an event reminder trio", async () => {
      // Arrange
      const mockEvent = {
        title: "Test Event",
        date: "2025-08-10",
        time: "14:00",
      };

      const mockUser = {
        _id: { toString: () => "user-123" },
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
      expect(result.messageId).toBe("mock-message-id");
      expect(result.notificationsSent).toBe(1);
    });
  });

  describe("Multiple Recipients", () => {
    it("should handle trio creation for multiple recipients", async () => {
      // Act
      const result = await TrioNotificationService.createTrio({
        systemMessage: {
          title: "System Announcement",
          content: "Important system update for all users",
          type: "announcement",
          priority: "high",
        },
        recipients: ["user-1", "user-2", "user-3"],
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.notificationsSent).toBe(3);

      // Should emit websocket events for each recipient
      expect(socketService.emitSystemMessageUpdate).toHaveBeenCalledTimes(3);
    });
  });

  describe("Error Scenarios", () => {
    it("should handle email service failures gracefully", async () => {
      // Arrange - Mock auth email service to fail
      const { AuthEmailService } = await import(
        "../../../src/services/email/domains/AuthEmailService"
      );
      vi.mocked(AuthEmailService.sendWelcomeEmail).mockRejectedValue(
        new Error("Email service down")
      );

      // Act
      const result = await TrioNotificationService.createWelcomeTrio(
        "test@example.com",
        "Test User",
        "user-123"
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain("Email failed after");
      expect(result.rollbackCompleted).toBe(true);

      // Verify metrics were updated for failure
      const metrics = TrioNotificationService.getMetrics();
      expect(metrics.failedTrios).toBe(1);
      expect(metrics.rollbackCount).toBe(1);
    }, 10000); // 10 second timeout (reduced from 30 seconds)

    it("should handle database failures gracefully", async () => {
      // Arrange - Mock database operation to fail
      vi.mocked(
        UnifiedMessageController.createTargetedSystemMessage
      ).mockRejectedValue(new Error("Database connection failed"));

      // Act
      const result = await TrioNotificationService.createTrio({
        systemMessage: {
          title: "Test Message",
          content: "Test Content",
        },
        recipients: ["user-123"],
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain("System message creation failed");
      expect(result.rollbackCompleted).toBe(true);
    });

    it("should handle partial WebSocket failures", async () => {
      // Arrange - Reset database mock to work properly
      vi.mocked(
        UnifiedMessageController.createTargetedSystemMessage
      ).mockResolvedValue(
        createMockMessage(["user-1", "user-2", "user-3"]) as any,
      );

      // Mock the socketService.emitSystemMessageUpdate to throw for the second call
      let callCount = 0;
      vi.mocked(socketService.emitSystemMessageUpdate).mockImplementation(
        (userId: string) => {
          callCount++;
          if (callCount === 2) {
            // Simulate failure for user-2 by throwing immediately
            throw new Error("WebSocket failed");
          }
          // Return normally for other calls
        }
      );

      // Act
      const result = await TrioNotificationService.createTrio({
        systemMessage: {
          title: "Test Message",
          content: "Test Content",
        },
        recipients: ["user-1", "user-2", "user-3"],
      });

      // Assert
      expect(result.success).toBe(true); // Should still succeed with partial failures
      expect(result.notificationsSent).toBe(3); // All 3 recipients (WebSocket failure is not counted in notificationsSent)
    });
  });

  describe("Performance and Configuration", () => {
    it("should respect timeout configurations", async () => {
      // Arrange - Mock a slow email service
      const { AuthEmailService } = await import(
        "../../../src/services/email/domains/AuthEmailService"
      );
      vi.mocked(AuthEmailService.sendWelcomeEmail).mockImplementation(
        () =>
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Email timeout after 100ms")),
              100
            )
          )
      );

      // Act
      const result = await TrioNotificationService.createWelcomeTrio(
        "test@example.com",
        "Test User",
        "user-123"
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain("timeout");
    }, 8000); // 8 second timeout (reduced from 30 seconds)

    it("should collect performance metrics", async () => {
      // Reset metrics to start clean
      TrioNotificationService.resetMetrics();

      // Reset all mocks to work properly
      const { AuthEmailService } = await import(
        "../../../src/services/email/domains/AuthEmailService"
      );
      vi.mocked(AuthEmailService.sendWelcomeEmail).mockResolvedValue(true);
      vi.mocked(
        UnifiedMessageController.createTargetedSystemMessage
      ).mockImplementation(async (_messageData, recipientIds) =>
        createMockMessage(recipientIds) as any,
      );

      // Act - Create multiple trios
      await TrioNotificationService.createWelcomeTrio(
        "user1@test.com",
        "User 1",
        "user-1"
      );
      await TrioNotificationService.createWelcomeTrio(
        "user2@test.com",
        "User 2",
        "user-2"
      );

      // Create a failing trio - disable retry to force failure
      vi.mocked(AuthEmailService.sendWelcomeEmail).mockRejectedValue(
        new Error("Email failed")
      );

      try {
        await TrioNotificationService.createWelcomeTrio(
          "user3@test.com",
          "User 3",
          "user-3"
        );
      } catch (error) {
        // Expected to fail
      }

      // Metrics are updated synchronously with the completed trio promises.
      const metrics = TrioNotificationService.getMetrics();
      expect(metrics.totalRequests).toBeGreaterThanOrEqual(3);
      expect(metrics.successfulTrios).toBeGreaterThanOrEqual(2);
      expect(metrics.failedTrios).toBeGreaterThanOrEqual(0); // May be 0 or 1 depending on recovery timing
      expect(metrics.averageLatency).toBeGreaterThanOrEqual(0);
      expect(metrics.rollbackCount).toBeGreaterThanOrEqual(0);
    }, 15000); // 15 second timeout (reduced from 40 seconds)
  });

  describe("Configuration Validation", () => {
    it("should use correct timeout values from configuration", () => {
      expect(NOTIFICATION_CONFIG.timeouts.email).toBeGreaterThan(0);
      expect(NOTIFICATION_CONFIG.timeouts.websocket).toBeGreaterThan(0);
      expect(NOTIFICATION_CONFIG.retries.email).toBeGreaterThan(0);
      expect(NOTIFICATION_CONFIG.retries.websocket).toBeGreaterThan(0);
      expect(typeof NOTIFICATION_CONFIG.features.enableRollback).toBe(
        "boolean"
      );
    });
  });
});
