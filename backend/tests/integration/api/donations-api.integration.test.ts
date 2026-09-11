import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
/**
 * Donation API Integration Tests
 *
 * Tests the complete donation feature including:
 * - Creating one-time and recurring donations
 * - Retrieving donation history and statistics
 * - Managing scheduled donations (edit, hold, resume, cancel)
 * - Authentication and authorization
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Donation from "../../../src/models/Donation";
import DonationTransaction from "../../../src/models/DonationTransaction";
import { ensureIntegrationDB } from "../setup/connect";

// Mock Stripe services
vi.mock("../../../src/services/stripeService", async () => {
  const actual = await vi.importActual("../../../src/services/stripeService");
  return {
    ...actual,
    createDonationCheckoutSession: vi.fn().mockResolvedValue({
      id: "cs_test_checkout",
      url: "https://checkout.stripe.com/test",
      customer: "cus_test",
    }),
    createDonationSubscription: vi.fn().mockResolvedValue({
      subscriptionId: "sub_test",
      checkoutUrl: "https://checkout.stripe.com/test_sub",
    }),
    updateDonationSubscription: vi.fn().mockResolvedValue({}),
    pauseDonationSubscription: vi.fn().mockResolvedValue({}),
    resumeDonationSubscription: vi.fn().mockResolvedValue({}),
    cancelDonationSubscription: vi.fn().mockResolvedValue({}),
  };
});

describe("Donation API Integration Tests", () => {
  let authToken: string;
  let userId: string;
  let donationId: string;

  beforeAll(async () => {
    await User.deleteMany({});
    await DonationTransaction.deleteMany({});

    // Register and authenticate a test user ONCE for all tests
    const registerResponse = await request(app)
      .post("/api/auth/register")
      .send({
        ...TEST_REGISTRATION_PROFILE,
        username: "donoruser",
        email: "donor@test.com",
        password: "DonorPass123!",
        confirmPassword: "DonorPass123!",
        firstName: "Donor",
        lastName: "User",
        role: "user",
        gender: "male",
        isAtCloudLeader: false,
        acceptTerms: true,
      })
      .expect(201);

    userId = registerResponse.body.data.user.id;

    // Verify user for login
    await User.findOneAndUpdate(
      { email: "donor@test.com" },
      { isVerified: true }
    );

    // Login to get auth token
    const loginResponse = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: "donor@test.com", password: "DonorPass123!" })
      .expect(200);

    authToken = loginResponse.body.data.accessToken;
  });

  afterAll(async () => {
    // Clean up all test data at the end
    await User.deleteMany({});
    await Donation.deleteMany({});
    await DonationTransaction.deleteMany({});
    // Close connection after cleanup
    // Shared integration harness owns connection lifecycle.
    vi.restoreAllMocks();
  });

  describe("POST /api/donations/create", () => {
    it("should create a one-time donation successfully", async () => {
      const donationData = {
        amount: 5000, // $50.00 in cents
        type: "one-time",
        giftDate: new Date("2025-12-25").toISOString(),
      };

      const response = await request(app)
        .post("/api/donations/create")
        .set("Authorization", `Bearer ${authToken}`)
        .send(donationData)
        .expect(201);

      expect(response.body).toMatchObject({
        success: true,
        message: "Donation created successfully.",
        data: {
          donationId: expect.any(String),
          checkoutUrl: expect.stringContaining("checkout.stripe.com"),
        },
      });

      // Verify donation was created in database
      const donation = await Donation.findById(response.body.data.donationId);
      expect(donation).toBeDefined();
      expect(donation?.type).toBe("one-time");
      expect(donation?.amount).toBe(5000);
    });

    it("should create a recurring donation successfully", async () => {
      const donationData = {
        amount: 10000, // $100.00 in cents
        type: "recurring",
        frequency: "monthly",
        startDate: new Date("2025-01-01").toISOString(),
        endAfterOccurrences: 12,
      };

      const response = await request(app)
        .post("/api/donations/create")
        .set("Authorization", `Bearer ${authToken}`)
        .send(donationData)
        .expect(201);

      expect(response.body).toMatchObject({
        success: true,
        data: {
          donationId: expect.any(String),
          checkoutUrl: expect.stringContaining("checkout.stripe.com"),
        },
      });

      // Verify recurring donation was created
      const donation = await Donation.findById(response.body.data.donationId);
      expect(donation?.type).toBe("recurring");
      expect(donation?.frequency).toBe("monthly");
      expect(donation?.endAfterOccurrences).toBe(12);
    });

    it("should reject donation without authentication", async () => {
      const donationData = {
        amount: 5000,
        type: "one-time",
        giftDate: new Date().toISOString(),
      };

      const response = await request(app)
        .post("/api/donations/create")
        .send(donationData)
        .expect(401);

      expect(response.body.success).toBe(false);
    });

    it("should reject donation without amount", async () => {
      const donationData = {
        type: "one-time",
        giftDate: new Date().toISOString(),
      };

      const response = await request(app)
        .post("/api/donations/create")
        .set("Authorization", `Bearer ${authToken}`)
        .send(donationData)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain("Amount and type are required");
    });

    it("should reject donation without type", async () => {
      const donationData = {
        amount: 5000,
        giftDate: new Date().toISOString(),
      };

      const response = await request(app)
        .post("/api/donations/create")
        .set("Authorization", `Bearer ${authToken}`)
        .send(donationData)
        .expect(400);

      expect(response.body.success).toBe(false);
    });
  });

  describe("POST /api/donations/:donationId/retry-checkout", () => {
    beforeEach(async () => {
      // Create a pending one-time donation
      const donation = await Donation.create({
        userId: userId,
        amount: 5000,
        type: "one-time",
        status: "pending",
        giftDate: new Date("2025-12-25"),
        stripeCustomerId: "cus_test",
      });
      donationId = (donation._id as mongoose.Types.ObjectId).toString();
    });

    it("should retry checkout for pending donation", async () => {
      const response = await request(app)
        .post(`/api/donations/${donationId}/retry-checkout`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        data: {
          checkoutUrl: expect.stringContaining("checkout.stripe.com"),
        },
      });
    });

    it("should reject retry for non-existent donation", async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();

      const response = await request(app)
        .post(`/api/donations/${fakeId}/retry-checkout`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain("not found");
    });

    it("should reject retry without authentication", async () => {
      await request(app)
        .post(`/api/donations/${donationId}/retry-checkout`)
        .expect(401);
    });
  });

  describe("GET /api/donations/my-donations", () => {
    beforeEach(async () => {
      // Create test transactions
      const donation = await Donation.create({
        userId: userId,
        amount: 5000,
        type: "one-time",
        status: "completed",
        giftDate: new Date("2025-01-15"),
        stripeCustomerId: "cus_test",
      });

      await DonationTransaction.create({
        donationId: donation._id,
        userId: userId,
        amount: 5000,
        type: "one-time",
        status: "completed",
        giftDate: new Date("2025-01-15"),
        stripePaymentIntentId: `pi_test_${Date.now()}_${Math.random()}`,
      });

      // Create pending donation
      await Donation.create({
        userId: userId,
        amount: 3000,
        type: "one-time",
        status: "pending",
        giftDate: new Date("2025-02-01"),
        stripeCustomerId: "cus_test2",
      });
    });

    it("should return user's donation history", async () => {
      const response = await request(app)
        .get("/api/donations/my-donations")
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        data: {
          transactions: expect.arrayContaining([
            expect.objectContaining({
              amount: 5000,
              type: "one-time",
              status: "completed",
            }),
          ]),
          pending: expect.arrayContaining([
            expect.objectContaining({
              amount: 3000,
              status: "pending",
            }),
          ]),
          pagination: expect.objectContaining({
            page: 1,
            total: expect.any(Number),
          }),
        },
      });
    });

    it("should support pagination", async () => {
      const response = await request(app)
        .get("/api/donations/my-donations?page=1&limit=10")
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.data.pagination).toMatchObject({
        page: 1,
        limit: 10,
      });
    });

    it("should reject without authentication", async () => {
      await request(app).get("/api/donations/my-donations").expect(401);
    });
  });

  describe("GET /api/donations/my-scheduled-donations", () => {
    beforeEach(async () => {
      // Create scheduled and active donations
      await Donation.create({
        userId: userId,
        amount: 10000,
        type: "recurring",
        frequency: "monthly",
        status: "active",
        startDate: new Date("2025-01-01"),
        nextPaymentDate: new Date("2025-02-01"),
        stripeCustomerId: "cus_test",
        stripeSubscriptionId: "sub_test",
      });

      await Donation.create({
        userId: userId,
        amount: 5000,
        type: "one-time",
        status: "scheduled",
        giftDate: new Date("2025-06-01"),
        stripeCustomerId: "cus_test2",
      });
    });

    it("should return scheduled donations", async () => {
      const response = await request(app)
        .get("/api/donations/my-scheduled")
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        data: {
          scheduled: expect.arrayContaining([
            expect.objectContaining({
              status: expect.stringMatching(/active|scheduled|on_hold/),
            }),
          ]),
        },
      });

      expect(response.body.data.scheduled.length).toBeGreaterThan(0);
    });

    it("should reject without authentication", async () => {
      await request(app).get("/api/donations/my-scheduled").expect(401);
    });
  });

  describe("GET /api/donations/stats", () => {
    let statsTestDonationId: string;

    beforeEach(async () => {
      // Clean up any previous test data first
      await DonationTransaction.deleteMany({ userId });
      await Donation.deleteMany({ userId });

      // Create completed transactions
      const donation = await Donation.create({
        userId: userId,
        amount: 10000,
        type: "recurring",
        frequency: "monthly",
        startDate: new Date("2025-01-01"),
        status: "active",
        stripeCustomerId: "cus_test",
        stripeSubscriptionId: "sub_test_stats",
      });

      statsTestDonationId = (
        donation._id as mongoose.Types.ObjectId
      ).toString();

      for (let i = 0; i < 5; i++) {
        await DonationTransaction.create({
          donationId: donation._id,
          userId: userId,
          amount: 10000,
          type: "recurring",
          status: "completed",
          giftDate: new Date(`2025-0${i + 1}-01`),
          stripePaymentIntentId: `pi_test_stats_${Date.now()}_${i}_${Math.random()
            .toString(36)
            .substring(7)}`,
        });
      }
    });

    afterEach(async () => {
      // Clean up test data
      await DonationTransaction.deleteMany({ userId });
      await Donation.deleteMany({ userId });
    });

    it("should return donation statistics", async () => {
      const response = await request(app)
        .get("/api/donations/stats")
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        data: {
          totalAmount: 50000, // 5 donations x $100
          totalGifts: 5,
        },
      });
    });

    it("should return zeros for user with no donations", async () => {
      // Clear all transactions
      await DonationTransaction.deleteMany({});

      const response = await request(app)
        .get("/api/donations/stats")
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.data).toMatchObject({
        totalAmount: 0,
        totalGifts: 0,
      });
    });

    it("should reject without authentication", async () => {
      await request(app).get("/api/donations/stats").expect(401);
    });
  });

  describe("PUT /api/donations/:id/edit", () => {
    it("should edit scheduled donation", async () => {
      // Create a scheduled donation
      const donation = await Donation.create({
        userId: userId,
        amount: 5000,
        type: "one-time",
        status: "scheduled",
        giftDate: new Date("2025-06-01"),
        stripeCustomerId: "cus_test",
      });
      const donationId = (donation._id as mongoose.Types.ObjectId).toString();

      const updates = {
        amount: 75, // In dollars, will be converted to 7500 cents
        giftDate: new Date("2025-07-01").toISOString(),
      };

      const response = await request(app)
        .put(`/api/donations/${donationId}/edit`)
        .set("Authorization", `Bearer ${authToken}`)
        .send(updates)
        .expect(200);

      expect(response.body.success).toBe(true);

      // Verify changes
      const updatedDonation = await Donation.findById(donationId);
      expect(updatedDonation?.amount).toBe(7500); // In cents

      // Cleanup
      await Donation.deleteOne({ _id: donationId });
    });

    it("should reject editing completed donation", async () => {
      // Create a completed donation
      const donation = await Donation.create({
        userId: userId,
        amount: 5000,
        type: "one-time",
        status: "completed",
        giftDate: new Date("2025-06-01"),
        stripeCustomerId: "cus_test",
      });
      const donationId = (donation._id as mongoose.Types.ObjectId).toString();

      const updates = { amount: 75 }; // In dollars

      const response = await request(app)
        .put(`/api/donations/${donationId}/edit`)
        .set("Authorization", `Bearer ${authToken}`)
        .send(updates)
        .expect(400);

      expect(response.body.success).toBe(false);

      // Cleanup
      await Donation.deleteOne({ _id: donationId });
    });
  });

  describe("PUT /api/donations/:id/hold", () => {
    it("should place recurring donation on hold", async () => {
      // Create an active recurring donation
      const donation = await Donation.create({
        userId: userId,
        amount: 10000,
        type: "recurring",
        frequency: "monthly",
        status: "active",
        startDate: new Date("2025-01-01"),
        nextPaymentDate: new Date("2025-02-01"),
        stripeCustomerId: "cus_test",
        stripeSubscriptionId: "sub_test_hold",
      });
      const donationId = (donation._id as mongoose.Types.ObjectId).toString();

      const response = await request(app)
        .put(`/api/donations/${donationId}/hold`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);

      // Verify status changed
      const updatedDonation = await Donation.findById(donationId);
      expect(updatedDonation?.status).toBe("on_hold");

      // Cleanup
      await Donation.deleteOne({ _id: donationId });
    });

    it("should reject holding one-time donation", async () => {
      // Create a one-time donation
      const donation = await Donation.create({
        userId: userId,
        amount: 5000,
        type: "one-time",
        status: "scheduled",
        giftDate: new Date("2025-06-01"),
        stripeCustomerId: "cus_test",
      });
      const donationId = (donation._id as mongoose.Types.ObjectId).toString();

      const response = await request(app)
        .put(`/api/donations/${donationId}/hold`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(400);

      expect(response.body.success).toBe(false);

      // Cleanup
      await Donation.deleteOne({ _id: donationId });
    });
  });

  describe("PUT /api/donations/:id/resume", () => {
    it("should resume donation from hold", async () => {
      // Create an on-hold donation
      const donation = await Donation.create({
        userId: userId,
        amount: 10000,
        type: "recurring",
        frequency: "monthly",
        status: "on_hold",
        startDate: new Date("2025-01-01"),
        nextPaymentDate: new Date("2025-02-01"),
        stripeCustomerId: "cus_test",
        stripeSubscriptionId: "sub_test_resume",
      });
      const donationId = (donation._id as mongoose.Types.ObjectId).toString();

      const response = await request(app)
        .put(`/api/donations/${donationId}/resume`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);

      // Verify status changed
      const updatedDonation = await Donation.findById(donationId);
      expect(updatedDonation?.status).toBe("active");

      // Cleanup
      await Donation.deleteOne({ _id: donationId });
    });

    it("should reject resuming active donation", async () => {
      // Create an already active donation
      const donation = await Donation.create({
        userId: userId,
        amount: 10000,
        type: "recurring",
        frequency: "monthly",
        status: "active",
        startDate: new Date("2025-01-01"),
        nextPaymentDate: new Date("2025-02-01"),
        stripeCustomerId: "cus_test",
        stripeSubscriptionId: "sub_test_resume2",
      });
      const donationId = (donation._id as mongoose.Types.ObjectId).toString();

      const response = await request(app)
        .put(`/api/donations/${donationId}/resume`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(400);

      expect(response.body.success).toBe(false);

      // Cleanup
      await Donation.deleteOne({ _id: donationId });
    });
  });

  describe("DELETE /api/donations/:id/cancel", () => {
    it("should cancel donation", async () => {
      // Create an active donation
      const donation = await Donation.create({
        userId: userId,
        amount: 10000,
        type: "recurring",
        frequency: "monthly",
        status: "active",
        startDate: new Date("2025-01-01"),
        nextPaymentDate: new Date("2025-02-01"),
        stripeCustomerId: "cus_test",
        stripeSubscriptionId: "sub_test_cancel",
      });
      const donationId = (donation._id as mongoose.Types.ObjectId).toString();

      const response = await request(app)
        .delete(`/api/donations/${donationId}/cancel`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);

      // Verify status changed
      const updatedDonation = await Donation.findById(donationId);
      expect(updatedDonation?.status).toBe("cancelled");

      // Cleanup
      await Donation.deleteOne({ _id: donationId });
    });

    it("should reject cancelling completed donation", async () => {
      // Create a completed donation
      const donation = await Donation.create({
        userId: userId,
        amount: 10000,
        type: "recurring",
        frequency: "monthly",
        status: "completed",
        startDate: new Date("2025-01-01"),
        nextPaymentDate: new Date("2025-02-01"),
        stripeCustomerId: "cus_test",
        stripeSubscriptionId: "sub_test_cancel2",
      });
      const donationId = (donation._id as mongoose.Types.ObjectId).toString();

      const response = await request(app)
        .delete(`/api/donations/${donationId}/cancel`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(400);

      expect(response.body.success).toBe(false);

      // Cleanup
      await Donation.deleteOne({ _id: donationId });
    });

    it("should reject without authentication", async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      await request(app).delete(`/api/donations/${fakeId}/cancel`).expect(401);
    });
  });
});
