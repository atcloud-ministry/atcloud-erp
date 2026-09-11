import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../src/app";
import { User, Event, Registration, AuditLog } from "../../../src/models";

/**
 * Integration tests for Email Notifications API endpoints
 * Route: /api/email-notifications/*
 *
 * Tests cover:
 * - Authentication requirements
 * - Event creation notifications
 * - Role change notifications (system authorization and @Cloud roles)
 * - Admin notifications (new leader signup)
 * - Event management notifications (co-organizer assigned, event reminders)
 * - Scheduler endpoint
 * - Request validation
 * - Response format
 */

describe("Email Notifications API - Integration Tests", () => {
  let adminToken: string;
  let leaderToken: string;
  let guestExpertToken: string;
  let memberToken: string;
  let adminUserId: string;
  let leaderUserId: string;
  let memberUserId: string;
  let testEventId: string;
  let openedLocal = false;

  beforeAll(async () => {
    // Check if MongoDB is already connected, if not connect
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(
        process.env.MONGODB_TEST_URI ||
          "mongodb://127.0.0.1:27017/atcloud-signup-test",
      );
      openedLocal = true;
    }

    // Clean up test data
    await User.deleteMany({});
    await Event.deleteMany({});
    await Registration.deleteMany({});
    await AuditLog.deleteMany({});

    // Create admin user
    const adminRegister = await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      username: "emailnotif_admin",
      email: "emailnotif.admin@test.com",
      password: "Admin123!@#",
      confirmPassword: "Admin123!@#",
      firstName: "Admin",
      lastName: "User",
      gender: "male",
      phoneNumber: "+1234567890",
      roleInAtCloud: "Member",
      bio: "",
      isAtCloudLeader: false,
      acceptTerms: true,
    });

    if (!adminRegister.body.success) {
      console.log(
        "Admin registration response:",
        JSON.stringify(adminRegister.body, null, 2),
      );
      throw new Error(
        `Admin registration failed: ${adminRegister.body.message}`,
      );
    }

    adminUserId = adminRegister.body.data.user.id;

    // Manually verify and set admin role
    const adminUser = await User.findOne({
      email: "emailnotif.admin@test.com",
    });
    if (!adminUser) {
      throw new Error("Admin user not found after registration");
    }
    adminUser.isVerified = true;
    adminUser.role = "Super Admin";
    await adminUser.save();

    // Login admin
    const adminLogin = await request(app).post("/api/auth/login").send({
      emailOrUsername: "emailnotif.admin@test.com",
      password: "Admin123!@#",
    });

    if (!adminLogin.body.success) {
      throw new Error(`Admin login failed: ${adminLogin.body.message}`);
    }

    adminToken = adminLogin.body.data.accessToken;

    // Create leader user
    const leaderRegister = await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      username: "emailnotif_leader",
      email: "emailnotif.leader@test.com",
      password: "Leader123!@#",
      confirmPassword: "Leader123!@#",
      firstName: "Leader",
      lastName: "User",
      gender: "female",
      phoneNumber: "+1234567891",
      roleInAtCloud: "Member",
      bio: "",
      isAtCloudLeader: false,
      acceptTerms: true,
    });

    if (!leaderRegister.body.success) {
      throw new Error(
        `Leader registration failed: ${leaderRegister.body.message}`,
      );
    }

    leaderUserId = leaderRegister.body.data.user.id;

    // Manually verify and set leader role
    const leaderUser = await User.findOne({
      email: "emailnotif.leader@test.com",
    });
    if (!leaderUser) {
      throw new Error("Leader user not found after registration");
    }
    leaderUser.isVerified = true;
    leaderUser.role = "Leader";
    leaderUser.roleInAtCloud = "Leader";
    await leaderUser.save();

    // Login leader
    const leaderLogin = await request(app).post("/api/auth/login").send({
      emailOrUsername: "emailnotif.leader@test.com",
      password: "Leader123!@#",
    });

    if (!leaderLogin.body.success) {
      throw new Error(`Leader login failed: ${leaderLogin.body.message}`);
    }

    leaderToken = leaderLogin.body.data.accessToken;

    const guestExpert = await User.create({
      username: "emailnotif_guest",
      email: "emailnotif.guest.expert@test.com",
      password: "Guest123!@#",
      firstName: "Guest",
      lastName: "Expert",
      gender: "female",
      role: "Guest Expert",
      isVerified: true,
      isActive: true,
    });

    const guestExpertLogin = await request(app).post("/api/auth/login").send({
      emailOrUsername: guestExpert.email,
      password: "Guest123!@#",
    });

    if (!guestExpertLogin.body.success) {
      throw new Error(
        `Guest Expert login failed: ${guestExpertLogin.body.message}`,
      );
    }

    guestExpertToken = guestExpertLogin.body.data.accessToken;

    // Create regular member
    const memberRegister = await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      username: "emailnotif_member",
      email: "emailnotif.member@test.com",
      password: "Member123!@#",
      confirmPassword: "Member123!@#",
      firstName: "Member",
      lastName: "User",
      gender: "male",
      phoneNumber: "+1234567892",
      roleInAtCloud: "Member",
      bio: "",
      isAtCloudLeader: false,
      acceptTerms: true,
    });

    if (!memberRegister.body.success) {
      throw new Error(
        `Member registration failed: ${memberRegister.body.message}`,
      );
    }

    memberUserId = memberRegister.body.data.user.id; // Manually verify member
    const memberUser = await User.findOne({
      email: "emailnotif.member@test.com",
    });
    if (!memberUser) {
      throw new Error("Member user not found after registration");
    }
    memberUser.isVerified = true;
    await memberUser.save();

    // Login member
    const memberLogin = await request(app).post("/api/auth/login").send({
      emailOrUsername: "emailnotif.member@test.com",
      password: "Member123!@#",
    });

    if (!memberLogin.body.success) {
      throw new Error(`Member login failed: ${memberLogin.body.message}`);
    }

    memberToken = memberLogin.body.data.accessToken;

    // Create a test event
    const eventResponse = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Test Event for Email Notifications",
        type: "Conference",
        date: "2027-06-15",
        endDate: "2027-06-15",
        time: "14:00",
        endTime: "15:00",
        location: "Test Location",
        purpose:
          "This is a test event purpose for email notification integration testing",
        agenda: "Welcome and Introduction\nMain Session\nQ&A",
        format: "In-person",
        organizer: "Test Organizer",
        roles: [
          {
            name: "Participant",
            description: "General participation role",
            maxParticipants: 20,
          },
        ],
        timeZone: "America/Los_Angeles",
        suppressNotifications: true,
      });

    if (!eventResponse.body.success || !eventResponse.body.data) {
      throw new Error(
        `Event creation failed: ${eventResponse.status} - ${
          eventResponse.body.message || "Unknown error"
        } - Details: ${JSON.stringify(eventResponse.body, null, 2)}`,
      );
    }

    testEventId = eventResponse.body.data.event.id;
  }, 30000);

  afterAll(async () => {
    // Clean up test data
    await User.deleteMany({});
    await Event.deleteMany({});
    await Registration.deleteMany({});
    await AuditLog.deleteMany({});

    if (openedLocal) {
      // Shared integration harness owns connection lifecycle.
    }
  });

  afterEach(async () => {
    // Clean up audit logs between tests
    await AuditLog.deleteMany({});
  });

  // ========================================
  // Authentication Tests
  // ========================================

  describe("Authentication and Authorization", () => {
    const controlPlaneEndpoints = [
      "/event-created",
      "/system-authorization-change",
      "/atcloud-role-change",
      "/new-leader-signup",
      "/co-organizer-assigned",
      "/event-reminder",
      "/password-reset",
      "/email-verification",
      "/security-alert",
      "/schedule-reminder",
      "/event-role-removal",
      "/event-role-move",
    ] as const;

    it("requires authentication for every control-plane endpoint", async () => {
      for (const endpoint of controlPlaneEndpoints) {
        const response = await request(app).post(
          `/api/email-notifications${endpoint}`,
        );

        expect(response.status, endpoint).toBe(401);
        expect(response.body.success, endpoint).toBe(false);
      }
    });

    it("denies every role without notification-management permission", async () => {
      const deniedPrincipals = [
        ["Participant", memberToken],
        ["Guest Expert", guestExpertToken],
        ["Leader", leaderToken],
      ] as const;

      for (const [role, token] of deniedPrincipals) {
        for (const endpoint of controlPlaneEndpoints) {
          const response = await request(app)
            .post(`/api/email-notifications${endpoint}`)
            .set("Authorization", `Bearer ${token}`)
            .send({});

          expect(response.status, `${role}: ${endpoint}`).toBe(403);
          expect(response.body.success, `${role}: ${endpoint}`).toBe(false);
        }
      }
    });

    it("should accept requests with valid authentication token", async () => {
      const response = await request(app)
        .post("/api/email-notifications/event-created")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          eventData: {
            title: "Test Event",
            date: "2026-01-15",
            time: "14:00",
            location: "Test Location",
            organizerName: "Test Organizer",
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it("does not expose the former test-event-reminder endpoint", async () => {
      const response = await request(app)
        .post("/api/email-notifications/test-event-reminder")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          eventId: testEventId,
          eventData: {
            title: "Test Event",
            date: "2026-01-15",
            time: "14:00",
            location: "Test Location",
          },
          reminderType: "24h",
        });

      expect(response.status).toBe(404);
    });
  });

  // ========================================
  // Event Creation Notification Tests
  // ========================================

  describe("POST /api/email-notifications/event-created", () => {
    it("should send event creation notifications successfully", async () => {
      const response = await request(app)
        .post("/api/email-notifications/event-created")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          eventData: {
            title: "New Amazing Event",
            date: "2026-01-20",
            time: "18:00",
            location: "Community Center",
            organizerName: "Admin User",
            endTime: "20:00",
            purpose: "Fellowship",
            format: "In-Person",
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.recipientCount).toBeGreaterThanOrEqual(0);
    });

    it("should exclude specified email from recipients", async () => {
      const response = await request(app)
        .post("/api/email-notifications/event-created")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          eventData: {
            title: "Exclusive Event",
            date: "2026-01-25",
            time: "19:00",
            location: "Private Venue",
            organizerName: "Admin User",
          },
          excludeEmail: "emailnotif.member@test.com",
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it("should reject request with missing event title", async () => {
      const response = await request(app)
        .post("/api/email-notifications/event-created")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          eventData: {
            date: "2026-01-15",
            time: "14:00",
            location: "Test Location",
            organizerName: "Test Organizer",
          },
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain("title");
    });

    it("should reject request with missing event date", async () => {
      const response = await request(app)
        .post("/api/email-notifications/event-created")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          eventData: {
            title: "Test Event",
            time: "14:00",
            location: "Test Location",
            organizerName: "Test Organizer",
          },
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain("date");
    });

    it("should handle optional event fields correctly", async () => {
      const response = await request(app)
        .post("/api/email-notifications/event-created")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          eventData: {
            title: "Simple Event",
            date: "2026-01-30",
            time: "10:00",
            location: "Simple Location",
            organizerName: "Simple Organizer",
            // No optional fields
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  // ========================================
  // System Authorization Change Tests
  // ========================================

  describe("POST /api/email-notifications/system-authorization-change", () => {
    it("should send promotion notification successfully", async () => {
      const response = await request(app)
        .post("/api/email-notifications/system-authorization-change")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          userData: {
            _id: memberUserId,
            firstName: "Member",
            lastName: "User",
            email: "emailnotif.member@test.com",
            oldRole: "Participant",
            newRole: "Leader",
          },
          changedBy: {
            firstName: "Admin",
            lastName: "User",
            email: "emailnotif.admin@test.com",
            role: "Super Admin",
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain(
        "Promotion notification sent with email, system message, and bell notification",
      );
    });

    it("should send demotion notification successfully", async () => {
      const response = await request(app)
        .post("/api/email-notifications/system-authorization-change")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          userData: {
            _id: leaderUserId,
            firstName: "Leader",
            lastName: "User",
            email: "emailnotif.leader@test.com",
            oldRole: "Leader",
            newRole: "Participant",
          },
          changedBy: {
            firstName: "Admin",
            lastName: "User",
            email: "emailnotif.admin@test.com",
            role: "Super Admin",
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain(
        "Role change notification sent with email, system message, and bell notification",
      );
    });

    it("should reject request with missing user ID", async () => {
      const response = await request(app)
        .post("/api/email-notifications/system-authorization-change")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          userData: {
            firstName: "Test",
            lastName: "User",
            email: "test@test.com",
            oldRole: "Member",
            newRole: "Leader",
          },
          changedBy: {
            firstName: "Admin",
            lastName: "User",
            email: "admin@test.com",
            role: "Super Admin",
          },
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it("should handle request with same old and new roles gracefully", async () => {
      const response = await request(app)
        .post("/api/email-notifications/system-authorization-change")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          userData: {
            _id: memberUserId,
            firstName: "Member",
            lastName: "User",
            email: "emailnotif.member@test.com",
            oldRole: "Participant",
            newRole: "Participant",
          },
          changedBy: {
            firstName: "Admin",
            lastName: "User",
            email: "emailnotif.admin@test.com",
            role: "Super Admin",
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain("Role has not changed");
      expect(response.body.emailsSent).toBe(0);
    });
  });

  // ========================================
  // @Cloud Role Change Tests
  // ========================================

  describe("POST /api/email-notifications/atcloud-role-change", () => {
    it("should send @Cloud role change notification successfully", async () => {
      const response = await request(app)
        .post("/api/email-notifications/atcloud-role-change")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          userData: {
            _id: memberUserId,
            firstName: "Member",
            lastName: "User",
            email: "emailnotif.member@test.com",
            oldRoleInAtCloud: "Member",
            newRoleInAtCloud: "Leader",
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain(
        "@Cloud role change notification sent",
      );
    });

    it("should reject request with missing user data", async () => {
      const response = await request(app)
        .post("/api/email-notifications/atcloud-role-change")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });
  });

  // ========================================
  // New Leader Signup Tests
  // ========================================

  describe("POST /api/email-notifications/new-leader-signup", () => {
    it("should send new leader signup notification to admins", async () => {
      const response = await request(app)
        .post("/api/email-notifications/new-leader-signup")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          userData: {
            firstName: "New",
            lastName: "Leader",
            email: "new.leader@test.com",
            roleInAtCloud: "Leader",
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain("notification sent");
    });

    it("should reject request with missing user data", async () => {
      const response = await request(app)
        .post("/api/email-notifications/new-leader-signup")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });
  });

  // ========================================
  // Co-Organizer Assignment Tests
  // ========================================

  describe("POST /api/email-notifications/co-organizer-assigned", () => {
    it("should send co-organizer assignment notification successfully", async () => {
      const response = await request(app)
        .post("/api/email-notifications/co-organizer-assigned")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          assignedUser: {
            email: "emailnotif.leader@test.com",
            firstName: "Leader",
            lastName: "User",
          },
          eventData: {
            title: "Test Event",
            date: "2026-01-15",
            time: "14:00",
            location: "Test Location",
          },
          assignedBy: {
            firstName: "Admin",
            lastName: "User",
            email: "emailnotif.admin@test.com",
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain(
        "Co-organizer assignment notification sent",
      );
    });

    it("should reject request with missing assigned user", async () => {
      const response = await request(app)
        .post("/api/email-notifications/co-organizer-assigned")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          eventData: {
            title: "Test Event",
            date: "2026-01-15",
            time: "14:00",
            location: "Test Location",
          },
          assignedBy: {
            firstName: "Admin",
            lastName: "User",
            email: "emailnotif.admin@test.com",
          },
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });
  });

  // ========================================
  // Event Reminder Tests
  // ========================================

  describe("POST /api/email-notifications/event-reminder", () => {
    it("should deny a user without notification-management permission", async () => {
      const response = await request(app)
        .post("/api/email-notifications/event-reminder")
        .set("Authorization", `Bearer ${memberToken}`)
        .send({
          eventId: testEventId,
          eventData: {
            title: "Test Event",
            date: "2026-01-15",
            time: "14:00",
            location: "Test Location",
          },
          reminderType: "1h",
        });

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
    });

    it("should send event reminder notification successfully", async () => {
      const response = await request(app)
        .post("/api/email-notifications/event-reminder")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          eventId: testEventId,
          eventData: {
            title: "Test Event",
            date: "2026-01-15",
            time: "14:00",
            location: "Test Location",
          },
          reminderType: "24h",
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it("should handle 1h reminder type", async () => {
      const response = await request(app)
        .post("/api/email-notifications/event-reminder")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          eventId: testEventId,
          eventData: {
            title: "Test Event",
            date: "2026-01-15",
            time: "14:00",
            location: "Test Location",
          },
          reminderType: "1h",
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it("should handle 1week reminder type", async () => {
      const response = await request(app)
        .post("/api/email-notifications/event-reminder")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          eventId: testEventId,
          eventData: {
            title: "Test Event",
            date: "2026-01-15",
            time: "14:00",
            location: "Test Location",
          },
          reminderType: "1week",
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it("should reject request with missing event ID", async () => {
      const response = await request(app)
        .post("/api/email-notifications/event-reminder")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          eventData: {
            title: "Test Event",
            date: "2026-01-15",
            time: "14:00",
            location: "Test Location",
          },
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });
  });

  // ========================================
  // Schedule Reminder Tests
  // ========================================

  describe("POST /api/email-notifications/schedule-reminder", () => {
    it("should trigger manual reminder check successfully", async () => {
      const response = await request(app)
        .post("/api/email-notifications/schedule-reminder")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain("reminder check triggered");
    });

    it("should deny a user without notification-management permission", async () => {
      const response = await request(app)
        .post("/api/email-notifications/schedule-reminder")
        .set("Authorization", `Bearer ${memberToken}`)
        .send({});

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
    });
  });

  // ========================================
  // Not Implemented Endpoints Tests
  // ========================================

  describe("Not Implemented Endpoints", () => {
    it("should return 501 for password-reset endpoint", async () => {
      const response = await request(app)
        .post("/api/email-notifications/password-reset")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({});

      expect(response.status).toBe(501);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain("Not implemented");
    });

    it("should return 501 for email-verification endpoint", async () => {
      const response = await request(app)
        .post("/api/email-notifications/email-verification")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({});

      expect(response.status).toBe(501);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain("Not implemented");
    });

    it("should return 501 for security-alert endpoint", async () => {
      const response = await request(app)
        .post("/api/email-notifications/security-alert")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({});

      expect(response.status).toBe(501);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain("Not implemented");
    });
  });
});
