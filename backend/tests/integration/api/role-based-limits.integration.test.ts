import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import { buildValidEventPayload } from "../../test-utils/eventTestHelpers";
import mongoose from "mongoose";
import { ensureIntegrationDB } from "../setup/connect";

// Integration tests for role-based registration limits (NEW POLICY 2025-10-10)
// - Super Admin & Administrator: Unlimited
// - Leader: 5 roles max
// - Guest Expert: 4 roles max
// - Participant: 3 roles max
// - Unauthenticated Guest (email): 1 role max

describe("Role-based registration limits per event", () => {
  let eventId: string;
  const roleIds: string[] = [];

  beforeAll(async () => {
    await ensureIntegrationDB();
    await User.deleteMany({});
    await Event.deleteMany({});

    await request(app)
      .post("/api/auth/register")
      .send({
        ...TEST_REGISTRATION_PROFILE,
        username: "adminlimits",
        email: "admin_limits@example.com",
        password: "Password123!",
        confirmPassword: "Password123!",
        firstName: "Admin",
        lastName: "Limits",
        role: "Administrator",
        gender: "male",
        isAtCloudLeader: false,
        acceptTerms: true,
      })
      .expect(201);

    // Force elevate to Administrator
    await User.updateOne(
      { email: "admin_limits@example.com" },
      { $set: { isVerified: true, role: "Administrator" } },
    );

    const adminLogin = await request(app)
      .post("/api/auth/login")
      .send({
        emailOrUsername: "admin_limits@example.com",
        password: "Password123!",
      })
      .expect(200);
    const adminToken =
      adminLogin.body?.data?.accessToken ||
      adminLogin.body?.accessToken ||
      adminLogin.body?.token;

    const roles = [];
    for (let i = 1; i <= 10; i++) {
      roles.push({
        name: `Role ${i}`,
        description: `Role ${i} description`,
        maxParticipants: 10,
      });
    }

    const payload = buildValidEventPayload({
      title: "Role Limits Test Event",
      roles,
      overrides: { suppressNotifications: true },
    });

    const createRes = await request(app)
      .post(`/api/events`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send(payload)
      .expect(201);

    eventId = createRes.body.data.event.id;
    createRes.body.data.event.roles.forEach((r: any) => roleIds.push(r.id));
  }, 30000);

  afterAll(async () => {
    await User.deleteMany({});
    await Event.deleteMany({});
    // Shared integration harness owns connection lifecycle.
  });

  describe("Participant (3-role limit)", () => {
    let token: string;

    beforeAll(async () => {
      await request(app)
        .post("/api/auth/register")
        .send({
          ...TEST_REGISTRATION_PROFILE,
          username: "participantlimit",
          email: "participant_limit@example.com",
          password: "Password123!",
          confirmPassword: "Password123!",
          firstName: "Participant",
          lastName: "Limit",
          role: "Participant",
          gender: "female",
          isAtCloudLeader: false,
          acceptTerms: true,
        })
        .expect(201);

      await User.updateOne(
        { email: "participant_limit@example.com" },
        { $set: { isVerified: true } },
      );

      const loginRes = await request(app)
        .post("/api/auth/login")
        .send({
          emailOrUsername: "participant_limit@example.com",
          password: "Password123!",
        })
        .expect(200);

      token =
        loginRes.body?.data?.accessToken ||
        loginRes.body?.accessToken ||
        loginRes.body?.token;
    });

    it("allows 3 role registrations then blocks the 4th", async () => {
      // Register for roles 1-3 (should succeed)
      for (let i = 0; i < 3; i++) {
        const res = await request(app)
          .post(`/api/events/${eventId}/register`)
          .set("Authorization", `Bearer ${token}`)
          .send({ roleId: roleIds[i] })
          .expect(200);
        expect(res.body.success).toBe(true);
      }

      // 4th attempt should be rejected
      const res4th = await request(app)
        .post(`/api/events/${eventId}/register`)
        .set("Authorization", `Bearer ${token}`)
        .send({ roleId: roleIds[3] })
        .expect(400);

      expect(res4th.body.message).toMatch(/Role limit reached/i);
      expect(res4th.body.message).toMatch(/3 role/i);
      expect(res4th.body.message).toMatch(/Participant/i);
    });
  });

  describe("Guest Expert (4-role limit)", () => {
    let token: string;

    beforeAll(async () => {
      await request(app)
        .post("/api/auth/register")
        .send({
          ...TEST_REGISTRATION_PROFILE,
          username: "guestexpertlimit",
          email: "guestexpert_limit@example.com",
          password: "Password123!",
          confirmPassword: "Password123!",
          firstName: "GuestExpert",
          lastName: "Limit",
          role: "Guest Expert",
          gender: "male",
          isAtCloudLeader: false,
          acceptTerms: true,
        })
        .expect(201);

      await User.updateOne(
        { email: "guestexpert_limit@example.com" },
        { $set: { isVerified: true, role: "Guest Expert" } },
      );

      const loginRes = await request(app)
        .post("/api/auth/login")
        .send({
          emailOrUsername: "guestexpert_limit@example.com",
          password: "Password123!",
        })
        .expect(200);

      token =
        loginRes.body?.data?.accessToken ||
        loginRes.body?.accessToken ||
        loginRes.body?.token;
    });

    it("allows 4 role registrations then blocks the 5th", async () => {
      // Register for roles 1-4 (should succeed)
      for (let i = 0; i < 4; i++) {
        const res = await request(app)
          .post(`/api/events/${eventId}/register`)
          .set("Authorization", `Bearer ${token}`)
          .send({ roleId: roleIds[i] })
          .expect(200);
        expect(res.body.success).toBe(true);
      }

      // 5th attempt should be rejected
      const res5th = await request(app)
        .post(`/api/events/${eventId}/register`)
        .set("Authorization", `Bearer ${token}`)
        .send({ roleId: roleIds[4] })
        .expect(400);

      expect(res5th.body.message).toMatch(/Role limit reached/i);
      expect(res5th.body.message).toMatch(/4 role/i);
      expect(res5th.body.message).toMatch(/Guest Expert/i);
    });
  });

  describe("Leader (5-role limit)", () => {
    let token: string;

    beforeAll(async () => {
      await request(app)
        .post("/api/auth/register")
        .send({
          ...TEST_REGISTRATION_PROFILE,
          username: "leaderlimit",
          email: "leader_limit@example.com",
          password: "Password123!",
          confirmPassword: "Password123!",
          firstName: "Leader",
          lastName: "Limit",
          role: "Leader",
          gender: "female",
          isAtCloudLeader: false,
          acceptTerms: true,
        })
        .expect(201);

      await User.updateOne(
        { email: "leader_limit@example.com" },
        { $set: { isVerified: true, role: "Leader" } },
      );

      const loginRes = await request(app)
        .post("/api/auth/login")
        .send({
          emailOrUsername: "leader_limit@example.com",
          password: "Password123!",
        })
        .expect(200);

      token =
        loginRes.body?.data?.accessToken ||
        loginRes.body?.accessToken ||
        loginRes.body?.token;
    });

    it("allows 5 role registrations then blocks the 6th", async () => {
      // Register for roles 1-5 (should succeed)
      for (let i = 0; i < 5; i++) {
        const res = await request(app)
          .post(`/api/events/${eventId}/register`)
          .set("Authorization", `Bearer ${token}`)
          .send({ roleId: roleIds[i] })
          .expect(200);
        expect(res.body.success).toBe(true);
      }

      // 6th attempt should be rejected
      const res6th = await request(app)
        .post(`/api/events/${eventId}/register`)
        .set("Authorization", `Bearer ${token}`)
        .send({ roleId: roleIds[5] })
        .expect(400);

      expect(res6th.body.message).toMatch(/Role limit reached/i);
      expect(res6th.body.message).toMatch(/5 role/i);
      expect(res6th.body.message).toMatch(/Leader/i);
    });
  });

  describe("Super Admin (unlimited roles)", () => {
    let token: string;

    beforeAll(async () => {
      await request(app)
        .post("/api/auth/register")
        .send({
          ...TEST_REGISTRATION_PROFILE,
          username: "superadminlimit",
          email: "superadmin_limit@example.com",
          password: "Password123!",
          confirmPassword: "Password123!",
          firstName: "SuperAdmin",
          lastName: "Limit",
          role: "Super Admin",
          gender: "male",
          isAtCloudLeader: false,
          acceptTerms: true,
        })
        .expect(201);

      await User.updateOne(
        { email: "superadmin_limit@example.com" },
        { $set: { isVerified: true, role: "Super Admin" } },
      );

      const loginRes = await request(app)
        .post("/api/auth/login")
        .send({
          emailOrUsername: "superadmin_limit@example.com",
          password: "Password123!",
        })
        .expect(200);

      token =
        loginRes.body?.data?.accessToken ||
        loginRes.body?.accessToken ||
        loginRes.body?.token;
    });

    it("allows unlimited role registrations (tests 10 roles)", async () => {
      // Register for all 10 roles (should all succeed)
      for (let i = 0; i < 10; i++) {
        const res = await request(app)
          .post(`/api/events/${eventId}/register`)
          .set("Authorization", `Bearer ${token}`)
          .send({ roleId: roleIds[i] })
          .expect(200);
        expect(res.body.success).toBe(true);
      }
    });
  });

  describe("Administrator (unlimited roles)", () => {
    let token: string;

    beforeAll(async () => {
      await request(app)
        .post("/api/auth/register")
        .send({
          ...TEST_REGISTRATION_PROFILE,
          username: "administratorlimit",
          email: "administrator_limit@example.com",
          password: "Password123!",
          confirmPassword: "Password123!",
          firstName: "Administrator",
          lastName: "Limit",
          role: "Administrator",
          gender: "female",
          isAtCloudLeader: false,
          acceptTerms: true,
        })
        .expect(201);

      await User.updateOne(
        { email: "administrator_limit@example.com" },
        { $set: { isVerified: true, role: "Administrator" } },
      );

      const loginRes = await request(app)
        .post("/api/auth/login")
        .send({
          emailOrUsername: "administrator_limit@example.com",
          password: "Password123!",
        })
        .expect(200);

      token =
        loginRes.body?.data?.accessToken ||
        loginRes.body?.accessToken ||
        loginRes.body?.token;
    });

    it("allows unlimited role registrations (tests 10 roles)", async () => {
      // Register for all 10 roles (should all succeed)
      for (let i = 0; i < 10; i++) {
        const res = await request(app)
          .post(`/api/events/${eventId}/register`)
          .set("Authorization", `Bearer ${token}`)
          .send({ roleId: roleIds[i] })
          .expect(200);
        expect(res.body.success).toBe(true);
      }
    });
  });
});
