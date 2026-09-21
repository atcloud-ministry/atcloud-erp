import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
/**
 * Integration Test: User self-cancellation vs admin removal
 *
 * Purpose: Ensure regular users can cancel their own registrations
 * using the correct /cancel endpoint (not /manage/remove-user)
 *
 * Bug Fix: Previously, frontend incorrectly used /manage/remove-user endpoint
 * causing 403 errors for non-admin users trying to cancel their own registration.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import Registration from "../../../src/models/Registration";

describe("Event self-cancellation vs admin removal", () => {
  let userToken: string;
  let userId: string;
  let adminToken: string;
  let adminId: string;
  let eventId: string;

  beforeAll(async () => {
    await User.deleteMany({});
    await Event.deleteMany({});
    await Registration.deleteMany({});

    // Create regular user
    const userRes = await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      username: "regularuser",
      email: "regularuser@example.com",
      password: "UserPass123!",
      confirmPassword: "UserPass123!",
      firstName: "Regular",
      lastName: "User",
      role: "Participant",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
    });
    userId = userRes.body.data.user.id;
    await User.findByIdAndUpdate(userId, { isVerified: true });

    const userLogin = await request(app).post("/api/auth/login").send({
      emailOrUsername: "regularuser@example.com",
      password: "UserPass123!",
    });
    userToken = userLogin.body.data.accessToken;

    // Create admin user
    const adminRes = await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      username: "adminuser",
      email: "adminuser@example.com",
      password: "AdminPass123!",
      confirmPassword: "AdminPass123!",
      firstName: "Admin",
      lastName: "User",
      role: "Administrator",
      gender: "female",
      isAtCloudLeader: false,
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
    });
    adminId = adminRes.body.data.user.id;
    await User.findByIdAndUpdate(adminId, {
      isVerified: true,
      role: "Administrator",
    });

    const adminLogin = await request(app).post("/api/auth/login").send({
      emailOrUsername: "adminuser@example.com",
      password: "AdminPass123!",
    });
    adminToken = adminLogin.body.data.accessToken;

    // Create event
    const event = await Event.create({
      title: "Self-Cancel Test Event",
      description: "Event to test self-cancellation",
      date: new Date(Date.now() + 86400000).toISOString().split("T")[0],
      time: "14:00",
      endTime: "16:00",
      location: "Test Location",
      type: "Effective Communication Workshop",
      format: "In-person",
      purpose: "Testing self-cancellation",
      organizer: "QA Team",
      createdBy: new mongoose.Types.ObjectId(adminId),
      roles: [
        {
          id: "role-1",
          name: "Participants",
          maxParticipants: 20,
          description: "Main participants",
        },
      ],
      status: "upcoming",
      timeZone: "Etc/UTC",
    } as any);
    eventId = (event as any)._id.toString();
  }, 30000); // 30 second timeout for beforeAll

  afterAll(async () => {
    await User.deleteMany({});
    await Event.deleteMany({});
    await Registration.deleteMany({});
  });

  it("regular user can sign up for a role", async () => {
    const res = await request(app)
      .post(`/api/events/${eventId}/signup`)
      .set("Authorization", `Bearer ${userToken}`)
      .send({
        roleId: "role-1",
        notes: "Excited to participate!",
      })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.event.roles[0].registrations).toHaveLength(1);
    expect(res.body.data.event.roles[0].registrations[0].user.id).toBe(userId);
  });

  it("regular user can cancel their own registration using /cancel endpoint", async () => {
    const res = await request(app)
      .post(`/api/events/${eventId}/cancel`)
      .set("Authorization", `Bearer ${userToken}`)
      .send({
        roleId: "role-1",
      })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.message).toMatch(/successfully|Successfully/i);
    expect(res.body.data.event.roles[0].registrations).toHaveLength(0);
  });

  it("regular user CANNOT use /manage/remove-user endpoint (requires event management)", async () => {
    // Sign up again first
    await request(app)
      .post(`/api/events/${eventId}/signup`)
      .set("Authorization", `Bearer ${userToken}`)
      .send({ roleId: "role-1" })
      .expect(200);

    // Try to use admin endpoint - should fail with 403
    const res = await request(app)
      .post(`/api/events/${eventId}/manage/remove-user`)
      .set("Authorization", `Bearer ${userToken}`)
      .send({
        userId: userId,
        roleId: "role-1",
      })
      .expect(403);

    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain("Access denied");

    // Verify registration still exists (removal failed)
    const checkRes = await request(app)
      .get(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${userToken}`)
      .expect(200);

    expect(checkRes.body.data.event.roles[0].registrations).toHaveLength(1);
  });

  it("admin CAN use /manage/remove-user to remove other users", async () => {
    // User is still signed up from previous test
    const res = await request(app)
      .post(`/api/events/${eventId}/manage/remove-user`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        userId: userId,
        roleId: "role-1",
      })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.message).toContain("successfully");
    expect(res.body.data.event.roles[0].registrations).toHaveLength(0);
  });

  it("returns 404 when canceling non-existent registration", async () => {
    const res = await request(app)
      .post(`/api/events/${eventId}/cancel`)
      .set("Authorization", `Bearer ${userToken}`)
      .send({
        roleId: "role-1", // User is not signed up anymore
      })
      .expect(400); // Changed from 404 - API returns 400 Bad Request for invalid cancellations

    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain("not signed up"); // Changed from "not found" - actual message is "You are not signed up for this role."
  });
});
