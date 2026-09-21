import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
/**
 * Events API Integration Tests
 *
 * Tests the complete events management flow including:
 * - Event creation, reading, updating, deletion
 * - Event registration and management
 * - Role-based access control
 * - Event search and filtering
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import { buildValidEventPayload } from "../../test-utils/eventTestHelpers";
import { ensureIntegrationDB } from "../setup/connect";

describe("Events API Integration Tests", () => {
  // Reuse auth users across tests to dramatically reduce runtime under coverage.
  // Creating & hashing passwords for two users in every beforeEach was adding
  // significant overhead (especially with instrumentation), leading to stalls.
  let authToken: string;
  let adminToken: string;
  let userId: string;
  let adminId: string;
  let usersInitialized = false;

  async function ensureBaseUsers() {
    if (usersInitialized) return; // Already created
    // Safety: clear only user/event collections once at start
    await User.deleteMany({});
    await Event.deleteMany({});

    // Regular user
    const userData = {
      ...TEST_REGISTRATION_PROFILE,
      username: "eventuser",
      email: "event@example.com",
      password: "EventPass123!",
      confirmPassword: "EventPass123!",
      firstName: "Event",
      lastName: "User",
      role: "Participant",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
    };
    const userResponse = await request(app)
      .post("/api/auth/register")
      .send(userData);
    await User.findOneAndUpdate(
      { email: "event@example.com" },
      { isVerified: true },
    );
    const loginResponse = await request(app).post("/api/auth/login").send({
      emailOrUsername: "event@example.com",
      password: "EventPass123!",
    });
    authToken = loginResponse.body.data.accessToken;
    userId = userResponse.body.data.user.id;

    // Admin user
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
      registrationNoticeVersion: "registration-privacy-v1",
    };
    const adminResponse = await request(app)
      .post("/api/auth/register")
      .send(adminData);
    await User.findOneAndUpdate(
      { email: "admin@example.com" },
      { isVerified: true, role: "Administrator" },
    );
    const adminLoginResponse = await request(app).post("/api/auth/login").send({
      emailOrUsername: "admin@example.com",
      password: "AdminPass123!",
    });
    adminToken = adminLoginResponse.body.data.accessToken;
    adminId = adminResponse.body.data.user.id;
    usersInitialized = true;
  }

  beforeAll(async () => {
    // Use shared DB connection to prevent connection pool exhaustion
    await ensureIntegrationDB();
    await ensureBaseUsers();
  }, 40000); // allow extra time under coverage for initial user creation & connection

  // For each test only clear events; keep user documents & tokens
  beforeEach(async () => {
    // Fast path: if tokens somehow lost (rare), recreate users
    if (!authToken || !adminToken) {
      usersInitialized = false;
      await ensureBaseUsers();
    }
    await Event.deleteMany({});
  }, 15000);

  // Some nested describes have their own beforeEach creating events; afterEach
  // still clears events to avoid cross-test leakage.
  afterEach(async () => {
    await Event.deleteMany({});
  });

  afterAll(async () => {
    await Event.deleteMany({});
    await User.deleteMany({});
    // Connection is shared, don't close it here
  }, 30000);

  describe("POST /api/events", () => {
    const validEventData = buildValidEventPayload({
      title: "Test Event",
      time: "10:00",
      endTime: "12:00",
      format: "In-person",
      location: "Test Location",
      type: "Effective Communication Workshop",
      organizer: "Test Organizer Team",
      overrides: {
        description: "A test event for integration testing",
        agenda:
          "1. Welcome and introductions\n2. Main presentation content\n3. Interactive discussion session\n4. Q&A period\n5. Closing remarks and next steps",
        maxParticipants: 50,
        category: "general",
      },
      roles: [
        {
          id: "role-1",
          name: "Zoom Host",
          maxParticipants: 1,
          description: "Hosts the Zoom session and oversees logistics",
        },
      ],
    });

    it("should create event with admin token", async () => {
      const response = await request(app)
        .post("/api/events")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(validEventData)
        .expect(201);

      expect(response.body).toMatchObject({
        success: true,
        message: expect.stringContaining("created"),
        data: {
          event: {
            title: "Test Event",
            location: "Test Location",
            type: "Effective Communication Workshop",
            format: "In-person",
            createdBy: {
              id: adminId,
              username: "admin",
              firstName: "Admin",
              lastName: "User",
              role: "Administrator",
            },
          },
        },
      });

      // Verify event was created in database
      const createdEvent = await Event.findOne({ title: "Test Event" });
      expect(createdEvent).toBeTruthy();
      expect(createdEvent?.createdBy.toString()).toBe(adminId);
    });

    it("should reject event creation with user token", async () => {
      const response = await request(app)
        .post("/api/events")
        .set("Authorization", `Bearer ${authToken}`)
        .send(validEventData)
        .expect(403);

      expect(response.body).toMatchObject({
        success: false,
        message: expect.stringContaining("Access denied"),
      });
    });

    it("should reject event creation without authentication", async () => {
      const response = await request(app)
        .post("/api/events")
        .send(validEventData)
        .expect(401);

      expect(response.body).toMatchObject({
        success: false,
        message: expect.stringContaining("token"),
      });
    });

    it("should validate required fields", async () => {
      const invalidEventData = {
        description: "Missing title and date",
      };

      const response = await request(app)
        .post("/api/events")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(invalidEventData)
        .expect(400);

      expect(response.body).toMatchObject({
        success: false,
        message: expect.any(String),
      });
    });

    it("should validate date is in the future", async () => {
      // Build yesterday's date as a local wall date string to match controller logic
      const now = new Date();
      const y = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - 1,
        0,
        0,
        0,
        0,
      );
      const yyyy = y.getFullYear();
      const mm = String(y.getMonth() + 1).padStart(2, "0");
      const dd = String(y.getDate()).padStart(2, "0");
      const yesterdayLocal = `${yyyy}-${mm}-${dd}`;

      const pastEventData = {
        ...validEventData,
        date: yesterdayLocal,
      };

      const response = await request(app)
        .post("/api/events")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(pastEventData)
        .expect(400);

      expect(response.body).toMatchObject({
        success: false,
        message: expect.stringContaining("date"),
      });
    });

    it("should validate maxParticipants is positive", async () => {
      const invalidEventData = {
        ...validEventData,
        roles: [
          {
            id: "role-test",
            name: "Test Role",
            description: "Test role with invalid maxParticipants",
            maxParticipants: -5, // Invalid negative value
          },
        ],
      };

      const response = await request(app)
        .post("/api/events")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(invalidEventData)
        .expect(400);

      expect(response.body).toMatchObject({
        success: false,
        message: expect.any(String),
      });
    });
  });

  describe("GET /api/events", () => {
    beforeEach(async () => {
      // Create test events
      const events = [
        {
          title: "Event 1",
          description: "First test event",
          date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
            .toISOString()
            .split("T")[0],
          time: "10:00",
          endTime: "12:00",
          location: "Location 1",
          type: "Effective Communication Workshop",
          format: "In-person",
          purpose: "Test purpose for Event 1",
          organizer: "Test Organizer 1",
          roles: [
            {
              id: "role-1-event1",
              name: "Volunteer",
              maxParticipants: 30,
              description: "General volunteers for Event 1",
            },
          ],
          createdBy: adminId,
        },
        {
          title: "Event 2",
          description: "Second test event",
          date: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
            .toISOString()
            .split("T")[0],
          time: "14:00",
          endTime: "16:00",
          location: "Location 2",
          type: "Webinar",
          format: "In-person",
          purpose: "Test purpose for Event 2",
          organizer: "Test Organizer 2",
          roles: [
            {
              id: "role-1-event2",
              name: "Participant",
              maxParticipants: 50,
              description: "General participants for Event 2",
            },
          ],
          createdBy: adminId,
        },
      ];

      await Event.insertMany(events);
    });

    it("should get all events without authentication", async () => {
      const response = await request(app).get("/api/events").expect(200);

      expect(response.body).toMatchObject({
        success: true,
        data: {
          events: expect.arrayContaining([
            expect.objectContaining({ title: "Event 1" }),
            expect.objectContaining({ title: "Event 2" }),
          ]),
        },
      });

      expect(response.body.data.events).toHaveLength(2);
    });

    it("should filter events by type", async () => {
      const response = await request(app)
        .get("/api/events?type=Webinar")
        .expect(200);

      expect(response.body.data.events).toHaveLength(1);
      expect(response.body.data.events[0]).toMatchObject({
        title: "Event 2",
        type: "Webinar",
      });
    });

    it("should paginate events", async () => {
      const response = await request(app)
        .get("/api/events?page=1&limit=1")
        .expect(200);

      expect(response.body.data.events).toHaveLength(1);
      expect(response.body.data).toMatchObject({
        pagination: {
          currentPage: 1,
          totalPages: expect.any(Number),
          totalEvents: 2,
          hasNext: expect.any(Boolean),
          hasPrev: expect.any(Boolean),
        },
      });
    });

    it("should sort events by date", async () => {
      const response = await request(app)
        .get("/api/events?sortBy=date&sortOrder=asc")
        .expect(200);

      const events = response.body.data.events;
      expect(new Date(events[0].date).getTime()).toBeLessThan(
        new Date(events[1].date).getTime(),
      );
    });
  });

  describe("GET /api/events/:id", () => {
    let eventId: string;

    beforeEach(async () => {
      const event = await Event.create({
        title: "Detailed Event",
        description: "Event for detail testing",
        date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        time: "15:00",
        endTime: "17:00",
        location: "Detail Location",
        type: "Conference",
        format: "In-person",
        purpose: "Test purpose for detailed event",
        organizer: "Detail Test Organizer",
        roles: [
          {
            id: "role-detailed",
            name: "Attendee",
            maxParticipants: 40,
            description: "General attendees for detailed event",
          },
        ],
        createdBy: adminId,
      });

      eventId = (event as any)._id.toString();
    });

    it("should get event details by ID", async () => {
      const response = await request(app)
        .get(`/api/events/${eventId}`)
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        data: {
          event: {
            title: "Detailed Event",
            location: "Detail Location",
            type: "Conference",
            format: "In-person",
          },
        },
      });
    });

    it("should return 404 for non-existent event", async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();

      const response = await request(app)
        .get(`/api/events/${fakeId}`)
        .expect(404);

      expect(response.body).toMatchObject({
        success: false,
        message: expect.stringContaining("not found"),
      });
    });

    it("should return 400 for invalid event ID", async () => {
      const response = await request(app)
        .get("/api/events/invalid-id")
        .expect(400);

      expect(response.body).toMatchObject({
        success: false,
        message: expect.stringContaining("Validation failed"),
      });
    });
  });

  describe("PUT /api/events/:id", () => {
    let eventId: string;

    beforeEach(async () => {
      const event = await Event.create({
        title: "Update Event",
        description: "Event for update testing",
        date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        time: "09:00",
        endTime: "11:00",
        location: "Update Location",
        type: "Conference",
        format: "In-person",
        purpose: "Test purpose for update event",
        organizer: "Update Test Organizer",
        category: "general",
        roles: [
          {
            id: "role-update",
            name: "Spiritual Adviser",
            maxParticipants: 1,
            description: "Prayer lead, feedback after Q&A, closing prayer",
          },
        ],
        createdBy: adminId,
      });

      eventId = (event as any)._id.toString();
    });

    it("should update event with admin token", async () => {
      const updateData = {
        title: "Updated Event Title",
        description: "Updated description",
        roles: [
          {
            id: "role-update",
            name: "Zoom Co-host",
            maxParticipants: 1,
            description: "Assists the Zoom Host with moderation",
          },
        ],
      };

      const response = await request(app)
        .put(`/api/events/${eventId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send(updateData)
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        message: expect.stringContaining("updated"),
        data: {
          event: {
            title: "Updated Event Title",
            maxParticipants: 1,
          },
        },
      });
    });

    it("forces location to 'Online' when updating format to Online (server-side guard)", async () => {
      // Start with an in-person event having a physical location
      const updateToOnline = {
        format: "Online",
        // Try to sneak a stale location; server should override to "Online"
        location: "123 Main St, City",
      };

      const response = await request(app)
        .put(`/api/events/${eventId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send(updateToOnline)
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        data: {
          event: {
            format: "Online",
            location: "Online",
          },
        },
      });

      // Confirm persisted value
      const updated: any = await Event.findById(eventId).lean();
      expect(updated?.format).toBe("Online");
      expect(updated?.location).toBe("Online");
    });

    describe("POST /api/events (create) - Online location normalization", () => {
      it("sets location to 'Online' for Online events even if a different location is provided", async () => {
        const createPayload = {
          title: "Online Event",
          description: "Should force location",
          agenda: "Intro, keynote, breakouts, and Q&A session to follow.",
          date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
            .toISOString()
            .split("T")[0],
          endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
            .toISOString()
            .split("T")[0],
          // Choose a non-overlapping window relative to the parent suite's event (09:00–11:00)
          time: "12:00",
          endTime: "14:00",
          location: "Old Address",
          type: "Conference",
          format: "Online",
          purpose: "Test purpose",
          organizer: "Admin",
          timeZone: "America/Los_Angeles",
          roles: [
            {
              id: "role-online",
              name: "Common Participant (Zoom)",
              maxParticipants: 5,
              description: "General participant",
            },
          ],
        };

        const response = await request(app)
          .post("/api/events")
          .set("Authorization", `Bearer ${adminToken}`)
          .send(createPayload);
        expect(response.status, JSON.stringify(response.body)).toBe(201);

        expect(response.body).toMatchObject({
          success: true,
          data: {
            event: {
              format: "Online",
              location: "Online",
            },
          },
        });
      });
    });
    it("should allow Administrator to update any event (not just their own)", async () => {
      // Create a different admin user who will create an event
      const anotherAdminData = {
        ...TEST_REGISTRATION_PROFILE,
        firstName: "Another",
        lastName: "Admin",
        email: "another.admin@example.com",
        username: "anotheradmin",
        password: "AnotherAdminPass123!",
        confirmPassword: "AnotherAdminPass123!",
        gender: "female",
        isAtCloudLeader: false,
        acceptTerms: true,
        registrationNoticeVersion: "registration-privacy-v1",
      };

      const anotherAdminResponse = await request(app)
        .post("/api/auth/register")
        .send(anotherAdminData);

      await User.findOneAndUpdate(
        { email: "another.admin@example.com" },
        { isVerified: true, role: "Administrator" },
      );

      const anotherAdminLoginResponse = await request(app)
        .post("/api/auth/login")
        .send({
          emailOrUsername: "another.admin@example.com",
          password: "AnotherAdminPass123!",
        });

      const anotherAdminToken = anotherAdminLoginResponse.body.data.accessToken;
      const anotherAdminId = anotherAdminResponse.body.data.user.id;

      // Create an event by the other admin
      const eventByAnotherAdmin = await Event.create({
        title: "Event by Another Admin",
        description: "Event created by another admin user",
        date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        time: "14:00",
        endTime: "16:00",
        location: "Other Admin Location",
        type: "Conference",
        format: "In-person",
        purpose: "Test purpose for another admin event",
        organizer: "Another Admin Organizer",
        category: "general",
        roles: [
          {
            id: "role-other",
            name: "Participant",
            maxParticipants: 5,
            description: "General participant role",
          },
        ],
        createdBy: anotherAdminId,
      });

      const otherEventId = (eventByAnotherAdmin as any)._id.toString();

      // The original admin (different from creator) should be able to update this event
      const updateData = {
        title: "Updated by Different Administrator",
        description: "Administrator can update any event, not just their own",
      };

      const response = await request(app)
        .put(`/api/events/${otherEventId}`)
        .set("Authorization", `Bearer ${adminToken}`) // Original admin updating another admin's event
        .send(updateData)
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        message: expect.stringContaining("updated"),
        data: {
          event: {
            title: "Updated by Different Administrator",
          },
        },
      });
    });

    it("should reject update with user token", async () => {
      const updateData = {
        title: "Unauthorized Update",
      };

      const response = await request(app)
        .put(`/api/events/${eventId}`)
        .set("Authorization", `Bearer ${authToken}`)
        .send(updateData)
        .expect(403);

      expect(response.body).toMatchObject({
        success: false,
        message: expect.stringContaining(
          "Insufficient permissions to edit this event",
        ),
      });
    });

    it("should validate update data", async () => {
      const invalidUpdateData = {
        date: "invalid-date-format",
      };

      const response = await request(app)
        .put(`/api/events/${eventId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send(invalidUpdateData)
        .expect(400);

      expect(response.body).toMatchObject({
        success: false,
        message: expect.any(String),
      });
    });
  });

  describe("DELETE /api/events/:id", () => {
    let eventId: string;

    beforeEach(async () => {
      const event = await Event.create({
        title: "Delete Event",
        description: "Event for delete testing",
        date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        time: "13:00",
        endTime: "15:00",
        location: "Delete Location",
        type: "Effective Communication Workshop",
        format: "In-person",
        purpose: "Test purpose for delete event",
        organizer: "Delete Test Organizer",
        maxParticipants: 25,
        category: "general",
        roles: [
          {
            id: "role-delete",
            name: "Participant",
            maxParticipants: 25,
            description: "General participants for delete event",
          },
        ],
        createdBy: adminId,
      });

      eventId = (event as any)._id.toString();
    });

    it("should delete event with admin token", async () => {
      const response = await request(app)
        .delete(`/api/events/${eventId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        message: expect.stringContaining("deleted"),
      });

      // Verify event was deleted from database
      const deletedEvent = await Event.findById(eventId);
      expect(deletedEvent).toBeNull();
    });

    it("should reject delete with user token", async () => {
      const response = await request(app)
        .delete(`/api/events/${eventId}`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(403);

      expect(response.body).toMatchObject({
        success: false,
        message: expect.stringContaining("Access denied"),
      });
    });

    it("should return 404 for non-existent event", async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();

      const response = await request(app)
        .delete(`/api/events/${fakeId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(404);

      expect(response.body).toMatchObject({
        success: false,
        message: expect.stringContaining("not found"),
      });
    });
  });

  describe("POST /api/events/:id/register", () => {
    let eventId: string;

    beforeEach(async () => {
      const event = await Event.create({
        title: "Registration Event",
        description: "Event for registration testing",
        date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        time: "16:00",
        endTime: "18:00",
        location: "Registration Location",
        type: "Conference",
        format: "In-person",
        purpose: "Test purpose for registration event",
        organizer: "Registration Test Organizer",
        maxParticipants: 20,
        category: "general",
        roles: [
          {
            id: "role-participant",
            name: "Common Participant (on-site)",
            maxParticipants: 5,
            description: "General participants",
          },
          {
            id: "role-speaker",
            name: "Prepared Speaker (on-site)",
            maxParticipants: 2,
            description: "Event speakers",
          },
        ],
        createdBy: adminId,
      });

      eventId = (event as any)._id.toString();
    });

    it("should register user for event", async () => {
      const registrationData = {
        roleId: "role-participant",
        notes: "Excited to help!",
      };

      const response = await request(app)
        .post(`/api/events/${eventId}/register`)
        .set("Authorization", `Bearer ${authToken}`)
        .send(registrationData)
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        message: expect.stringContaining("signed up"),
        data: {
          event: expect.objectContaining({
            id: eventId,
            title: "Registration Event",
          }),
        },
      });
    });

    it("should prevent duplicate registration (same role)", async () => {
      // First registration
      const registrationData = {
        roleId: "role-participant",
      };

      await request(app)
        .post(`/api/events/${eventId}/register`)
        .set("Authorization", `Bearer ${authToken}`)
        .send(registrationData)
        .expect(200);

      // Second registration should fail
      const response = await request(app)
        .post(`/api/events/${eventId}/register`)
        .set("Authorization", `Bearer ${authToken}`)
        .send(registrationData)
        .expect(400);

      expect(response.body).toMatchObject({
        success: false,
        message: "You are already signed up for this role.",
      });
    });

    it("should validate role availability", async () => {
      const registrationData = {
        roleId: "invalid-role",
      };

      const response = await request(app)
        .post(`/api/events/${eventId}/register`)
        .set("Authorization", `Bearer ${authToken}`)
        .send(registrationData)
        .expect(400);

      expect(response.body).toMatchObject({
        success: false,
        message: expect.stringContaining("Role not found"),
      });
    });

    it("should require authentication for registration", async () => {
      const registrationData = {
        roleId: "role-volunteer",
      };

      const response = await request(app)
        .post(`/api/events/${eventId}/register`)
        .send(registrationData)
        .expect(401);

      expect(response.body).toMatchObject({
        success: false,
        message: expect.stringContaining("token"),
      });
    });
  });

  describe("Event Search and Filtering", () => {
    beforeEach(async () => {
      // Create diverse events for search testing
      const events = [
        {
          title: "JavaScript Workshop",
          description: "Learn modern JavaScript features",
          date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
            .toISOString()
            .split("T")[0],
          time: "10:00",
          endTime: "16:00",
          location: "Tech Center",
          type: "Effective Communication Workshop",
          format: "In-person",
          purpose: "Learn modern JavaScript features and best practices",
          organizer: "Tech Learning Center",
          roles: [
            {
              id: "role-js-student",
              name: "Student",
              maxParticipants: 30,
              description: "Workshop participants",
            },
          ],
          createdBy: adminId,
        },
        {
          title: "Community Cleanup",
          description: "Help clean our neighborhood",
          date: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
            .toISOString()
            .split("T")[0],
          time: "09:00",
          endTime: "12:00",
          location: "Community Park",
          type: "Mentor Circle",
          format: "In-person",
          purpose: "Help clean our neighborhood and make it beautiful",
          organizer: "Community Volunteer Group",
          roles: [
            {
              id: "role-cleanup-volunteer",
              name: "Volunteer",
              maxParticipants: 50,
              description: "Community cleanup volunteers",
            },
          ],
          createdBy: adminId,
        },
        {
          title: "React Conference",
          description: "Annual React developer conference",
          date: new Date(Date.now() + 21 * 24 * 60 * 60 * 1000)
            .toISOString()
            .split("T")[0],
          time: "08:00",
          endTime: "17:00",
          location: "Convention Center",
          type: "Conference",
          format: "In-person",
          purpose: "Annual React developer conference with latest trends",
          organizer: "React Developers Association",
          roles: [
            {
              id: "role-conference-attendee",
              name: "Attendee",
              maxParticipants: 100,
              description: "Conference attendees",
            },
          ],
          createdBy: adminId,
        },
      ];

      // Use Event.create() to ensure pre-save middleware runs and totalSlots is calculated
      for (const eventData of events) {
        await Event.create(eventData);
      }
    });

    it("should search events by title", async () => {
      const response = await request(app)
        .get("/api/events?search=JavaScript")
        .expect(200);

      expect(response.body.data.events).toHaveLength(1);
      expect(response.body.data.events[0]).toMatchObject({
        title: "JavaScript Workshop",
      });
    });

    it("should search events by description", async () => {
      const response = await request(app)
        .get("/api/events?search=React")
        .expect(200);

      expect(response.body.data.events).toHaveLength(1);
      expect(response.body.data.events[0]).toMatchObject({
        title: "React Conference",
      });
    });

    it("should filter by specific event type", async () => {
      const response = await request(app)
        .get("/api/events?type=Conference")
        .expect(200);

      expect(response.body.data.events).toHaveLength(1);
      const titles = response.body.data.events.map((e: any) => e.title);
      expect(titles).toContain("React Conference");
    });

    it("should filter by date range", async () => {
      const startDate = new Date(
        Date.now() + 6 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const endDate = new Date(
        Date.now() + 15 * 24 * 60 * 60 * 1000,
      ).toISOString();

      const response = await request(app)
        .get(`/api/events?startDate=${startDate}&endDate=${endDate}`)
        .expect(200);

      expect(response.body.data.events).toHaveLength(2);
      const titles = response.body.data.events.map((e: any) => e.title);
      expect(titles).toContain("JavaScript Workshop");
      expect(titles).toContain("Community Cleanup");
    });

    it("should filter by participant capacity", async () => {
      // First, let's see what events exist
      const allEventsResponse = await request(app)
        .get("/api/events")
        .expect(200);

      console.log("All events in database:");
      allEventsResponse.body.data.events.forEach((event: any) => {
        console.log(
          `- ${event.title}: totalSlots=${event.totalSlots}, maxParticipants=${event.maxParticipants}`,
        );
      });

      const response = await request(app)
        .get("/api/events?minParticipants=100")
        .expect(200);

      expect(response.body.data.events).toHaveLength(1);
      expect(response.body.data.events[0]).toMatchObject({
        title: "React Conference",
        totalSlots: 100,
      });
    });

    // Note: The /api/events/templates endpoint was removed as part of moving to
    // database-only templates. Role templates are now managed via the
    // /api/roles-templates endpoint and stored in the database.
  });
});
