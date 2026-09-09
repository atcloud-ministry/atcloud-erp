import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../src/app";
import { ensureIntegrationDB } from "../setup/connect";
import Message from "../../../src/models/Message";
import User from "../../../src/models/User";
import { TokenService } from "../../../src/middleware/auth";

describe("POST /api/notifications/cleanup - MessageCleanupController", () => {
  beforeAll(async () => {
    await ensureIntegrationDB();
  });

  afterEach(async () => {
    await Message.deleteMany({});
    await User.deleteMany({});
  });

  afterAll(async () => {
    // Shared integration harness owns connection lifecycle.
  });

  describe("Authentication", () => {
    it("should return 401 if no token is provided", async () => {
      const response = await request(app).post("/api/notifications/cleanup");
      expect(response.status).toBe(401);
    });

    it("should return 401 if token is invalid", async () => {
      const response = await request(app)
        .post("/api/notifications/cleanup")
        .set("Authorization", "Bearer invalid-token");
      expect(response.status).toBe(401);
    });
  });

  describe("Authorization", () => {
    it.each(["Participant", "Guest Expert", "Leader"] as const)(
      "should return 403 for %s and leave expired messages unchanged",
      async (role) => {
        const roleSlug = role.toLowerCase().replace(/\s+/g, "-");
        const user = await User.create({
          username: `cleanup_${roleSlug.replace(/-/g, "_")}`,
          email: `cleanup-${roleSlug}@example.com`,
          password: "TestPass123!",
          role,
          isVerified: true,
          isActive: true,
        } as any);

        const message = await Message.create({
          title: "Protected Expired Message",
          content: "Low-permission callers must not clean up this message",
          type: "announcement",
          priority: "low",
          creator: {
            id: "admin123",
            firstName: "Admin",
            lastName: "User",
            username: "admin",
            gender: "male",
            authLevel: "Administrator",
          },
          isActive: true,
          expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
          userStates: new Map(),
        });
        const originalUpdatedAt = message.updatedAt.getTime();
        const token = TokenService.generateAccessToken({
          userId: user._id.toString(),
          email: user.email,
          role: user.role,
        });

        const response = await request(app)
          .post("/api/notifications/cleanup")
          .set("Authorization", `Bearer ${token}`);

        expect(response.status).toBe(403);
        expect(response.body).toMatchObject({
          success: false,
          error: "Insufficient permissions.",
        });

        const unchangedMessage = await Message.findById(message._id);
        expect(unchangedMessage).not.toBeNull();
        expect(unchangedMessage?.isActive).toBe(true);
        expect(unchangedMessage?.updatedAt.getTime()).toBe(originalUpdatedAt);
      },
    );
  });

  describe("Success Cases", () => {
    it("should cleanup expired messages successfully", async () => {
      const user = await User.create({
        username: "testuser",
        email: "test@example.com",
        password: "TestPass123!",
        role: "Administrator",
        isVerified: true,
        isActive: true,
      } as any);

      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);

      // Create expired message
      await Message.create({
        title: "Expired Message",
        content: "This message has expired",
        type: "announcement",
        priority: "low",
        creator: {
          id: "admin123",
          firstName: "Admin",
          lastName: "User",
          username: "admin",
          gender: "male",
          authLevel: "Administrator",
        },
        isActive: true,
        expiresAt: pastDate,
        userStates: new Map(),
      });

      const token = TokenService.generateAccessToken({
        userId: user._id.toString(),
        email: user.email,
        role: user.role,
      });

      const response = await request(app)
        .post("/api/notifications/cleanup")
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe("Expired messages cleaned up");
      expect(response.body.data.expiredCount).toBe(1);
    });

    it("should mark expired messages as inactive", async () => {
      const user = await User.create({
        username: "testuser",
        email: "test@example.com",
        password: "TestPass123!",
        role: "Administrator",
        isVerified: true,
        isActive: true,
      } as any);

      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);

      const message = await Message.create({
        title: "Expired Message",
        content: "This message has expired",
        type: "announcement",
        priority: "low",
        creator: {
          id: "admin123",
          firstName: "Admin",
          lastName: "User",
          username: "admin",
          gender: "male",
          authLevel: "Administrator",
        },
        isActive: true,
        expiresAt: pastDate,
        userStates: new Map(),
      });

      const token = TokenService.generateAccessToken({
        userId: user._id.toString(),
        email: user.email,
        role: user.role,
      });

      await request(app)
        .post("/api/notifications/cleanup")
        .set("Authorization", `Bearer ${token}`);

      const updatedMessage = await Message.findById(message._id);
      expect(updatedMessage?.isActive).toBe(false);
    });

    it("should cleanup multiple expired messages", async () => {
      const user = await User.create({
        username: "testuser",
        email: "test@example.com",
        password: "TestPass123!",
        role: "Administrator",
        isVerified: true,
        isActive: true,
      } as any);

      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);

      // Create 3 expired messages
      for (let i = 0; i < 3; i++) {
        await Message.create({
          title: `Expired Message ${i + 1}`,
          content: `Content ${i + 1}`,
          type: "announcement",
          priority: "low",
          creator: {
            id: "admin123",
            firstName: "Admin",
            lastName: "User",
            username: "admin",
            gender: "male",
            authLevel: "Administrator",
          },
          isActive: true,
          expiresAt: pastDate,
          userStates: new Map(),
        });
      }

      const token = TokenService.generateAccessToken({
        userId: user._id.toString(),
        email: user.email,
        role: user.role,
      });

      const response = await request(app)
        .post("/api/notifications/cleanup")
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data.expiredCount).toBe(3);
    });

    it("should return 0 when no messages are expired", async () => {
      const user = await User.create({
        username: "testuser",
        email: "test@example.com",
        password: "TestPass123!",
        role: "Administrator",
        isVerified: true,
        isActive: true,
      } as any);

      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 7);

      // Create non-expired message
      await Message.create({
        title: "Active Message",
        content: "This message is still active",
        type: "announcement",
        priority: "medium",
        creator: {
          id: "admin123",
          firstName: "Admin",
          lastName: "User",
          username: "admin",
          gender: "male",
          authLevel: "Administrator",
        },
        isActive: true,
        expiresAt: futureDate,
        userStates: new Map(),
      });

      const token = TokenService.generateAccessToken({
        userId: user._id.toString(),
        email: user.email,
        role: user.role,
      });

      const response = await request(app)
        .post("/api/notifications/cleanup")
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data.expiredCount).toBe(0);
    });

    it("should not affect messages without expiry date", async () => {
      const user = await User.create({
        username: "testuser",
        email: "test@example.com",
        password: "TestPass123!",
        role: "Administrator",
        isVerified: true,
        isActive: true,
      } as any);

      const message = await Message.create({
        title: "Permanent Message",
        content: "This message has no expiry",
        type: "announcement",
        priority: "high",
        creator: {
          id: "admin123",
          firstName: "Admin",
          lastName: "User",
          username: "admin",
          gender: "male",
          authLevel: "Administrator",
        },
        isActive: true,
        userStates: new Map(),
      });

      const token = TokenService.generateAccessToken({
        userId: user._id.toString(),
        email: user.email,
        role: user.role,
      });

      await request(app)
        .post("/api/notifications/cleanup")
        .set("Authorization", `Bearer ${token}`);

      const updatedMessage = await Message.findById(message._id);
      expect(updatedMessage?.isActive).toBe(true);
    });

    it("should not affect already inactive messages", async () => {
      const user = await User.create({
        username: "testuser",
        email: "test@example.com",
        password: "TestPass123!",
        role: "Administrator",
        isVerified: true,
        isActive: true,
      } as any);

      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);

      await Message.create({
        title: "Inactive Message",
        content: "Already inactive",
        type: "announcement",
        priority: "low",
        creator: {
          id: "admin123",
          firstName: "Admin",
          lastName: "User",
          username: "admin",
          gender: "male",
          authLevel: "Administrator",
        },
        isActive: false,
        expiresAt: pastDate,
        userStates: new Map(),
      });

      const token = TokenService.generateAccessToken({
        userId: user._id.toString(),
        email: user.email,
        role: user.role,
      });

      const response = await request(app)
        .post("/api/notifications/cleanup")
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data.expiredCount).toBe(0);
    });
  });

  describe("Edge Cases", () => {
    it("should handle cleanup with mixed expired and active messages", async () => {
      const user = await User.create({
        username: "testuser",
        email: "test@example.com",
        password: "TestPass123!",
        role: "Administrator",
        isVerified: true,
        isActive: true,
      } as any);

      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);

      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 7);

      // Create 2 expired messages
      await Message.create({
        title: "Expired 1",
        content: "Expired",
        type: "announcement",
        priority: "low",
        creator: {
          id: "admin123",
          firstName: "Admin",
          lastName: "User",
          username: "admin",
          gender: "male",
          authLevel: "Administrator",
        },
        isActive: true,
        expiresAt: pastDate,
        userStates: new Map(),
      });

      await Message.create({
        title: "Expired 2",
        content: "Expired",
        type: "update",
        priority: "low",
        creator: {
          id: "admin123",
          firstName: "Admin",
          lastName: "User",
          username: "admin",
          gender: "male",
          authLevel: "Administrator",
        },
        isActive: true,
        expiresAt: pastDate,
        userStates: new Map(),
      });

      // Create 1 active message
      const activeMessage = await Message.create({
        title: "Active",
        content: "Still active",
        type: "announcement",
        priority: "medium",
        creator: {
          id: "admin123",
          firstName: "Admin",
          lastName: "User",
          username: "admin",
          gender: "male",
          authLevel: "Administrator",
        },
        isActive: true,
        expiresAt: futureDate,
        userStates: new Map(),
      });

      const token = TokenService.generateAccessToken({
        userId: user._id.toString(),
        email: user.email,
        role: user.role,
      });

      const response = await request(app)
        .post("/api/notifications/cleanup")
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data.expiredCount).toBe(2);

      // Verify active message is still active
      const stillActive = await Message.findById(activeMessage._id);
      expect(stillActive?.isActive).toBe(true);
    });

    it("should handle cleanup when database is empty", async () => {
      const user = await User.create({
        username: "testuser",
        email: "test@example.com",
        password: "TestPass123!",
        role: "Administrator",
        isVerified: true,
        isActive: true,
      } as any);

      const token = TokenService.generateAccessToken({
        userId: user._id.toString(),
        email: user.email,
        role: user.role,
      });

      const response = await request(app)
        .post("/api/notifications/cleanup")
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.expiredCount).toBe(0);
    });

    it("should handle messages expiring at exact current time", async () => {
      const user = await User.create({
        username: "testuser",
        email: "test@example.com",
        password: "TestPass123!",
        role: "Administrator",
        isVerified: true,
        isActive: true,
      } as any);

      // Message that expires 1 second ago
      const justExpired = new Date(Date.now() - 1000);

      await Message.create({
        title: "Just Expired",
        content: "Expired 1 second ago",
        type: "announcement",
        priority: "low",
        creator: {
          id: "admin123",
          firstName: "Admin",
          lastName: "User",
          username: "admin",
          gender: "male",
          authLevel: "Administrator",
        },
        isActive: true,
        expiresAt: justExpired,
        userStates: new Map(),
      });

      const token = TokenService.generateAccessToken({
        userId: user._id.toString(),
        email: user.email,
        role: user.role,
      });

      const response = await request(app)
        .post("/api/notifications/cleanup")
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data.expiredCount).toBe(1);
    });

    it("should work for different message types", async () => {
      const user = await User.create({
        username: "testuser",
        email: "test@example.com",
        password: "TestPass123!",
        role: "Administrator",
        isVerified: true,
        isActive: true,
      } as any);

      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);

      const messageTypes = ["announcement", "maintenance", "update", "warning"];

      for (const type of messageTypes) {
        await Message.create({
          title: `Expired ${type}`,
          content: `Expired ${type} message`,
          type,
          priority: "low",
          creator: {
            id: "admin123",
            firstName: "Admin",
            lastName: "User",
            username: "admin",
            gender: "male",
            authLevel: "Administrator",
          },
          isActive: true,
          expiresAt: pastDate,
          userStates: new Map(),
        });
      }

      const token = TokenService.generateAccessToken({
        userId: user._id.toString(),
        email: user.email,
        role: user.role,
      });

      const response = await request(app)
        .post("/api/notifications/cleanup")
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data.expiredCount).toBe(4);
    });

    it("should be idempotent - can run cleanup multiple times", async () => {
      const user = await User.create({
        username: "testuser",
        email: "test@example.com",
        password: "TestPass123!",
        role: "Administrator",
        isVerified: true,
        isActive: true,
      } as any);

      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);

      await Message.create({
        title: "Expired Message",
        content: "This message has expired",
        type: "announcement",
        priority: "low",
        creator: {
          id: "admin123",
          firstName: "Admin",
          lastName: "User",
          username: "admin",
          gender: "male",
          authLevel: "Administrator",
        },
        isActive: true,
        expiresAt: pastDate,
        userStates: new Map(),
      });

      const token = TokenService.generateAccessToken({
        userId: user._id.toString(),
        email: user.email,
        role: user.role,
      });

      // First cleanup
      const response1 = await request(app)
        .post("/api/notifications/cleanup")
        .set("Authorization", `Bearer ${token}`);

      expect(response1.status).toBe(200);
      expect(response1.body.data.expiredCount).toBe(1);

      // Second cleanup - should find 0 messages since already cleaned
      const response2 = await request(app)
        .post("/api/notifications/cleanup")
        .set("Authorization", `Bearer ${token}`);

      expect(response2.status).toBe(200);
      expect(response2.body.data.expiredCount).toBe(0);
    });
  });

  describe("Response Format", () => {
    it("should return correct response structure", async () => {
      const user = await User.create({
        username: "testuser",
        email: "test@example.com",
        password: "TestPass123!",
        role: "Administrator",
        isVerified: true,
        isActive: true,
      } as any);

      const token = TokenService.generateAccessToken({
        userId: user._id.toString(),
        email: user.email,
        role: user.role,
      });

      const response = await request(app)
        .post("/api/notifications/cleanup")
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("success");
      expect(response.body).toHaveProperty("message");
      expect(response.body).toHaveProperty("data");
      expect(response.body.data).toHaveProperty("expiredCount");
      expect(typeof response.body.data.expiredCount).toBe("number");
    });
  });
});
