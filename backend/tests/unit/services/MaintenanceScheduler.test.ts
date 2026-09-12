/**
 * Unit Tests for MaintenanceScheduler
 *
 * Tests the maintenance scheduler that periodically purges:
 * - Expired guest manage tokens
 * - Old audit logs based on retention policy
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import GuestRegistration from "../../../src/models/GuestRegistration";
import AuditLog from "../../../src/models/AuditLog";

const alumniRetentionMocks = vi.hoisted(() => ({
  runBounded: vi.fn(),
}));

// Mock the models
vi.mock("../../../src/models/GuestRegistration");
vi.mock("../../../src/models/AuditLog");
vi.mock(
  "../../../src/services/alumni/AlumniRetentionCleanupService",
  () => ({
    alumniRetentionCleanupService: alumniRetentionMocks,
  }),
);
vi.mock("../../../src/services/LoggerService", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

describe("MaintenanceScheduler", () => {
  let scheduler: any;
  let purgeExpiredTokensMock: ReturnType<typeof vi.fn>;
  let purgeOldAuditLogsMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    purgeExpiredTokensMock = vi.fn().mockResolvedValue(undefined);
    purgeOldAuditLogsMock = vi.fn().mockResolvedValue({ deletedCount: 5 });
    alumniRetentionMocks.runBounded.mockResolvedValue({
      importCandidatesScanned: 0,
      importBatchesPurged: 0,
      invitationCandidatesScanned: 0,
      invitationsPurged: 0,
    });

    (GuestRegistration as any).purgeExpiredManageTokens =
      purgeExpiredTokensMock;
    (AuditLog as any).purgeOldAuditLogs = purgeOldAuditLogsMock;

    // Import fresh module
    const module = await import("../../../src/services/MaintenanceScheduler");
    // Use the singleton instance exposed by the class
    scheduler = (module.default as any).getInstance();
  });

  afterEach(() => {
    if (scheduler.stop) {
      scheduler.stop();
    }
    vi.useRealTimers();
  });

  describe("start", () => {
    it("should start the scheduler and trigger initial purge after 10 seconds", async () => {
      scheduler.start();

      // Fast-forward 10 seconds for initial purge
      await vi.advanceTimersByTimeAsync(10 * 1000);

      expect(purgeExpiredTokensMock).toHaveBeenCalledTimes(1);
      expect(purgeOldAuditLogsMock).toHaveBeenCalledTimes(1);
      expect(alumniRetentionMocks.runBounded).toHaveBeenCalledTimes(1);
      expect(alumniRetentionMocks.runBounded).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger: "startup",
          principal: expect.objectContaining({
            serviceKey: "alumni-retention",
            capabilities: ["alumni.retention.purge"],
          }),
        }),
      );
    });

    it("should run purge every hour", async () => {
      scheduler.start();

      // Skip initial 10-second delay
      await vi.advanceTimersByTimeAsync(10 * 1000);
      expect(purgeExpiredTokensMock).toHaveBeenCalledTimes(1);
      expect(purgeOldAuditLogsMock).toHaveBeenCalledTimes(1);
      expect(alumniRetentionMocks.runBounded).toHaveBeenCalledTimes(1);

      // Fast-forward 1 hour
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(purgeExpiredTokensMock).toHaveBeenCalledTimes(2);
      expect(purgeOldAuditLogsMock).toHaveBeenCalledTimes(2);
      expect(alumniRetentionMocks.runBounded).toHaveBeenCalledTimes(2);
      expect(alumniRetentionMocks.runBounded).toHaveBeenLastCalledWith(
        expect.objectContaining({ trigger: "scheduled" }),
      );

      // Fast-forward another hour
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(purgeExpiredTokensMock).toHaveBeenCalledTimes(3);
      expect(purgeOldAuditLogsMock).toHaveBeenCalledTimes(3);
      expect(alumniRetentionMocks.runBounded).toHaveBeenCalledTimes(3);
    });

    it("should not start if already running", () => {
      const consoleSpy = vi.spyOn(console, "log");
      scheduler.start();
      scheduler.start(); // Try to start again

      expect(consoleSpy).toHaveBeenCalledWith(
        "⚠️ Maintenance scheduler is already running"
      );
    });
  });

  describe("stop", () => {
    it("should stop the scheduler", async () => {
      scheduler.start();

      // Wait for initial purge
      await vi.advanceTimersByTimeAsync(10 * 1000);
      expect(purgeExpiredTokensMock).toHaveBeenCalledTimes(1);

      scheduler.stop();

      // Fast-forward an hour - should not trigger purge
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(purgeExpiredTokensMock).toHaveBeenCalledTimes(1); // Still 1
    });

    it("cancels the tracked startup cleanup before it can run", async () => {
      scheduler.start();
      scheduler.stop();

      await vi.advanceTimersByTimeAsync(10 * 1000);

      expect(purgeExpiredTokensMock).not.toHaveBeenCalled();
      expect(purgeOldAuditLogsMock).not.toHaveBeenCalled();
      expect(alumniRetentionMocks.runBounded).not.toHaveBeenCalled();
    });

    it("should warn if trying to stop when not running", () => {
      const consoleSpy = vi.spyOn(console, "log");
      scheduler.stop();

      expect(consoleSpy).toHaveBeenCalledWith(
        "⚠️ Maintenance scheduler is not running"
      );
    });
  });

  describe("purgeExpiredTokens", () => {
    it("should handle purge errors gracefully", async () => {
      const errorSpy = vi.spyOn(console, "error");
      purgeExpiredTokensMock.mockRejectedValue(new Error("Database error"));

      scheduler.start();
      await vi.advanceTimersByTimeAsync(10 * 1000);

      expect(errorSpy).toHaveBeenCalledWith(
        "Failed to purge expired manage tokens:",
        expect.any(Error)
      );
    });
  });

  describe("purgeOldAuditLogs", () => {
    it("should log deleted count when audit logs are purged", async () => {
      const consoleSpy = vi.spyOn(console, "log");
      purgeOldAuditLogsMock.mockResolvedValue({ deletedCount: 15 });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(10 * 1000);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Purged 15 old audit logs")
      );
    });

    it("should not log if no audit logs were deleted", async () => {
      const consoleSpy = vi.spyOn(console, "log");
      purgeOldAuditLogsMock.mockResolvedValue({ deletedCount: 0 });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(10 * 1000);

      // Should not log the "Purged X old audit logs" message
      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("Purged 0 old audit logs")
      );
    });

    it("should handle audit log purge errors gracefully", async () => {
      const errorSpy = vi.spyOn(console, "error");
      purgeOldAuditLogsMock.mockRejectedValue(new Error("Audit DB error"));

      scheduler.start();
      await vi.advanceTimersByTimeAsync(10 * 1000);

      expect(errorSpy).toHaveBeenCalledWith(
        "Failed to purge old audit logs:",
        expect.any(Error)
      );
    });
  });

  describe("singleton pattern", () => {
    it("should return the same instance", async () => {
      const module = await import("../../../src/services/MaintenanceScheduler");
      const instance1 = (module.default as any).getInstance();
      const instance2 = (module.default as any).getInstance();

      expect(instance1).toBe(instance2);
    });
  });
});
