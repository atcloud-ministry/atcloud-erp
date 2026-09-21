import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../../../src/app";
import mongoose from "mongoose";
import GuestRegistration from "../../../src/models/GuestRegistration";
import User from "../../../src/models/User";

describe("Auto-migrate guest registrations on email verify", () => {
  const email = `auto_${Math.random().toString(36).slice(2, 8)}@example.com`;
  const password = "TestPass123!";
  let verifyToken: string;
  let userId: string;
  let eventId: mongoose.Types.ObjectId;

  beforeAll(async () => {
    // Seed a pending guest registration for an upcoming event
    eventId = new mongoose.Types.ObjectId();
    await GuestRegistration.create({
      eventId,
      roleId: "role-A",
      fullName: "Auto Guest",
      gender: "male",
      email,
      phone: "1234567890",
      status: "active",
      registrationDate: new Date(),
      eventSnapshot: {
        title: "Upcoming Event",
        date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        location: "Test Location",
        roleName: "Helper",
      },
      migrationStatus: "pending",
    } as any);

    // Register a user with the same email to trigger migration later
    const res = await request(app)
      .post("/api/auth/register")
      .send({
        ...TEST_REGISTRATION_PROFILE,
        username: `u_${Math.random().toString(36).slice(2, 8)}`,
        email,
        password,
        confirmPassword: password,
        firstName: "Auto",
        lastName: "Migrate",
        gender: "male",
        isAtCloudLeader: false,
        acceptTerms: true,
        registrationNoticeVersion: "registration-privacy-v1",
      });
    expect(res.status).toBe(201);

    const user = await User.findOne({ email });
    expect(user).toBeTruthy();
    userId = (user as any)!._id.toString();

    // Extract the verification token stored on the user document
    const rawToken = (user as any).generateEmailVerificationToken();
    await user!.save();
    verifyToken = rawToken;
  });

  afterAll(async () => {
    await GuestRegistration.deleteMany({ email });
  });

  it("verifying email performs migration in background and returns success", async () => {
    // Call verify endpoint (middleware uses the hashed token)
    const res = await request(app)
      .get(`/api/auth/verify-email/${verifyToken}`)
      .expect(200);
    expect(res.body.success).toBe(true);

    // Guest doc should be removed; user registration should exist
    const remainingGuests = await GuestRegistration.find({ email });
    expect(remainingGuests.length).toBe(0);
  });
});
