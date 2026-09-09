/**
 * Users API Integration Tests
 *
 * Tests the complete user management flow including:
 * - User profile management
 * - User search and filtering
 * - Admin user operations
 * - Role-based access control
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";

describe("Users API Integration Tests", () => {
  let authToken: string;
  let adminToken: string;
  let userId: string;
  let adminId: string;

  beforeEach(async () => {
    // Clear users collection
    await User.deleteMany({});

    // Create regular user
    const userData = {
      username: "testuser",
      email: "test@example.com",
      password: "TestPass123!",
      confirmPassword: "TestPass123!",
      firstName: "Test",
      lastName: "User",
      role: "Participant",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
    };

    const userResponse = await request(app)
      .post("/api/auth/register")
      .send(userData);

    // Manually verify the user using email lookup
    await User.findOneAndUpdate(
      { email: "test@example.com" },
      { isVerified: true }
    );

    const loginResponse = await request(app).post("/api/auth/login").send({
      emailOrUsername: "test@example.com",
      password: "TestPass123!",
    });

    authToken = loginResponse.body.data.accessToken;
    userId = userResponse.body.data.user.id;

    // Create admin user
    const adminData = {
      username: "admin",
      email: "admin@example.com",
      password: "AdminPass123!",
      confirmPassword: "AdminPass123!",
      firstName: "Admin",
      lastName: "User",
      role: "Administrator", // This will be overridden to Participant by registration
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
    };

    const adminResponse = await request(app)
      .post("/api/auth/register")
      .send(adminData);

    // Manually verify the admin user and set proper role
    await User.findOneAndUpdate(
      { email: "admin@example.com" },
      { isVerified: true, role: "Administrator" } // Set to Administrator role for user management
    );

    const adminLoginResponse = await request(app).post("/api/auth/login").send({
      emailOrUsername: "admin@example.com",
      password: "AdminPass123!",
    });

    adminToken = adminLoginResponse.body.data.accessToken;
    adminId = adminResponse.body.data.user.id;
  });

  afterEach(async () => {
    await User.deleteMany({});
  });

  describe("GET /api/users", () => {
    beforeEach(async () => {
      // Create additional test users
      const users = [
        {
          username: "user1",
          email: "user1@example.com",
          password: "Password123!",
          confirmPassword: "Password123!",
          firstName: "John",
          lastName: "Doe",
          gender: "male",
          isAtCloudLeader: false,
          acceptTerms: true,
        },
        {
          username: "user2",
          email: "user2@example.com",
          password: "Password123!",
          confirmPassword: "Password123!",
          firstName: "Jane",
          lastName: "Smith",
          gender: "female",
          isAtCloudLeader: false,
          acceptTerms: true,
        },
      ];

      for (const user of users) {
        const registerResponse = await request(app)
          .post("/api/auth/register")
          .send(user);

        // Manually verify the users like we do for the main test users
        await User.findOneAndUpdate(
          { email: user.email },
          { isVerified: true }
        );
      }
    });

    it("should get all users with admin token", async () => {
      const response = await request(app)
        .get("/api/users")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        data: {
          users: expect.arrayContaining([
            expect.objectContaining({ username: "testuser" }),
            expect.objectContaining({ username: "admin" }),
            expect.objectContaining({ username: "user1" }),
            expect.objectContaining({ username: "user2" }),
          ]),
        },
      });

      // Should not include passwords
      response.body.data.users.forEach((user: any) => {
        expect(user.password).toBeUndefined();
      });
    });

    it("should direct non-admin user-list reads to the Community API", async () => {
      const response = await request(app)
        .get("/api/users")
        .set("Authorization", `Bearer ${authToken}`)
        .expect(403);

      expect(response.body).toMatchObject({
        success: false,
        message: expect.stringContaining("manage_users"),
      });
    });

    it("should require authentication", async () => {
      const response = await request(app).get("/api/users").expect(401);

      expect(response.body).toMatchObject({
        success: false,
        message: expect.stringContaining("token"),
      });
    });

    it("should paginate users", async () => {
      const response = await request(app)
        .get("/api/users?page=1&limit=2")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body.data.users).toHaveLength(2);
      expect(response.body.data).toMatchObject({
        pagination: {
          currentPage: 1,
          totalPages: expect.any(Number),
          totalUsers: expect.any(Number),
          hasNext: expect.any(Boolean),
          hasPrev: expect.any(Boolean),
        },
      });
    });

    it("should reject a page size above the contract maximum", async () => {
      const response = await request(app)
        .get("/api/users?page=1&limit=50")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(400);

      expect(response.body).toMatchObject({
        success: false,
        message: "Validation failed",
      });
    });

    it("should reject invalid pagination parameters", async () => {
      const response = await request(app)
        .get("/api/users?page=-5&limit=abc")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(400);

      expect(response.body).toMatchObject({
        success: false,
        message: "Validation failed",
      });
    });

    it("should filter users by role", async () => {
      const response = await request(app)
        .get("/api/users?role=Participant")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body.data.users).toHaveLength(3); // testuser, user1, user2 are all Participants
      const usernames = response.body.data.users.map((u: any) => u.username);
      expect(usernames).toEqual(
        expect.arrayContaining(["testuser", "user1", "user2"])
      );
    });

    it("should search users by name", async () => {
      const response = await request(app)
        .get("/api/users?search=John")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body.data.users).toHaveLength(1);
      expect(response.body.data.users[0]).toMatchObject({
        firstName: "John",
        lastName: "Doe",
      });
    });
  });

  describe("GET /api/users/:id", () => {
    it("should get user by ID with admin token", async () => {
      const response = await request(app)
        .get(`/api/users/${userId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        data: {
          user: {
            username: "testuser",
            email: "test@example.com",
            firstName: "Test",
            lastName: "User",
            role: "Participant",
          },
        },
      });

      // Should not include password
      expect(response.body.data.user.password).toBeUndefined();
    });

    it("should keep self-service profile reads on the profile endpoint", async () => {
      await request(app)
        .get(`/api/users/${userId}`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(403);
    });

    it("should reject Participant trying to get another user's profile", async () => {
      const response = await request(app)
        .get(`/api/users/${adminId}`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(403);

      expect(response.body).toMatchObject({
        success: false,
        message: expect.stringContaining("permission"),
      });
    });

    it("should allow Administrator to view Super Admin's profile (new rule)", async () => {
      // Create a Super Admin user
      const superAdminReg = await request(app).post("/api/auth/register").send({
        username: "sup",
        email: "sup@example.com",
        password: "SupPass123!",
        confirmPassword: "SupPass123!",
        firstName: "Sup",
        lastName: "Er",
        gender: "male",
        isAtCloudLeader: false,
        acceptTerms: true,
      });

      // Verify and promote to Super Admin
      await User.findOneAndUpdate(
        { email: "sup@example.com" },
        { isVerified: true, role: "Super Admin" }
      );

      const targetId = superAdminReg.body.data.user.id;

      // Admin should be able to fetch Super Admin profile
      const response = await request(app)
        .get(`/api/users/${targetId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        data: {
          user: expect.objectContaining({
            id: targetId,
            username: "sup",
            role: "Super Admin",
          }),
        },
      });
    });

    it("should return 404 for non-existent user", async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();

      const response = await request(app)
        .get(`/api/users/${fakeId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(404);

      expect(response.body).toMatchObject({
        success: false,
        message: expect.stringContaining("not found"),
      });
    });

    it("should return 400 for invalid user ID", async () => {
      const response = await request(app)
        .get("/api/users/invalid-id")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(400);

      expect(response.body).toMatchObject({
        success: false,
        message: expect.stringContaining("Validation failed"),
      });
    });
  });

  describe("GET /api/search/users", () => {
    beforeEach(async () => {
      // Create users with varied data for search testing
      const searchUsers = [
        {
          username: "developer",
          email: "dev@example.com",
          password: "Password123!",
          confirmPassword: "Password123!",
          firstName: "John",
          lastName: "Developer",
          gender: "male",
          isAtCloudLeader: false,
          acceptTerms: true,
        },
        {
          username: "designer",
          email: "design@example.com",
          password: "Password123!",
          confirmPassword: "Password123!",
          firstName: "Jane",
          lastName: "Designer",
          gender: "female",
          isAtCloudLeader: false,
          acceptTerms: true,
        },
      ];

      for (const user of searchUsers) {
        await request(app).post("/api/auth/register").send(user);

        // Manually verify the users
        await User.findOneAndUpdate(
          { email: user.email },
          { isVerified: true }
        );
      }
    });

    it("should search users by multiple criteria", async () => {
      const response = await request(app)
        .get("/api/search/users?q=John&role=Participant")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body.data.users).toHaveLength(1);
      expect(response.body.data.users[0]).toMatchObject({
        firstName: "John",
        lastName: "Developer",
        role: "Participant",
      });
    });

    it("should search by name keywords", async () => {
      const response = await request(app)
        .get("/api/search/users?q=Developer")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body.data.users).toHaveLength(1);
      expect(response.body.data.users[0]).toMatchObject({
        username: "developer",
      });
    });

    it("should return empty results for no matches", async () => {
      const response = await request(app)
        .get("/api/search/users?q=NonExistent")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body.data.users).toHaveLength(0);
    });

    it("should restrict compatibility user search to account managers", async () => {
      await request(app)
        .get("/api/search/users?q=John")
        .set("Authorization", `Bearer ${authToken}`)
        .expect(403);
    });
  });

  describe("PUT /api/users/profile", () => {
    it("should update own profile", async () => {
      const updateData = {
        firstName: "Updated",
        lastName: "Name",
        phone: "+1234567890",
      };

      const response = await request(app)
        .put(`/api/users/profile`)
        .set("Authorization", `Bearer ${authToken}`)
        .send(updateData)
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        message: expect.stringContaining("updated"),
        data: {
          firstName: "Updated",
          lastName: "Name",
          phone: "+1234567890",
        },
      });
    });

    it("should preserve protected account fields during profile updates", async () => {
      const userBefore = await User.findById(userId).select("+password");
      expect(userBefore).not.toBeNull();
      const passwordBefore = userBefore!.password;

      await request(app)
        .put("/api/users/profile")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          firstName: "Still Participant",
          role: "Super Admin",
          isActive: false,
          isVerified: false,
          password: "AttackerPass123!",
          passwordResetToken: "attacker-token",
        })
        .expect(200);

      const userAfter = await User.findById(userId).select(
        "+password +passwordResetToken",
      );
      expect(userAfter).toMatchObject({
        firstName: "Still Participant",
        role: "Participant",
        isActive: true,
        isVerified: true,
      });
      expect(userAfter!.password).toBe(passwordBefore);
      expect(userAfter!.passwordResetToken).toBeUndefined();
    });

    it("should validate email format", async () => {
      const updateData = {
        email: "invalid-email",
      };

      const response = await request(app)
        .put(`/api/users/profile`)
        .set("Authorization", `Bearer ${authToken}`)
        .send(updateData)
        .expect(400);

      expect(response.body).toMatchObject({
        success: false,
        message: expect.stringContaining("Validation failed"),
      });
    });

    it("should validate phone format", async () => {
      const updateData = {
        phone: "invalid-phone",
      };

      const response = await request(app)
        .put(`/api/users/profile`)
        .set("Authorization", `Bearer ${authToken}`)
        .send(updateData)
        .expect(400);

      expect(response.body).toMatchObject({
        success: false,
        message: expect.stringContaining("Validation failed"),
      });
    });
  });

  describe("PUT /api/users/:id/role", () => {
    it("should allow admin to update user role", async () => {
      const updateData = {
        role: "Leader",
      };

      const response = await request(app)
        .put(`/api/users/${userId}/role`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send(updateData)
        .expect(200);

      expect(response.body.data.user).toMatchObject({
        role: "Leader",
      });
    });

    it("should reject user trying to update another user's role", async () => {
      const updateData = {
        role: "Admin",
      };

      const response = await request(app)
        .put(`/api/users/${adminId}/role`)
        .set("Authorization", `Bearer ${authToken}`)
        .send(updateData)
        .expect(403);

      expect(response.body).toMatchObject({
        success: false,
        message: expect.stringContaining("Access denied"),
      });
    });

    it("should reject user trying to change their own role", async () => {
      const updateData = {
        role: "admin",
      };

      const response = await request(app)
        .put(`/api/users/${userId}/role`)
        .set("Authorization", `Bearer ${authToken}`)
        .send(updateData)
        .expect(403);

      expect(response.body).toMatchObject({
        success: false,
        message: expect.stringContaining("Access denied"),
      });
    });
  });

  describe("DELETE /api/users/:id", () => {
    it("should allow Super Admin to delete user", async () => {
      // Create a Super Admin user
      const superAdminData = {
        username: "superadmin",
        email: "superadmin@example.com",
        password: "SuperPass123!",
        confirmPassword: "SuperPass123!",
        firstName: "Super",
        lastName: "Admin",
        role: "Participant", // Will be updated after registration
        gender: "male",
        isAtCloudLeader: false,
        acceptTerms: true,
      };

      await request(app).post("/api/auth/register").send(superAdminData);

      // Manually verify and set Super Admin role
      await User.findOneAndUpdate(
        { email: "superadmin@example.com" },
        { isVerified: true, role: "Super Admin" }
      );

      // Login to get Super Admin token
      const superAdminLoginResponse = await request(app)
        .post("/api/auth/login")
        .send({
          emailOrUsername: "superadmin@example.com",
          password: "SuperPass123!",
        });

      const superAdminToken = superAdminLoginResponse.body.data.accessToken;

      const response = await request(app)
        .delete(`/api/users/${userId}`)
        .set("Authorization", `Bearer ${superAdminToken}`)
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        message: expect.stringContaining("deleted"),
      });

      // Verify user was deleted
      const deletedUser = await User.findById(userId);
      expect(deletedUser).toBeNull();
    });

    it("should reject admin trying to delete user (Super Admin only)", async () => {
      const response = await request(app)
        .delete(`/api/users/${userId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(403);

      expect(response.body).toMatchObject({
        success: false,
        message: expect.stringContaining("Access denied"),
      });
    });

    it("should reject user trying to delete another user", async () => {
      const response = await request(app)
        .delete(`/api/users/${adminId}`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(403);

      expect(response.body).toMatchObject({
        success: false,
        message: expect.stringContaining("Access denied"),
      });
    });

    it("should return 404 for non-existent user (Super Admin)", async () => {
      // Create a Super Admin user for this test
      const superAdminData = {
        username: "superadmin2",
        email: "superadmin2@example.com",
        password: "SuperPass123!",
        confirmPassword: "SuperPass123!",
        firstName: "Super",
        lastName: "Admin2",
        role: "Participant",
        gender: "male",
        isAtCloudLeader: false,
        acceptTerms: true,
      };

      await request(app).post("/api/auth/register").send(superAdminData);

      await User.findOneAndUpdate(
        { email: "superadmin2@example.com" },
        { isVerified: true, role: "Super Admin" }
      );

      const superAdminLoginResponse = await request(app)
        .post("/api/auth/login")
        .send({
          emailOrUsername: "superadmin2@example.com",
          password: "SuperPass123!",
        });

      const superAdminToken = superAdminLoginResponse.body.data.accessToken;
      const fakeId = new mongoose.Types.ObjectId().toString();

      const response = await request(app)
        .delete(`/api/users/${fakeId}`)
        .set("Authorization", `Bearer ${superAdminToken}`)
        .expect(404);

      expect(response.body).toMatchObject({
        success: false,
        message: expect.stringContaining("not found"),
      });
    });
  });

  describe("POST /api/users/avatar", () => {
    it("should require a file for avatar upload", async () => {
      const response = await request(app)
        .post(`/api/users/avatar`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(400);

      expect(response.body).toMatchObject({
        success: false,
        message: expect.stringContaining("file"),
      });
    });

    it("should require authentication", async () => {
      const imageBuffer = Buffer.from("fake-image-data");

      const response = await request(app)
        .post(`/api/users/avatar`)
        .attach("avatar", imageBuffer, "test-avatar.jpg")
        .expect(401);

      expect(response.body).toMatchObject({
        success: false,
        message: expect.stringContaining("token"),
      });
    });
  });

  describe("POST /api/users/:id/change-password", () => {
    it("should change own password", async () => {
      const passwordData = {
        currentPassword: "TestPass123!",
        newPassword: "NewPassword123!",
        confirmPassword: "NewPassword123!",
      };

      const response = await request(app)
        .post(`/api/users/${userId}/change-password`)
        .set("Authorization", `Bearer ${authToken}`)
        .send(passwordData)
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        message: "Password changed successfully",
      });

      // Verify old password no longer works
      const oldPasswordResponse = await request(app)
        .post("/api/auth/login")
        .send({
          emailOrUsername: "test@example.com",
          password: "TestPass123!",
        })
        .expect(401);

      expect(oldPasswordResponse.body.success).toBe(false);

      // Verify can login with new password
      const loginResponse = await request(app)
        .post("/api/auth/login")
        .send({
          emailOrUsername: "test@example.com",
          password: "NewPassword123!",
        })
        .expect(200);

      expect(loginResponse.body.success).toBe(true);
    });

    it("should reject incorrect current password", async () => {
      const passwordData = {
        currentPassword: "WrongPassword123!",
        newPassword: "NewPassword123!",
        confirmPassword: "NewPassword123!",
      };

      const response = await request(app)
        .post(`/api/users/${userId}/change-password`)
        .set("Authorization", `Bearer ${authToken}`)
        .send(passwordData)
        .expect(400);

      expect(response.body).toMatchObject({
        success: false,
        error: "Current password is incorrect",
      });
    });

    it("should reject mismatched password confirmation", async () => {
      const passwordData = {
        currentPassword: "TestPass123!",
        newPassword: "NewPassword123!",
        confirmPassword: "DifferentPassword123!",
      };

      const response = await request(app)
        .post(`/api/users/${userId}/change-password`)
        .set("Authorization", `Bearer ${authToken}`)
        .send(passwordData)
        .expect(400);

      expect(response.body).toMatchObject({
        success: false,
        error: expect.stringContaining("confirm"),
      });
    });

    it("should reject weak new password", async () => {
      const passwordData = {
        currentPassword: "TestPass123!",
        newPassword: "weak",
        confirmPassword: "weak",
      };

      const response = await request(app)
        .post(`/api/users/${userId}/change-password`)
        .set("Authorization", `Bearer ${authToken}`)
        .send(passwordData)
        .expect(400);

      expect(response.body).toMatchObject({
        success: false,
        error: expect.stringContaining("password"),
      });
    });
  });

  describe("PUT /api/users/:id/admin-edit - Admin Profile Edit", () => {
    let targetUserId: string;
    let leaderToken: string;

    beforeEach(async () => {
      // Create a target user to edit
      const targetUser = await User.create({
        username: "targetuser",
        email: "target@example.com",
        password: "TargetPass123!",
        firstName: "Target",
        lastName: "User",
        role: "Participant",
        gender: "female",
        phone: "1234567890",
        isAtCloudLeader: false,
        roleInAtCloud: "",
        isVerified: true,
        isActive: true,
        acceptTerms: true,
      } as any);
      targetUserId = targetUser._id.toString();

      // Create a leader user
      const leaderUser = await User.create({
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
      } as any);

      const leaderLogin = await request(app).post("/api/auth/login").send({
        emailOrUsername: "leader@example.com",
        password: "LeaderPass123!",
      });
      leaderToken = leaderLogin.body.data.accessToken;
    });

    it("should allow Super Admin to edit other users' profiles", async () => {
      // Create Super Admin token
      const superAdminUser = await User.create({
        username: "superadmin",
        email: "superadmin@example.com",
        password: "SuperPass123!",
        firstName: "Super",
        lastName: "Admin",
        role: "Super Admin",
        gender: "male",
        isVerified: true,
        isActive: true,
        acceptTerms: true,
      } as any);

      const superAdminLogin = await request(app).post("/api/auth/login").send({
        emailOrUsername: "superadmin@example.com",
        password: "SuperPass123!",
      });
      const superAdminToken = superAdminLogin.body.data.accessToken;

      const response = await request(app)
        .put(`/api/users/${targetUserId}/admin-edit`)
        .set("Authorization", `Bearer ${superAdminToken}`)
        .send({
          phone: "9876543210",
          isAtCloudLeader: true,
          roleInAtCloud: "Technical Lead",
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain("updated successfully by admin");
      expect(response.body.data.phone).toBe("9876543210");
      expect(response.body.data.isAtCloudLeader).toBe(true);
      expect(response.body.data.roleInAtCloud).toBe("Technical Lead");

      // Verify in database
      const updatedUser = await User.findById(targetUserId);
      expect(updatedUser?.phone).toBe("9876543210");
      expect(updatedUser?.isAtCloudLeader).toBe(true);
      expect(updatedUser?.roleInAtCloud).toBe("Technical Lead");
    });

    it("should allow Administrator to edit other users' profiles", async () => {
      const response = await request(app)
        .put(`/api/users/${targetUserId}/admin-edit`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          phone: "5555555555",
          isAtCloudLeader: true,
          roleInAtCloud: "Project Manager",
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.phone).toBe("5555555555");
      expect(response.body.data.isAtCloudLeader).toBe(true);
      expect(response.body.data.roleInAtCloud).toBe("Project Manager");
    });

    it("should reject Leader from editing other users' profiles", async () => {
      const response = await request(app)
        .put(`/api/users/${targetUserId}/admin-edit`)
        .set("Authorization", `Bearer ${leaderToken}`)
        .send({
          phone: "9999999999",
        })
        .expect(403);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain("Access denied");

      // Verify user was not updated
      const unchangedUser = await User.findById(targetUserId);
      expect(unchangedUser?.phone).toBe("1234567890"); // Original value
    });

    it("should reject Participant from editing other users' profiles", async () => {
      const response = await request(app)
        .put(`/api/users/${targetUserId}/admin-edit`)
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          phone: "8888888888",
        })
        .expect(403);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain("Access denied");
    });

    it("should only allow editing specific fields (avatar, phone, isAtCloudLeader, roleInAtCloud)", async () => {
      // Attempt to edit fields that should not be editable
      const response = await request(app)
        .put(`/api/users/${targetUserId}/admin-edit`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          phone: "1111111111",
          isAtCloudLeader: true,
          roleInAtCloud: "Designer",
          // These fields should be ignored
          firstName: "Hacked",
          lastName: "Name",
          email: "hacked@example.com",
          role: "Super Admin", // Attempting privilege escalation
          password: "NewPassword123!",
        })
        .expect(200);

      expect(response.body.success).toBe(true);

      // Verify only allowed fields were updated
      const updatedUser = await User.findById(targetUserId);
      expect(updatedUser?.phone).toBe("1111111111");
      expect(updatedUser?.isAtCloudLeader).toBe(true);
      expect(updatedUser?.roleInAtCloud).toBe("Designer");

      // Verify restricted fields were NOT updated
      expect(updatedUser?.firstName).toBe("Target"); // Original value
      expect(updatedUser?.lastName).toBe("User"); // Original value
      expect(updatedUser?.email).toBe("target@example.com"); // Original value
      expect(updatedUser?.role).toBe("Participant"); // Original value
    });

    it("should require roleInAtCloud when setting isAtCloudLeader to true", async () => {
      const response = await request(app)
        .put(`/api/users/${targetUserId}/admin-edit`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          isAtCloudLeader: true,
          // Missing roleInAtCloud
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain(
        "Role in @Cloud is required for @Cloud co-workers"
      );
    });

    it("should clear roleInAtCloud when setting isAtCloudLeader to false", async () => {
      // First set user as @Cloud co-worker
      await User.findByIdAndUpdate(targetUserId, {
        isAtCloudLeader: true,
        roleInAtCloud: "Developer",
      });

      // Now remove @Cloud co-worker status
      const response = await request(app)
        .put(`/api/users/${targetUserId}/admin-edit`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          isAtCloudLeader: false,
        })
        .expect(200);

      expect(response.body.success).toBe(true);

      // Verify roleInAtCloud was cleared (could be undefined or empty string)
      const updatedUser = await User.findById(targetUserId);
      expect(updatedUser?.isAtCloudLeader).toBe(false);
      expect(updatedUser?.roleInAtCloud || undefined).toBeUndefined();
    });

    it("should return 404 when editing non-existent user", async () => {
      const fakeId = new mongoose.Types.ObjectId();

      const response = await request(app)
        .put(`/api/users/${fakeId}/admin-edit`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          phone: "7777777777",
        })
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain("User not found");
    });

    it("should update avatar field when provided", async () => {
      const response = await request(app)
        .put(`/api/users/${targetUserId}/admin-edit`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          avatar: "https://example.com/avatar.jpg",
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.avatar).toBe("https://example.com/avatar.jpg");

      const updatedUser = await User.findById(targetUserId);
      expect(updatedUser?.avatar).toBe("https://example.com/avatar.jpg");
    });

    it("should allow partial updates (only some fields)", async () => {
      const response = await request(app)
        .put(`/api/users/${targetUserId}/admin-edit`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          phone: "3333333333",
          // Not updating isAtCloudLeader or roleInAtCloud
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.phone).toBe("3333333333");

      // Verify other fields remain unchanged
      const updatedUser = await User.findById(targetUserId);
      expect(updatedUser?.isAtCloudLeader).toBe(false); // Original value
      // roleInAtCloud could be undefined or empty string when not set
      expect(updatedUser?.roleInAtCloud || "").toBe(""); // Original value
    });
  });
});
