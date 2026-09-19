import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
  vi,
} from "vitest";
import mongoose from "mongoose";
import AuditLog from "../../../src/models/AuditLog";
import { ensureIntegrationDB } from "../setup/connect";

describe("AuditLog retention and cleanup", () => {
  let originalEnv: string | undefined;

  beforeAll(async () => {
    // Use the shared test database connection like integration tests
    await ensureIntegrationDB();
  });

  beforeEach(async () => {
    // Save original env
    originalEnv = process.env.AUDIT_LOG_RETENTION_MONTHS;

    // Ensure clean state
    await AuditLog.deleteMany({});
  });

  afterEach(async () => {
    // Restore original env
    if (originalEnv === undefined) {
      delete process.env.AUDIT_LOG_RETENTION_MONTHS;
    } else {
      process.env.AUDIT_LOG_RETENTION_MONTHS = originalEnv;
    }

    // Clean up test data
    await AuditLog.deleteMany({});
  });

  afterAll(async () => {
    // Clean up test data only (don't disconnect - shared connection)
    await AuditLog.deleteMany({});
  });

  describe("purgeOldAuditLogs static method", () => {
    it("should use default 12-month retention when no env var set", async () => {
      delete process.env.AUDIT_LOG_RETENTION_MONTHS;

      // Create logs with different ages
      const now = new Date();
      const thirteenMonthsAgo = new Date(now);
      thirteenMonthsAgo.setMonth(thirteenMonthsAgo.getMonth() - 13);

      const elevenMonthsAgo = new Date(now);
      elevenMonthsAgo.setMonth(elevenMonthsAgo.getMonth() - 11);

      await AuditLog.create({
        action: "EventPublished",
        createdAt: thirteenMonthsAgo,
      });

      await AuditLog.create({
        action: "EventUnpublished",
        createdAt: elevenMonthsAgo,
      });

      const result = await (AuditLog as any).purgeOldAuditLogs();

      expect(result.deletedCount).toBe(1); // Only the 13-month-old log

      const remaining = await AuditLog.countDocuments({});
      expect(remaining).toBe(1); // 11-month-old log should remain
    });

    it("should respect custom retention months from environment", async () => {
      process.env.AUDIT_LOG_RETENTION_MONTHS = "6";

      const now = new Date();
      const sevenMonthsAgo = new Date(now);
      sevenMonthsAgo.setMonth(sevenMonthsAgo.getMonth() - 7);

      const fiveMonthsAgo = new Date(now);
      fiveMonthsAgo.setMonth(fiveMonthsAgo.getMonth() - 5);

      await AuditLog.create({
        action: "EventPublished",
        createdAt: sevenMonthsAgo,
      });

      await AuditLog.create({
        action: "EventUnpublished",
        createdAt: fiveMonthsAgo,
      });

      const result = await (AuditLog as any).purgeOldAuditLogs();

      expect(result.deletedCount).toBe(1); // Only the 7-month-old log with 6-month retention

      const remaining = await AuditLog.countDocuments({});
      expect(remaining).toBe(1); // 5-month-old log should remain
    });

    it("should accept custom retention parameter overriding env var", async () => {
      process.env.AUDIT_LOG_RETENTION_MONTHS = "12";

      const now = new Date();
      const fourMonthsAgo = new Date(now);
      fourMonthsAgo.setMonth(fourMonthsAgo.getMonth() - 4);

      const twoMonthsAgo = new Date(now);
      twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);

      await AuditLog.create({
        action: "EventPublished",
        createdAt: fourMonthsAgo,
      });

      await AuditLog.create({
        action: "EventUnpublished",
        createdAt: twoMonthsAgo,
      });

      // Override with 3-month retention parameter
      const result = await (AuditLog as any).purgeOldAuditLogs(3);

      expect(result.deletedCount).toBe(1); // Only the 4-month-old log with 3-month retention

      const remaining = await AuditLog.countDocuments({});
      expect(remaining).toBe(1); // 2-month-old log should remain
    });

    it("should return zero deletedCount when no old logs exist", async () => {
      const now = new Date();
      const oneMonthAgo = new Date(now);
      oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

      await AuditLog.create({
        action: "EventPublished",
        createdAt: oneMonthAgo,
      });

      const result = await (AuditLog as any).purgeOldAuditLogs();

      expect(result.deletedCount).toBe(0);

      const remaining = await AuditLog.countDocuments({});
      expect(remaining).toBe(1); // Recent log should remain
    });

    it("should delete only logs strictly older than retention cutoff and keep boundary log", async () => {
      vi.useFakeTimers();
      const frozenNow = new Date("2024-02-29T23:30:00.000Z");
      vi.setSystemTime(frozenNow);
      try {
        const boundaryDate = new Date("2023-02-28T23:30:00.000Z");
        const olderDate = new Date(boundaryDate.getTime() - 1000);

        await AuditLog.create({
          action: "BoundaryKept",
          createdAt: boundaryDate,
        });
        await AuditLog.create({ action: "OlderDeleted", createdAt: olderDate });

        const result = await (AuditLog as any).purgeOldAuditLogs(12);
        expect(result.deletedCount).toBe(1);

        const remainingLogs = await AuditLog.find({}).lean();
        expect(remainingLogs.length).toBe(1);
        expect(remainingLogs[0].action).toBe("BoundaryKept");
      } finally {
        vi.useRealTimers();
      }
    });

    it("should preserve complex audit log data when within retention", async () => {
      vi.useFakeTimers();
      const frozenNow = new Date("2025-10-06T12:00:00.000Z");
      vi.setSystemTime(frozenNow);
      try {
        const sixMonthsAgo = new Date(frozenNow);
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

        const sampleMetadata = {
          ip: "192.168.1.1",
          userAgent: "test-agent",
          additional: "complex data",
        };

        await AuditLog.create({
          action: "PublicRegistrationCreated",
          actorId: new mongoose.Types.ObjectId(),
          eventId: new mongoose.Types.ObjectId(),
          metadata: sampleMetadata,
          ipHash: "hashed-ip",
          emailHash: "hashed-email",
          createdAt: sixMonthsAgo,
        });

        const result = await (AuditLog as any).purgeOldAuditLogs(12);

        expect(result.deletedCount).toBe(0);

        const remaining = await AuditLog.findOne({}).lean();
        expect(remaining).toBeTruthy();
        expect(remaining?.metadata).toEqual(sampleMetadata);
        expect(remaining?.ipHash).toBe("hashed-ip");
        expect(remaining?.emailHash).toBe("hashed-email");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
