import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";

describe("Feedback API Integration", () => {
  let authToken: string;
  let userId: string;

  beforeEach(async () => {
    // Clear users collection
    await User.deleteMany({});

    // Create and login a user
    const userData = {
      ...TEST_REGISTRATION_PROFILE,
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
      registrationNoticeVersion: "registration-privacy-v1",
    };

    const registerResponse = await request(app)
      .post("/api/auth/register")
      .send(userData)
      .expect(201);

    // Manually verify the user
    await User.findOneAndUpdate(
      { email: "test@example.com" },
      { isVerified: true }
    );

    const loginResponse = await request(app)
      .post("/api/auth/login")
      .send({
        emailOrUsername: userData.email,
        password: userData.password,
      })
      .expect(200);
    authToken = loginResponse.body.data.accessToken;
    userId = loginResponse.body.data.user.id;
  });

  afterEach(async () => {
    await User.deleteMany({});
  });

  describe("POST /api/feedback", () => {
    it("accepts feedback submission from authenticated user", async () => {
      const feedbackData = {
        type: "bug",
        subject: "Test Bug Report",
        message: "This is a test bug report description",
        includeContact: true,
      };

      const response = await request(app)
        .post("/api/feedback")
        .set("Authorization", `Bearer ${authToken}`)
        .send(feedbackData)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe("Feedback submitted successfully");
    });

    it("returns 401 for unauthenticated requests", async () => {
      const feedbackData = {
        type: "bug",
        subject: "Test Bug Report",
        message: "This is a test bug report description",
      };

      await request(app).post("/api/feedback").send(feedbackData).expect(401);
    });

    it("validates required fields", async () => {
      // Test missing type
      await request(app)
        .post("/api/feedback")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          subject: "Test",
          message: "Test description",
        })
        .expect(400);
    });
  });
});
