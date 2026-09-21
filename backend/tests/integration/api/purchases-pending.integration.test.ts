/**
 * Pending Purchases Integration Tests
 *
 * Tests the pending purchases feature including:
 * - Fetching pending purchases with auto-cleanup
 * - Auto-cleanup of expired sessions (>24 hours)
 * - Auto-cleanup of redundant pending purchases (already completed)
 * - Retry purchase with duplicate prevention
 * - Cancel pending purchase
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
  vi,
} from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Program from "../../../src/models/Program";
import { Purchase } from "../../../src/models";
import { ensureIntegrationDB } from "../setup/connect";

const stripeCheckoutMocks = vi.hoisted(() => {
  let nextSessionNumber = 0;

  return {
    create: vi.fn(async () => {
      nextSessionNumber += 1;
      const id = `cs_test_pending_purchase_${nextSessionNumber}`;
      return {
        id,
        url: `https://checkout.stripe.com/c/pay/${id}`,
        status: "open",
      };
    }),
    retrieve: vi.fn(async () => ({ status: "open" })),
    expire: vi.fn(async () => ({ status: "expired" })),
  };
});

// Purchase retry imports `createCheckoutSession` under a local alias, so mock
// the exported symbol as well as direct checkout session calls.
vi.mock("../../../src/services/stripeService", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/services/stripeService")
  >("../../../src/services/stripeService");
  return {
    ...actual,
    createCheckoutSession: stripeCheckoutMocks.create,
    stripe: {
      checkout: {
        sessions: {
          create: stripeCheckoutMocks.create,
          retrieve: stripeCheckoutMocks.retrieve,
          expire: stripeCheckoutMocks.expire,
        },
      },
    },
  };
});

describe("Pending Purchases Integration Tests", () => {
  let authToken: string;
  let userId: string;
  let programId: string;

  beforeAll(async () => {
    await ensureIntegrationDB();
  });

  beforeEach(async () => {
    // Clean up
    await User.deleteMany({});
    await Program.deleteMany({});
    await Purchase.deleteMany({});

    // Create test user
    const user = await User.create({
      username: "testuser",
      email: "test@example.com",
      password: "Password123",
      firstName: "Test",
      lastName: "User",
      role: "Participant",
      isVerified: true, // Required for login
    });
    userId = (user._id as mongoose.Types.ObjectId).toString();

    // Create auth token
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: "testuser", password: "Password123" });
    authToken = loginRes.body.data?.accessToken || "";

    // Create test program
    const program = await Program.create({
      title: "Test Program",
      introduction: "Test Description",
      programType: "EMBA Mentor Circles",
      isFree: false,
      fullPriceTicket: 1900, // $19.00 in cents (max is 100000 = $1000)
      classRepDiscount: 0,
      earlyBirdDiscount: 0,
      createdBy: userId,
      published: true,
    });
    programId = (program._id as mongoose.Types.ObjectId).toString();
  });

  afterEach(async () => {
    await User.deleteMany({});
    await Program.deleteMany({});
    await Purchase.deleteMany({});
  });

  afterAll(async () => {
    // Shared integration harness owns connection lifecycle.
  });

  describe("GET /api/purchases/my-pending-purchases", () => {
    it("should return empty array when no pending purchases exist", async () => {
      const res = await request(app)
        .get("/api/purchases/my-pending-purchases")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });

    it("should return pending purchases", async () => {
      // Create pending purchase
      await Purchase.create({
        userId: userId,
        programId: programId,
        orderNumber: "ORD-TEST-001",
        fullPrice: 99.99,
        classRepDiscount: 0,
        earlyBirdDiscount: 0,
        finalPrice: 99.99,
        isClassRep: false,
        isEarlyBird: false,
        stripeSessionId: "cs_test_123",
        status: "pending",
        billingInfo: {
          fullName: "Test User",
          email: "test@example.com",
        },
        paymentMethod: {
          type: "card",
        },
        purchaseDate: new Date(),
      });

      const res = await request(app)
        .get("/api/purchases/my-pending-purchases")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].orderNumber).toBe("ORD-TEST-001");
      expect(res.body.data[0].status).toBe("pending");
    });

    it("should auto-cleanup expired pending purchases (>24 hours)", async () => {
      // Create expired pending purchase (created 25 hours ago)
      const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await Purchase.create({
        userId: userId,
        programId: programId,
        orderNumber: "ORD-EXPIRED-001",
        fullPrice: 99.99,
        finalPrice: 99.99,
        classRepDiscount: 0,
        earlyBirdDiscount: 0,
        isClassRep: false,
        isEarlyBird: false,
        stripeSessionId: "cs_expired_123",
        status: "pending",
        billingInfo: { fullName: "Test User", email: "test@example.com" },
        paymentMethod: { type: "card" },
        purchaseDate: twentyFiveHoursAgo,
        createdAt: twentyFiveHoursAgo,
      });

      // Create fresh pending purchase
      await Purchase.create({
        userId: userId,
        programId: programId,
        orderNumber: "ORD-FRESH-001",
        fullPrice: 99.99,
        finalPrice: 99.99,
        classRepDiscount: 0,
        earlyBirdDiscount: 0,
        isClassRep: false,
        isEarlyBird: false,
        stripeSessionId: "cs_fresh_123",
        status: "pending",
        billingInfo: { fullName: "Test User", email: "test@example.com" },
        paymentMethod: { type: "card" },
        purchaseDate: new Date(),
      });

      // Fetch pending purchases (should trigger auto-cleanup)
      const res = await request(app)
        .get("/api/purchases/my-pending-purchases")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].orderNumber).toBe("ORD-FRESH-001");

      // Verify expired purchase was deleted from database
      const expiredPurchase = await Purchase.findOne({
        orderNumber: "ORD-EXPIRED-001",
      });
      expect(expiredPurchase).toBeNull();
    });

    it("should auto-cleanup redundant pending purchases (already completed)", async () => {
      // Create completed purchase for the program
      await Purchase.create({
        userId: userId,
        programId: programId,
        orderNumber: "ORD-COMPLETED-001",
        fullPrice: 99.99,
        finalPrice: 99.99,
        classRepDiscount: 0,
        earlyBirdDiscount: 0,
        isClassRep: false,
        isEarlyBird: false,
        stripeSessionId: "cs_completed_123",
        status: "completed",
        billingInfo: { fullName: "Test User", email: "test@example.com" },
        paymentMethod: { type: "card", cardBrand: "visa", last4: "4242" },
        purchaseDate: new Date(),
      });

      // Create redundant pending purchase for same program
      await Purchase.create({
        userId: userId,
        programId: programId,
        orderNumber: "ORD-REDUNDANT-001",
        fullPrice: 99.99,
        finalPrice: 99.99,
        classRepDiscount: 0,
        earlyBirdDiscount: 0,
        isClassRep: false,
        isEarlyBird: false,
        stripeSessionId: "cs_redundant_123",
        status: "pending",
        billingInfo: { fullName: "Test User", email: "test@example.com" },
        paymentMethod: { type: "card" },
        purchaseDate: new Date(),
      });

      // Create another program
      const anotherProgram = await Program.create({
        title: "Another Program",
        introduction: "Another Description",
        programType: "Effective Communication Workshops",
        isFree: false,
        fullPriceTicket: 1500, // $15.00 in cents (max is 100000 = $1000)
        classRepDiscount: 0,
        earlyBirdDiscount: 0,
        createdBy: userId,
        published: true,
      });

      // Create valid pending purchase for different program
      await Purchase.create({
        userId: userId,
        programId: anotherProgram._id,
        orderNumber: "ORD-VALID-001",
        fullPrice: 149.99,
        finalPrice: 149.99,
        classRepDiscount: 0,
        earlyBirdDiscount: 0,
        isClassRep: false,
        isEarlyBird: false,
        stripeSessionId: "cs_valid_123",
        status: "pending",
        billingInfo: { fullName: "Test User", email: "test@example.com" },
        paymentMethod: { type: "card" },
        purchaseDate: new Date(),
      });

      // Fetch pending purchases (should trigger auto-cleanup of redundant)
      const res = await request(app)
        .get("/api/purchases/my-pending-purchases")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].orderNumber).toBe("ORD-VALID-001");

      // Verify redundant pending purchase was deleted
      const redundantPurchase = await Purchase.findOne({
        orderNumber: "ORD-REDUNDANT-001",
      });
      expect(redundantPurchase).toBeNull();
    });

    it("should require authentication", async () => {
      const res = await request(app).get("/api/purchases/my-pending-purchases");

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });

  describe("POST /api/purchases/retry/:id", () => {
    it("should create new checkout session for valid pending purchase", async () => {
      // Create pending purchase
      const purchase = await Purchase.create({
        userId: userId,
        programId: programId,
        orderNumber: "ORD-RETRY-001",
        fullPrice: 99.99,
        finalPrice: 99.99,
        classRepDiscount: 0,
        earlyBirdDiscount: 0,
        isClassRep: false,
        isEarlyBird: false,
        stripeSessionId: "cs_old_123",
        status: "pending",
        billingInfo: { fullName: "Test User", email: "test@example.com" },
        paymentMethod: { type: "card" },
        purchaseDate: new Date(),
      });

      const res = await request(app)
        .post(`/api/purchases/retry/${purchase._id}`)
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.sessionId).toBeTruthy(); // Check that a session ID exists
      expect(res.body.data.sessionId).toMatch(/^cs_test_/); // Verify it's a Stripe test session ID
      expect(res.body.data.sessionUrl).toContain("checkout.stripe.com");
    });

    it("should prevent retry if program already purchased (duplicate prevention)", async () => {
      // Create completed purchase
      await Purchase.create({
        userId: userId,
        programId: programId,
        orderNumber: "ORD-COMPLETED-002",
        fullPrice: 99.99,
        finalPrice: 99.99,
        classRepDiscount: 0,
        earlyBirdDiscount: 0,
        isClassRep: false,
        isEarlyBird: false,
        stripeSessionId: "cs_completed_456",
        status: "completed",
        billingInfo: { fullName: "Test User", email: "test@example.com" },
        paymentMethod: { type: "card", cardBrand: "visa", last4: "4242" },
        purchaseDate: new Date(),
      });

      // Create pending purchase for same program
      const pendingPurchase = await Purchase.create({
        userId: userId,
        programId: programId,
        orderNumber: "ORD-PENDING-002",
        fullPrice: 99.99,
        finalPrice: 99.99,
        classRepDiscount: 0,
        earlyBirdDiscount: 0,
        isClassRep: false,
        isEarlyBird: false,
        stripeSessionId: "cs_pending_456",
        status: "pending",
        billingInfo: { fullName: "Test User", email: "test@example.com" },
        paymentMethod: { type: "card" },
        purchaseDate: new Date(),
      });

      const res = await request(app)
        .post(`/api/purchases/retry/${pendingPurchase._id}`)
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain(
        "You have already purchased this program"
      );
    });

    it("should reject retry for non-pending purchase", async () => {
      // Create completed purchase
      const completedPurchase = await Purchase.create({
        userId: userId,
        programId: programId,
        orderNumber: "ORD-COMPLETED-003",
        fullPrice: 99.99,
        finalPrice: 99.99,
        classRepDiscount: 0,
        earlyBirdDiscount: 0,
        isClassRep: false,
        isEarlyBird: false,
        stripeSessionId: "cs_completed_789",
        status: "completed",
        billingInfo: { fullName: "Test User", email: "test@example.com" },
        paymentMethod: { type: "card", cardBrand: "visa", last4: "4242" },
        purchaseDate: new Date(),
      });

      const res = await request(app)
        .post(`/api/purchases/retry/${completedPurchase._id}`)
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Cannot retry a completed purchase");
    });

    it("should verify purchase ownership", async () => {
      // Create another user
      const otherUser = await User.create({
        username: "otheruser",
        email: "other@example.com",
        password: "Password123",
        firstName: "Other",
        lastName: "User",
        role: "Participant",
        isVerified: true,
      });

      // Create pending purchase for other user
      const purchase = await Purchase.create({
        userId: otherUser._id,
        programId: programId,
        orderNumber: "ORD-OTHER-001",
        fullPrice: 99.99,
        finalPrice: 99.99,
        classRepDiscount: 0,
        earlyBirdDiscount: 0,
        isClassRep: false,
        isEarlyBird: false,
        stripeSessionId: "cs_other_123",
        status: "pending",
        billingInfo: { fullName: "Other User", email: "other@example.com" },
        paymentMethod: { type: "card" },
        purchaseDate: new Date(),
      });

      const res = await request(app)
        .post(`/api/purchases/retry/${purchase._id}`)
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("only retry your own purchases");
    });

    it("should require authentication", async () => {
      const res = await request(app).post(
        `/api/purchases/retry/507f1f77bcf86cd799439011`
      );

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });

  describe("DELETE /api/purchases/:id", () => {
    it("should successfully cancel pending purchase", async () => {
      // Create pending purchase
      const purchase = await Purchase.create({
        userId: userId,
        programId: programId,
        orderNumber: "ORD-CANCEL-001",
        fullPrice: 99.99,
        finalPrice: 99.99,
        classRepDiscount: 0,
        earlyBirdDiscount: 0,
        isClassRep: false,
        isEarlyBird: false,
        stripeSessionId: "cs_cancel_123",
        status: "pending",
        billingInfo: { fullName: "Test User", email: "test@example.com" },
        paymentMethod: { type: "card" },
        purchaseDate: new Date(),
      });

      const res = await request(app)
        .delete(`/api/purchases/${purchase._id}`)
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain("cancelled successfully");

      // Verify purchase was deleted
      const deletedPurchase = await Purchase.findById(purchase._id);
      expect(deletedPurchase).toBeNull();
    });

    it("should prevent canceling completed purchase", async () => {
      // Create completed purchase
      const completedPurchase = await Purchase.create({
        userId: userId,
        programId: programId,
        orderNumber: "ORD-COMPLETED-004",
        fullPrice: 99.99,
        finalPrice: 99.99,
        classRepDiscount: 0,
        earlyBirdDiscount: 0,
        isClassRep: false,
        isEarlyBird: false,
        stripeSessionId: "cs_completed_999",
        status: "completed",
        billingInfo: { fullName: "Test User", email: "test@example.com" },
        paymentMethod: { type: "card", cardBrand: "visa", last4: "4242" },
        purchaseDate: new Date(),
      });

      const res = await request(app)
        .delete(`/api/purchases/${completedPurchase._id}`)
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Cannot cancel a completed purchase");

      // Verify purchase still exists
      const stillExists = await Purchase.findById(completedPurchase._id);
      expect(stillExists).not.toBeNull();
    });

    it("should verify purchase ownership before canceling", async () => {
      // Create another user
      const otherUser = await User.create({
        username: "otheruser2",
        email: "other2@example.com",
        password: "Password123",
        firstName: "Other",
        lastName: "User",
        role: "Participant",
        isVerified: true,
      });

      // Create pending purchase for other user
      const purchase = await Purchase.create({
        userId: otherUser._id,
        programId: programId,
        orderNumber: "ORD-OTHER-002",
        fullPrice: 99.99,
        finalPrice: 99.99,
        classRepDiscount: 0,
        earlyBirdDiscount: 0,
        isClassRep: false,
        isEarlyBird: false,
        stripeSessionId: "cs_other_456",
        status: "pending",
        billingInfo: { fullName: "Other User", email: "other2@example.com" },
        paymentMethod: { type: "card" },
        purchaseDate: new Date(),
      });

      const res = await request(app)
        .delete(`/api/purchases/${purchase._id}`)
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("only cancel your own purchases");
    });

    it("should require authentication", async () => {
      const res = await request(app).delete(
        `/api/purchases/507f1f77bcf86cd799439011`
      );

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });

  describe("Complete workflow test", () => {
    it("should handle full pending purchase lifecycle", async () => {
      // Step 1: Create pending purchase
      const purchase = await Purchase.create({
        userId: userId,
        programId: programId,
        orderNumber: "ORD-WORKFLOW-001",
        fullPrice: 99.99,
        finalPrice: 89.99,
        classRepDiscount: 10.0,
        earlyBirdDiscount: 0,
        isClassRep: true,
        isEarlyBird: false,
        stripeSessionId: "cs_workflow_123",
        status: "pending",
        billingInfo: { fullName: "Test User", email: "test@example.com" },
        paymentMethod: { type: "card" },
        purchaseDate: new Date(),
      });

      // Step 2: Fetch pending purchases
      let res = await request(app)
        .get("/api/purchases/my-pending-purchases")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].orderNumber).toBe("ORD-WORKFLOW-001");

      // Step 3: Retry purchase (should create new session)
      res = await request(app)
        .post(`/api/purchases/retry/${purchase._id}`)
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.sessionId).toBeDefined();

      // Step 4: Simulate user changing mind and canceling
      res = await request(app)
        .delete(`/api/purchases/${purchase._id}`)
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);

      // Step 5: Verify purchase was removed
      res = await request(app)
        .get("/api/purchases/my-pending-purchases")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });
  });
});
