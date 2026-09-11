import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import Registration from "../../../src/models/Registration";
import GuestRegistration from "../../../src/models/GuestRegistration";

/**
 * Concurrency tests for guest flows
 * - Parallel guest signups should respect role capacity
 * - Parallel moves to a target role should not overflow capacity
 */
describe("Guest concurrency safety", () => {
  const admin = {
    email: "admin@example.com",
    password: "Password1",
    username: "admin_user",
  };
  let adminToken: string;

  beforeEach(async () => {
    await Promise.all([
      GuestRegistration.deleteMany({}),
      Registration.deleteMany({}),
      Event.deleteMany({}),
      User.deleteMany({}),
    ]);
  });

  afterEach(async () => {
    await Promise.all([
      GuestRegistration.deleteMany({}),
      Registration.deleteMany({}),
      Event.deleteMany({}),
      User.deleteMany({}),
    ]);
  });

  async function ensureAdminAndLogin() {
    // Register admin
    const adminData = {
      ...TEST_REGISTRATION_PROFILE,
      username: admin.username,
      email: admin.email,
      password: admin.password,
      confirmPassword: admin.password,
      firstName: "Admin",
      lastName: "User",
      role: "Administrator",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
    };
    await request(app).post("/api/auth/register").send(adminData);
    await User.findOneAndUpdate(
      { email: admin.email },
      { isVerified: true, role: "Administrator" }
    );
    const res = await request(app).post("/api/auth/login").send({
      emailOrUsername: admin.email,
      password: admin.password,
    });
    adminToken = res.body?.data?.accessToken;
    return adminToken;
  }

  async function createEvent(
    title: string,
    roleNameA = "Group A Participants",
    roleNameB = "Group B Participants",
    roleAMax = 1,
    roleBMax = 1
  ) {
    // Always (re)create and login admin to avoid stale tokens after DB resets
    const token = await ensureAdminAndLogin();
    const date = new Date();
    date.setDate(date.getDate() + 1);

    const payload = {
      title,
      description: `${title} description`,
      date: date.toISOString().slice(0, 10),
      time: "10:00",
      endTime: "11:00",
      location: "Test Hall",
      type: "Effective Communication Workshop",
      format: "In-person",
      purpose: "Testing concurrency of guest flows",
      agenda:
        "A detailed agenda for testing concurrent behavior that satisfies validators.",
      organizer: "Test Organizer",
      roles: [
        {
          name: roleNameA,
          description: `${roleNameA} role for testing`,
          maxParticipants: roleAMax,
        },
        {
          name: roleNameB,
          description: `${roleNameB} role for testing`,
          maxParticipants: roleBMax,
        },
      ],
    };

    const res = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${token}`)
      .send(payload);

    expect(res.status).toBe(201);
    const event = res.body.data.event;
    const roleA = event.roles.find((r: any) => r.name === roleNameA);
    const roleB = event.roles.find((r: any) => r.name === roleNameB);
    // Note: Event's toJSON transform removes _id and exposes id
    return { eventId: event.id, roleAId: roleA.id, roleBId: roleB.id };
  }

  it("allows only one success when N concurrent signups race for a single slot", async () => {
    const { eventId, roleAId } = await createEvent("Concurrent Signup Event");

    const attempts = 6;
    const reqs = Array.from({ length: attempts }, (_, i) =>
      request(app)
        .post(`/api/events/${eventId}/guest-signup`)
        .send({
          roleId: roleAId,
          // Use letters-only names to satisfy validator
          fullName: `Guest ${String.fromCharCode(65 + i)}`,
          gender: "male",
          email: `guest_${i}@example.com`,
          phone: "1234567890",
          notes: "",
        })
    );

    const results = await Promise.all(reqs);
    const ok = results.filter((r) => r.status === 201).length;
    const full = results.filter(
      (r) => r.status === 400 && /full capacity/i.test(r.text)
    ).length;
    const dup = results.filter(
      (r) => r.status === 400 && /already registered/i.test(r.text)
    ).length;

    expect(ok).toBe(1);
    expect(full + dup).toBe(attempts - 1);
  });

  it("serializes guest moves so target role does not overflow", async () => {
    const { eventId, roleAId, roleBId } = await createEvent(
      "Concurrent Move Event",
      "Group A Participants",
      "Group B Participants",
      2, // allow two guests in role A for seeding
      1 // keep role B capacity at 1 to test move serialization
    );

    // Seed two guests into role A
    const g1 = await request(app)
      .post(`/api/events/${eventId}/guest-signup`)
      .send({
        roleId: roleAId,
        fullName: "Alpha",
        gender: "male",
        email: "alpha@example.com",
        phone: "1234567890",
        notes: "",
      });
    const g2 = await request(app)
      .post(`/api/events/${eventId}/guest-signup`)
      .send({
        roleId: roleAId,
        fullName: "Beta",
        gender: "male",
        email: "beta@example.com",
        phone: "1234567890",
        notes: "",
      });
    expect(g1.status).toBe(201);
    expect(g2.status).toBe(201);

    const token = await ensureAdminAndLogin();

    // Attempt to move both guests into role B (capacity 1) concurrently
    const move = (guestRegistrationId: string) =>
      request(app)
        .post(`/api/events/${eventId}/manage/move-guest`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          guestRegistrationId,
          fromRoleId: roleAId,
          toRoleId: roleBId,
        });

    const results = await Promise.all([
      move(g1.body.data.registrationId),
      move(g2.body.data.registrationId),
    ]);

    const ok = results.filter((r) => r.status === 200).length;
    const full = results.filter(
      (r) => r.status === 400 && /full capacity/i.test(r.text)
    ).length;

    expect(ok).toBe(1);
    expect(full).toBe(1);
  });

  it("serializes concurrent signup vs admin move to the same target role", async () => {
    const { eventId, roleAId, roleBId } = await createEvent(
      "Concurrent Move vs Signup Event",
      "Group A Participants",
      "Group B Participants",
      1, // role A capacity
      1 // role B capacity
    );

    // Seed one guest into role A
    const seed = await request(app)
      .post(`/api/events/${eventId}/guest-signup`)
      .send({
        roleId: roleAId,
        fullName: "Seeder One",
        gender: "male",
        email: "seed@example.com",
        phone: "1234567890",
        notes: "",
      });
    expect(seed.status).toBe(201);

    const token = await ensureAdminAndLogin();

    // Concurrently attempt: (1) admin moves seeded guest A->B, (2) new guest signs up directly into B
    const moveReq = request(app)
      .post(`/api/events/${eventId}/manage/move-guest`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        guestRegistrationId: seed.body.data.registrationId,
        fromRoleId: roleAId,
        toRoleId: roleBId,
      });

    const signupReq = request(app)
      .post(`/api/events/${eventId}/guest-signup`)
      .send({
        roleId: roleBId,
        fullName: "Charlie Delta",
        gender: "male",
        email: "toB@example.com",
        phone: "1234567890",
        notes: "",
      });

    const results = await Promise.all([moveReq, signupReq]);
    const ok = results.filter(
      (r) => r.status === 200 || r.status === 201
    ).length;
    const full = results.filter(
      (r) => r.status === 400 && /full capacity/i.test(r.text)
    ).length;

    expect(ok).toBe(1);
    expect(full).toBe(1);
  });
});
