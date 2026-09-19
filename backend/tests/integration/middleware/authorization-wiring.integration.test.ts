import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";
import AuditLog from "../../../src/models/AuditLog";

describe("Authorization wiring integration", () => {
  let participantToken: string;
  let adminToken: string;
  let superAdminToken: string;
  let participantId: string;

  beforeEach(async () => {
    await Promise.all([User.deleteMany({}), AuditLog.deleteMany({})]);

    // Create participant
    const userData = {
      ...TEST_REGISTRATION_PROFILE,
      username: "aw_participant",
      email: "aw_participant@example.com",
      password: "TestPass123!",
      confirmPassword: "TestPass123!",
      firstName: "Parti",
      lastName: "User",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
    };
    const regRes = await request(app)
      .post("/api/auth/register")
      .send(userData)
      .expect(201);
    participantId = regRes.body.data.user.id;
    await User.findOneAndUpdate(
      { email: userData.email },
      { isVerified: true }
    );
    const loginP = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: userData.email, password: userData.password })
      .expect(200);
    participantToken = loginP.body.data.accessToken;

    // Create admin
    const adminData = {
      ...TEST_REGISTRATION_PROFILE,
      username: "aw_admin",
      email: "aw_admin@example.com",
      password: "AdminPass123!",
      confirmPassword: "AdminPass123!",
      firstName: "Admin",
      lastName: "User",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
    };
    await request(app).post("/api/auth/register").send(adminData).expect(201);
    await User.findOneAndUpdate(
      { email: adminData.email },
      { isVerified: true, role: "Administrator" }
    );
    const loginA = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: adminData.email, password: adminData.password })
      .expect(200);
    adminToken = loginA.body.data.accessToken;

    // Create super admin
    const saData = {
      ...TEST_REGISTRATION_PROFILE,
      username: "aw_super",
      email: "aw_super@example.com",
      password: "SuperPass123!",
      confirmPassword: "SuperPass123!",
      firstName: "Super",
      lastName: "Admin",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
    };
    await request(app).post("/api/auth/register").send(saData).expect(201);
    await User.findOneAndUpdate(
      { email: saData.email },
      { isVerified: true, role: "Super Admin" }
    );
    const loginSA = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: saData.email, password: saData.password })
      .expect(200);
    superAdminToken = loginSA.body.data.accessToken;
  });

  afterEach(async () => {
    await Promise.all([User.deleteMany({}), AuditLog.deleteMany({})]);
  });

  describe("/api/users/stats (permission-protected)", () => {
    it("returns 401 without token", async () => {
      await request(app).get("/api/users/stats").expect(401);
    });

    it("returns 403 for participant token", async () => {
      const correlationId = "auth-wiring-denial-001";
      const res = await request(app)
        .get("/api/users/stats")
        .set("Authorization", `Bearer ${participantToken}`)
        .set("x-correlation-id", correlationId)
        .expect(403);
      expect(res.body).toMatchObject({ success: false });

      await vi.waitFor(
        async () => {
          expect(
            await AuditLog.exists({
              version: 2,
              action: "authorization.denied",
              correlationId,
            }),
          ).toBeTruthy();
        },
        { timeout: 2_000, interval: 20 },
      );

      const denial = await AuditLog.findOne({
        version: 2,
        action: "authorization.denied",
        correlationId,
      }).lean();
      expect(denial).toMatchObject({
        actorType: "user",
        actorKey: participantId,
        source: "http",
        outcome: "denied",
        reasonCode: "insufficient_permission",
        details: {
          authorizationAction: "platform.has_permission",
        },
      });
      expect(denial?.actor?.email).toBeUndefined();
      expect(JSON.stringify(denial)).not.toContain("aw_participant@example.com");
    });

    it("returns 200 for admin token", async () => {
      const res = await request(app)
        .get("/api/users/stats")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body).toMatchObject({ success: true });
    });
  });

  describe("/api/users/:id/role (requireAdmin)", () => {
    it("returns 403 for participant token", async () => {
      const res = await request(app)
        .put(`/api/users/${participantId}/role`)
        .set("Authorization", `Bearer ${participantToken}`)
        .send({ role: "Leader" })
        .expect(403);
      expect(res.body).toMatchObject({ success: false });
    });

    it("returns 200 for admin token", async () => {
      const res = await request(app)
        .put(`/api/users/${participantId}/role`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ role: "Leader" })
        .expect(200);
      expect(res.body).toMatchObject({ success: true });
    });
  });

  describe("/api/users/:id/deletion-impact (requireSuperAdmin)", () => {
    it("returns 403 for admin token", async () => {
      const targetId = new mongoose.Types.ObjectId().toString();
      const res = await request(app)
        .get(`/api/users/${targetId}/deletion-impact`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(403);
      expect(res.body).toMatchObject({ success: false });
    });

    it("returns 200 for super admin token", async () => {
      // Use an existing user id so the service can compute deletion impact without 500
      const targetId = participantId;
      const res = await request(app)
        .get(`/api/users/${targetId}/deletion-impact`)
        .set("Authorization", `Bearer ${superAdminToken}`)
        .expect(200);
      expect(res.body).toMatchObject({ success: true });
    });
  });

  describe("/api/system/recovery (MANAGE_SYSTEM_SETTINGS)", () => {
    it("returns 401 without a token", async () => {
      const res = await request(app).get("/api/system/recovery").expect(401);
      expect(res.headers["cache-control"]).toBe("no-store");
    });

    it.each([
      { role: "Participant", token: () => participantToken },
      { role: "Administrator", token: () => adminToken },
    ])("returns 403 for $role", async ({ token }) => {
      const res = await request(app)
        .get("/api/system/recovery")
        .set("Authorization", `Bearer ${token()}`)
        .expect(403);
      expect(res.headers["cache-control"]).toBe("no-store");
    });

    it("returns 200 for Super Admin", async () => {
      const res = await request(app)
        .get("/api/system/recovery")
        .set("Authorization", `Bearer ${superAdminToken}`)
        .expect(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).toMatchObject({
        success: true,
        data: { operation: "notification_outbox_reconcile" },
      });
    });
  });

  describe("/api/system/feature-controls (MANAGE_SYSTEM_SETTINGS)", () => {
    it("returns 401 without a token", async () => {
      const res = await request(app)
        .get("/api/system/feature-controls")
        .expect(401);
      expect(res.headers["cache-control"]).toBe("no-store");
    });

    it.each([
      { role: "Participant", token: () => participantToken },
      { role: "Administrator", token: () => adminToken },
    ])("returns 403 for $role", async ({ token }) => {
      const res = await request(app)
        .get("/api/system/feature-controls")
        .set("Authorization", `Bearer ${token()}`)
        .expect(403);
      expect(res.headers["cache-control"]).toBe("no-store");
    });

    it("returns 200 for Super Admin", async () => {
      const res = await request(app)
        .get("/api/system/feature-controls")
        .set("Authorization", `Bearer ${superAdminToken}`)
        .expect(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).toMatchObject({
        success: true,
        data: { version: 1, alumniNetwork: { mode: "off" } },
      });
    });
  });
});
