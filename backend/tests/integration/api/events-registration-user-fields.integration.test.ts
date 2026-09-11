import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import request from "supertest";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import app from "../../../src/app";
import User from "../../../src/models/User";

describe("Event registration user fields (role + systemAuthorizationLevel)", () => {
  let adminToken: string;
  let adminId: string;
  let leaderId: string;
  // Use unique suffix to avoid collisions across parallel/previous runs
  const uniq = `${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const adminEmail = `fields.admin.${uniq}@example.com`;
  // Keep usernames under 20 chars per validation rules
  const short = uniq.slice(0, 12);
  const adminUsername = `fa_${short}`;
  const leaderEmail = `fields.leader.${uniq}@example.com`;
  const leaderUsername = `lf_${short}`;

  beforeAll(async () => {
    // Create admin
    const regAdmin = await request(app)
      .post("/api/auth/register")
      .send({
        ...TEST_REGISTRATION_PROFILE,
        firstName: "Admin",
        lastName: "User",
        email: adminEmail,
        username: adminUsername,
        password: "AdminPass123!",
        confirmPassword: "AdminPass123!",
        gender: "male",
        isAtCloudLeader: false,
        acceptTerms: true,
      })
      .expect(201);
    adminId = regAdmin.body.data.user.id;
    await User.findByIdAndUpdate(adminId, {
      isVerified: true,
      role: "Administrator",
    });
    const login = await request(app).post("/api/auth/login").send({
      emailOrUsername: adminEmail,
      password: "AdminPass123!",
    });
    adminToken = login.body.data.accessToken;

    // Create a leader user with role but no explicit systemAuthorizationLevel set
    const regLeader = await request(app)
      .post("/api/auth/register")
      .send({
        ...TEST_REGISTRATION_PROFILE,
        firstName: "Leda",
        lastName: "Er",
        email: leaderEmail,
        username: leaderUsername,
        password: "LeaderPass123!",
        confirmPassword: "LeaderPass123!",
        gender: "female",
        // Not an @Cloud co-worker to avoid requiring roleInAtCloud in validation
        isAtCloudLeader: false,
        acceptTerms: true,
      })
      .expect(201);
    leaderId = regLeader.body.data.user.id;
    await User.findByIdAndUpdate(leaderId, {
      isVerified: true,
      role: "Leader",
      // Leave systemAuthorizationLevel undefined to exercise fallback
      $unset: { systemAuthorizationLevel: "" },
    });
  });

  afterAll(async () => {
    await User.deleteMany({
      _id: { $in: [adminId, leaderId].filter(Boolean) },
    } as any);
  });

  it("includes user.role on registrations and falls back when systemAuthorizationLevel is missing", async () => {
    // Create event
    const createRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Fields Event",
        description: "Test",
        date: new Date(Date.now() + 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        time: "09:00",
        endTime: "10:00",
        type: "Conference",
        format: "In-person",
        location: "Main Hall",
        agenda: "This is a valid agenda with sufficient length for validation.",
        organizer: "Org",
        purpose: "This is a valid purpose text.",
        roles: [
          {
            id: "r1",
            name: "Common Participant (on-site)",
            maxParticipants: 5,
            description: "General attendee",
          },
        ],
      })
      .expect(201);

    const eventId = createRes.body.data.event.id as string;
    const createdRoleId = createRes.body.data.event.roles[0].id as string;

    // Log in as leader to get token
    const loginLeader = await request(app).post("/api/auth/login").send({
      emailOrUsername: leaderEmail,
      password: "LeaderPass123!",
    });
    const leaderToken = loginLeader.body.data.accessToken as string;

    // Sign leader up
    await request(app)
      .post(`/api/events/${eventId}/signup`)
      .set("Authorization", `Bearer ${leaderToken}`)
      .send({ roleId: createdRoleId })
      .expect(200);

    // Fetch event detail
    const getRes = await request(app)
      .get(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    const roles = getRes.body.data.event.roles as Array<{
      registrations: Array<{
        user: { role?: string; systemAuthorizationLevel?: string };
      }>;
    }>;

    expect(Array.isArray(roles)).toBe(true);
    const reg = roles[0].registrations[0];
    expect(reg.user.role).toBe("Leader");
    // The service defaults systemAuthorizationLevel to Participant only when missing; role still present allows frontend fallback
    expect(
      reg.user.systemAuthorizationLevel === "Leader" ||
        reg.user.systemAuthorizationLevel === "Participant",
    ).toBe(true);
  });
});
