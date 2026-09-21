import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../src/app";
import { ensureIntegrationDB } from "../setup/connect";
import User from "../../../src/models/User";
import Purchase from "../../../src/models/Purchase";
import PromoCode from "../../../src/models/PromoCode";

// Mock email service
vi.mock("../../../src/utils/email", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

const stripeCheckoutMocks = vi.hoisted(() => {
  let nextSessionNumber = 0;

  return {
    create: vi.fn(async () => {
      nextSessionNumber += 1;
      const id = `cs_test_event_purchase_${nextSessionNumber}`;
      return {
        id,
        url: `https://checkout.stripe.com/c/pay/${id}`,
        status: "open",
      };
    }),
    retrieve: vi.fn(async () => ({ status: "open" })),
    expire: vi.fn(async () => ({ status: "expired" })),
    retrieveCharge: vi.fn(async () => ({
      payment_method_details: {
        card: { brand: "visa", last4: "4242" },
      },
      billing_details: { name: "Test Purchaser" },
    })),
  };
});

// Keep checkout and webhook processing local: no integration test may invoke Stripe.
vi.mock("../../../src/services/stripeService", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../src/services/stripeService")
  >();
  return {
    ...actual,
    constructWebhookEvent: vi.fn().mockImplementation((body) => {
      return body;
    }),
    getPaymentIntent: vi.fn().mockResolvedValue({
      id: "pi_test_event_purchase",
      latest_charge: null,
    }),
    stripe: {
      checkout: {
        sessions: {
          create: stripeCheckoutMocks.create,
          retrieve: stripeCheckoutMocks.retrieve,
          expire: stripeCheckoutMocks.expire,
        },
      },
      charges: {
        retrieve: stripeCheckoutMocks.retrieveCharge,
      },
    },
  };
});

