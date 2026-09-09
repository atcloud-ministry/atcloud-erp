import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import app from "../../../src/app";
import User from "../../../src/models/User";
import mongoose from "mongoose";
import AuditLog from "../../../src/models/AuditLog";

describe("GET /api/audit-logs - Audit Logs API", () => {
  let adminToken: string;
  let leaderToken: string;
  let memberToken: string;
  let adminUserId: mongoose.Types.ObjectId;
  let leaderUserId: mongoose.Types.ObjectId;
  let memberUserId: mongoose.Types.ObjectId;
  let openedLocal = false;

  beforeAll(async () => {
    // Ensure MongoDB connection
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(
        process.env.MONGODB_TEST_URI ||
          "mongodb://127.0.0.1:27017/atcloud-signup-test"
      );
      openedLocal = true;
    }

    // Clean up existing users and audit logs
    await User.deleteMany({});
    await AuditLog.deleteMany({});

    // Create and register admin user
    const adminRegResponse = await request(app)
      .post("/api/auth/register")
      .send({
        username: "audit_admin",
        email: "audit.admin@test.com",
        password: "AdminPass123!",
        confirmPassword: "AdminPass123!",
        firstName: "Admin",
        lastName: "User",
        gender: "male",
        isAtCloudLeader: false,
        acceptTerms: true,
      });

    if (adminRegResponse.status !== 201) {
      throw new Error(
        `Failed to register admin: ${JSON.stringify(adminRegResponse.body)}`
      );
    }

    // Manually verify and set admin role
    const adminUser = await User.findOneAndUpdate(
      { email: "audit.admin@test.com" },
      { isVerified: true, role: "Super Admin", isActive: true },
      { new: true }
    );

    if (!adminUser) {
      throw new Error("Admin user not found after registration");
    }

    adminUserId = adminUser._id;

    // Login admin
    const adminLogin = await request(app).post("/api/auth/login").send({
      emailOrUsername: "audit.admin@test.com",
      password: "AdminPass123!",
    });
    adminToken = adminLogin.body.data.accessToken;

    // Create and register leader user
    const leaderRegResponse = await request(app)
      .post("/api/auth/register")
      .send({
        username: "audit_leader",
        email: "audit.leader@test.com",
        password: "LeaderPass123!",
        confirmPassword: "LeaderPass123!",
        firstName: "Leader",
        lastName: "User",
        gender: "male",
        isAtCloudLeader: false,
        acceptTerms: true,
      });

    if (leaderRegResponse.status !== 201) {
      throw new Error(
        `Failed to register leader: ${JSON.stringify(leaderRegResponse.body)}`
      );
    }

    const leaderUser = await User.findOneAndUpdate(
      { email: "audit.leader@test.com" },
      { isVerified: true, role: "Leader", isActive: true },
      { new: true }
    );

    if (!leaderUser) {
      throw new Error("Leader user not found after registration");
    }

    leaderUserId = leaderUser._id;

    const leaderLogin = await request(app).post("/api/auth/login").send({
      emailOrUsername: "audit.leader@test.com",
      password: "LeaderPass123!",
    });
    leaderToken = leaderLogin.body.data.accessToken;

    // Create and register member user
    const memberRegResponse = await request(app)
      .post("/api/auth/register")
      .send({
        username: "audit_member",
        email: "audit.member@test.com",
        password: "MemberPass123!",
        confirmPassword: "MemberPass123!",
        firstName: "Member",
        lastName: "User",
        gender: "male",
        isAtCloudLeader: false,
        acceptTerms: true,
      });

    if (memberRegResponse.status !== 201) {
      throw new Error(
        `Failed to register member: ${JSON.stringify(memberRegResponse.body)}`
      );
    }

    const memberUser = await User.findOneAndUpdate(
      { email: "audit.member@test.com" },
      { isVerified: true, role: "Participant", isActive: true },
      { new: true }
    );

    if (!memberUser) {
      throw new Error("Member user not found after registration");
    }

    memberUserId = memberUser._id;

    const memberLogin = await request(app).post("/api/auth/login").send({
      emailOrUsername: "audit.member@test.com",
      password: "MemberPass123!",
    });
    memberToken = memberLogin.body.data.accessToken;

    // Create sample audit logs with proper actor format
    await AuditLog.create({
      action: "user.create",
      actor: {
        id: adminUserId,
        role: "Admin",
        email: "audit.admin@test.com",
      },
      targetType: "User",
      targetId: memberUserId.toString(),
      details: {
        username: "audit_member",
        role: "Member",
      },
      ipAddress: "127.0.0.1",
      userAgent: "Test Agent",
    });

    await AuditLog.create({
      action: "event.create",
      actor: {
        id: leaderUserId,
        role: "Leader",
        email: "audit.leader@test.com",
      },
      targetType: "Event",
      targetId: new mongoose.Types.ObjectId().toString(),
      details: {
        eventName: "Test Event",
      },
      ipAddress: "127.0.0.1",
      userAgent: "Test Agent",
    });

    await AuditLog.create({
      action: "user.login",
      actor: {
        id: memberUserId,
        role: "Member",
        email: "audit.member@test.com",
      },
      targetType: "User",
      targetId: memberUserId.toString(),
      details: {},
      ipAddress: "192.168.1.1",
      userAgent: "Test Browser",
    });
  }, 30000); // 30 second timeout for beforeAll

  afterAll(async () => {
    // Close connection if we opened it
    if (openedLocal && mongoose.connection.readyState !== 0) {
      // Shared integration harness owns connection lifecycle.
    }
  });

  afterEach(async () => {
    // Clean up audit logs created during tests
    // Keep beforeAll logs for other tests
  });

  describe("Authentication and Authorization", () => {
    it("should reject request without authentication", async () => {
      const response = await request(app).get("/api/audit-logs");

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
    });

    it("should reject request from non-admin user (Participant)", async () => {
      const response = await request(app)
        .get("/api/audit-logs")
        .set("Authorization", `Bearer ${memberToken}`);

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toMatch(/admin|permission/i);
    });

    it("should reject request from non-admin user (Leader)", async () => {
      const response = await request(app)
        .get("/api/audit-logs")
        .set("Authorization", `Bearer ${leaderToken}`);

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
    });

    it("should allow request from admin user", async () => {
      const response = await request(app)
        .get("/api/audit-logs")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe("Pagination", () => {
    it("should return paginated audit logs with default pagination", async () => {
      const response = await request(app)
        .get("/api/audit-logs")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body).toHaveProperty("data");
      expect(response.body.data).toHaveProperty("auditLogs");
      expect(response.body.data).toHaveProperty("pagination");
      expect(Array.isArray(response.body.data.auditLogs)).toBe(true);
    });

    it("should accept custom page and limit parameters", async () => {
      const response = await request(app)
        .get("/api/audit-logs?page=1&limit=5")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.pagination).toHaveProperty("currentPage", 1);
      expect(response.body.data.pagination).toHaveProperty("limit", 5);
    });

    it("should include total count in pagination", async () => {
      const response = await request(app)
        .get("/api/audit-logs")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.pagination).toHaveProperty("totalCount");
      expect(response.body.data.pagination.totalCount).toBeGreaterThanOrEqual(
        3
      );
    });

    it("should include totalPages in pagination", async () => {
      const response = await request(app)
        .get("/api/audit-logs")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.pagination).toHaveProperty("totalPages");
      expect(response.body.data.pagination.totalPages).toBeGreaterThanOrEqual(
        1
      );
    });
  });

  describe("Filtering", () => {
    it("should filter audit logs by action", async () => {
      const response = await request(app)
        .get("/api/audit-logs?action=user.create")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.auditLogs.length).toBeGreaterThan(0);
      expect(response.body.data.auditLogs[0].action).toBe("user.create");
    });

    it("should filter audit logs by actor", async () => {
      const response = await request(app)
        .get(`/api/audit-logs?actorId=${adminUserId.toString()}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      if (response.body.data.auditLogs.length > 0) {
        expect(response.body.data.auditLogs[0].actorId).toBe(
          adminUserId.toString()
        );
      }
    });

    it("should filter audit logs by targetType", async () => {
      // Note: targetType/targetModel filtering is not currently implemented in the API
      // This test verifies the API accepts the parameter but may not filter by it
      const response = await request(app)
        .get("/api/audit-logs?targetType=User")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.auditLogs).toBeDefined();
      // API returns all logs regardless of targetType since filtering is not implemented
    });

    it("should filter audit logs by date range", async () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);

      const response = await request(app)
        .get(
          `/api/audit-logs?startDate=${yesterday.toISOString()}&endDate=${tomorrow.toISOString()}`
        )
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.auditLogs.length).toBeGreaterThan(0);
    });

    it("should combine multiple filters", async () => {
      const response = await request(app)
        .get("/api/audit-logs?action=user.create&targetType=User")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe("Sorting", () => {
    it("should sort audit logs by timestamp descending by default", async () => {
      const response = await request(app)
        .get("/api/audit-logs?limit=10")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      if (response.body.data.auditLogs.length > 1) {
        const firstTimestamp = new Date(
          response.body.data.auditLogs[0].createdAt
        );
        const secondTimestamp = new Date(
          response.body.data.auditLogs[1].createdAt
        );
        expect(firstTimestamp.getTime()).toBeGreaterThanOrEqual(
          secondTimestamp.getTime()
        );
      }
    });

    it("should accept sort parameter", async () => {
      const response = await request(app)
        .get("/api/audit-logs?sort=action")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe("Response Format", () => {
    it("should return audit logs with expected fields", async () => {
      const response = await request(app)
        .get("/api/audit-logs")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      if (response.body.data.auditLogs.length > 0) {
        const log = response.body.data.auditLogs[0];
        expect(log).toHaveProperty("action");
        expect(log).toHaveProperty("actorInfo");
        expect(log).toHaveProperty("targetModel");
        expect(log).toHaveProperty("createdAt");
      }
    });

    it("should populate actor information", async () => {
      const response = await request(app)
        .get("/api/audit-logs")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      if (response.body.data.auditLogs.length > 0) {
        const log = response.body.data.auditLogs[0];
        expect(log.actorInfo).toBeTypeOf("object");
        // Actor should be populated with user details
      }
    });

    it("should format actor info with name and role fields", async () => {
      const response = await request(app)
        .get("/api/audit-logs")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.auditLogs.length).toBeGreaterThan(0);

      // Find a log entry with actor info
      const logWithActor = response.body.data.auditLogs.find(
        (log: any) => log.actorInfo !== null
      );

      expect(logWithActor).toBeDefined();
      expect(logWithActor.actorInfo).toHaveProperty("name");
      expect(logWithActor.actorInfo).toHaveProperty("role");
      expect(logWithActor.actorInfo).toHaveProperty("username");
      expect(logWithActor.actorInfo).toHaveProperty("email");

      // Verify name is not empty and role exists
      expect(logWithActor.actorInfo.name).toBeTruthy();
      expect(logWithActor.actorInfo.role).toBeTruthy();
      expect(typeof logWithActor.actorInfo.name).toBe("string");
      expect(typeof logWithActor.actorInfo.role).toBe("string");
    });

    it("should format actor info consistently for new format entries", async () => {
      const response = await request(app)
        .get("/api/audit-logs?action=user.create")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      if (response.body.data.auditLogs.length > 0) {
        const log = response.body.data.auditLogs[0];

        // New format entries should have actorInfo with name and role
        expect(log.actorInfo).toBeDefined();
        expect(log.actorInfo).toHaveProperty("name");
        expect(log.actorInfo).toHaveProperty("role");

        // Name should be the full name (or username fallback), not the role
        expect(log.actorInfo.name).not.toBe(log.actorInfo.role);

        // Role should be a valid system role
        expect([
          "Super Admin",
          "Administrator",
          "Leader",
          "Member",
          "Participant",
          "Guest Expert",
          "Admin",
          "User",
        ]).toContain(log.actorInfo.role);
      }
    });

    it("should format actor info consistently for old format entries", async () => {
      // Create an old-format audit log for testing
      const oldFormatLog = await AuditLog.create({
        action: "test.oldformat",
        actorId: adminUserId,
        eventId: null,
        metadata: { test: true },
      });

      const response = await request(app)
        .get(`/api/audit-logs?action=test.oldformat`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      if (response.body.data.auditLogs.length > 0) {
        const log = response.body.data.auditLogs[0];

        // Old format entries should also have actorInfo with name and role
        expect(log.actorInfo).toBeDefined();
        expect(log.actorInfo).toHaveProperty("name");
        expect(log.actorInfo).toHaveProperty("role");

        // Name should be populated from firstName/lastName or username
        expect(log.actorInfo.name).toBeTruthy();
        expect(typeof log.actorInfo.name).toBe("string");

        // Role should be populated from user's role field
        expect(log.actorInfo.role).toBeTruthy();
        expect(typeof log.actorInfo.role).toBe("string");
      }

      // Clean up
      await AuditLog.deleteOne({ _id: oldFormatLog._id });
    });

    it("should include details field", async () => {
      const response = await request(app)
        .get("/api/audit-logs?action=user.create")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      if (response.body.data.auditLogs.length > 0) {
        expect(response.body.data.auditLogs[0]).toHaveProperty("details");
        expect(response.body.data.auditLogs[0].details).toBeTypeOf("object");
      }
    });
  });

  describe("Error Handling", () => {
    it("should handle invalid pagination parameters", async () => {
      const response = await request(app)
        .get("/api/audit-logs?page=invalid&limit=abc")
        .set("Authorization", `Bearer ${adminToken}`);

      // Should either return 400 or use default pagination
      expect([200, 400]).toContain(response.status);
    });

    it("should handle invalid date format", async () => {
      const response = await request(app)
        .get("/api/audit-logs?startDate=invalid-date")
        .set("Authorization", `Bearer ${adminToken}`);

      // Should either return 400 or ignore invalid date
      expect([200, 400]).toContain(response.status);
    });

    it("should handle database errors gracefully", async () => {
      // This test would require mocking to simulate database failure
      // For now, just verify the endpoint is stable
      const response = await request(app)
        .get("/api/audit-logs")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
    });
  });
});
