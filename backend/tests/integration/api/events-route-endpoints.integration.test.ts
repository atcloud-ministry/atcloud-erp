import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
/**
 * Events Route Additional Endpoints Integration Tests
 *
 * Tests inline handlers in events.ts route file
 * Covers: /calendar, /access, /purchase-info, /purchases, /email, /shortlink
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { ensureIntegrationDB } from "../setup/connect";
import app from "../../../src/app";
import { Event, User, Registration } from "../../../src/models";

describe("Events Route - Additional Endpoints Integration", () => {
  let testUser: any;
  let adminUser: any;
  let adminToken: string;
  let userToken: string;
  let testEvent: any;
  let usersInitialized = false;

  async function ensureBaseUsers() {
    if (usersInitialized) return;

    // Clear any existing test users first
    await User.deleteMany({
      email: {
        $in: ["events-routes-admin@test.com", "events-routes-user@test.com"],
      },
    });

    // Admin user via registration API
    const adminData = {
      ...TEST_REGISTRATION_PROFILE,
      username: "events_routes_admin",
      email: "events-routes-admin@test.com",
      password: "AdminPass123!",
      confirmPassword: "AdminPass123!",
      firstName: "Admin",
      lastName: "User",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
    };
    await request(app).post("/api/auth/register").send(adminData);

    // Verify and promote to admin
    await User.findOneAndUpdate(
      { email: adminData.email },
      { isVerified: true, role: "Administrator" }
    );

    const adminLoginResponse = await request(app).post("/api/auth/login").send({
      emailOrUsername: adminData.email,
      password: "AdminPass123!",
    });

    adminToken = adminLoginResponse.body.data.accessToken;
    adminUser = await User.findOne({ email: adminData.email });

    // Regular user via registration API
    const userData = {
      ...TEST_REGISTRATION_PROFILE,
      username: "events_routes_user",
      email: "events-routes-user@test.com",
      password: "UserPass123!",
      confirmPassword: "UserPass123!",
      firstName: "Regular",
      lastName: "User",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
    };
    await request(app).post("/api/auth/register").send(userData);

    await User.findOneAndUpdate(
      { email: userData.email },
      { isVerified: true }
    );

    const userLoginResponse = await request(app).post("/api/auth/login").send({
      emailOrUsername: userData.email,
      password: "UserPass123!",
    });

    userToken = userLoginResponse.body.data.accessToken;
    testUser = await User.findOne({ email: userData.email });

    usersInitialized = true;
  }

  beforeAll(async () => {
    await ensureIntegrationDB();
    await ensureBaseUsers();
  });

  beforeEach(async () => {
    // Ensure users are set up (they persist across tests)
    await ensureBaseUsers();

    // Clean up test events and registrations only
    await Event.deleteMany({ title: { $regex: /Test Events Route/ } });
    await Registration.deleteMany({});

    // Create test event with all required fields
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 7);

    testEvent = await Event.create({
      title: `Test Events Route Event ${Date.now()}`,
      date: futureDate.toISOString().split("T")[0],
      time: "14:00",
      endTime: "16:00",
      location: "Online",
      format: "Online",
      organizer: "Test Automation",
      purpose:
        "Testing event routes - this is a longer purpose to meet validation requirements",
      type: "Webinar",
      createdBy: adminUser._id,
      eventOrganizers: [adminUser._id],
      organizerDetails: [
        {
          name: "Admin User",
          email: adminUser.email,
          phone: "555-555-5555",
          role: "Event Organizer",
        },
      ],
      roles: [
        {
          id: "role-1",
          name: "Attendee",
          description: "Regular attendee role for testing",
          openToPublic: true,
          maxParticipants: 10,
        },
      ],
      status: "upcoming",
      publish: true,
      publicSlug: `test-event-${Date.now()}`,
      timeZone: "America/New_York",
    });
  });

  afterAll(async () => {
    await User.deleteMany({ email: { $regex: /test-events-routes/ } });
    await Event.deleteMany({ title: { $regex: /Test Events Route/ } });
    await Registration.deleteMany({});
  });

  describe("GET /api/events/:id/calendar", () => {
    it("should return ICS file for valid event", async () => {
      const response = await request(app)
        .get(`/api/events/${testEvent._id}/calendar`)
        .expect(200);

      expect(response.headers["content-type"]).toContain("text/calendar");
      expect(response.headers["content-disposition"]).toContain("attachment");
      expect(response.text).toContain("BEGIN:VCALENDAR");
      expect(response.text).toContain("END:VCALENDAR");
      expect(response.text).toContain(testEvent.title);
    });

    it("should return 404 for non-existent event", async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const response = await request(app)
        .get(`/api/events/${fakeId}/calendar`)
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe("Event not found");
    });

    it("should return 400 for invalid event ID format", async () => {
      const response = await request(app)
        .get("/api/events/invalid-id/calendar")
        .expect(400);

      expect(response.body.success).toBe(false);
    });
  });

  describe("GET /api/events/:id/has-registrations", () => {
    it("should return false when event has no registrations", async () => {
      const response = await request(app)
        .get(`/api/events/${testEvent._id}/has-registrations`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.hasRegistrations).toBe(false);
    });

    it("should return true when event has registrations", async () => {
      // Create a registration with all required eventSnapshot fields
      await Registration.create({
        eventId: testEvent._id,
        userId: testUser._id,
        roleId: "role-1",
        registrationDate: new Date(),
        registeredBy: testUser._id,
        status: "active",
        userSnapshot: {
          username: testUser.username,
          email: testUser.email,
          firstName: testUser.firstName,
          lastName: testUser.lastName,
        },
        eventSnapshot: {
          title: testEvent.title,
          date: testEvent.date,
          time: testEvent.time,
          location: testEvent.location,
          type: testEvent.type,
          roleName: "Attendee",
          roleDescription: "Regular attendee role for testing",
        },
      });

      const response = await request(app)
        .get(`/api/events/${testEvent._id}/has-registrations`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.hasRegistrations).toBe(true);
    });

    it("should require authentication", async () => {
      const response = await request(app)
        .get(`/api/events/${testEvent._id}/has-registrations`)
        .expect(401);

      expect(response.body.success).toBe(false);
    });
  });

  describe("GET /api/events/:id/access", () => {
    it("should check access for authenticated user", async () => {
      const response = await request(app)
        .get(`/api/events/${testEvent._id}/access`)
        .set("Authorization", `Bearer ${userToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty("hasAccess");
    });

    it("should require authentication", async () => {
      const response = await request(app)
        .get(`/api/events/${testEvent._id}/access`)
        .expect(401);

      expect(response.body.success).toBe(false);
    });
  });

  describe("GET /api/events/:id/purchase-info", () => {
    it("should return 400 for free event", async () => {
      // Event doesn't have pricing set, so it's considered free
      const response = await request(app)
        .get(`/api/events/${testEvent._id}/purchase-info`)
        .set("Authorization", `Bearer ${userToken}`)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain("free");
    });

    it("should require authentication", async () => {
      const response = await request(app)
        .get(`/api/events/${testEvent._id}/purchase-info`)
        .expect(401);

      expect(response.body.success).toBe(false);
    });

    it("should return 404 for non-existent event", async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const response = await request(app)
        .get(`/api/events/${fakeId}/purchase-info`)
        .set("Authorization", `Bearer ${userToken}`)
        .expect(404);

      expect(response.body.success).toBe(false);
    });
  });

  describe("GET /api/events/:id/purchases", () => {
    it("should return empty purchases for event with no purchases", async () => {
      const response = await request(app)
        .get(`/api/events/${testEvent._id}/purchases`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.purchases).toEqual([]);
      expect(response.body.data.totalCount).toBe(0);
      expect(response.body.data.totalRevenue).toBe(0);
    });

    it("should require authentication", async () => {
      const response = await request(app)
        .get(`/api/events/${testEvent._id}/purchases`)
        .expect(401);

      expect(response.body.success).toBe(false);
    });

    it("should require event management authorization", async () => {
      // Regular user should not have access
      const response = await request(app)
        .get(`/api/events/${testEvent._id}/purchases`)
        .set("Authorization", `Bearer ${userToken}`)
        .expect(403);

      expect(response.body.success).toBe(false);
    });
  });

  describe("POST /api/events/:id/email", () => {
    it("should return 400 when subject is missing", async () => {
      const response = await request(app)
        .post(`/api/events/${testEvent._id}/email`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ bodyHtml: "<p>Test</p>" })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain(
        "Subject and bodyHtml are required"
      );
    });

    it("should return 400 when bodyHtml is missing", async () => {
      const response = await request(app)
        .post(`/api/events/${testEvent._id}/email`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ subject: "Test Subject" })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain(
        "Subject and bodyHtml are required"
      );
    });

    it("should return 404 for non-existent event", async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const response = await request(app)
        .post(`/api/events/${fakeId}/email`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ subject: "Test", bodyHtml: "<p>Test</p>" })
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe("Event not found");
    });

    it("should return success with 0 recipients when no participants", async () => {
      const response = await request(app)
        .post(`/api/events/${testEvent._id}/email`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          subject: "Test Email",
          bodyHtml: "<p>Hello World</p>",
          includeUsers: true,
          includeGuests: true,
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.recipientCount).toBe(0);
      expect(response.body.sent).toBe(0);
    });

    it("should require event management authorization", async () => {
      const response = await request(app)
        .post(`/api/events/${testEvent._id}/email`)
        .set("Authorization", `Bearer ${userToken}`)
        .send({ subject: "Test", bodyHtml: "<p>Test</p>" })
        .expect(403);

      expect(response.body.success).toBe(false);
    });
  });

  describe("POST /api/events/:id/shortlink", () => {
    it("should require authentication", async () => {
      const response = await request(app)
        .post(`/api/events/${testEvent._id}/shortlink`)
        .expect(401);

      expect(response.body.success).toBe(false);
    });

    it("should create or return short link for published event with public roles", async () => {
      const response = await request(app)
        .post(`/api/events/${testEvent._id}/shortlink`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect((res) => {
          // Should be 200 (exists) or 201 (created)
          expect([200, 201]).toContain(res.status);
        });

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty("key");
      expect(response.body.data.eventId).toBe(testEvent._id.toString());
    });

    it("should return 404 for non-existent event", async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const response = await request(app)
        .post(`/api/events/${fakeId}/shortlink`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe("EVENT_NOT_FOUND");
    });

    it("should return error for unpublished event", async () => {
      // Unpublish the event
      await Event.findByIdAndUpdate(testEvent._id, { publish: false });

      const response = await request(app)
        .post(`/api/events/${testEvent._id}/shortlink`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe("EVENT_NOT_PUBLISHED");
    });
  });

  describe("GET /api/events/user/registered", () => {
    it("should return empty array when user has no registrations", async () => {
      const response = await request(app)
        .get("/api/events/user/registered")
        .set("Authorization", `Bearer ${userToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty("events");
      expect(Array.isArray(response.body.data.events)).toBe(true);
      expect(response.body.data).toHaveProperty("stats");
      expect(response.body.data).toHaveProperty("pagination");
    });

    it("should return registered events for user", async () => {
      // Create a registration with all required eventSnapshot fields
      await Registration.create({
        eventId: testEvent._id,
        userId: testUser._id,
        roleId: "role-1",
        registrationDate: new Date(),
        registeredBy: testUser._id,
        status: "active",
        userSnapshot: {
          username: testUser.username,
          email: testUser.email,
          firstName: testUser.firstName,
          lastName: testUser.lastName,
        },
        eventSnapshot: {
          title: testEvent.title,
          date: testEvent.date,
          time: testEvent.time,
          location: testEvent.location,
          type: testEvent.type,
          roleName: "Attendee",
          roleDescription: "Regular attendee role for testing",
        },
      });

      const response = await request(app)
        .get("/api/events/user/registered")
        .set("Authorization", `Bearer ${userToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.events.length).toBeGreaterThan(0);
    });
  });

  describe("GET /api/events/user/created", () => {
    it("should return events created by user", async () => {
      const response = await request(app)
        .get("/api/events/user/created")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty("events");
      expect(Array.isArray(response.body.data.events)).toBe(true);
    });
  });
});