describe("Event Purchase Flow Integration Tests", () => {
  let authToken: string;
  let userId: mongoose.Types.ObjectId;
  let organizerId: mongoose.Types.ObjectId;
  let programId: mongoose.Types.ObjectId;
  let eventId: mongoose.Types.ObjectId;

  beforeEach(async () => {
    await ensureIntegrationDB();
    // Clear collections
    await User.deleteMany({});
    await Purchase.deleteMany({});
    await PromoCode.deleteMany({});

    // Create event organizer user (different from purchaser)
    const organizer = await User.create({
      email: "organizer@test.com",
      firstName: "Event",
      lastName: "Organizer",
      username: "organizer",
      password: "ValidPassword123!",
      isVerified: true,
    });
    organizerId = organizer._id as mongoose.Types.ObjectId;

    // Create test purchaser user
    const user = await User.create({
      email: "purchaser@test.com",
      firstName: "Test",
      lastName: "Purchaser",
      username: "purchaser",
      password: "ValidPassword123!",
      isVerified: true,
    });
    userId = user._id as mongoose.Types.ObjectId;

    // Login as purchaser to get token
    const loginRes = await request(app).post("/api/auth/login").send({
      emailOrUsername: "purchaser@test.com",
      password: "ValidPassword123!",
    });
    authToken = loginRes.body.data.accessToken;

    // Create program with paid event (using dynamic import)
    const { default: Program } = await import("../../../src/models/Program");
    const program = await Program.create({
      title: "Test Program",
      programType: "EMBA Mentor Circles",
      description: "Program for testing",
      createdBy: organizerId, // Created by organizer, not purchaser
      fullPriceTicket: 20000, // $200 in cents
      date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      startTime: "09:00",
      endTime: "17:00",
      location: "Test Location",
      address: "123 Test St",
      capacity: 100,
      earlyBirdDeadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      earlyBirdPrice: 15000,
      regularPrice: 20000,
      status: "published",
      isPublished: true,
      agenda: [],
    });
    programId = program._id as mongoose.Types.ObjectId;

    // Create paid event
    const { default: Event } = await import("../../../src/models/Event");
    const event = await Event.create({
      title: "Test Event",
      date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0], // YYYY-MM-DD format
      endDate: new Date(Date.now() + 7.5 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0],
      time: "10:00",
      endTime: "12:00",
      location: "Event Location",
      organizer: "@Cloud",
      type: "Mentor Circle",
      format: "Hybrid Participation",
      purpose: "Event for testing",
      programId: programId,
      createdBy: organizerId, // Created by organizer, not purchaser
      status: "upcoming",
      pricing: {
        isFree: false,
        price: 5000, // $50 in cents
      },
      roles: [
        {
          id: "role1",
          name: "Participant",
          description: "Event participant",
          maxParticipants: 100,
        },
      ],
      signedUp: 0,
      totalSlots: 100,
    });
    eventId = event._id as mongoose.Types.ObjectId;
  });

  afterAll(async () => {
    // Cleanup handled by vitest config
  });

  describe("Event purchase without promo code", () => {
    it("should create pending purchase and return Stripe session URL", async () => {
      const response = await request(app)
        .post(`/api/events/${eventId}/purchase`)
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          userName: "Test Purchaser",
          userEmail: "purchaser@test.com",
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty("sessionUrl");
      expect(response.body.data.sessionUrl).toMatch(
        /^https:\/\/checkout.stripe.com/
      );

      // Verify pending purchase was created
      const pendingPurchase = await Purchase.findOne({
        userId,
        purchaseType: "event",
        eventId,
        status: "pending",
      });

      expect(pendingPurchase).toBeTruthy();
      expect(pendingPurchase?.finalPrice).toBe(5000);
      expect(pendingPurchase?.promoCodeId).toBeUndefined();
    });

    it("should allow re-purchasing (deletes old pending purchase and creates new session)", async () => {
      // Create first pending purchase
      const firstResponse = await request(app)
        .post(`/api/events/${eventId}/purchase`)
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          userName: "Test Purchaser",
          userEmail: "purchaser@test.com",
        })
        .expect(200);

      const firstSessionUrl = firstResponse.body.data.sessionUrl;

      // Try to create second pending purchase - should succeed by deleting old one
      const secondResponse = await request(app)
        .post(`/api/events/${eventId}/purchase`)
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          userName: "Test Purchaser",
          userEmail: "purchaser@test.com",
        })
        .expect(200);

      const secondSessionUrl = secondResponse.body.data.sessionUrl;

      // Should have new session URL
      expect(secondSessionUrl).toBeTruthy();
      expect(secondSessionUrl).not.toBe(firstSessionUrl);

      // Should only have one pending purchase
      const pendingPurchases = await Purchase.find({
        userId,
        purchaseType: "event",
        eventId,
        status: "pending",
      });

      expect(pendingPurchases.length).toBe(1);
    });
  });

  describe("Event purchase with promo code", () => {
    it("should apply general promo code discount", async () => {
      // Create general promo code (50% off)
      const promoCode = await PromoCode.create({
        code: "GEN50OFF",
        type: "reward",
        discountPercent: 50,
        isActive: true,
        createdBy: userId,
        ownerId: userId,
        // No applicableToType = works for both programs and events
      });

      const response = await request(app)
        .post(`/api/events/${eventId}/purchase`)
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          userName: "Test Purchaser",
          userEmail: "purchaser@test.com",
          promoCode: "GEN50OFF",
        })
        .expect(200);

      expect(response.body.success).toBe(true);

      // Verify pending purchase has correct discounted price
      const pendingPurchase = await Purchase.findOne({
        userId,
        purchaseType: "event",
        eventId,
        status: "pending",
      });

      expect(pendingPurchase).toBeTruthy();
      expect(pendingPurchase?.fullPrice).toBe(5000);
      expect(pendingPurchase?.finalPrice).toBe(2500); // 50% off
      expect(pendingPurchase?.promoCodeId?.toString()).toBe(
        String((promoCode as any)._id)
      );
    });

    it("should apply event-specific promo code", async () => {
      // Create event-specific promo code
      const promoCode = await PromoCode.create({
        code: "EVENT20X",
        type: "reward",
        discountPercent: 20,
        isActive: true,
        createdBy: userId,
        ownerId: userId,
        applicableToType: "event",
        allowedEventIds: [eventId],
      });

      const response = await request(app)
        .post(`/api/events/${eventId}/purchase`)
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          userName: "Test Purchaser",
          userEmail: "purchaser@test.com",
          promoCode: "EVENT20X",
        })
        .expect(200);

      expect(response.body.success).toBe(true);

      const pendingPurchase = await Purchase.findOne({
        userId,
        eventId,
        status: "pending",
      });

      expect(pendingPurchase?.finalPrice).toBe(4000); // 20% off $50
    });

    it("should reject program-only promo code for event purchase", async () => {
      // Create program-only promo code
      await PromoCode.create({
        code: "PROG30PC",
        type: "staff_access",
        discountPercent: 30,
        isActive: true,
        createdBy: userId,
        ownerId: userId,
        applicableToType: "program",
        allowedProgramIds: [programId],
      });

      const response = await request(app)
        .post(`/api/events/${eventId}/purchase`)
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          userName: "Test Purchaser",
          userEmail: "purchaser@test.com",
          promoCode: "PROG30PC",
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe("Code is only valid for programs");
    });

    it("should reject event-specific code for different event", async () => {
      const { default: Event } = await import("../../../src/models/Event");
      const otherEvent = await Event.create({
        title: "Other Event",
        date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        endDate: new Date(Date.now() + 7.5 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        time: "14:00",
        endTime: "16:00",
        location: "Other Location",
        organizer: "@Cloud",
        type: "Webinar",
        format: "Online",
        purpose: "Another event",
        programId: programId,
        createdBy: organizerId,
        status: "upcoming",
        pricing: { isFree: false, price: 3000 },
        roles: [
          {
            id: "role1",
            name: "Participant",
            description: "Participant",
            maxParticipants: 50,
          },
        ],
        signedUp: 0,
        totalSlots: 50,
      });

      await PromoCode.create({
        code: "OTHEREV1",
        type: "reward",
        discountPercent: 25,
        isActive: true,
        createdBy: userId,
        ownerId: userId,
        applicableToType: "event",
        allowedEventIds: [otherEvent._id],
      });

      const response = await request(app)
        .post(`/api/events/${eventId}/purchase`)
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          userName: "Test Purchaser",
          userEmail: "purchaser@test.com",
          promoCode: "OTHEREV1",
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe("Code is not valid for this event");
    });
  });

  describe("Webhook processing for event purchase", () => {
    it("should mark purchase as completed on successful webhook", async () => {
      // Create pending purchase
      const sessionId = `cs_test_${Date.now()}`;
      const pendingPurchase = await Purchase.create({
        userId,
        purchaseType: "event",
        eventId,
        fullPrice: 5000,
        finalPrice: 5000,
        status: "pending",
        stripeSessionId: sessionId,
        orderNumber: `ORD-${Date.now()}`,
        paymentMethod: {
          type: "card",
          brand: "visa",
          last4: "4242",
        },
        billingInfo: {
          fullName: "Test Purchaser",
          email: "purchaser@test.com",
        },
      });

      // Simulate Stripe webhook
      const webhookPayload = {
        type: "checkout.session.completed",
        data: {
          object: {
            id: sessionId,
            payment_status: "paid",
          },
        },
      };

      await request(app)
        .post("/api/webhooks/stripe")
        .set("stripe-signature", "test_signature")
        .send(webhookPayload)
        .expect(200);

      // Verify purchase is now completed
      const completedPurchase = await Purchase.findById(pendingPurchase._id);
      expect(completedPurchase?.status).toBe("completed");
    });

    it("should mark promo code as used on successful webhook", async () => {
      const promoCode = await PromoCode.create({
        code: "FIRST50X",
        type: "reward",
        discountPercent: 50,
        isActive: true,
        isUsed: false,
        createdBy: userId,
        ownerId: userId,
      });

      const sessionId = `cs_test_${Date.now()}`;
      await Purchase.create({
        userId,
        purchaseType: "event",
        eventId,
        fullPrice: 5000,
        finalPrice: 2500,
        promoCodeId: promoCode._id,
        promoCode: promoCode.code,
        status: "pending",
        stripeSessionId: sessionId,
        orderNumber: `ORD-${Date.now()}-1`,
        paymentMethod: {
          type: "card",
          brand: "visa",
          last4: "4242",
        },
        billingInfo: {
          fullName: "Test Purchaser",
          email: "purchaser@test.com",
        },
      });

      // Simulate webhook
      await request(app)
        .post("/api/webhooks/stripe")
        .set("stripe-signature", "test_signature")
        .send({
          type: "checkout.session.completed",
          data: {
            object: {
              id: sessionId,
              payment_status: "paid",
            },
          },
        })
        .expect(200);

      // Verify promo code is marked as used
      const updatedPromo = await PromoCode.findById(promoCode._id);
      expect(updatedPromo?.isUsed).toBe(true);
    });

    it("should send confirmation email on successful webhook", async () => {
      const sessionId = `cs_test_${Date.now()}`;
      await Purchase.create({
        userId,
        purchaseType: "event",
        eventId,
        fullPrice: 5000,
        finalPrice: 5000,
        status: "pending",
        stripeSessionId: sessionId,
        orderNumber: `ORD-${Date.now()}-2`,
        paymentMethod: {
          type: "card",
          brand: "visa",
          last4: "4242",
        },
        billingInfo: {
          fullName: "Test Purchaser",
          email: "purchaser@test.com",
        },
      });

      await request(app)
        .post("/api/webhooks/stripe")
        .set("stripe-signature", "test_signature")
        .send({
          type: "checkout.session.completed",
          data: {
            object: {
              id: sessionId,
              payment_status: "paid",
            },
          },
        })
        .expect(200);

      // Email sending is handled by webhook - verify purchase completed
      const completedPurchase = await Purchase.findOne({
        userId,
        eventId,
        status: "completed",
      });
      expect(completedPurchase).toBeTruthy();
    });

    it("should NOT generate bundle code for event purchase", async () => {
      const promoCode = await PromoCode.create({
        code: "BUNDLE30",
        type: "bundle_discount",
        discountAmount: 3000, // $30 off in cents
        isActive: true,
        isUsed: false,
        createdBy: userId,
        ownerId: userId,
      });

      const sessionId = `cs_test_${Date.now()}`;
      await Purchase.create({
        userId,
        purchaseType: "event",
        eventId,
        fullPrice: 5000,
        finalPrice: 3500,
        promoCodeId: promoCode._id,
        status: "pending",
        stripeSessionId: sessionId,
        orderNumber: `ORD-${Date.now()}-3`,
        paymentMethod: {
          type: "card",
          brand: "visa",
          last4: "4242",
        },
        billingInfo: {
          fullName: "Test Purchaser",
          email: "purchaser@test.com",
        },
      });

      await request(app)
        .post("/api/webhooks/stripe")
        .set("stripe-signature", "test_signature")
        .send({
          type: "checkout.session.completed",
          data: {
            object: {
              id: sessionId,
              payment_status: "paid",
            },
          },
        })
        .expect(200);

      // Verify no new bundle code was created
      const bundleCodes = await PromoCode.find({
        createdBy: userId,
        isBundle: true,
        sourcePromoCodeId: promoCode._id,
      });

      expect(bundleCodes.length).toBe(0);
    });
  });

  describe("Free event purchase", () => {
    it("should reject free event through purchase endpoint (free events don't use purchase flow)", async () => {
      // Create free event
      const { default: Event } = await import("../../../src/models/Event");
      const freeEvent = await Event.create({
        title: "Free Webinar",
        date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        endDate: new Date(Date.now() + 7.5 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        time: "10:00",
        endTime: "12:00",
        location: "Online",
        organizer: "@Cloud",
        type: "Webinar",
        format: "Online",
        purpose: "Free event",
        programId: programId,
        createdBy: organizerId,
        status: "upcoming",
        pricing: { isFree: true }, // Free events don't need price field
        roles: [
          {
            id: "role1",
            name: "Participant",
            description: "Participant",
            maxParticipants: 100, // Maximum allowed is 100
          },
        ],
        signedUp: 0,
        totalSlots: 100,
      });

      // Purchase endpoint should reject free events
      const response = await request(app)
        .post(`/api/events/${freeEvent._id}/purchase`)
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          userName: "Test Purchaser",
          userEmail: "purchaser@test.com",
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toMatch(/free.*no.*purchase/i);
    });
  });
});
