import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import request from "supertest";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import app from "../../../src/app";
import User from "../../../src/models/User";

/**
 * Integration tests for Guest Expert permissions:
 * - Guest Expert can register (sign up) for event roles
 * - Organizer/Admin can assign a Guest Expert to a role
 */
describe("Guest Expert event role permissions (signup + assign)", () => {
  let adminToken: string;
  let adminId: string;
  let guestExpertId: string;
  let guestExpertToken: string;

  // Use unique suffix to avoid collisions across parallel/previous runs
  const uniq = `${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const adminEmail = `ge.admin.${uniq}@example.com`;
  const adminUsername = `gea_${uniq.slice(0, 12)}`;
  const guestEmail = `ge.user.${uniq}@example.com`;
  const guestUsername = `geu_${uniq.slice(0, 12)}`;

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
    const loginAdmin = await request(app).post("/api/auth/login").send({
      emailOrUsername: adminEmail,
      password: "AdminPass123!",
    });
    adminToken = loginAdmin.body.data.accessToken as string;

    // Create Guest Expert user
    const regGuest = await request(app)
      .post("/api/auth/register")
      .send({
        ...TEST_REGISTRATION_PROFILE,
        firstName: "Gus",
        lastName: "Expert",
        email: guestEmail,
        username: guestUsername,
        password: "GuestPass123!",
        confirmPassword: "GuestPass123!",
        gender: "female",
        isAtCloudLeader: false, // not required for signup
        acceptTerms: true,
      })
      .expect(201);
    guestExpertId = regGuest.body.data.user.id as string;
    await User.findByIdAndUpdate(guestExpertId, {
      isVerified: true,
      role: "Guest Expert",
    });
    const loginGuest = await request(app).post("/api/auth/login").send({
      emailOrUsername: guestEmail,
      password: "GuestPass123!",
    });
    guestExpertToken = loginGuest.body.data.accessToken as string;
  });

  afterAll(async () => {
    await User.deleteMany({
      _id: { $in: [adminId, guestExpertId].filter(Boolean) },
    } as any);
  });

  it("allows Guest Expert to sign up for a role and allows organizer to assign Guest Expert to another role", async () => {
    // Create an upcoming event with two roles
    const createRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "GE Permissions Event",
        description: "Test",
        date: new Date(Date.now() + 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        // Use uncommon evening slot to avoid conflicts with other tests that cluster around 10:00-12:00
        time: "21:10",
        endTime: "22:40",
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
          {
            id: "r2",
            name: "Prepared Speaker (on-site)",
            maxParticipants: 3,
            description: "Speaker",
          },
        ],
      })
      .expect(201);

    const eventId = createRes.body.data.event.id as string;
    const role1 = createRes.body.data.event.roles[0].id as string;
    const role2 = createRes.body.data.event.roles[1].id as string;

    // Guest Expert self sign-up to role1
    const signupRes = await request(app)
      .post(`/api/events/${eventId}/signup`)
      .set("Authorization", `Bearer ${guestExpertToken}`)
      .send({ roleId: role1 })
      .expect(200);
    expect(signupRes.body.success).toBe(true);

    // Admin assigns Guest Expert to role2
    const assignRes = await request(app)
      .post(`/api/events/${eventId}/manage/assign-user`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ userId: guestExpertId, roleId: role2 })
      .expect(200);
    expect(assignRes.body.success).toBe(true);

    // Fetch event and ensure both registrations present for the Guest Expert
    const getRes = await request(app)
      .get(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    const roles = (getRes.body.data.event.roles || []) as Array<{
      id: string;
      registrations: Array<{ userId: string }>;
    }>;

    const regCountsForGuest = roles.map((r) =>
      (r.registrations || []).some(
        (rr) => String(rr.userId) === String(guestExpertId)
      )
    );
    // Should be registered in both roles (2 true values)
    expect(regCountsForGuest.filter(Boolean).length).toBe(2);
  });
});
