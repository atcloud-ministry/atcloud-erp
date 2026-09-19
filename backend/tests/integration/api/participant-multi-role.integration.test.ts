import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import { buildValidEventPayload } from "../../test-utils/eventTestHelpers";
import mongoose from "mongoose";
import { ensureIntegrationDB } from "../setup/connect";

// Integration test: verifies updated policy allowing a single participant to register
// for multiple distinct roles within the same event (no per-user role cap).

describe("Participant multi-role capability (policy update)", () => {
  let participantToken: string;
  let eventId: string;
  let roleIds: { roleA: string; roleB: string };

  beforeAll(async () => {
    await ensureIntegrationDB();
    await User.deleteMany({});
    await Event.deleteMany({});

    // Create participant user
    await request(app)
      .post("/api/auth/register")
      .send({
        ...TEST_REGISTRATION_PROFILE,
        username: "multirole_part",
        email: "multi_role_participant@example.com",
        password: "Password123!",
        confirmPassword: "Password123!",
        firstName: "Multi",
        lastName: "Role",
        role: "Participant",
        gender: "male",
        isAtCloudLeader: false,
        acceptTerms: true,
        registrationNoticeVersion: "registration-privacy-v1",
      })
      .expect(201);

    // Force-verify the participant (bypass email requirement in test)
    await User.updateOne(
      { email: "multi_role_participant@example.com" },
      { $set: { isVerified: true } }
    );

    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({
        emailOrUsername: "multi_role_participant@example.com",
        password: "Password123!",
      })
      .expect(200);
    participantToken =
      loginRes.body?.data?.accessToken ||
      loginRes.body?.accessToken ||
      loginRes.body?.token;

    // Create an admin to create the event (if participant creation restricted)
    await request(app)
      .post("/api/auth/register")
      .send({
        ...TEST_REGISTRATION_PROFILE,
        username: "admincreator99",
        email: "admin_creator99@example.com",
        password: "Password123!",
        confirmPassword: "Password123!",
        firstName: "Admin",
        lastName: "Creator",
        role: "Administrator",
        gender: "male",
        isAtCloudLeader: false,
        acceptTerms: true,
        registrationNoticeVersion: "registration-privacy-v1",
      })
      .expect(201);

    await User.updateOne(
      { email: "admin_creator99@example.com" },
      { $set: { isVerified: true } }
    );

    // Defensive: ensure role is Administrator (some environments might lowercase or default differently)
    await User.updateOne(
      { email: "admin_creator99@example.com" },
      { $set: { role: "Administrator" } }
    );

    // Re-fetch and log roles for debugging if needed

    const adminLogin = await request(app)
      .post("/api/auth/login")
      .send({
        emailOrUsername: "admin_creator99@example.com",
        password: "Password123!",
      })
      .expect(200);
    const adminToken =
      adminLogin.body?.data?.accessToken ||
      adminLogin.body?.accessToken ||
      adminLogin.body?.token;

    const payload = buildValidEventPayload({
      title: "Multi-Role Event",
      roles: [
        {
          name: "Common Participant (Zoom)",
          description: "General participation slot",
          maxParticipants: 5,
        },
        {
          name: "Prepared Speaker (Zoom)",
          description: "Speaker slot",
          maxParticipants: 3,
        },
      ],
      overrides: { suppressNotifications: true },
    });

    const createRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(payload)
      .expect(201);

    eventId = createRes.body.data.event.id;
    roleIds = createRes.body.data.event.roles.reduce(
      (acc: any, r: any) => {
        if (r.name.includes("Common Participant")) acc.roleA = r.id;
        if (r.name.includes("Prepared Speaker")) acc.roleB = r.id;
        return acc;
      },
      { roleA: "", roleB: "" } as { roleA: string; roleB: string }
    );
  });

  afterAll(async () => {
    await User.deleteMany({});
    await Event.deleteMany({});
    // Shared integration harness owns connection lifecycle.
  });

  it("allows a Participant to register for two distinct roles", async () => {
    // First role
    const res1 = await request(app)
      .post(`/api/events/${eventId}/register`)
      .set("Authorization", `Bearer ${participantToken}`)
      .send({ roleId: roleIds.roleA })
      .expect(200);
    expect(res1.body.success).toBe(true);

    // Second role
    const res2 = await request(app)
      .post(`/api/events/${eventId}/register`)
      .set("Authorization", `Bearer ${participantToken}`)
      .send({ roleId: roleIds.roleB })
      .expect(200);
    expect(res2.body.success).toBe(true);

    // Fetch event to confirm two distinct registrations present for same user
    const detail = await request(app)
      .get(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${participantToken}`)
      .expect(200);

    const roles = detail.body.data.event.roles;
    const participantRolesWithUser = roles.filter((r: any) =>
      (r.registrations || []).some((reg: any) => reg.userId)
    );
    expect(participantRolesWithUser.length).toBeGreaterThanOrEqual(2);
  });
});
