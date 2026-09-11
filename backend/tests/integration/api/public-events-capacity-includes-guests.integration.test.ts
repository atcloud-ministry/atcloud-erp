import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../src/app";
import {
  User,
  Event,
  Registration,
  GuestRegistration,
} from "../../../src/models";
import { ensureIntegrationDB } from "../setup/connect";

/**
 * Integration Test: Public Event Capacity Includes Guest Registrations
 *
 * Tests that the capacity bar on public event detail page correctly counts
 * BOTH system user registrations AND guest registrations.
 *
 * Bug Fix: Previously, only Registration (system users) were counted,
 * but GuestRegistration records were ignored, causing the capacity bar
 * to show incorrect numbers.
 */
describe("Public Event Capacity - Includes Guests", () => {
  let adminToken: string;
  let adminUserId: string;
  let userToken: string;
  let userId: string;
  let eventId: string;
  let slug: string;
  let roleId: string;

  beforeAll(async () => {
    await ensureIntegrationDB();
  });

  afterAll(async () => {
    // Shared integration harness owns connection lifecycle.
  });

  beforeEach(async () => {
    // Clean up
    await User.deleteMany({});
    await Event.deleteMany({});
    await Registration.deleteMany({});
    await GuestRegistration.deleteMany({});

    // Create Admin user
    const adminResponse = await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      email: "admin@test.com",
      username: "admin",
      password: "TestPass123!",
      confirmPassword: "TestPass123!",
      firstName: "Test",
      lastName: "Admin",
      gender: "female",
      isAtCloudLeader: false,
      acceptTerms: true,
    });

    adminUserId = adminResponse.body.data.user.id;

    // Verify Admin user AND set role to Administrator
    await User.findByIdAndUpdate(adminUserId, {
      isVerified: true,
      role: "Administrator",
    });

    // Login Admin
    const adminLoginResponse = await request(app).post("/api/auth/login").send({
      emailOrUsername: "admin@test.com",
      password: "TestPass123!",
    });

    adminToken = adminLoginResponse.body.data.accessToken;

    // Create Participant user
    const userResponse = await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      email: "user@test.com",
      username: "user",
      password: "TestPass123!",
      confirmPassword: "TestPass123!",
      firstName: "Test",
      lastName: "User",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
    });

    userId = userResponse.body.data.user.id;

    // Verify User
    await User.findByIdAndUpdate(userId, {
      isVerified: true,
    });

    // Login User
    const userLoginResponse = await request(app).post("/api/auth/login").send({
      emailOrUsername: "user@test.com",
      password: "TestPass123!",
    });

    userToken = userLoginResponse.body.data.accessToken;

    // Create a published event with openToPublic role
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const createEventResponse = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Capacity Test Event",
        type: "Webinar",
        date: futureDate,
        endDate: futureDate, // Required field
        time: "10:00",
        endTime: "12:00",
        location: "Test Location",
        organizer: "Test Organizer",
        agenda:
          "This is a test agenda for capacity testing with both system users and guest registrations.",
        format: "Online",
        purpose:
          "This is a capacity test event to verify that both system users and guests are counted correctly in capacity calculations.",
        timeZone: "America/Los_Angeles",
        // Required for publishing Online events
        zoomLink: "https://zoom.us/j/123456789",
        meetingId: "123-456-789",
        passcode: "test123",
        roles: [
          {
            name: "Attendee",
            description: "Event attendee",
            maxParticipants: 10, // Maximum capacity
            openToPublic: true, // Open for guest registration
          },
        ],
        suppressNotifications: true, // Prevent email spam during tests
      });

    if (createEventResponse.status !== 201) {
      console.error("Event creation failed:", createEventResponse.body);
    }
    expect(createEventResponse.status).toBe(201);
    eventId = createEventResponse.body.data.event.id;
    roleId = createEventResponse.body.data.event.roles[0].id;

    // Publish the event
    const publishResponse = await request(app)
      .post(`/api/events/${eventId}/publish`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send();

    if (publishResponse.status !== 200) {
      console.error("Event publish failed:", publishResponse.body);
    }
    expect(publishResponse.status).toBe(200);
    slug = publishResponse.body.data.slug;
  });

  it("should count BOTH system users AND guests in capacityRemaining", async () => {
    // Step 1: Register 2 system users
    await request(app)
      .post(`/api/events/${eventId}/register`)
      .set("Authorization", `Bearer ${userToken}`)
      .send({ roleId });

    // Create another system user and register
    const user2Response = await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      email: "user2@test.com",
      username: "user2",
      password: "TestPass123!",
      confirmPassword: "TestPass123!",
      firstName: "Test",
      lastName: "User2",
      gender: "female",
      isAtCloudLeader: false,
      acceptTerms: true,
    });

    await User.findByIdAndUpdate(user2Response.body.data.user.id, {
      isVerified: true,
    });

    const user2LoginResponse = await request(app).post("/api/auth/login").send({
      emailOrUsername: "user2@test.com",
      password: "TestPass123!",
    });

    const user2Token = user2LoginResponse.body.data.accessToken;

    await request(app)
      .post(`/api/events/${eventId}/register`)
      .set("Authorization", `Bearer ${user2Token}`)
      .send({ roleId });

    // Step 2: Register 3 guests via public registration
    await request(app)
      .post(`/api/public/events/${slug}/register`)
      .send({
        roleId,
        attendee: {
          name: "Guest One",
          email: "guest1@test.com",
          phone: "1234567890",
        },
        consent: { termsAccepted: true },
      });

    await request(app)
      .post(`/api/public/events/${slug}/register`)
      .send({
        roleId,
        attendee: {
          name: "Guest Two",
          email: "guest2@test.com",
          phone: "1234567891",
        },
        consent: { termsAccepted: true },
      });

    await request(app)
      .post(`/api/public/events/${slug}/register`)
      .send({
        roleId,
        attendee: {
          name: "Guest Three",
          email: "guest3@test.com",
          phone: "1234567892",
        },
        consent: { termsAccepted: true },
      });

    // Step 3: Get public event and verify capacity
    const getResponse = await request(app).get(`/api/public/events/${slug}`);

    expect(getResponse.status).toBe(200);
    expect(getResponse.body.success).toBe(true);

    const role = getResponse.body.data.roles[0];
    expect(role.maxParticipants).toBe(10);

    // CRITICAL ASSERTION: capacityRemaining should be 5 (10 total - 2 users - 3 guests)
    expect(role.capacityRemaining).toBe(5);

    // Step 4: Verify the counts in database
    const systemUserCount = await Registration.countDocuments({
      eventId: new mongoose.Types.ObjectId(eventId),
      roleId,
      status: "active",
    });
    expect(systemUserCount).toBe(2);

    const guestCount = await GuestRegistration.countDocuments({
      eventId: new mongoose.Types.ObjectId(eventId),
      roleId,
      status: "active",
    });
    expect(guestCount).toBe(3);

    // Total should be 5
    expect(systemUserCount + guestCount).toBe(5);
  });

  it("should show capacityRemaining = 0 when role is full with mixed registrations", async () => {
    // Register 6 system users and 4 guests (total 10 = full)

    // Create 6 system users
    const userTokens: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const userRes = await request(app)
        .post("/api/auth/register")
        .send({
          ...TEST_REGISTRATION_PROFILE,
          email: `user${i}@test.com`,
          username: `user${i}`,
          password: "TestPass123!",
          confirmPassword: "TestPass123!",
          firstName: "User",
          lastName: `${i}`,
          gender: i % 2 === 0 ? "female" : "male",
          isAtCloudLeader: false,
          acceptTerms: true,
        });

      await User.findByIdAndUpdate(userRes.body.data.user.id, {
        isVerified: true,
      });

      const loginRes = await request(app)
        .post("/api/auth/login")
        .send({
          emailOrUsername: `user${i}@test.com`,
          password: "TestPass123!",
        });

      userTokens.push(loginRes.body.data.accessToken);
    }

    // Register 6 system users
    for (const token of userTokens) {
      await request(app)
        .post(`/api/events/${eventId}/register`)
        .set("Authorization", `Bearer ${token}`)
        .send({ roleId });
    }

    // Register 4 guests
    for (let i = 1; i <= 4; i++) {
      await request(app)
        .post(`/api/public/events/${slug}/register`)
        .send({
          roleId,
          attendee: {
            name: `Guest ${i}`,
            email: `guest${i}@test.com`,
            phone: `123456789${i}`,
          },
          consent: { termsAccepted: true },
        });
    }

    // Get public event
    const getResponse = await request(app).get(`/api/public/events/${slug}`);

    expect(getResponse.status).toBe(200);
    const role = getResponse.body.data.roles[0];

    // Should be full (0 capacity remaining)
    expect(role.capacityRemaining).toBe(0);
  });

  it("should correctly calculate capacity when guests are cancelled", async () => {
    // Register 2 guests
    await request(app)
      .post(`/api/public/events/${slug}/register`)
      .send({
        roleId,
        attendee: {
          name: "Guest One",
          email: "guest1@test.com",
          phone: "1234567890",
        },
        consent: { termsAccepted: true },
      });

    await request(app)
      .post(`/api/public/events/${slug}/register`)
      .send({
        roleId,
        attendee: {
          name: "Guest Two",
          email: "guest2@test.com",
          phone: "1234567891",
        },
        consent: { termsAccepted: true },
      });

    // Capacity should be 8 (10 - 2 guests)
    let getResponse = await request(app).get(`/api/public/events/${slug}`);
    expect(getResponse.body.data.roles[0].capacityRemaining).toBe(8);

    // Cancel guest1 by updating status directly in database
    // (Public registration doesn't return manageToken, so we test the capacity logic directly)
    await GuestRegistration.findOneAndUpdate(
      {
        email: "guest1@test.com",
        eventId: new mongoose.Types.ObjectId(eventId),
      },
      {
        $set: {
          status: "cancelled",
        },
      }
    );

    // Verify guest1 was cancelled
    const guest1After = await GuestRegistration.findOne({
      email: "guest1@test.com",
      eventId: new mongoose.Types.ObjectId(eventId),
    });
    expect(guest1After?.status).toBe("cancelled");

    // Capacity should now be 9 (10 - 1 active guest)
    getResponse = await request(app).get(`/api/public/events/${slug}`);
    expect(getResponse.body.data.roles[0].capacityRemaining).toBe(9);
  });
});
