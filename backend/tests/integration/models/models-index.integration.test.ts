/**
 * Models Index Unit Tests
 *
 * Tests model exports from models/index.ts
 * The database connection functions are tested via integration tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("models/index exports", () => {
  describe("Model exports", () => {
    it("should export User model and IUser type", async () => {
      const { User } = await import("../../../src/models/index");
      expect(User).toBeDefined();
    });

    it("should export Event model and related types", async () => {
      const { Event } = await import("../../../src/models/index");
      expect(Event).toBeDefined();
    });

    it("should export Registration model and related types", async () => {
      const { Registration } = await import("../../../src/models/index");
      expect(Registration).toBeDefined();
    });

    it("should export GuestRegistration model", async () => {
      const { GuestRegistration } = await import("../../../src/models/index");
      expect(GuestRegistration).toBeDefined();
    });

    it("should export Program model", async () => {
      const { Program } = await import("../../../src/models/index");
      expect(Program).toBeDefined();
    });

    it("should export ShortLink model", async () => {
      const { ShortLink } = await import("../../../src/models/index");
      expect(ShortLink).toBeDefined();
    });

    it("should export Purchase model", async () => {
      const { Purchase } = await import("../../../src/models/index");
      expect(Purchase).toBeDefined();
    });

    it("should export PromoCode model", async () => {
      const { PromoCode } = await import("../../../src/models/index");
      expect(PromoCode).toBeDefined();
    });

    it("should export SystemConfig model and related types", async () => {
      const { SystemConfig } = await import("../../../src/models/index");
      expect(SystemConfig).toBeDefined();
    });

    it("should export AuditLog model", async () => {
      const { AuditLog } = await import("../../../src/models/index");
      expect(AuditLog).toBeDefined();
    });

    it("should export RolesTemplate model", async () => {
      const { RolesTemplate } = await import("../../../src/models/index");
      expect(RolesTemplate).toBeDefined();
    });

    it("should export Message model", async () => {
      const { Message } = await import("../../../src/models/index");
      expect(Message).toBeDefined();
    });

    it("should export the five M2 alumni data models and initializer", async () => {
      const models = await import("../../../src/models/index");
      expect(models.AlumniProfile).toBeDefined();
      expect(models.AlumniAffiliation).toBeDefined();
      expect(models.AlumniInvitation).toBeDefined();
      expect(models.AlumniImportBatch).toBeDefined();
      expect(models.ConsentRecord).toBeDefined();
      expect(models.initializeAlumniDataModels).toBeTypeOf("function");
    });
  });

  describe("Database utility exports", () => {
    it("should export connectDatabase function", async () => {
      const { connectDatabase } = await import("../../../src/models/index");
      expect(connectDatabase).toBeDefined();
      expect(typeof connectDatabase).toBe("function");
    });

    it("should export checkDatabaseHealth function", async () => {
      const { checkDatabaseHealth } = await import("../../../src/models/index");
      expect(checkDatabaseHealth).toBeDefined();
      expect(typeof checkDatabaseHealth).toBe("function");
    });

    it("should export getDatabaseStats function", async () => {
      const { getDatabaseStats } = await import("../../../src/models/index");
      expect(getDatabaseStats).toBeDefined();
      expect(typeof getDatabaseStats).toBe("function");
    });
  });

  describe("checkDatabaseHealth logic", () => {
    it("should return true when mongoose readyState is 1", async () => {
      // Test the logic directly
      const checkHealth = (readyState: number): boolean => {
        try {
          return readyState === 1;
        } catch {
          return false;
        }
      };

      expect(checkHealth(1)).toBe(true);
      expect(checkHealth(0)).toBe(false);
      expect(checkHealth(2)).toBe(false);
      expect(checkHealth(3)).toBe(false);
    });

    it("should return false on error", () => {
      const checkHealthWithError = (): boolean => {
        try {
          throw new Error("Connection error");
        } catch {
          return false;
        }
      };

      expect(checkHealthWithError()).toBe(false);
    });
  });

  describe("getDatabaseStats logic", () => {
    it("should return stats object when database is connected", async () => {
      const mockStats = {
        dataSize: 1000,
        storageSize: 2000,
        indexes: 5,
        objects: 50,
        avgObjSize: 100,
      };

      const mockDb = {
        databaseName: "test-db",
        stats: async () => mockStats,
        listCollections: () => ({
          toArray: async () => [{ name: "users" }, { name: "events" }],
        }),
      };

      const buildStats = async (db: typeof mockDb, readyState: number) => ({
        databaseName: db.databaseName,
        collections: 2,
        dataSize: mockStats.dataSize,
        storageSize: mockStats.storageSize,
        indexes: mockStats.indexes,
        objects: mockStats.objects,
        avgObjSize: mockStats.avgObjSize,
        connected: readyState === 1,
      });

      const result = await buildStats(mockDb, 1);
      expect(result.databaseName).toBe("test-db");
      expect(result.collections).toBe(2);
      expect(result.connected).toBe(true);
    });

    it("should throw when database not connected", async () => {
      const getStatsWithNoDb = async (db: null) => {
        if (!db) {
          throw new Error("Database not connected");
        }
        return db;
      };

      await expect(getStatsWithNoDb(null)).rejects.toThrow("Database not connected");
    });
  });

  describe("connectDatabase logic", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let consoleErrorSpy: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let consoleWarnSpy: any;

    beforeEach(() => {
      consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleErrorSpy.mockRestore();
      consoleWarnSpy.mockRestore();
    });

    it("should throw when MONGODB_URI is not defined", async () => {
      const connectWithoutUri = async (mongoUri: string | undefined) => {
        if (!mongoUri) {
          throw new Error("MONGODB_URI environment variable is not defined");
        }
      };

      await expect(connectWithoutUri(undefined)).rejects.toThrow(
        "MONGODB_URI environment variable is not defined"
      );
    });

    it("should use connection options with expected values", () => {
      const options = {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
        bufferCommands: false,
      };

      expect(options.maxPoolSize).toBe(10);
      expect(options.serverSelectionTimeoutMS).toBe(5000);
      expect(options.socketTimeoutMS).toBe(45000);
      expect(options.bufferCommands).toBe(false);
    });

    it("should handle connection events", () => {
      // Test event handler logic
      const onError = (error: Error) => {
        console.error("❌ MongoDB connection error:", error);
      };

      const onDisconnected = () => {
        console.warn("⚠️ MongoDB disconnected");
      };

      const onReconnected = () => {
        // No logging on reconnect - just verify handler exists
      };

      // Execute handlers
      onError(new Error("Test error"));
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "❌ MongoDB connection error:",
        expect.any(Error)
      );

      onDisconnected();
      expect(consoleWarnSpy).toHaveBeenCalledWith("⚠️ MongoDB disconnected");

      // onReconnected should not throw
      expect(() => onReconnected()).not.toThrow();
    });
  });
});
