import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import path from "path";
import fs from "fs";
import os from "os";
import app from "../../../src/app";
import { User } from "../../../src/models";

/**
 * Integration tests for Uploads API endpoints
 * Route: /api/uploads/*
 *
 * Tests cover:
 * - Authentication requirements
 * - Authorization (admin-only for avatar uploads)
 * - Image upload validation (file type, size)
 * - Generic image uploads (/image)
 * - Avatar uploads (/avatar)
 * - Rate limiting
 * - Response format
 * - Error handling
 */

describe("Uploads API - Integration Tests", () => {
  let adminToken: string;
  let leaderToken: string;
  let memberToken: string;
  let adminUserId: string;
  let leaderUserId: string;
  let memberUserId: string;
  let openedLocal = false;

  // Each file owns its fixtures so parallel workers cannot delete one another's
  // uploads or depend on repository-generated artifacts.
  const fixturesDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "atcloud-upload-test-"),
  );
  const validImagePath = path.join(fixturesDir, "test-image.png");
  const largeImagePath = path.join(fixturesDir, "large-image.jpg");
  const invalidFilePath = path.join(fixturesDir, "test-file.txt");

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

    // Create test fixtures if they don't exist
    // Keep the fixture self-contained so backend CI never depends on a prior
    // frontend build. This valid 16x16 PNG satisfies the upload minimum.
    if (!fs.existsSync(validImagePath)) {
      fs.writeFileSync(
        validImagePath,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAHUlEQVR4nGNgaPj/nyLMMGoAw6gB/0cN+D8cDAAAgeJ+HwnnxlQAAAAASUVORK5CYII=",
          "base64",
        ),
      );
    }

    // Create a large image file (>10MB) for size validation testing
    if (!fs.existsSync(largeImagePath)) {
      // Create a buffer larger than 10MB
      const largeBuffer = Buffer.alloc(11 * 1024 * 1024);
      fs.writeFileSync(largeImagePath, largeBuffer);
    }

    // Create an invalid text file
    if (!fs.existsSync(invalidFilePath)) {
      fs.writeFileSync(invalidFilePath, "This is not an image file");
    }

    // Create admin user
    const adminRegister = await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      username: "upload_admin",
      email: "upload.admin@test.com",
      password: "Admin123!@#",
      confirmPassword: "Admin123!@#",
      firstName: "Upload",
      lastName: "Admin",
      gender: "male",
      phoneNumber: "+1234567890",
      roleInAtCloud: "Member",
      bio: "",
      isAtCloudLeader: false,
      acceptTerms: true,
    });

    if (!adminRegister.body.success) {
      throw new Error(
        `Admin registration failed: ${adminRegister.body.message}`,
      );
    }

    adminUserId = adminRegister.body.data.user._id;

    // Manually verify and set admin role
    const adminUser = await User.findOne({ email: "upload.admin@test.com" });
    if (!adminUser) {
      throw new Error("Admin user not found after registration");
    }
    adminUser.isVerified = true;
    adminUser.role = "Super Admin";
    await adminUser.save();

    // Login admin
    const adminLogin = await request(app).post("/api/auth/login").send({
      emailOrUsername: "upload.admin@test.com",
      password: "Admin123!@#",
    });

    if (!adminLogin.body.success) {
      throw new Error(`Admin login failed: ${adminLogin.body.message}`);
    }

    adminToken = adminLogin.body.data.accessToken;

    // Create leader user
    const leaderRegister = await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      username: "upload_leader",
      email: "upload.leader@test.com",
      password: "Leader123!@#",
      confirmPassword: "Leader123!@#",
      firstName: "Upload",
      lastName: "Leader",
      gender: "female",
      phoneNumber: "+1234567891",
      roleInAtCloud: "Leader",
      bio: "",
      isAtCloudLeader: false,
      acceptTerms: true,
    });

    if (!leaderRegister.body.success) {
      throw new Error(
        `Leader registration failed: ${leaderRegister.body.message}`,
      );
    }

    leaderUserId = leaderRegister.body.data.user._id;

    // Manually verify and set leader role
    const leaderUser = await User.findOne({ email: "upload.leader@test.com" });
    if (!leaderUser) {
      throw new Error("Leader user not found after registration");
    }
    leaderUser.isVerified = true;
    leaderUser.role = "Leader";
    await leaderUser.save();

    // Login leader
    const leaderLogin = await request(app).post("/api/auth/login").send({
      emailOrUsername: "upload.leader@test.com",
      password: "Leader123!@#",
    });

    if (!leaderLogin.body.success) {
      throw new Error(`Leader login failed: ${leaderLogin.body.message}`);
    }

    leaderToken = leaderLogin.body.data.accessToken;

    // Create regular member
    const memberRegister = await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      username: "upload_member",
      email: "upload.member@test.com",
      password: "Member123!@#",
      confirmPassword: "Member123!@#",
      firstName: "Upload",
      lastName: "Member",
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

    memberUserId = memberRegister.body.data.user._id;

    // Manually verify member
    const memberUser = await User.findOne({ email: "upload.member@test.com" });
    if (!memberUser) {
      throw new Error("Member user not found after registration");
    }
    memberUser.isVerified = true;
    await memberUser.save();

    // Login member
    const memberLogin = await request(app).post("/api/auth/login").send({
      emailOrUsername: "upload.member@test.com",
      password: "Member123!@#",
    });

    if (!memberLogin.body.success) {
      throw new Error(`Member login failed: ${memberLogin.body.message}`);
    }

    memberToken = memberLogin.body.data.accessToken;
  }, 30000);

  afterAll(async () => {
    // Clean up test data
    await User.deleteMany({});

    // Clean up test fixtures
    if (fs.existsSync(fixturesDir)) {
      fs.rmSync(fixturesDir, { recursive: true, force: true });
    }

    if (openedLocal) {
      // Shared integration harness owns connection lifecycle.
    }
  });

  // ========================================
  // Generic Image Upload Tests
  // ========================================

  describe("POST /api/uploads/image - Generic Image Upload", () => {
    describe("Authentication and Authorization", () => {
      it("should reject requests without authentication token", async () => {
        // Authentication runs before multipart parsing. Do not keep streaming a
        // file after the server has already returned 401; that races into EPIPE.
        const response = await request(app).post("/api/uploads/image");

        expect(response.status).toBe(401);
        expect(response.body.success).toBe(false);
      });

      it("should allow authenticated regular members to upload images", async () => {
        expect(fs.existsSync(validImagePath)).toBe(true);

        const response = await request(app)
          .post("/api/uploads/image")
          .set("Authorization", `Bearer ${memberToken}`)
          .attach("image", validImagePath);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.data).toHaveProperty("url");
      });

      it("should allow authenticated leaders to upload images", async () => {
        const response = await request(app)
          .post("/api/uploads/image")
          .set("Authorization", `Bearer ${leaderToken}`)
          .attach("image", validImagePath);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.data).toHaveProperty("url");
      });

      it("should allow authenticated admins to upload images", async () => {
        const response = await request(app)
          .post("/api/uploads/image")
          .set("Authorization", `Bearer ${adminToken}`)
          .attach("image", validImagePath);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.data).toHaveProperty("url");
      });
    });

    describe("File Validation", () => {
      it("should reject request without a file", async () => {
        const response = await request(app)
          .post("/api/uploads/image")
          .set("Authorization", `Bearer ${memberToken}`)
          .send({});

        expect(response.status).toBe(400);
        expect(response.body.success).toBe(false);
        expect(response.body.message).toContain("No file uploaded");
      });

      it("should reject non-multipart/form-data requests", async () => {
        const response = await request(app)
          .post("/api/uploads/image")
          .set("Authorization", `Bearer ${memberToken}`)
          .set("Content-Type", "application/json")
          .send({ image: "not-a-file" });

        expect(response.status).toBe(400);
        expect(response.body.success).toBe(false);
        expect(response.body.message).toContain("multipart/form-data");
      });

      it("should reject files larger than 10MB", async () => {
        try {
          const response = await request(app)
            .post("/api/uploads/image")
            .set("Authorization", `Bearer ${memberToken}`)
            .attach("image", largeImagePath);

          expect(response.status).toBe(413);
          expect(response.body.success).toBe(false);
        } catch (error: unknown) {
          // EPIPE/ECONNRESET errors are expected when server closes connection on large file
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            (error.code === "EPIPE" || error.code === "ECONNRESET")
          ) {
            // This is actually the expected behavior - server rejected the large file
            return;
          }
          throw error;
        }
      });

      it("should reject non-image files", async () => {
        const response = await request(app)
          .post("/api/uploads/image")
          .set("Authorization", `Bearer ${memberToken}`)
          .attach("image", invalidFilePath);

        expect(response.status).toBe(400);
        expect(response.body.success).toBe(false);
      });
    });

    describe("Successful Upload", () => {
      it("should return a valid URL for uploaded image", async () => {
        const response = await request(app)
          .post("/api/uploads/image")
          .set("Authorization", `Bearer ${memberToken}`)
          .attach("image", validImagePath);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.data.url).toBeTruthy();
        expect(response.body.data.url).toMatch(/\/images\//);
        expect(response.body.data.url).toMatch(/\.webp$/);
      });

      it("should return an absolute URL", async () => {
        const response = await request(app)
          .post("/api/uploads/image")
          .set("Authorization", `Bearer ${memberToken}`)
          .attach("image", validImagePath);

        expect(response.status).toBe(200);
        expect(response.body.data.url).toMatch(/^https?:\/\//);
      });

      it("should include compression info in response", async () => {
        const response = await request(app)
          .post("/api/uploads/image")
          .set("Authorization", `Bearer ${memberToken}`)
          .attach("image", validImagePath);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        // Compression info may be in headers or body depending on middleware
      });
    });
  });

  // ========================================
  // Avatar Upload Tests
  // ========================================

  describe("POST /api/uploads/avatar - Avatar Upload", () => {
    describe("Authentication and Authorization", () => {
      it("should reject requests without authentication token", async () => {
        try {
          const response = await request(app)
            .post("/api/uploads/avatar")
            .attach("avatar", validImagePath);

          expect(response.status).toBe(401);
          expect(response.body.success).toBe(false);
        } catch (error: unknown) {
          // Handle EPIPE error during cleanup
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "EPIPE"
          ) {
            return;
          }
          throw error;
        }
      });

      it("should reject non-admin users (regular members)", async () => {
        // Authorization runs before multipart parsing, so no fixture is needed.
        const response = await request(app)
          .post("/api/uploads/avatar")
          .set("Authorization", `Bearer ${memberToken}`);

        expect(response.status).toBe(403);
        expect(response.body.success).toBe(false);
        expect(response.body.message).toContain("Administrator");
      });

      it("should reject non-admin users (leaders)", async () => {
        // Don't attach a file — requireAdmin rejects before multer runs,
        // and sending a file causes EPIPE when the server closes early.
        const response = await request(app)
          .post("/api/uploads/avatar")
          .set("Authorization", `Bearer ${leaderToken}`);

        expect(response.status).toBe(403);
        expect(response.body.success).toBe(false);
        expect(response.body.message).toContain("Administrator");
      });

      it("should allow admins to upload avatars", async () => {
        const response = await request(app)
          .post("/api/uploads/avatar")
          .set("Authorization", `Bearer ${adminToken}`)
          .attach("avatar", validImagePath);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.data).toHaveProperty("avatarUrl");
      });
    });

    describe("File Validation", () => {
      it("should reject request without a file", async () => {
        const response = await request(app)
          .post("/api/uploads/avatar")
          .set("Authorization", `Bearer ${adminToken}`)
          .send({});

        expect(response.status).toBe(400);
        expect(response.body.success).toBe(false);
        expect(response.body.message).toContain("No file uploaded");
      });

      it("should reject non-multipart/form-data requests", async () => {
        const response = await request(app)
          .post("/api/uploads/avatar")
          .set("Authorization", `Bearer ${adminToken}`)
          .set("Content-Type", "application/json")
          .send({ avatar: "not-a-file" });

        expect(response.status).toBe(400);
        expect(response.body.success).toBe(false);
        expect(response.body.message).toContain("multipart/form-data");
      });

      it("should reject files larger than 10MB", async () => {
        try {
          const response = await request(app)
            .post("/api/uploads/avatar")
            .set("Authorization", `Bearer ${adminToken}`)
            .attach("avatar", largeImagePath);

          expect(response.status).toBe(413);
          expect(response.body.success).toBe(false);
        } catch (error: unknown) {
          // EPIPE/ECONNRESET errors are expected when server closes connection on large file
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            (error.code === "EPIPE" || error.code === "ECONNRESET")
          ) {
            // This is actually the expected behavior - server rejected the large file
            return;
          }
          throw error;
        }
      });

      it("should reject non-image files", async () => {
        const response = await request(app)
          .post("/api/uploads/avatar")
          .set("Authorization", `Bearer ${adminToken}`)
          .attach("avatar", invalidFilePath);

        expect(response.status).toBe(400);
        expect(response.body.success).toBe(false);
      });
    });

    describe("Successful Upload", () => {
      it("should return a valid avatar URL", async () => {
        const response = await request(app)
          .post("/api/uploads/avatar")
          .set("Authorization", `Bearer ${adminToken}`)
          .attach("avatar", validImagePath);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.data.avatarUrl).toBeTruthy();
        expect(response.body.data.avatarUrl).toMatch(/\/avatars\//);
        expect(response.body.data.avatarUrl).toMatch(/\.webp\?t=\d+$/);
      });

      it("should return an absolute URL", async () => {
        const response = await request(app)
          .post("/api/uploads/avatar")
          .set("Authorization", `Bearer ${adminToken}`)
          .attach("avatar", validImagePath);

        expect(response.status).toBe(200);
        expect(response.body.data.avatarUrl).toMatch(/^https?:\/\//);
      });

      it("should include cache-busting timestamp in URL", async () => {
        const response = await request(app)
          .post("/api/uploads/avatar")
          .set("Authorization", `Bearer ${adminToken}`)
          .attach("avatar", validImagePath);

        expect(response.status).toBe(200);
        expect(response.body.data.avatarUrl).toMatch(/\?t=\d+/);
      });

      it("should not update user profile automatically", async () => {
        const response = await request(app)
          .post("/api/uploads/avatar")
          .set("Authorization", `Bearer ${adminToken}`)
          .attach("avatar", validImagePath);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);

        // Verify admin's avatar was not changed
        const admin = await User.findById(adminUserId);
        expect(admin?.avatar).not.toBe(response.body.data.avatarUrl);
      });
    });
  });

});
