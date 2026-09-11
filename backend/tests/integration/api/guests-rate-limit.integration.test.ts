import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import Registration from "../../../src/models/Registration";
import GuestRegistration from "../../../src/models/GuestRegistration";
import {
  __resetGuestRateLimitStore,
  __setGuestRateLimitNowProvider,
} from "../../../src/middleware/guestValidation";

describe("Guests API Rate Limiting", () => {
  let adminToken: string;
  let eventId: string;
  let roleId: string;

  beforeEach(async () => {
    __resetGuestRateLimitStore();
    await Promise.all([
      User.deleteMany({}),
      Event.deleteMany({}),
      Registration.deleteMany({}),
      GuestRegistration.deleteMany({}),
    ]);

    const adminData = {
      ...TEST_REGISTRATION_PROFILE,
      username: "admin",
      email: "admin@example.com",
      password: "AdminPass123!",
      confirmPassword: "AdminPass123!",
      firstName: "Admin",
      lastName: "User",
      role: "Administrator",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
    };

    await request(app).post("/api/auth/register").send(adminData);
    await User.findOneAndUpdate(
      { email: adminData.email },
      { isVerified: true, role: "Administrator" }
    );
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: adminData.email, password: adminData.password });
    adminToken = loginRes.body.data.accessToken;

    // Create a valid event with a role (capacity > attempts so capacity doesn't interfere)
    const roleName = "Zoom Host";
    const eventRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Guest RL Test Event",
        description: "Event for rate limit tests",
        date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        time: "10:00",
        endTime: "12:00",
        location: "Test Location",
        type: "Effective Communication Workshop",
        format: "In-person",
        purpose: "Rate limit testing purpose to satisfy validation.",
        agenda:
          "Agenda: Step 1, Step 2, Step 3. Validate rate limiting end-to-end.",
        organizer: "Tester",
        maxParticipants: 100,
        category: "general",
        roles: [
          {
            name: roleName,
            maxParticipants: 3,
            description: "Role for RL",
          },
        ],
      })
      .expect(201);

    const createdEvent = eventRes.body.data.event;
    eventId = createdEvent.id || createdEvent._id;
    roleId = (createdEvent.roles || []).find(
      (r: any) => r.name === roleName
    )?.id;
    expect(roleId).toBeTruthy();
  });

  afterEach(async () => {
    // Restore real timers and default now provider in case a test changed them
    try {
      vi.useRealTimers();
    } catch {}
    __setGuestRateLimitNowProvider(null);
    __resetGuestRateLimitStore();
    await Promise.all([
      GuestRegistration.deleteMany({}),
      Registration.deleteMany({}),
      Event.deleteMany({}),
      User.deleteMany({}),
    ]);
  });

  const makeGuestPayload = (overrides: Partial<Record<string, any>> = {}) => ({
    roleId,
    fullName: "John Doe",
    gender: "male",
    email: "rl.doe@example.com",
    phone: "+1 555 000 1111",
    notes: "RL",
    ...overrides,
  });

  it("checks capacity is enforced before rate-limit (returns 400 when full, not 429)", async () => {
    // Warm up rate limit for a specific ip+email on a different event
    const warmRoleName = "RL Warmup";
    const warmRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Warmup Event",
        description: "Warmup for rate limit attempts",
        date: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        time: "09:00",
        endTime: "11:00",
        location: "Test Location",
        type: "Effective Communication Workshop",
        format: "In-person",
        purpose: "Warm attempts",
        agenda: "Warm RL",
        organizer: "Tester",
        maxParticipants: 100,
        category: "general",
        roles: [
          { name: warmRoleName, maxParticipants: 50, description: "warm" },
        ],
      });
    // If warmup event failed validation (rare in CI), skip warm attempts; the core assertion below still holds
    let warmRoleId: string | undefined;
    const ip = "12.34.56.78";
    const rlEmail = "rl.precedence@example.com";
    if (warmRes.status === 201) {
      const warmEvent = warmRes.body.data.event;
      const warmEventId = warmEvent.id || warmEvent._id;
      warmRoleId = (warmEvent.roles || []).find(
        (r: any) => r.name === warmRoleName
      )?.id;
      expect(warmRoleId).toBeTruthy();

      const warmPath = `/api/events/${warmEventId}/guest-signup`;
      for (let i = 0; i < 5; i++) {
        const res = await request(app)
          .post(warmPath)
          .set("X-Forwarded-For", ip)
          .send({
            roleId: warmRoleId,
            fullName: `Warm ${i + 1}`,
            gender: "male",
            email: rlEmail,
            phone: "+1 555 100 2000",
          });
        expect([201, 400]).toContain(res.status);
      }
    }

    // Use the already-created event (role has maxParticipants=3) and fill it to capacity
    const capEventId = eventId;
    const capRoleId = roleId;
    const capPath = `/api/events/${capEventId}/guest-signup`;

    // Fill capacity with different emails
    const fillers = [
      { fullName: "First Fills", email: "fills1@example.com" },
      { fullName: "Second Fills", email: "fills2@example.com" },
      { fullName: "Third Fills", email: "fills3@example.com" },
    ];
    for (const f of fillers) {
      await request(app)
        .post(capPath)
        .set("X-Forwarded-For", ip)
        .send({
          roleId: capRoleId,
          fullName: f.fullName,
          gender: "male",
          email: f.email,
          phone: "+1 555 100 1000",
        })
        .expect([201, 400]);
    }

    // Now attempt with the rate-limited email; expect 400 capacity, not 429
    const resAfterCapacity = await request(app)
      .post(capPath)
      .set("X-Forwarded-For", ip)
      .send({
        roleId: capRoleId,
        fullName: "Should get capacity not RL",
        gender: "male",
        email: rlEmail,
        phone: "+1 555 100 2001",
      });

    expect(resAfterCapacity.status).toBe(400);
    const msg = String(resAfterCapacity.body?.message || "").toLowerCase();
    expect(msg).toContain("capacity");
  });

  it("should return 429 after too many attempts within an hour", async () => {
    const path = `/api/events/${eventId}/guest-signup`;

    // 5 allowed attempts -> usually 201 for the first; capacity is large to avoid interference
    const names = [
      "John Doe Alpha",
      "John Doe Beta",
      "John Doe Gamma",
      "John Doe Delta",
      "John Doe Epsilon",
    ];
    for (let i = 0; i < names.length; i++) {
      const res = await request(app)
        .post(path)
        .set("X-Forwarded-For", "1.2.3.4")
        .send(
          makeGuestPayload({
            fullName: names[i],
            notes: `try ${i}`,
          })
        );
      // First should be 201; subsequent duplicates by email become 400 after rate-limit check
      expect([201, 400]).toContain(res.status);
    }

    // 6th attempt should hit rate limit 429
    const res429 = await request(app)
      .post(path)
      .set("X-Forwarded-For", "1.2.3.4")
      .send(makeGuestPayload({ fullName: "Johnathan Doe Final" }))
      .expect(429);

    expect(res429.body).toMatchObject({ success: false });
    expect(String(res429.body?.message || "").toLowerCase()).toContain(
      "too many"
    );
  });

  it("should reset attempts after the 1h window elapses", async () => {
    const path = `/api/events/${eventId}/guest-signup`;
    // Use injected time provider to simulate window without faking global timers
    let now = Date.now();
    __setGuestRateLimitNowProvider(() => now);

    // 5 attempts from same ip+email within window
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post(path)
        .set("X-Forwarded-For", "5.6.7.8")
        .send(
          makeGuestPayload({
            email: "window.a@example.com",
            fullName: `John Doe RL Window ${i + 1}`,
            notes: `win ${i}`,
          })
        );
      expect([201, 400]).toContain(res.status);
    }

    // Advance time beyond 1 hour (window should clear)
    now = now + 61 * 60 * 1000;

    // New email, same IP should not be rate limited now; should pass capacity and return 201
    const resAfterWindow = await request(app)
      .post(path)
      .set("X-Forwarded-For", "5.6.7.8")
      .send(
        makeGuestPayload({
          email: "window.b@example.com",
          fullName: "John Doe RL Window Reset",
          notes: "after window",
        })
      );
    expect(resAfterWindow.status).toBe(201);

    // Cleanup provider is in afterEach
  });

  it("should not rate limit when IP changes for the same email (different key)", async () => {
    const path = `/api/events/${eventId}/guest-signup`;

    // Fill attempts on IP A
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post(path)
        .set("X-Forwarded-For", "7.7.7.7")
        .send(
          makeGuestPayload({
            email: "ip.scope@example.com",
            fullName: `John Doe IP Scope ${i + 1}`,
            notes: `ipA ${i}`,
          })
        );
      expect([201, 400]).toContain(res.status);
    }

    // New attempt with same email but different IP should not be rate-limited (though may be 400 due to duplicate)
    const resDifferentIp = await request(app)
      .post(path)
      .set("X-Forwarded-For", "8.8.8.8")
      .send(
        makeGuestPayload({
          email: "ip.scope@example.com",
          fullName: "John Doe IP Scope Different IP",
          notes: "ipB",
        })
      );
    expect(resDifferentIp.status).not.toBe(429);
  });

  it("should not rate limit when email changes for the same IP (different key)", async () => {
    const path = `/api/events/${eventId}/guest-signup`;

    // Fill attempts on email A for same IP
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post(path)
        .set("X-Forwarded-For", "9.9.9.9")
        .send(
          makeGuestPayload({
            email: "email.scope.a@example.com",
            fullName: `John Doe Email Scope ${i + 1}`,
            notes: `emailA ${i}`,
          })
        );
      expect([201, 400]).toContain(res.status);
    }

    // Different email but same IP should not hit rate limit; capacity allows another success (201)
    const resDifferentEmail = await request(app)
      .post(path)
      .set("X-Forwarded-For", "9.9.9.9")
      .send(
        makeGuestPayload({
          email: "email.scope.b@example.com",
          fullName: "John Doe Email Scope New Email",
          notes: "emailB",
        })
      );
    expect(resDifferentEmail.status).toBe(201);
  });

  it("should allow new attempts exactly at the 60-minute boundary (window resets)", async () => {
    const path = `/api/events/${eventId}/guest-signup`;
    // Use injected time provider for deterministic boundary without fake timers
    let now = Date.now();
    __setGuestRateLimitNowProvider(() => now);

    // 5 attempts within the initial window
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post(path)
        .set("X-Forwarded-For", "10.10.10.10")
        .send(
          makeGuestPayload({
            email: "boundary.a@example.com",
            fullName: `John Doe Boundary ${i + 1}`,
          })
        );
      expect([201, 400]).toContain(res.status);
    }

    // Move time forward by exactly 60 minutes
    now = now + 60 * 60 * 1000;

    // New email, same IP should be allowed (201) because prior attempts aged out at boundary
    const resAtBoundary = await request(app)
      .post(path)
      .set("X-Forwarded-For", "10.10.10.10")
      .send(
        makeGuestPayload({
          email: "boundary.b@example.com",
          fullName: "John Doe Boundary Reset",
        })
      );
    expect(resAtBoundary.status).toBe(201);

    // Cleanup provider is in afterEach
  });

  it("should count attempts even when uniqueness fails (pre-existing guest)", async () => {
    const path = `/api/events/${eventId}/guest-signup`;

    // Seed a pre-existing active guest (via API) so uniqueness fails immediately
    // Use a different IP so we don't increment the rate-limit key we want to test
    await request(app)
      .post(path)
      .set("X-Forwarded-For", "99.99.99.99")
      .send(
        makeGuestPayload({
          email: "pre.exist@example.com",
          fullName: "Pre Existing",
          notes: "seed",
        })
      )
      .expect([201, 400]);

    // 5 attempts with same ip+email will all be duplicate 400, but should still increment attempts under RL
    const alphaNames = [
      "John Doe Preexist Alpha",
      "John Doe Preexist Beta",
      "John Doe Preexist Gamma",
      "John Doe Preexist Delta",
      "John Doe Preexist Epsilon",
    ];
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post(path)
        .set("X-Forwarded-For", "11.11.11.11")
        .send(
          makeGuestPayload({
            email: "pre.exist@example.com",
            fullName: alphaNames[i],
          })
        );
      expect(res.status).toBe(400);
    }

    // 6th should now be rate-limited 429 (since RL check occurs before uniqueness)
    await request(app)
      .post(path)
      .set("X-Forwarded-For", "11.11.11.11")
      .send(
        makeGuestPayload({
          email: "pre.exist@example.com",
          fullName: "John Doe Preexist Final",
        })
      )
      .expect(429);
  });
});
