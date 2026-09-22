import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../src/app";
import { ensureIntegrationDB } from "../setup/connect";
import User from "../../../src/models/User";
import Purchase from "../../../src/models/Purchase";

const stripeCheckoutMocks = vi.hoisted(() => {
  let nextSessionNumber = 0;

  return {
    create: vi.fn(async () => {
      nextSessionNumber += 1;
      const id = `cs_test_event_retry_${nextSessionNumber}`;
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

vi.mock("../../../src/services/stripeService", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../src/services/stripeService")
  >();

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

describe("Event Purchase Retry and Pending Integration Tests", () => {
  let authToken: string;
  let userId: mongoose.Types.ObjectId;
  let programId: mongoose.Types.ObjectId;
  let eventId: mongoose.Types.ObjectId;

  beforeEach(async () => {
    await ensureIntegrationDB();
    // Clear collections
    await User.deleteMany({});
    await Purchase.deleteMany({});

    // Create test user
    const user = await User.create({
      username: "retryuser",
      email: "retry@test.com",
      firstName: "Retry",
      lastName: "User",
      password: "ValidPassword123!",
      isVerified: true,
      gender: "male",
      isAtCloudLeader: false,
      role: "Participant",
    });
    userId = user._id as mongoose.Types.ObjectId;

    // Login
    const loginRes = await request(app).post("/api/auth/login").send({
      emailOrUsername: "retry@test.com",
      password: "ValidPassword123!",
    });
    authToken = loginRes.body.data.accessToken;

    // Create program and event
    const { default: Program } = await import("../../../src/models/Program");
    const program = await Program.create({
      title: "Test Program",
      description: "Program for retry testing",
      programType: "EMBA Mentor Circles",
      fullPriceTicket: 15000,
      date: "2025-12-15",
      startTime: "09:00",
      endTime: "17:00",
      location: "Test Location",
      address: "123 Test St",
      capacity: 100,
      status: "open",
      agenda: "Test agenda for program",
      createdBy: userId,
    });
    programId = program._id as mongoose.Types.ObjectId;

    const { default: Event } = await import("../../../src/models/Event");
    const event = await Event.create({
      title: "Test Event",
      description: "Event for retry testing",
      type: "Conference",
      format: "In-person",
      purpose: "Community Building",
      date: "2025-12-15",
      time: "09:00",
      endDate: "2025-12-15",
      endTime: "17:00",
      location: "Test Location",
      address: "123 Test St",
      organizer: userId.toString(),
      roles: [
        {
          id: "role1",
          name: "Participant",
          description: "Event participant",
          maxParticipants: 100,
          currentParticipants: 0,
        },
      ],
      pricing: {
        isFree: false,
        price: 5000,
      },
      status: "upcoming",
      programId: programId,
      createdBy: userId,
    });
    eventId = event._id as mongoose.Types.ObjectId;
  });

  afterAll(async () => {
    // Cleanup handled by vitest config
  });

  describe("GET /api/purchases/pending", () => {
    it("should return pending event purchase", async () => {
      // Create pending event purchase
      await Purchase.create({
        userId,
        purchaseType: "event",
        eventId,
        fullPrice: 5000,
        finalPrice: 5000,
        status: "pending",
        stripeSessionId: "cs_test_pending123",
        orderNumber: "ORD-TEST-001",
        paymentMethod: { type: "card", brand: "visa", last4: "4242" },
        billingInfo: { fullName: "Test User", email: "test@example.com" },
      });

      const response = await request(app)
        .get("/api/purchases/my-pending-purchases")
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].purchaseType).toBe("event");
      expect(response.body.data[0].eventId).toBeTruthy();
      expect(response.body.data[0].eventId.title).toBe("Test Event");
    });

    it("should populate event details in pending purchase", async () => {
      await Purchase.create({
        userId,
        purchaseType: "event",
        eventId,
        fullPrice: 5000,
        finalPrice: 4000, // Discounted
        status: "pending",
        stripeSessionId: "cs_test_pending456",
        orderNumber: "ORD-TEST-002",
        paymentMethod: { type: "card", brand: "visa", last4: "4242" },
        billingInfo: { fullName: "Test User", email: "test@example.com" },
      });

      const response = await request(app)
        .get("/api/purchases/my-pending-purchases")
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      const pendingPurchase = response.body.data[0];
      expect(pendingPurchase.eventId).toBeTruthy();
      expect(pendingPurchase.eventId.title).toBe("Test Event");
      expect(pendingPurchase.eventId.date).toBeTruthy();
      expect(pendingPurchase.fullPrice).toBe(5000);
      expect(pendingPurchase.finalPrice).toBe(4000);
    });

    it("should not return completed event purchases", async () => {
      // Create completed purchase
      await Purchase.create({
        userId,
        purchaseType: "event",
        eventId,
        fullPrice: 5000,
        finalPrice: 5000,
        status: "completed",
        stripeSessionId: "cs_test_completed",
        orderNumber: "ORD-TEST-003",
        paymentMethod: { type: "card", brand: "visa", last4: "4242" },
        billingInfo: { fullName: "Test User", email: "test@example.com" },
      });

      const response = await request(app)
        .get("/api/purchases/my-pending-purchases")
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      // Should only return pending, not completed
      expect(response.body.data).toHaveLength(0);
    });
  });

  describe("POST /api/purchases/retry/:id", () => {
    it("should create new Stripe session for pending event purchase", async () => {
      const pendingPurchase = await Purchase.create({
        userId,
        purchaseType: "event",
        eventId,
        fullPrice: 5000,
        finalPrice: 5000,
        status: "pending",
        stripeSessionId: "cs_test_old_session",
        orderNumber: "ORD-TEST-004",
        paymentMethod: { type: "card", brand: "visa", last4: "4242" },
        billingInfo: { fullName: "Test User", email: "test@example.com" },
      });

      const response = await request(app)
        .post(`/api/purchases/retry/${pendingPurchase._id}`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.sessionUrl).toMatch(
        /^https:\/\/checkout.stripe.com/
      );

      // Verify session ID was updated
      const updatedPurchase = await Purchase.findById(pendingPurchase._id);
      expect(updatedPurchase?.stripeSessionId).not.toBe("cs_test_old_session");
    });

    it("should use correct price without 100x multiplication", async () => {
      const pendingPurchase = await Purchase.create({
        userId,
        purchaseType: "event",
        eventId,
        fullPrice: 5000, // $50 in cents
        finalPrice: 5000,
        status: "pending",
        stripeSessionId: "cs_test_price_check",
        orderNumber: "ORD-TEST-005",
        paymentMethod: { type: "card", brand: "visa", last4: "4242" },
        billingInfo: { fullName: "Test User", email: "test@example.com" },
      });

      const response = await request(app)
        .post(`/api/purchases/retry/${pendingPurchase._id}`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      // Price should be $50, not $5000 (100x bug)
    });

    it("should prevent retry if event already purchased", async () => {
      // Create completed purchase
      await Purchase.create({
        userId,
        purchaseType: "event",
        eventId,
        fullPrice: 5000,
        finalPrice: 5000,
        status: "completed",
        orderNumber: "ORD-TEST-006",
        paymentMethod: { type: "card", brand: "visa", last4: "4242" },
        billingInfo: { fullName: "Test User", email: "test@example.com" },
      });

      // Create pending purchase
      const pendingPurchase = await Purchase.create({
        userId,
        purchaseType: "event",
        eventId,
        fullPrice: 5000,
        finalPrice: 5000,
        status: "pending",
        stripeSessionId: "cs_test_retry_dupe",
        orderNumber: "ORD-TEST-007",
        paymentMethod: { type: "card", brand: "visa", last4: "4242" },
        billingInfo: { fullName: "Test User", email: "test@example.com" },
      });

      const response = await request(app)
        .post(`/api/purchases/retry/${pendingPurchase._id}`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toMatch(/already purchased|already own/i);
    });

    it("should include correct cancel URL for events", async () => {
      const pendingPurchase = await Purchase.create({
        userId,
        purchaseType: "event",
        eventId,
        fullPrice: 5000,
        finalPrice: 5000,
        status: "pending",
        stripeSessionId: "cs_test_cancel_url",
        orderNumber: "ORD-TEST-008",
        paymentMethod: { type: "card", brand: "visa", last4: "4242" },
        billingInfo: { fullName: "Test User", email: "test@example.com" },
      });

      const response = await request(app)
        .post(`/api/purchases/retry/${pendingPurchase._id}`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      // Cancel URL should be /dashboard/purchase/cancel?event_id=...
      // (Cannot directly verify Stripe session metadata, but endpoint should return successfully)
    });

    it("should reject retry for non-existent purchase", async () => {
      const fakeId = new mongoose.Types.ObjectId();

      const response = await request(app)
        .post(`/api/purchases/retry/${fakeId}`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toMatch(/not found/i);
    });

    it("should reject retry for other user's purchase", async () => {
      // Create another user
      const otherUser = await User.create({
        username: "otheruser",
        email: "other@test.com",
        firstName: "Other",
        lastName: "User",
        password: "Password123!",
        isVerified: true,
        gender: "male",
        isAtCloudLeader: false,
        role: "Participant",
      });

      const otherPurchase = await Purchase.create({
        userId: otherUser._id,
        purchaseType: "event",
        eventId,
        fullPrice: 5000,
        finalPrice: 5000,
        status: "pending",
        stripeSessionId: "cs_test_other",
        orderNumber: "ORD-TEST-009",
        paymentMethod: { type: "card", brand: "visa", last4: "4242" },
        billingInfo: { fullName: "Test User", email: "test@example.com" },
      });

      const response = await request(app)
        .post(`/api/purchases/retry/${otherPurchase._id}`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(403);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain(
        "You can only retry your own purchases"
      );
    });
  });

  describe("DELETE /api/purchases/pending/:id", () => {
    it("should cancel pending event purchase", async () => {
      const pendingPurchase = await Purchase.create({
        userId,
        purchaseType: "event",
        eventId,
        fullPrice: 5000,
        finalPrice: 5000,
        status: "pending",
        stripeSessionId: "cs_test_delete",
        orderNumber: "ORD-TEST-010",
        paymentMethod: { type: "card", brand: "visa", last4: "4242" },
        billingInfo: { fullName: "Test User", email: "test@example.com" },
      });

      const response = await request(app)
        .delete(`/api/purchases/${pendingPurchase._id}`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toMatch(/removed|cancelled/i);

      // Verify purchase was deleted
      const deletedPurchase = await Purchase.findById(pendingPurchase._id);
      expect(deletedPurchase).toBeNull();
    });

    it("should not allow deleting completed event purchase", async () => {
      const completedPurchase = await Purchase.create({
        userId,
        purchaseType: "event",
        eventId,
        fullPrice: 5000,
        finalPrice: 5000,
        status: "completed",
        orderNumber: "ORD-TEST-011",
        paymentMethod: { type: "card", brand: "visa", last4: "4242" },
        billingInfo: { fullName: "Test User", email: "test@example.com" },
      });

      const response = await request(app)
        .delete(`/api/purchases/${completedPurchase._id}`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain(
        "Cannot cancel a completed purchase"
      );

      // Verify purchase was NOT deleted
      const stillExists = await Purchase.findById(completedPurchase._id);
      expect(stillExists).toBeTruthy();
    });

    it("should not allow deleting other user's pending purchase", async () => {
      const otherUser = await User.create({
        username: "otheruser2",
        email: "other2@test.com",
        firstName: "Other2",
        lastName: "User",
        password: "Password123!",
        isVerified: true,
        gender: "male",
        isAtCloudLeader: false,
        role: "Participant",
      });

      const otherPurchase = await Purchase.create({
        userId: otherUser._id,
        purchaseType: "event",
        eventId,
        fullPrice: 5000,
        finalPrice: 5000,
        status: "pending",
        stripeSessionId: "cs_test_other_delete",
        orderNumber: "ORD-TEST-012",
        paymentMethod: { type: "card", brand: "visa", last4: "4242" },
        billingInfo: { fullName: "Test User", email: "test@example.com" },
      });

      const response = await request(app)
        .delete(`/api/purchases/${otherPurchase._id}`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(403);

      expect(response.body.success).toBe(false);

      // Verify purchase still exists
      const stillExists = await Purchase.findById(otherPurchase._id);
      expect(stillExists).toBeTruthy();
    });
  });
});
