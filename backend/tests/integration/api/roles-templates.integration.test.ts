import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
/**
 * Roles Templates API Integration Tests
 *
 * Tests the role templates management system including:
 * - Template CRUD operations (Create, Read, Update, Delete)
 * - Permission-based access control (Super Admin, Administrator, Leader, Creator)
 * - Template validation and error handling
 * - Event type filtering and grouping
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
import RolesTemplate from "../../../src/models/RolesTemplate";
import { ensureIntegrationDB } from "../setup/connect";

describe("Roles Templates API Integration Tests", () => {
  let superAdminToken: string;
  let adminToken: string;
  let leaderToken: string;
  let participantToken: string;
  let superAdminId: string;
  let adminId: string;
  let leaderId: string;
  let participantId: string;
  let usersInitialized = false;

  async function ensureBaseUsers() {
    if (usersInitialized) return;

    await User.deleteMany({});
    await RolesTemplate.deleteMany({});

    // Super Admin - Create directly in database (pre-save hook will hash password)
    const superAdminUser = await User.create({
      ...TEST_REGISTRATION_PROFILE,
      username: "superadmin",
      email: "superadmin@example.com",
      password: "SuperPass123!",
      firstName: "Super",
      lastName: "Admin",
      role: "Super Admin",
      gender: "male",
      isAtCloudLeader: false,
      isVerified: true,
      isActive: true,
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
    } as any);
    superAdminId = superAdminUser._id.toString();
    const superAdminLogin = await request(app).post("/api/auth/login").send({
      emailOrUsername: "superadmin@example.com",
      password: "SuperPass123!",
    });
    superAdminToken = superAdminLogin.body.data.accessToken;

    // Administrator - Create directly in database (pre-save hook will hash password)
    const adminUser = await User.create({
      ...TEST_REGISTRATION_PROFILE,
      username: "admin",
      email: "admin@example.com",
      password: "AdminPass123!",
      firstName: "Admin",
      lastName: "User",
      role: "Administrator",
      gender: "male",
      isAtCloudLeader: false,
      isVerified: true,
      isActive: true,
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
    } as any);
    adminId = adminUser._id.toString();
    const adminLogin = await request(app).post("/api/auth/login").send({
      emailOrUsername: "admin@example.com",
      password: "AdminPass123!",
    });
    adminToken = adminLogin.body.data.accessToken;

    // Leader - Create directly in database (pre-save hook will hash password)
    const leaderUser = await User.create({
      ...TEST_REGISTRATION_PROFILE,
      username: "leader",
      email: "leader@example.com",
      password: "LeaderPass123!",
      firstName: "Leader",
      lastName: "User",
      role: "Leader",
      gender: "male",
      isAtCloudLeader: true,
      isVerified: true,
      isActive: true,
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
    } as any);
    leaderId = leaderUser._id.toString();
    const leaderLogin = await request(app).post("/api/auth/login").send({
      emailOrUsername: "leader@example.com",
      password: "LeaderPass123!",
    });
    leaderToken = leaderLogin.body.data.accessToken;

    // Participant - Create directly in database (pre-save hook will hash password)
    const participantUser = await User.create({
      ...TEST_REGISTRATION_PROFILE,
      username: "participant",
      email: "participant@example.com",
      password: "PartPass123!",
      firstName: "Participant",
      lastName: "User",
      role: "Participant",
      gender: "female",
      isAtCloudLeader: false,
      isVerified: true,
      isActive: true,
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
    } as any);
    participantId = participantUser._id.toString();
    const participantLogin = await request(app).post("/api/auth/login").send({
      emailOrUsername: "participant@example.com",
      password: "PartPass123!",
    });
    participantToken = participantLogin.body.data.accessToken;

    usersInitialized = true;
  }

  beforeAll(async () => {
    await ensureIntegrationDB();
    await ensureBaseUsers();
  });

  beforeEach(async () => {
    if (!usersInitialized) await ensureBaseUsers();
    // Clear templates before each test
    await RolesTemplate.deleteMany({});
  });

  afterAll(async () => {
    await RolesTemplate.deleteMany({});
    await User.deleteMany({});
    // Shared integration harness owns connection lifecycle.
  });

  describe("GET /api/roles-templates", () => {
    it("should return all templates grouped by event type", async () => {
      // Create test templates
      await RolesTemplate.create([
        {
          name: "Conference Template 1",
          eventType: "Conference",
          roles: [
            {
              name: "Speaker",
              description: "Test speaker",
              maxParticipants: 5,
            },
            {
              name: "Attendee",
              description: "Test attendee",
              maxParticipants: 100,
            },
          ],
          createdBy: superAdminId,
        },
        {
          name: "Conference Template 2",
          eventType: "Conference",
          roles: [
            {
              name: "Moderator",
              description: "Test moderator",
              maxParticipants: 2,
            },
          ],
          createdBy: superAdminId,
        },
        {
          name: "Webinar Template",
          eventType: "Webinar",
          roles: [
            { name: "Host", description: "Test host", maxParticipants: 1 },
          ],
          createdBy: adminId,
        },
      ]);

      const response = await request(app)
        .get("/api/roles-templates")
        .set("Authorization", `Bearer ${participantToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeDefined();
      expect(response.body.data.Conference).toHaveLength(2);
      expect(response.body.data.Webinar).toHaveLength(1);
      expect(response.body.data.Conference[0]).toHaveProperty("name");
      expect(response.body.data.Conference[0]).toHaveProperty("roles");
      expect(response.body.data.Conference[0]).toHaveProperty("createdBy");
    });

    it("should return empty object when no templates exist", async () => {
      const response = await request(app)
        .get("/api/roles-templates")
        .set("Authorization", `Bearer ${participantToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual({});
    });

    it("should require authentication", async () => {
      const response = await request(app).get("/api/roles-templates");

      expect(response.status).toBe(401);
    });
  });

  describe("GET /api/roles-templates/event-type/:eventType", () => {
    beforeEach(async () => {
      await RolesTemplate.create([
        {
          name: "Conference Template 1",
          eventType: "Conference",
          roles: [{ name: "Speaker", description: "Test", maxParticipants: 5 }],
          createdBy: superAdminId,
        },
        {
          name: "Conference Template 2",
          eventType: "Conference",
          roles: [
            { name: "Attendee", description: "Test", maxParticipants: 100 },
          ],
          createdBy: superAdminId,
        },
      ]);
    });

    it("should return templates for specific event type", async () => {
      const response = await request(app)
        .get("/api/roles-templates/event-type/Conference")
        .set("Authorization", `Bearer ${participantToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.data[0].eventType).toBe("Conference");
    });

    it("should return empty array for event type with no templates", async () => {
      const response = await request(app)
        .get("/api/roles-templates/event-type/Webinar")
        .set("Authorization", `Bearer ${participantToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual([]);
    });
  });

  describe("GET /api/roles-templates/:id", () => {
    it("should return a single template by ID", async () => {
      const template = await RolesTemplate.create({
        name: "Test Template",
        eventType: "Conference",
        roles: [
          { name: "Speaker", description: "Test speaker", maxParticipants: 5 },
        ],
        createdBy: superAdminId,
      });

      const response = await request(app)
        .get(`/api/roles-templates/${template._id}`)
        .set("Authorization", `Bearer ${participantToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.name).toBe("Test Template");
      expect(response.body.data.eventType).toBe("Conference");
      expect(response.body.data.roles).toHaveLength(1);
    });

    it("should return 404 for non-existent template", async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const response = await request(app)
        .get(`/api/roles-templates/${fakeId}`)
        .set("Authorization", `Bearer ${participantToken}`);

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
    });

    it("should return 400 for invalid ID", async () => {
      const response = await request(app)
        .get("/api/roles-templates/invalid-id")
        .set("Authorization", `Bearer ${participantToken}`);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });
  });

  describe("POST /api/roles-templates", () => {
    const validTemplate = {
      name: "New Conference Template",
      eventType: "Conference",
      roles: [
        {
          name: "Speaker",
          description: "Main speaker for the event",
          maxParticipants: 5,
          openToPublic: false,
        },
        {
          name: "Attendee",
          description: "Event attendee",
          maxParticipants: 100,
          openToPublic: true,
        },
      ],
    };

    it("should allow Super Admin to create template", async () => {
      const response = await request(app)
        .post("/api/roles-templates")
        .set("Authorization", `Bearer ${superAdminToken}`)
        .send(validTemplate);

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.name).toBe(validTemplate.name);
      expect(response.body.data.eventType).toBe(validTemplate.eventType);
      expect(response.body.data.roles).toHaveLength(2);
      expect(response.body.data.createdBy).toBeDefined();
    });

    it("should allow Administrator to create template", async () => {
      const response = await request(app)
        .post("/api/roles-templates")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(validTemplate);

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
    });

    it("should allow Leader to create template", async () => {
      const response = await request(app)
        .post("/api/roles-templates")
        .set("Authorization", `Bearer ${leaderToken}`)
        .send(validTemplate);

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
    });

    it("should deny Participant from creating template", async () => {
      const response = await request(app)
        .post("/api/roles-templates")
        .set("Authorization", `Bearer ${participantToken}`)
        .send(validTemplate);

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
    });

    it("should require template name", async () => {
      const invalidTemplate = { ...validTemplate, name: "" };
      const response = await request(app)
        .post("/api/roles-templates")
        .set("Authorization", `Bearer ${superAdminToken}`)
        .send(invalidTemplate);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it("should require event type", async () => {
      const invalidTemplate = { ...validTemplate, eventType: "" };
      const response = await request(app)
        .post("/api/roles-templates")
        .set("Authorization", `Bearer ${superAdminToken}`)
        .send(invalidTemplate);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it("should require at least one role", async () => {
      const invalidTemplate = { ...validTemplate, roles: [] };
      const response = await request(app)
        .post("/api/roles-templates")
        .set("Authorization", `Bearer ${superAdminToken}`)
        .send(invalidTemplate);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it("should validate role fields", async () => {
      const invalidTemplate = {
        ...validTemplate,
        roles: [{ name: "Speaker", description: "", maxParticipants: 0 }],
      };
      const response = await request(app)
        .post("/api/roles-templates")
        .set("Authorization", `Bearer ${superAdminToken}`)
        .send(invalidTemplate);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it("should support optional role fields", async () => {
      const templateWithOptionals = {
        ...validTemplate,
        roles: [
          {
            name: "Speaker",
            description: "Main speaker",
            maxParticipants: 5,
            openToPublic: true,
            agenda: "Opening remarks",
            startTime: "10:00",
            endTime: "11:00",
          },
        ],
      };

      const response = await request(app)
        .post("/api/roles-templates")
        .set("Authorization", `Bearer ${superAdminToken}`)
        .send(templateWithOptionals);

      expect(response.status).toBe(201);
      expect(response.body.data.roles[0].agenda).toBe("Opening remarks");
      expect(response.body.data.roles[0].startTime).toBe("10:00");
      expect(response.body.data.roles[0].endTime).toBe("11:00");
    });
  });

  describe("PUT /api/roles-templates/:id", () => {
    let template: any;

    beforeEach(async () => {
      template = await RolesTemplate.create({
        name: "Original Template",
        eventType: "Conference",
        roles: [{ name: "Speaker", description: "Test", maxParticipants: 5 }],
        createdBy: leaderId,
      });
    });

    it("should allow creator to update their template", async () => {
      const updates = {
        name: "Updated Template",
        roles: [
          {
            name: "Moderator",
            description: "Updated role",
            maxParticipants: 3,
          },
        ],
      };

      const response = await request(app)
        .put(`/api/roles-templates/${template._id}`)
        .set("Authorization", `Bearer ${leaderToken}`)
        .send(updates);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.name).toBe("Updated Template");
      expect(response.body.data.roles[0].name).toBe("Moderator");
    });

    it("should allow Super Admin to update any template", async () => {
      const updates = { name: "Admin Updated" };

      const response = await request(app)
        .put(`/api/roles-templates/${template._id}`)
        .set("Authorization", `Bearer ${superAdminToken}`)
        .send(updates);

      expect(response.status).toBe(200);
      expect(response.body.data.name).toBe("Admin Updated");
    });

    it("should allow Administrator to update any template", async () => {
      const updates = { name: "Admin Updated" };

      const response = await request(app)
        .put(`/api/roles-templates/${template._id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send(updates);

      expect(response.status).toBe(200);
    });

    it("should deny non-creator/non-admin from updating", async () => {
      const updates = { name: "Unauthorized Update" };

      const response = await request(app)
        .put(`/api/roles-templates/${template._id}`)
        .set("Authorization", `Bearer ${participantToken}`)
        .send(updates);

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
    });

    it("should validate updated roles", async () => {
      const updates = {
        roles: [{ name: "", description: "", maxParticipants: 0 }],
      };

      const response = await request(app)
        .put(`/api/roles-templates/${template._id}`)
        .set("Authorization", `Bearer ${leaderToken}`)
        .send(updates);

      expect(response.status).toBe(400);
    });

    it("should not allow event type change", async () => {
      const updates = { eventType: "Webinar" };

      const response = await request(app)
        .put(`/api/roles-templates/${template._id}`)
        .set("Authorization", `Bearer ${leaderToken}`)
        .send(updates);

      // Event type should remain unchanged
      const updated = await RolesTemplate.findById(template._id);
      expect(updated?.eventType).toBe("Conference");
    });
  });

  describe("DELETE /api/roles-templates/:id", () => {
    let template: any;

    beforeEach(async () => {
      template = await RolesTemplate.create({
        name: "Template to Delete",
        eventType: "Conference",
        roles: [{ name: "Speaker", description: "Test", maxParticipants: 5 }],
        createdBy: leaderId,
      });
    });

    it("should allow creator to delete their template", async () => {
      const response = await request(app)
        .delete(`/api/roles-templates/${template._id}`)
        .set("Authorization", `Bearer ${leaderToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      const deleted = await RolesTemplate.findById(template._id);
      expect(deleted).toBeNull();
    });

    it("should allow Super Admin to delete any template", async () => {
      const response = await request(app)
        .delete(`/api/roles-templates/${template._id}`)
        .set("Authorization", `Bearer ${superAdminToken}`);

      expect(response.status).toBe(200);
      const deleted = await RolesTemplate.findById(template._id);
      expect(deleted).toBeNull();
    });

    it("should allow Administrator to delete any template", async () => {
      const response = await request(app)
        .delete(`/api/roles-templates/${template._id}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
    });

    it("should deny non-creator/non-admin from deleting", async () => {
      const response = await request(app)
        .delete(`/api/roles-templates/${template._id}`)
        .set("Authorization", `Bearer ${participantToken}`);

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);

      const stillExists = await RolesTemplate.findById(template._id);
      expect(stillExists).not.toBeNull();
    });

    it("should return 404 for non-existent template", async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const response = await request(app)
        .delete(`/api/roles-templates/${fakeId}`)
        .set("Authorization", `Bearer ${superAdminToken}`);

      expect(response.status).toBe(404);
    });
  });

  describe("Complex Scenarios", () => {
    it("should handle multiple templates per event type correctly", async () => {
      // Create 3 templates for Conference
      await RolesTemplate.create([
        {
          name: "Small Conference",
          eventType: "Conference",
          roles: [{ name: "Speaker", description: "Test", maxParticipants: 2 }],
          createdBy: superAdminId,
        },
        {
          name: "Medium Conference",
          eventType: "Conference",
          roles: [{ name: "Speaker", description: "Test", maxParticipants: 5 }],
          createdBy: adminId,
        },
        {
          name: "Large Conference",
          eventType: "Conference",
          roles: [
            { name: "Speaker", description: "Test", maxParticipants: 10 },
          ],
          createdBy: leaderId,
        },
      ]);

      const response = await request(app)
        .get("/api/roles-templates/event-type/Conference")
        .set("Authorization", `Bearer ${participantToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(3);
    });

    it("should maintain template independence (updates don't affect others)", async () => {
      const template1 = await RolesTemplate.create({
        name: "Template 1",
        eventType: "Conference",
        roles: [{ name: "Role A", description: "Test", maxParticipants: 5 }],
        createdBy: superAdminId,
      });

      const template2 = await RolesTemplate.create({
        name: "Template 2",
        eventType: "Conference",
        roles: [{ name: "Role B", description: "Test", maxParticipants: 10 }],
        createdBy: superAdminId,
      });

      // Update template 1
      await request(app)
        .put(`/api/roles-templates/${template1._id}`)
        .set("Authorization", `Bearer ${superAdminToken}`)
        .send({ name: "Updated Template 1" });

      // Template 2 should remain unchanged
      const unchanged = await RolesTemplate.findById(template2._id);
      expect(unchanged?.name).toBe("Template 2");
    });
  });

  describe("Template Read-Only Permissions for Leaders", () => {
    let leaderTemplate: any;
    let otherUserTemplate: any;

    beforeEach(async () => {
      await RolesTemplate.deleteMany({});

      // Leader creates their own template
      leaderTemplate = await RolesTemplate.create({
        name: "Leader's Template",
        eventType: "Conference",
        roles: [
          { name: "Host", description: "Event host", maxParticipants: 1 },
        ],
        createdBy: leaderId,
      });

      // Super Admin creates a template
      otherUserTemplate = await RolesTemplate.create({
        name: "Super Admin's Template",
        eventType: "Webinar",
        roles: [
          {
            name: "Presenter",
            description: "Webinar presenter",
            maxParticipants: 2,
          },
        ],
        createdBy: superAdminId,
      });
    });

    it("should allow leader to GET their own template", async () => {
      const response = await request(app)
        .get(`/api/roles-templates/${leaderTemplate._id}`)
        .set("Authorization", `Bearer ${leaderToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.name).toBe("Leader's Template");
    });

    it("should allow leader to GET templates created by others (read-only access)", async () => {
      const response = await request(app)
        .get(`/api/roles-templates/${otherUserTemplate._id}`)
        .set("Authorization", `Bearer ${leaderToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.name).toBe("Super Admin's Template");
      expect(response.body.data.createdBy._id).toBe(superAdminId);
    });

    it("should allow leader to UPDATE their own template", async () => {
      const response = await request(app)
        .put(`/api/roles-templates/${leaderTemplate._id}`)
        .set("Authorization", `Bearer ${leaderToken}`)
        .send({
          name: "Updated Leader's Template",
          roles: [
            { name: "Host", description: "Updated host", maxParticipants: 1 },
          ],
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.name).toBe("Updated Leader's Template");
    });

    it("should DENY leader from UPDATING templates created by others", async () => {
      const response = await request(app)
        .put(`/api/roles-templates/${otherUserTemplate._id}`)
        .set("Authorization", `Bearer ${leaderToken}`)
        .send({
          name: "Attempting to Update",
          roles: [
            { name: "Presenter", description: "Updated", maxParticipants: 2 },
          ],
        });

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain(
        "only edit templates you created"
      );
    });

    it("should allow leader to DELETE their own template", async () => {
      const response = await request(app)
        .delete(`/api/roles-templates/${leaderTemplate._id}`)
        .set("Authorization", `Bearer ${leaderToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      const deleted = await RolesTemplate.findById(leaderTemplate._id);
      expect(deleted).toBeNull();
    });

    it("should DENY leader from DELETING templates created by others", async () => {
      const response = await request(app)
        .delete(`/api/roles-templates/${otherUserTemplate._id}`)
        .set("Authorization", `Bearer ${leaderToken}`);

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain(
        "only delete templates you created"
      );
    });

    it("should allow Super Admin to edit ANY template", async () => {
      const response = await request(app)
        .put(`/api/roles-templates/${leaderTemplate._id}`)
        .set("Authorization", `Bearer ${superAdminToken}`)
        .send({
          name: "Super Admin Edited",
          roles: [
            { name: "Host", description: "Admin edited", maxParticipants: 1 },
          ],
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it("should allow Administrator to delete ANY template", async () => {
      const response = await request(app)
        .delete(`/api/roles-templates/${leaderTemplate._id}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it("should list all templates to leader (including others' templates)", async () => {
      const response = await request(app)
        .get("/api/roles-templates")
        .set("Authorization", `Bearer ${leaderToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty("Conference");
      expect(response.body.data).toHaveProperty("Webinar");
      expect(response.body.data.Conference).toHaveLength(1);
      expect(response.body.data.Webinar).toHaveLength(1);
    });
  });
});
