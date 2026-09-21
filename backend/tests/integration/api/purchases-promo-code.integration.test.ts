/**
 * Integration Tests for Purchase Flow with Promo Codes
 * Tests 100% discount (free) purchases, promo code validation during checkout
 */
import request from "supertest";
import { describe, test, expect, afterEach, beforeAll, vi } from "vitest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";
import PromoCode from "../../../src/models/PromoCode";
import Program from "../../../src/models/Program";
import Purchase from "../../../src/models/Purchase";
import { createAndLoginTestUser } from "../../test-utils/createTestUser";
import { ensureIntegrationDB } from "../setup/connect";

const stripeCheckoutMocks = vi.hoisted(() => {
  let nextSessionNumber = 0;

  return {
    create: vi.fn(async () => {
      nextSessionNumber += 1;
      const id = `cs_test_promo_purchase_${nextSessionNumber}`;
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

beforeAll(async () => {
  await ensureIntegrationDB();
});

// Helper function to create test program
async function createTestProgram(
  createdBy: mongoose.Types.ObjectId | string,
  overrides: Partial<any> = {}
) {
  return await Program.create({
    title: overrides.title || "Test Program",
    programType: "EMBA Mentor Circles",
    fullPriceTicket: 10000, // $100 in cents
    createdBy,
    ...overrides,
  });
}

describe("Purchase Flow with Promo Codes", () => {
  afterEach(async () => {
    // Clean up test data
    await PromoCode.deleteMany({});
    await Program.deleteMany({});
    await Purchase.deleteMany({});
    await User.deleteMany({});
  });

  // ============================================================================
  // 100% DISCOUNT (FREE) PURCHASE FLOW
  // ============================================================================

  describe("100% Discount - Free Purchase Flow", () => {
    test("creates free purchase with valid 100% staff discount code", async () => {
      const { token, userId } = await createAndLoginTestUser();

      const program = await createTestProgram(userId, {
        fullPriceTicket: 15000, // $150
      });

      const promoCode = await PromoCode.create({
        code: "FREECO01",
        type: "staff_access",
        discountPercent: 100,
        ownerId: userId,
        isActive: true,
        isUsed: false,
        createdBy: "admin",
      });

      // Create checkout session with 100% discount code
      const res = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${token}`)
        .send({
          programId: program._id.toString(),
          promoCode: "FREECO01",
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.isFree).toBe(true);
      expect(res.body.data.orderId).toBeDefined();
      expect(res.body.data.sessionId).toBeNull();
      expect(res.body.data.sessionUrl).toBeNull();

      // Verify promo code was marked as used
      const updatedCode = await PromoCode.findOne({ code: "FREECO01" });
      expect(updatedCode!.isUsed).toBe(true);
      expect(updatedCode!.usedAt).toBeInstanceOf(Date);
      expect(updatedCode!.usedForProgramId).toBeDefined();
      expect(updatedCode!.usedForProgramId!.toString()).toBe(
        program._id.toString()
      );

      // Verify purchase was created using the orderId
      const purchase = await Purchase.findOne({
        orderNumber: res.body.data.orderId,
      });
      expect(purchase).toBeDefined();
      expect(purchase!.finalPrice).toBe(0);
      expect(purchase!.status).toBe("completed");
      expect(purchase!.promoCode).toBe("FREECO01");
    });

    test("free purchase does not create Stripe session", async () => {
      const { token, userId } = await createAndLoginTestUser();

      const program = await createTestProgram(userId);

      await PromoCode.create({
        code: "FREE1001",
        type: "staff_access",
        discountPercent: 100,
        ownerId: userId,
        isActive: true,
        isUsed: false,
        createdBy: "admin",
      });

      const res = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${token}`)
        .send({
          programId: program._id.toString(),
          promoCode: "FREE1001",
        })
        .expect(200);

      expect(res.body.data.isFree).toBe(true);
      expect(res.body.data.sessionId).toBeNull();
      expect(res.body.data.sessionUrl).toBeNull();
    });

    test("free purchase includes correct program details", async () => {
      const { token, userId } = await createAndLoginTestUser();

      const program = await createTestProgram(userId, {
        title: "Free Access Program",
        programType: "EMBA Mentor Circles",
        fullPriceTicket: 25000, // $250
      });

      await PromoCode.create({
        code: "COMP1001",
        type: "staff_access",
        discountPercent: 100,
        ownerId: userId,
        isActive: true,
        isUsed: false,
        createdBy: "admin",
      });

      const res = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${token}`)
        .send({
          programId: program._id.toString(),
          promoCode: "COMP1001",
        })
        .expect(200);

      expect(res.body.data.orderId).toBeDefined();

      // Verify purchase in database
      const purchase = await Purchase.findOne({
        orderNumber: res.body.data.orderId,
      }).populate("programId");

      expect(purchase).toBeDefined();
      expect(purchase!.programId).toEqual(
        expect.objectContaining({
          title: "Free Access Program",
          programType: "EMBA Mentor Circles",
        })
      );
      expect(program.fullPriceTicket).toBe(25000);
      expect(purchase!.finalPrice).toBe(0);
      expect(25000 - purchase!.finalPrice).toBe(25000);
    });

    test("100% discount applies to full price only", async () => {
      const { token, userId } = await createAndLoginTestUser();

      const program = await createTestProgram(userId, {
        fullPriceTicket: 20000, // $200
        earlyBirdTicket: 15000, // $150 (not applicable with 100% code)
      });

      await PromoCode.create({
        code: "FULL1001",
        type: "staff_access",
        discountPercent: 100,
        ownerId: userId,
        isActive: true,
        isUsed: false,
        createdBy: "admin",
      });

      const res = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${token}`)
        .send({
          programId: program._id.toString(),
          promoCode: "FULL1001",
        })
        .expect(200);

      // Should use fullPriceTicket, not earlyBirdTicket
      expect(res.body.data.orderId).toBeDefined();

      const purchase = await Purchase.findOne({
        orderNumber: res.body.data.orderId,
      });

      expect(purchase).toBeDefined();
      expect(program.fullPriceTicket).toBe(20000);
      expect(purchase!.finalPrice).toBe(0);
    });

    test("rejects already used 100% discount code", async () => {
      const { token, userId } = await createAndLoginTestUser();

      const program = await createTestProgram(userId);

      const usedCode = await PromoCode.create({
        code: "USEDCOD1",
        type: "staff_access",
        discountPercent: 100,
        ownerId: userId,
        isActive: true,
        isUsed: true, // Already used
        usedAt: new Date(),
        createdBy: "admin",
      });

      const res = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${token}`)
        .send({
          programId: program._id.toString(),
          promoCode: "USEDCOD1",
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("already been used");
    });

    test("rejects inactive 100% discount code", async () => {
      const { token, userId } = await createAndLoginTestUser();

      const program = await createTestProgram(userId);

      await PromoCode.create({
        code: "INACTIV1",
        type: "staff_access",
        discountPercent: 100,
        ownerId: userId,
        isActive: false, // Deactivated
        isUsed: false,
        createdBy: "admin",
      });

      const res = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${token}`)
        .send({
          programId: program._id.toString(),
          promoCode: "INACTIV1",
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Code is no longer active");
    });

    test("rejects expired 100% discount code", async () => {
      const { token, userId } = await createAndLoginTestUser();

      const program = await createTestProgram(userId);

      const pastDate = new Date();
      pastDate.setFullYear(pastDate.getFullYear() - 1);

      const expiredCode = new PromoCode({
        code: "EXPIRED1",
        type: "staff_access",
        discountPercent: 100,
        ownerId: userId,
        expiresAt: pastDate,
        isActive: true,
        isUsed: false,
        createdBy: "admin",
      });
      await expiredCode.save({ validateBeforeSave: false });

      const res = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${token}`)
        .send({
          programId: program._id.toString(),
          promoCode: "EXPIRED1",
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("expired");
    });

    test("rejects code owned by different user", async () => {
      const { token: userToken, userId } = await createAndLoginTestUser();

      const otherUser = await User.create({
        username: "otheruser",
        firstName: "Other",
        lastName: "User",
        email: "other@example.com",
        password: "ValidPass123",
        role: "Participant",
        isVerified: true,
        gender: "male",
        isAtCloudLeader: false,
      });

      const program = await createTestProgram(userId);

      // Create code owned by different user
      await PromoCode.create({
        code: "NOTMINE1",
        type: "staff_access",
        discountPercent: 100,
        ownerId: otherUser._id,
        isActive: true,
        isUsed: false,
        createdBy: "admin",
      });

      const res = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${userToken}`)
        .send({
          programId: program._id.toString(),
          promoCode: "NOTMINE1",
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("does not belong to you");
    });

    test("enforces program restrictions on 100% discount", async () => {
      const { token, userId } = await createAndLoginTestUser();

      const allowedProgram = await createTestProgram(userId, {
        title: "Allowed Program",
      });
      const restrictedProgram = await createTestProgram(userId, {
        title: "Restricted Program",
      });

      await PromoCode.create({
        code: "LIMITED1",
        type: "staff_access",
        discountPercent: 100,
        ownerId: userId,
        applicableToType: "program",
        allowedProgramIds: [allowedProgram._id], // Only for specific program
        isActive: true,
        isUsed: false,
        createdBy: "admin",
      });

      // Should work for allowed program
      const res1 = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${token}`)
        .send({
          programId: allowedProgram._id.toString(),
          promoCode: "LIMITED1",
        })
        .expect(200);

      expect(res1.body.success).toBe(true);

      // Should fail for restricted program (need new code since first was used)
      const res2 = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${token}`)
        .send({
          programId: restrictedProgram._id.toString(),
          promoCode: "LIMITED1",
        })
        .expect(400);

      expect(res2.body.success).toBe(false);
      expect(res2.body.message).toContain("already been used");
    });
  });

  // ============================================================================
  // PARTIAL DISCOUNT PURCHASE FLOW
  // ============================================================================

  describe("Partial Discount Purchase Flow", () => {
    test("applies 50% staff discount and creates Stripe session", async () => {
      const { token, userId } = await createAndLoginTestUser();

      const program = await createTestProgram(userId, {
        fullPriceTicket: 10000, // $100
      });

      await PromoCode.create({
        code: "HALF5001",
        type: "staff_access",
        discountPercent: 50,
        ownerId: userId,
        isActive: true,
        isUsed: false,
        createdBy: "admin",
      });

      const res = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${token}`)
        .send({
          programId: program._id.toString(),
          promoCode: "HALF5001",
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.sessionId).toBeDefined();
      expect(res.body.data.sessionUrl).toBeDefined();

      // Verify purchase in database
      const purchase = await Purchase.findOne({
        userId,
        programId: program._id,
        status: "pending",
      });

      expect(purchase).toBeDefined();
      expect(purchase!.finalPrice).toBe(5000); // 50% of 10000
    });

    test("applies bundle discount and creates Stripe session", async () => {
      const { token, userId } = await createAndLoginTestUser();

      const program = await createTestProgram(userId, {
        fullPriceTicket: 15000, // $150
      });

      await PromoCode.create({
        code: "SAVE5001",
        type: "bundle_discount",
        discountAmount: 5000, // $50 off
        ownerId: userId,
        isActive: true,
        isUsed: false,
        createdBy: "system",
      });

      const res = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${token}`)
        .send({
          programId: program._id.toString(),
          promoCode: "SAVE5001",
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.sessionId).toBeDefined();

      // Verify purchase in database
      const purchase = await Purchase.findOne({
        userId,
        programId: program._id,
        status: "pending",
      });

      expect(purchase).toBeDefined();
      expect(purchase!.finalPrice).toBe(10000); // 15000 - 5000
    });

    test("bundle discount cannot exceed program price", async () => {
      const { token, userId } = await createAndLoginTestUser();

      const program = await createTestProgram(userId, {
        fullPriceTicket: 5000, // $50
      });

      await PromoCode.create({
        code: "BIG10001",
        type: "bundle_discount",
        discountAmount: 10000, // $100 off (more than price)
        ownerId: userId,
        isActive: true,
        isUsed: false,
        createdBy: "system",
      });

      const res = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${token}`)
        .send({
          programId: program._id.toString(),
          promoCode: "BIG10001",
        })
        .expect(200);

      // Should cap at program price, resulting in free purchase
      expect(res.body.success).toBe(true);
      expect(res.body.data.isFree).toBe(true);
      expect(res.body.data.orderId).toBeDefined();

      // Verify purchase in database
      const purchase = await Purchase.findOne({
        orderNumber: res.body.data.orderId,
      });

      expect(purchase).toBeDefined();
      expect(purchase!.finalPrice).toBe(0);
    });
  });

  // ============================================================================
  // PROMO CODE MARKING AS USED
  // ============================================================================

  describe("Promo Code Marking as Used", () => {
    test("marks staff code as used after successful free purchase", async () => {
      const { token, userId } = await createAndLoginTestUser();

      const program = await createTestProgram(userId);

      const code = await PromoCode.create({
        code: "MARKUSED",
        type: "staff_access",
        discountPercent: 100,
        ownerId: userId,
        isActive: true,
        isUsed: false,
        createdBy: "admin",
      });

      await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${token}`)
        .send({
          programId: program._id.toString(),
          promoCode: "MARKUSED",
        })
        .expect(200);

      // Verify code was marked as used
      const updatedCode = await PromoCode.findById(code._id);
      expect(updatedCode!.isUsed).toBe(true);
      expect(updatedCode!.usedAt).toBeInstanceOf(Date);
      expect(updatedCode!.usedForProgramId).toBeDefined();
      expect(updatedCode!.usedForProgramId!.toString()).toBe(
        program._id.toString()
      );
    });

    test("staff code used once cannot be used again", async () => {
      const { token, userId } = await createAndLoginTestUser();

      const program1 = await createTestProgram(userId, {
        title: "Program 1",
      });
      const program2 = await createTestProgram(userId, {
        title: "Program 2",
      });

      await PromoCode.create({
        code: "ONEUSE01",
        type: "staff_access",
        discountPercent: 100,
        ownerId: userId,
        isActive: true,
        isUsed: false,
        createdBy: "admin",
      });

      // Use code for first program
      await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${token}`)
        .send({
          programId: program1._id.toString(),
          promoCode: "ONEUSE01",
        })
        .expect(200);

      // Try to use same code for second program
      const res = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${token}`)
        .send({
          programId: program2._id.toString(),
          promoCode: "ONEUSE01",
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("already been used");
    });

    test("bundle code is NOT marked as used for partial discount", async () => {
      const { token, userId } = await createAndLoginTestUser();

      const program = await createTestProgram(userId);

      const code = await PromoCode.create({
        code: "BUNDLE50",
        type: "bundle_discount",
        discountAmount: 5000,
        ownerId: userId,
        isActive: true,
        isUsed: false,
        createdBy: "system",
      });

      await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${token}`)
        .send({
          programId: program._id.toString(),
          promoCode: "BUNDLE50",
        })
        .expect(200);

      // Bundle code should NOT be marked as used (only after payment succeeds)
      const updatedCode = await PromoCode.findById(code._id);
      expect(updatedCode!.isUsed).toBe(false);
      expect(updatedCode!.usedAt).toBeUndefined();
    });

    test("bundle code IS marked as used if results in 100% discount", async () => {
      const { token, userId } = await createAndLoginTestUser();

      const program = await createTestProgram(userId, {
        fullPriceTicket: 5000, // $50
      });

      const code = await PromoCode.create({
        code: "BUND1001",
        type: "bundle_discount",
        discountAmount: 5000, // Exactly matches price
        ownerId: userId,
        isActive: true,
        isUsed: false,
        createdBy: "system",
      });

      await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${token}`)
        .send({
          programId: program._id.toString(),
          promoCode: "BUND1001",
        })
        .expect(200);

      // Should be marked as used since it's a free purchase
      const updatedCode = await PromoCode.findById(code._id);
      expect(updatedCode!.isUsed).toBe(true);
      expect(updatedCode!.usedAt).toBeInstanceOf(Date);
    });
  });

  // ============================================================================
  // PURCHASE WITHOUT PROMO CODE
  // ============================================================================

  describe("Purchase Without Promo Code", () => {
    test("creates normal checkout session without promo code", async () => {
      const { token, userId } = await createAndLoginTestUser();

      const program = await createTestProgram(userId, {
        fullPriceTicket: 10000,
      });

      const res = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${token}`)
        .send({
          programId: program._id.toString(),
          // No promoCode
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.sessionId).toBeDefined();
      expect(res.body.data.sessionUrl).toBeDefined();
      expect(res.body.data.existing).toBe(false);

      // Verify purchase in database
      const purchase = await Purchase.findOne({
        userId,
        programId: program._id,
        status: "pending",
      });
      expect(purchase).toBeDefined();
      expect(purchase!.finalPrice).toBe(10000);
      expect(purchase!.promoCode).toBeUndefined();
    });

    test("ignores empty promo code string", async () => {
      const { token, userId } = await createAndLoginTestUser();

      const program = await createTestProgram(userId);

      const res = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${token}`)
        .send({
          programId: program._id.toString(),
          promoCode: "",
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      const purchase = await Purchase.findOne({
        userId,
        programId: program._id,
      });
      expect(purchase!.promoCode).toBeUndefined();
    });

    test("trims whitespace from promo code", async () => {
      const { token, userId } = await createAndLoginTestUser();

      const program = await createTestProgram(userId);

      await PromoCode.create({
        code: "TRIMMED1",
        type: "staff_access",
        discountPercent: 100,
        ownerId: userId,
        isActive: true,
        isUsed: false,
        createdBy: "admin",
      });

      const res = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${token}`)
        .send({
          programId: program._id.toString(),
          promoCode: " TRIMMED1 ",
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      const purchase = await Purchase.findOne({
        orderNumber: res.body.data.orderId,
      });
      expect(purchase!.promoCode).toBe("TRIMMED1");
    });
  });

  // ============================================================================
  // ERROR CASES
  // ============================================================================

  describe("Error Cases", () => {
    test("returns 400 for non-existent promo code", async () => {
      const { token, userId } = await createAndLoginTestUser();

      const program = await createTestProgram(userId);

      const res = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${token}`)
        .send({
          programId: program._id.toString(),
          promoCode: "NOTEXIST",
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Invalid promo code");
    });

    test("returns 400 for invalid program ID", async () => {
      const { token, userId } = await createAndLoginTestUser();

      await PromoCode.create({
        code: "VALID123",
        type: "staff_access",
        discountPercent: 100,
        ownerId: userId,
        isActive: true,
        isUsed: false,
        createdBy: "admin",
      });

      await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${token}`)
        .send({
          programId: "invalid-id",
          promoCode: "VALID123",
        })
        .expect(400);
    });

    test("requires authentication", async () => {
      const program = await createTestProgram(new mongoose.Types.ObjectId());

      await request(app)
        .post("/api/purchases/create-checkout-session")
        .send({
          programId: program._id.toString(),
          promoCode: "ANYCODE1",
        })
        .expect(401);
    });
  });
});
