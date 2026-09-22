/**
 * Webhook Handler Integration Tests
 *
 * Tests Stripe webhook event processing including:
 * - checkout.session.completed
 * - payment_intent.succeeded
 * - payment_intent.failed
 * - Email confirmation sending
 * - Purchase status updates
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
import Stripe from "stripe";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Program from "../../../src/models/Program";
import { Purchase } from "../../../src/models";
import { ensureIntegrationDB } from "../setup/connect";
import { EmailService } from "../../../src/services/infrastructure/EmailServiceFacade";

// Mock Stripe webhook construction and stripe instance
vi.mock("../../../src/services/stripeService", async () => {
  const actual = await vi.importActual("../../../src/services/stripeService");

  // Create a mock stripe instance
  const mockStripe = {
    charges: {
      retrieve: vi.fn().mockResolvedValue({
        payment_method_details: {
          card: {
            brand: "visa",
            last4: "4242",
          },
        },
        billing_details: {
          name: "Test User",
        },
      }),
    },
  };

  return {
    ...actual,
    constructWebhookEvent: vi.fn(
      (body: string | Buffer | any, signature: string) => {
        // In test environment, body might already be a parsed JSON object
        if (typeof body === "object" && !Buffer.isBuffer(body)) {
          return body;
        }
        // Parse the body if it's a Buffer or string (production behavior)
        const eventData =
          typeof body === "string"
            ? JSON.parse(body)
            : JSON.parse(body.toString());
        return eventData;
      }
    ),
    getPaymentIntent: vi.fn().mockResolvedValue({
      id: "pi_test_123",
      latest_charge: "ch_test_123",
    }),
    stripe: mockStripe,
  };
});

// Remove the separate Stripe mock as we're mocking the stripe instance directly above

// Spy on email service
const emailSpy = vi.spyOn(EmailService, "sendPurchaseConfirmationEmail");

describe("Webhook Handler Integration Tests", () => {
  let userId: string;
  let programId: string;
  let purchaseId: string;

  beforeAll(async () => {
    await ensureIntegrationDB();
  });

  beforeEach(async () => {
    await User.deleteMany({});
    await Program.deleteMany({});
    await Purchase.deleteMany({});
    emailSpy.mockClear();
    emailSpy.mockResolvedValue(true);

    // Create user
    const user = await User.create({
      username: "webhookuser",
      email: "webhook@example.com",
      password: "WebhookPass123!",
      firstName: "Webhook",
      lastName: "User",
      role: "Participant",
      gender: "male",
      isVerified: true,
    });
    userId = user._id.toString();

    // Create program (price in cents, max 2000 = $20)
    const program = await Program.create({
      title: "Webhook Test Mentor Circle",
      introduction: "Test program for webhooks",
      programType: "EMBA Mentor Circles",
      isFree: false,
      fullPriceTicket: 1900, // $19.00 in cents
      classRepDiscount: 500, // $5.00 in cents
      earlyBirdDeadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
      earlyBirdDiscount: 400, // $4.00 in cents
      createdBy: user._id,
    });
    programId = program._id.toString();
  });

  afterEach(async () => {
    await User.deleteMany({});
    await Program.deleteMany({});
    await Purchase.deleteMany({});
  });

  afterAll(async () => {
    // Shared integration harness owns connection lifecycle.
    vi.restoreAllMocks();
  });

  describe("POST /api/webhooks/stripe - checkout.session.completed", () => {
    beforeEach(async () => {
      // Create a pending purchase
      const purchase = await Purchase.create({
        userId: userId,
        programId: programId,
        fullPrice: 1900,
        finalPrice: 1000,
        isClassRep: true,
        classRepDiscount: 500,
        isEarlyBird: true,
        earlyBirdDiscount: 400,
        status: "pending",
        orderNumber: "ORD-WEBHOOK-001",
        stripeSessionId: "cs_test_session_123",
        paymentMethod: { type: "card", cardBrand: "visa", last4: "0000" },
        billingInfo: {
          fullName: "Webhook User",
          email: "webhook@example.com",
        },
      });
      purchaseId = (purchase._id as mongoose.Types.ObjectId).toString();
    });

    it("should mark purchase as completed", async () => {
      const event: Stripe.Event = {
        id: "evt_test_123",
        object: "event",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_session_123",
            payment_intent: "pi_test_123",
            customer_details: {
              name: "Webhook User Updated",
              email: "webhook@example.com",
              address: {
                line1: "123 Main St",
                city: "Springfield",
                state: "IL",
                postal_code: "62701",
                country: "US",
              },
            },
          } as Stripe.Checkout.Session,
        },
      } as Stripe.Event;

      const response = await request(app)
        .post("/api/webhooks/stripe")
        .set("stripe-signature", "test_signature")

        .send(event);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        received: true,
      });

      // Verify purchase was updated
      const purchase = await Purchase.findById(purchaseId);
      expect(purchase?.status).toBe("completed");
      expect(purchase?.purchaseDate).toBeDefined();
      expect(purchase?.stripePaymentIntentId).toBe("pi_test_123");
      expect(purchase?.billingInfo.fullName).toBe("Webhook User Updated");
      expect(purchase?.billingInfo.address).toBe("123 Main St");
      expect(purchase?.paymentMethod?.type).toBe("card");
      expect(purchase?.paymentMethod?.cardBrand).toBe("visa");
      expect(purchase?.paymentMethod?.last4).toBe("4242");
    });

    it("recovers completion by signed purchaseId metadata when the local session ID was not saved", async () => {
      await Purchase.updateOne(
        { _id: purchaseId },
        { $unset: { stripeSessionId: 1 } },
      );
      const event: Stripe.Event = {
        id: "evt_recover_purchase_id",
        object: "event",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_recovered_session",
            payment_intent: "pi_test_123",
            metadata: { purchaseId },
            customer_details: {
              name: "Webhook User",
              email: "webhook@example.com",
            },
          } as Stripe.Checkout.Session,
        },
      } as Stripe.Event;

      const response = await request(app)
        .post("/api/webhooks/stripe")
        .set("stripe-signature", "test_signature")
        .send(event);

      expect(response.status).toBe(200);
      const purchase = await Purchase.findById(purchaseId);
      expect(purchase?.status).toBe("completed");
      expect(purchase?.stripeSessionId).toBe("cs_recovered_session");
      expect(emailSpy).toHaveBeenCalledTimes(1);
    });

    it("completes a retried checkout and replaces its old non-empty session ID using signed purchaseId metadata", async () => {
      await Purchase.updateOne(
        { _id: purchaseId },
        { $set: { stripeSessionId: "cs_newer_session" } },
      );
      const event: Stripe.Event = {
        id: "evt_mismatched_purchase_id",
        object: "event",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_stale_session",
            payment_intent: "pi_test_123",
            metadata: { purchaseId },
          } as Stripe.Checkout.Session,
        },
      } as Stripe.Event;

      const response = await request(app)
        .post("/api/webhooks/stripe")
        .set("stripe-signature", "test_signature")
        .send(event);

      expect(response.status).toBe(200);
      const purchase = await Purchase.findById(purchaseId);
      expect(purchase?.status).toBe("completed");
      expect(purchase?.stripeSessionId).toBe("cs_stale_session");
      expect(emailSpy).toHaveBeenCalledTimes(1);
    });

    it("should send purchase confirmation email", async () => {
      const event: Stripe.Event = {
        id: "evt_test_124",
        object: "event",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_session_123",
            payment_intent: "pi_test_123",
            customer_details: {
              name: "Webhook User",
              email: "webhook@example.com",
            },
          } as Stripe.Checkout.Session,
        },
      } as Stripe.Event;

      await request(app)
        .post("/api/webhooks/stripe")
        .set("stripe-signature", "test_signature")

        .send(event);

      // Verify email was sent
      expect(emailSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          email: "webhook@example.com",
          name: "Webhook User",
          orderNumber: "ORD-WEBHOOK-001",
          programTitle: "Webhook Test Mentor Circle",
          programType: "EMBA Mentor Circles",
          fullPrice: 1900,
          finalPrice: 1000,
          classRepDiscount: 500,
          earlyBirdDiscount: 400,
          isClassRep: true,
          isEarlyBird: true,
        })
      );
    });

    it("should handle missing purchase gracefully", async () => {
      const event: Stripe.Event = {
        id: "evt_test_125",
        object: "event",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_nonexistent_session",
            payment_intent: "pi_test_123",
          } as Stripe.Checkout.Session,
        },
      } as Stripe.Event;

      const response = await request(app)
        .post("/api/webhooks/stripe")
        .set("stripe-signature", "test_signature")

        .send(event);

      // Should still return 200 to avoid Stripe retries
      expect(response.status).toBe(200);
    });

    it("should not fail webhook if email sending fails", async () => {
      emailSpy.mockRejectedValueOnce(new Error("Email service down"));

      const event: Stripe.Event = {
        id: "evt_test_126",
        object: "event",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_session_123",
            payment_intent: "pi_test_123",
            customer_details: {
              name: "Webhook User",
              email: "webhook@example.com",
            },
          } as Stripe.Checkout.Session,
        },
      } as Stripe.Event;

      const response = await request(app)
        .post("/api/webhooks/stripe")
        .set("stripe-signature", "test_signature")

        .send(event);

      expect(response.status).toBe(200);

      // Verify purchase was still updated
      const purchase = await Purchase.findById(purchaseId);
      expect(purchase?.status).toBe("completed");
    });
  });

  describe("POST /api/webhooks/stripe - payment_intent.succeeded", () => {
    beforeEach(async () => {
      // Create a pending purchase with payment intent
      const purchase = await Purchase.create({
        userId: userId,
        programId: programId,
        fullPrice: 1900,
        finalPrice: 1900,
        isClassRep: false,
        isEarlyBird: false,
        status: "pending",
        orderNumber: "ORD-WEBHOOK-002",
        stripeSessionId: "cs_test_session_456",
        stripePaymentIntentId: "pi_test_456",
        paymentMethod: { type: "card", cardBrand: "visa", last4: "0000" },
        billingInfo: {
          fullName: "Webhook User",
          email: "webhook@example.com",
        },
      });
      purchaseId = (purchase._id as mongoose.Types.ObjectId).toString();
    });

    it("should mark purchase as completed", async () => {
      const event: Stripe.Event = {
        id: "evt_test_200",
        object: "event",
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: "pi_test_456",
          } as Stripe.PaymentIntent,
        },
      } as Stripe.Event;

      const response = await request(app)
        .post("/api/webhooks/stripe")
        .set("stripe-signature", "test_signature")

        .send(event);

      expect(response.status).toBe(200);

      const purchase = await Purchase.findById(purchaseId);
      expect(purchase?.status).toBe("completed");
      expect(purchase?.purchaseDate).toBeDefined();
    });

    it("should not update already completed purchase", async () => {
      // Mark as completed first
      await Purchase.findByIdAndUpdate(purchaseId, {
        status: "completed",
        purchaseDate: new Date("2025-01-01"),
      });

      const event: Stripe.Event = {
        id: "evt_test_201",
        object: "event",
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: "pi_test_456",
          } as Stripe.PaymentIntent,
        },
      } as Stripe.Event;

      await request(app)
        .post("/api/webhooks/stripe")
        .set("stripe-signature", "test_signature")

        .send(event);

      const purchase = await Purchase.findById(purchaseId);
      expect(purchase?.purchaseDate?.toISOString()).toContain("2025-01-01");
    });

    it("should handle missing payment intent gracefully", async () => {
      const event: Stripe.Event = {
        id: "evt_test_202",
        object: "event",
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: "pi_nonexistent",
          } as Stripe.PaymentIntent,
        },
      } as Stripe.Event;

      const response = await request(app)
        .post("/api/webhooks/stripe")
        .set("stripe-signature", "test_signature")

        .send(event);

      expect(response.status).toBe(200);
    });
  });

  describe("POST /api/webhooks/stripe - payment_intent.payment_failed", () => {
    beforeEach(async () => {
      // Create a pending purchase
      const purchase = await Purchase.create({
        userId: userId,
        programId: programId,
        fullPrice: 1900,
        finalPrice: 1900,
        isClassRep: false,
        isEarlyBird: false,
        status: "pending",
        orderNumber: "ORD-WEBHOOK-003",
        stripeSessionId: "cs_test_session_789",
        stripePaymentIntentId: "pi_test_789",
        paymentMethod: { type: "card", cardBrand: "visa", last4: "0000" },
        billingInfo: {
          fullName: "Webhook User",
          email: "webhook@example.com",
        },
      });
      purchaseId = (purchase._id as mongoose.Types.ObjectId).toString();
    });

    it("should mark purchase as failed", async () => {
      const event: Stripe.Event = {
        id: "evt_test_300",
        object: "event",
        type: "payment_intent.payment_failed",
        data: {
          object: {
            id: "pi_test_789",
          } as Stripe.PaymentIntent,
        },
      } as Stripe.Event;

      const response = await request(app)
        .post("/api/webhooks/stripe")
        .set("stripe-signature", "test_signature")

        .send(event);

      expect(response.status).toBe(200);

      const purchase = await Purchase.findById(purchaseId);
      expect(purchase?.status).toBe("failed");
    });

    it("should handle missing payment intent gracefully", async () => {
      const event: Stripe.Event = {
        id: "evt_test_301",
        object: "event",
        type: "payment_intent.payment_failed",
        data: {
          object: {
            id: "pi_nonexistent_failed",
          } as Stripe.PaymentIntent,
        },
      } as Stripe.Event;

      const response = await request(app)
        .post("/api/webhooks/stripe")
        .set("stripe-signature", "test_signature")

        .send(event);

      expect(response.status).toBe(200);
    });
  });

  describe("Webhook Security", () => {
    it("should reject webhook without signature", async () => {
      const event: Stripe.Event = {
        id: "evt_test_400",
        object: "event",
        type: "checkout.session.completed",
        data: {
          object: {} as Stripe.Checkout.Session,
        },
      } as Stripe.Event;

      const response = await request(app)
        .post("/api/webhooks/stripe")

        .send(event);

      expect(response.status).toBe(400);
      expect(response.body.message).toContain("stripe-signature");
    });
  });
});
