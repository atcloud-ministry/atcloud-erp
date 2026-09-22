import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
/**
 * Purchase API Integration Tests
 *
 * Tests the complete purchase flow including:
 * - Checkout session creation
 * - Purchase retrieval and authorization
 * - Receipt generation
 * - Program access checking
 * - Mentor and admin access privileges
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

// Mock Stripe
vi.mock("../../../src/services/stripeService", () => ({
  createCheckoutSession: vi.fn().mockResolvedValue({
    url: "https://checkout.stripe.com/pay/test_session_123",
  }),
}));

describe("Purchase API Integration Tests", () => {
  let authToken: string;
  let userId: string;
  let adminToken: string;
  let adminId: string;
  let mentorToken: string;
  let mentorId: string;
  let paidProgramId: string;
  let freeProgramId: string;
  let usersInitialized = false;

  async function ensureBaseUsers() {
    if (usersInitialized) return;

    await User.deleteMany({});
    await Program.deleteMany({});
    await Purchase.deleteMany({});

    // Regular user
    const userData = {
      ...TEST_REGISTRATION_PROFILE,
      username: "purchaseuser",
      email: "purchase@example.com",
      password: "PurchasePass123!",
      confirmPassword: "PurchasePass123!",
      firstName: "Purchase",
      lastName: "User",
      role: "Participant",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
    };
    const userResponse = await request(app)
      .post("/api/auth/register")
      .send(userData);
    await User.findOneAndUpdate(
      { email: "purchase@example.com" },
      { isVerified: true },
    );
    const loginResponse = await request(app).post("/api/auth/login").send({
      emailOrUsername: "purchase@example.com",
      password: "PurchasePass123!",
    });
    authToken = loginResponse.body.data.accessToken;
    userId = userResponse.body.data.user.id;

    // Admin user
    const adminData = {
      ...TEST_REGISTRATION_PROFILE,
      username: "purchaseadmin",
      email: "purchaseadmin@example.com",
      password: "AdminPass123!",
      confirmPassword: "AdminPass123!",
      firstName: "Admin",
      lastName: "User",
      role: "Administrator",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
    };
    const adminResponse = await request(app)
      .post("/api/auth/register")
      .send(adminData);
    await User.findOneAndUpdate(
      { email: "purchaseadmin@example.com" },
      { isVerified: true, role: "Super Admin" },
    );
    const adminLoginResponse = await request(app).post("/api/auth/login").send({
      emailOrUsername: "purchaseadmin@example.com",
      password: "AdminPass123!",
    });
    adminToken = adminLoginResponse.body.data.accessToken;
    adminId = adminResponse.body.data.user.id;

    // Mentor user
    const mentorData = {
      ...TEST_REGISTRATION_PROFILE,
      username: "purchasementor",
      email: "mentor@example.com",
      password: "MentorPass123!",
      confirmPassword: "MentorPass123!",
      firstName: "Mentor",
      lastName: "User",
      role: "Leader",
      roleInAtCloud: "Mentor",
      gender: "female",
      isAtCloudLeader: true,
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
    };
    const mentorResponse = await request(app)
      .post("/api/auth/register")
      .send(mentorData);

    if (!mentorResponse.body.data?.user?.id) {
      throw new Error(
        `Mentor registration failed: ${JSON.stringify(mentorResponse.body)}`,
      );
    }

    await User.findOneAndUpdate(
      { email: "mentor@example.com" },
      { isVerified: true },
    );
    const mentorLoginResponse = await request(app)
      .post("/api/auth/login")
      .send({
        emailOrUsername: "mentor@example.com",
        password: "MentorPass123!",
      });

    if (!mentorLoginResponse.body.data?.accessToken) {
      throw new Error(
        `Mentor login failed: ${JSON.stringify(mentorLoginResponse.body)}`,
      );
    }

    mentorToken = mentorLoginResponse.body.data.accessToken;
    mentorId = mentorResponse.body.data.user.id;

    usersInitialized = true;
  }

  beforeAll(async () => {
    await ensureIntegrationDB();
    await ensureBaseUsers();
  });

  beforeEach(async () => {
    await Program.deleteMany({});
    await Purchase.deleteMany({});

    // Create a paid program (price in cents, max 2000 = $20)
    const paidProgram = await Program.create({
      title: "Advanced Leadership Mentor Circle",
      introduction: "Premium leadership development program",
      programType: "EMBA Mentor Circles",
      isFree: false,
      fullPriceTicket: 1900, // $19.00 in cents
      classRepDiscount: 500, // $5.00 in cents
      earlyBirdDeadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
      earlyBirdDiscount: 400, // $4.00 in cents
      mentors: [{ userId: mentorId }],
      createdBy: adminId,
    });
    paidProgramId = paidProgram._id.toString();

    // Create a free program
    const freeProgram = await Program.create({
      title: "Effective Communication Workshop",
      introduction: "Free communication skills program",
      programType: "Effective Communication Workshops",
      isFree: true,
      fullPriceTicket: 0,
      createdBy: adminId,
    });
    freeProgramId = freeProgram._id.toString();
  });

  afterEach(async () => {
    await Program.deleteMany({});
    await Purchase.deleteMany({});
  });

  afterAll(async () => {
    await User.deleteMany({});
    await Program.deleteMany({});
    await Purchase.deleteMany({});
    // Shared integration harness owns connection lifecycle.
  });

  describe("POST /api/purchases/create-checkout-session", () => {
    it("should create checkout session for paid program", async () => {
      const response = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${authToken}`)
        .send({ programId: paidProgramId, isClassRep: false });

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveProperty("sessionUrl");
      expect(response.body.data.sessionUrl).toContain("checkout.stripe.com");

      // Verify purchase record was created
      const purchase = await Purchase.findOne({
        userId: userId,
        programId: paidProgramId,
      });
      expect(purchase).toBeDefined();
      expect(purchase?.status).toBe("pending");
      expect(purchase?.fullPrice).toBe(1900);
      expect(purchase?.isEarlyBird).toBe(true); // Within early bird window
    });

    it("should apply class rep discount when isClassRep is true", async () => {
      // Create a purchase with class rep discount
      const response = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${authToken}`)
        .send({ programId: paidProgramId, isClassRep: true });

      expect(response.status).toBe(200);

      const purchase = await Purchase.findOne({
        userId: userId,
        programId: paidProgramId,
      });
      expect(purchase?.isClassRep).toBe(true);
      expect(purchase?.classRepDiscount).toBe(500);
      // Class Rep and Early Bird are mutually exclusive
      // When isClassRep=true, only Class Rep discount is applied
      expect(purchase?.earlyBirdDiscount).toBe(0);
      expect(purchase?.isEarlyBird).toBe(false);
      expect(purchase?.finalPrice).toBe(1400); // 1900 - 500 (Class Rep only)
    });

    it("should apply early bird discount when isClassRep is false (mutual exclusivity)", async () => {
      // Create a purchase without class rep (standard enrollment)
      const response = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${authToken}`)
        .send({ programId: paidProgramId, isClassRep: false });

      expect(response.status).toBe(200);

      const purchase = await Purchase.findOne({
        userId: userId,
        programId: paidProgramId,
      });
      expect(purchase?.isClassRep).toBe(false);
      expect(purchase?.classRepDiscount).toBe(0);
      // Early Bird should be applied when NOT enrolling as Class Rep
      expect(purchase?.isEarlyBird).toBe(true);
      expect(purchase?.earlyBirdDiscount).toBe(400);
      expect(purchase?.finalPrice).toBe(1500); // 1900 - 400 (Early Bird only)
    });

    it("should allow class rep enrollment when classRepCount field is missing (legacy programs)", async () => {
      // Create a program WITHOUT classRepCount field (simulating legacy program)
      // Use insertOne to bypass Mongoose defaults
      const legacyProgramData = {
        _id: new mongoose.Types.ObjectId(),
        title: "Legacy Program Without ClassRepCount",
        programType: "EMBA Mentor Circles",
        introduction: "Test legacy program",
        isFree: false,
        fullPriceTicket: 2000,
        classRepDiscount: 600,
        classRepLimit: 3,
        createdBy: new mongoose.Types.ObjectId(userId),
        // Note: NOT setting classRepCount field at all
      };
      await Program.collection.insertOne(legacyProgramData);

      // Verify field doesn't exist in database
      const programDoc = (await Program.findById(legacyProgramData._id)
        .select("classRepCount")
        .lean()) as { classRepCount?: number } | null;
      expect(programDoc?.classRepCount).toBeUndefined();

      // Attempt Class Rep enrollment - should succeed (bug fix verification)
      const response = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          programId: legacyProgramData._id.toString(),
          isClassRep: true,
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      // Verify classRepCount was initialized and incremented to 1
      const updatedProgram = (await Program.findById(legacyProgramData._id)
        .select("classRepCount")
        .lean()) as { classRepCount?: number } | null;
      expect(updatedProgram?.classRepCount).toBe(1);

      // Verify purchase was created correctly
      const purchase = await Purchase.findOne({
        userId: userId,
        programId: legacyProgramData._id,
      });
      expect(purchase?.isClassRep).toBe(true);
      expect(purchase?.classRepDiscount).toBe(600);
    });

    it("should complete checkout for free program without Stripe", async () => {
      const response = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${authToken}`)
        .send({ programId: freeProgramId, isClassRep: false });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toMatchObject({
        sessionId: null,
        sessionUrl: null,
        isFree: true,
      });

      const purchase = await Purchase.findOne({
        userId,
        programId: freeProgramId,
        purchaseType: "program",
      });
      expect(purchase?.status).toBe("completed");
      expect(purchase?.finalPrice).toBe(0);
    });

    it("should reject duplicate enrollment", async () => {
      // First purchase
      await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${authToken}`)
        .send({ programId: paidProgramId, isClassRep: false });

      // Mark the purchase as completed
      await Purchase.updateOne(
        { userId, programId: paidProgramId },
        { status: "completed" },
      );

      // Attempt second purchase
      const response = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${authToken}`)
        .send({ programId: paidProgramId, isClassRep: false });

      expect(response.status).toBe(400);
      expect(response.body.message).toContain("already");
    });

    it("should require authentication", async () => {
      const response = await request(app)
        .post("/api/purchases/create-checkout-session")
        .send({ programId: paidProgramId, isClassRep: false });

      expect(response.status).toBe(401);
    });

    it("should return 404 for non-existent program", async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      const response = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${authToken}`)
        .send({ programId: fakeId, isClassRep: false });

      expect(response.status).toBe(404);
    });
  });

  describe("GET /api/purchases/my-purchases", () => {
    beforeEach(async () => {
      // Create some purchases for the user
      await Purchase.create({
        userId: userId,
        programId: paidProgramId,
        fullPrice: 1900,
        finalPrice: 1000,
        isClassRep: true,
        classRepDiscount: 500,
        isEarlyBird: true,
        earlyBirdDiscount: 400,
        status: "completed",
        orderNumber: "ORD-TEST-001",
        purchaseDate: new Date(),
        paymentMethod: { type: "card", cardBrand: "visa", last4: "4242" },
        billingInfo: {
          fullName: "Purchase User",
          email: "purchase@example.com",
        },
      });
    });

    it("should retrieve user's purchases", async () => {
      const response = await request(app)
        .get("/api/purchases/my-purchases")
        .set("Authorization", `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeInstanceOf(Array);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]).toMatchObject({
        orderNumber: "ORD-TEST-001",
        status: "completed",
        fullPrice: 1900,
        finalPrice: 1000,
        isClassRep: true,
      });
    });

    it("should return empty array for user with no purchases", async () => {
      const response = await request(app)
        .get("/api/purchases/my-purchases")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(0);
    });

    it("should require authentication", async () => {
      const response = await request(app).get("/api/purchases/my-purchases");

      expect(response.status).toBe(401);
    });
  });

  describe("GET /api/purchases/:id", () => {
    let purchaseId: string;

    beforeEach(async () => {
      const purchase = await Purchase.create({
        userId: userId,
        programId: paidProgramId,
        fullPrice: 1900,
        finalPrice: 1900,
        isClassRep: false,
        isEarlyBird: false,
        status: "completed",
        orderNumber: "ORD-TEST-002",
        purchaseDate: new Date(),
        paymentMethod: { type: "card", cardBrand: "visa", last4: "4242" },
        billingInfo: {
          fullName: "Purchase User",
          email: "purchase@example.com",
        },
      });
      purchaseId = (purchase._id as mongoose.Types.ObjectId).toString();
    });

    it("should allow purchase owner to view their purchase", async () => {
      const response = await request(app)
        .get(`/api/purchases/${purchaseId}`)
        .set("Authorization", `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        orderNumber: "ORD-TEST-002",
        status: "completed",
      });
    });

    it("should allow admin to view any purchase", async () => {
      const response = await request(app)
        .get(`/api/purchases/${purchaseId}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.orderNumber).toBe("ORD-TEST-002");
    });

    it("should allow program mentor to view program purchases", async () => {
      const response = await request(app)
        .get(`/api/purchases/${purchaseId}`)
        .set("Authorization", `Bearer ${mentorToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.orderNumber).toBe("ORD-TEST-002");
    });

    it("should deny access to other users", async () => {
      // Create another user
      const otherUserData = {
        ...TEST_REGISTRATION_PROFILE,
        username: "otheruser",
        email: "other@example.com",
        password: "OtherPass123!",
        confirmPassword: "OtherPass123!",
        firstName: "Other",
        lastName: "User",
        role: "Participant",
        gender: "male",
        isAtCloudLeader: false,
        acceptTerms: true,
        registrationNoticeVersion: "registration-privacy-v1",
      };
      await request(app).post("/api/auth/register").send(otherUserData);
      await User.findOneAndUpdate(
        { email: "other@example.com" },
        { isVerified: true },
      );
      const otherLoginResponse = await request(app)
        .post("/api/auth/login")
        .send({
          emailOrUsername: "other@example.com",
          password: "OtherPass123!",
        });
      const otherToken = otherLoginResponse.body.data.accessToken;

      const response = await request(app)
        .get(`/api/purchases/${purchaseId}`)
        .set("Authorization", `Bearer ${otherToken}`);

      expect(response.status).toBe(403);
    });

    it("should return 404 for non-existent purchase", async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      const response = await request(app)
        .get(`/api/purchases/${fakeId}`)
        .set("Authorization", `Bearer ${authToken}`);

      expect(response.status).toBe(404);
    });
  });

  describe("GET /api/purchases/:id/receipt", () => {
    let purchaseId: string;

    beforeEach(async () => {
      const purchase = await Purchase.create({
        userId: userId,
        programId: paidProgramId,
        fullPrice: 1900,
        finalPrice: 1000,
        isClassRep: true,
        classRepDiscount: 500,
        isEarlyBird: true,
        earlyBirdDiscount: 400,
        status: "completed",
        orderNumber: "ORD-TEST-003",
        purchaseDate: new Date(),
        billingInfo: {
          fullName: "Purchase User",
          email: "purchase@example.com",
          address: "123 Main St",
          city: "Springfield",
          state: "IL",
          zipCode: "62701",
          country: "US",
        },
        paymentMethod: {
          type: "card",
          cardBrand: "visa",
          last4: "4242",
          cardholderName: "Purchase User",
        },
      });
      purchaseId = (purchase._id as mongoose.Types.ObjectId).toString();
    });

    it("should return formatted receipt for purchase owner", async () => {
      const response = await request(app)
        .get(`/api/purchases/${purchaseId}/receipt`)
        .set("Authorization", `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        orderNumber: "ORD-TEST-003",
        fullPrice: 1900,
        classRepDiscount: 500,
        earlyBirdDiscount: 400,
        finalPrice: 1000,
        isClassRep: true,
        isEarlyBird: true,
        paymentMethod: {
          type: "card",
          cardBrand: "visa",
          last4: "4242",
        },
        billingInfo: {
          fullName: "Purchase User",
          email: "purchase@example.com",
          address: "123 Main St",
          city: "Springfield",
          state: "IL",
          zipCode: "62701",
          country: "US",
        },
        status: "completed",
      });
    });

    it("should allow admin to view receipts", async () => {
      const response = await request(app)
        .get(`/api/purchases/${purchaseId}/receipt`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.orderNumber).toBe("ORD-TEST-003");
    });

    it("should deny access to other users", async () => {
      // Create another user
      const otherUserData = {
        ...TEST_REGISTRATION_PROFILE,
        username: "receiptuser",
        email: "receipt@example.com",
        password: "ReceiptPass123!",
        confirmPassword: "ReceiptPass123!",
        firstName: "Receipt",
        lastName: "User",
        role: "Participant",
        gender: "male",
        isAtCloudLeader: false,
        acceptTerms: true,
        registrationNoticeVersion: "registration-privacy-v1",
      };
      await request(app).post("/api/auth/register").send(otherUserData);
      await User.findOneAndUpdate(
        { email: "receipt@example.com" },
        { isVerified: true },
      );
      const otherLoginResponse = await request(app)
        .post("/api/auth/login")
        .send({
          emailOrUsername: "receipt@example.com",
          password: "ReceiptPass123!",
        });
      const otherToken = otherLoginResponse.body.data.accessToken;

      const response = await request(app)
        .get(`/api/purchases/${purchaseId}/receipt`)
        .set("Authorization", `Bearer ${otherToken}`);

      expect(response.status).toBe(403);
    });
  });

  describe("GET /api/purchases/check-access/:programId", () => {
    it("should return access for purchased program", async () => {
      // Create a completed purchase
      await Purchase.create({
        userId: userId,
        programId: paidProgramId,
        fullPrice: 1900,
        finalPrice: 1900,
        isClassRep: false,
        isEarlyBird: false,
        status: "completed",
        orderNumber: "ORD-TEST-004",
        purchaseDate: new Date(),
        paymentMethod: { type: "card", cardBrand: "visa", last4: "4242" },
        billingInfo: {
          fullName: "Purchase User",
          email: "purchase@example.com",
        },
      });

      const response = await request(app)
        .get(`/api/purchases/check-access/${paidProgramId}`)
        .set("Authorization", `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        hasAccess: true,
        reason: "purchased",
      });
    });

    it("should require enrollment before returning access for free program", async () => {
      const response = await request(app)
        .get(`/api/purchases/check-access/${freeProgramId}`)
        .set("Authorization", `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        hasAccess: false,
        reason: "not_purchased",
      });
    });

    it("should return access for admin", async () => {
      const response = await request(app)
        .get(`/api/purchases/check-access/${paidProgramId}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        hasAccess: true,
        reason: "admin",
      });
    });

    it("should return access for program mentor", async () => {
      const response = await request(app)
        .get(`/api/purchases/check-access/${paidProgramId}`)
        .set("Authorization", `Bearer ${mentorToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        hasAccess: true,
        reason: "mentor",
      });
    });

    it("should deny access for non-purchased program", async () => {
      const response = await request(app)
        .get(`/api/purchases/check-access/${paidProgramId}`)
        .set("Authorization", `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        hasAccess: false,
        reason: "not_purchased",
      });
    });

    it("should return 404 for non-existent program", async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      const response = await request(app)
        .get(`/api/purchases/check-access/${fakeId}`)
        .set("Authorization", `Bearer ${authToken}`);

      expect(response.status).toBe(404);
    });
  });

  describe("POST /api/purchases/check-access/batch", () => {
    it("returns access for multiple programs in one request", async () => {
      await Purchase.create({
        userId,
        programId: paidProgramId,
        purchaseType: "program",
        fullPrice: 1900,
        finalPrice: 1900,
        isClassRep: false,
        isEarlyBird: false,
        status: "completed",
        orderNumber: "ORD-BATCH-ACCESS",
        purchaseDate: new Date(),
        paymentMethod: { type: "card", cardBrand: "visa", last4: "4242" },
        billingInfo: {
          fullName: "Purchase User",
          email: "purchase@example.com",
        },
      });

      const response = await request(app)
        .post("/api/purchases/check-access/batch")
        .set("Authorization", `Bearer ${authToken}`)
        .send({ programIds: [paidProgramId, freeProgramId] });

      expect(response.status).toBe(200);
      expect(response.body.data.access).toEqual([
        {
          programId: paidProgramId,
          hasAccess: true,
          reason: "purchased",
        },
        {
          programId: freeProgramId,
          hasAccess: false,
          reason: "not_purchased",
        },
      ]);

      const uppercaseResponse = await request(app)
        .post("/api/purchases/check-access/batch")
        .set("Authorization", `Bearer ${authToken}`)
        .send({ programIds: [paidProgramId.toUpperCase()] });
      expect(uppercaseResponse.status).toBe(200);
      expect(uppercaseResponse.body.data.access).toEqual([
        {
          programId: paidProgramId,
          hasAccess: true,
          reason: "purchased",
        },
      ]);
    });

    it("rejects invalid or unbounded batch input", async () => {
      const invalidResponse = await request(app)
        .post("/api/purchases/check-access/batch")
        .set("Authorization", `Bearer ${authToken}`)
        .send({ programIds: ["not-an-object-id"] });
      expect(invalidResponse.status).toBe(400);

      const oversizedResponse = await request(app)
        .post("/api/purchases/check-access/batch")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          programIds: Array.from(
            { length: 101 },
            () => new mongoose.Types.ObjectId().toString(),
          ),
        });
      expect(oversizedResponse.status).toBe(400);
    });
  });

  describe("POST /api/purchases/create-checkout-session - classRepCount bug fix", () => {
    it("should not double-increment classRepCount when user clicks 'Proceed to Payment' multiple times with Class Rep", async () => {
      // Setup: Create a program with Class Rep limit
      const classRepProgram = await Program.create({
        title: `Class Rep Test Program ${Date.now()}`,
        programType: "EMBA Mentor Circles",
        introduction: "Test program for Class Rep count bug",
        isFree: false,
        fullPriceTicket: 2000,
        classRepDiscount: 500,
        classRepLimit: 3,
        createdBy: new mongoose.Types.ObjectId(userId),
        published: true,
      });

      // Verify initial state: classRepCount should be 0
      let program = await Program.findById(classRepProgram._id);
      expect(program?.classRepCount || 0).toBe(0);

      // Step 1: User clicks "Proceed to Payment" with Class Rep (first time)
      const response1 = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          programId: classRepProgram._id.toString(),
          isClassRep: true,
        });

      expect(response1.status).toBe(200);
      expect(response1.body.success).toBe(true);

      // Verify classRepCount incremented to 1
      program = await Program.findById(classRepProgram._id);
      expect(program?.classRepCount).toBe(1);

      // Verify pending purchase exists
      let pendingPurchase = await Purchase.findOne({
        userId: userId,
        programId: classRepProgram._id,
        status: "pending",
      });
      expect(pendingPurchase).toBeDefined();
      expect(pendingPurchase?.isClassRep).toBe(true);

      // Step 2: User abandons Stripe checkout, returns to Enroll page
      // User clicks "Proceed to Payment" with Class Rep AGAIN (second time)
      const response2 = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          programId: classRepProgram._id.toString(),
          isClassRep: true,
        });

      expect(response2.status).toBe(200);
      expect(response2.body.success).toBe(true);

      // CRITICAL TEST: classRepCount should STILL be 1 (not 2)
      // The bug was that it would increment to 2
      program = await Program.findById(classRepProgram._id);
      expect(program?.classRepCount).toBe(1);

      // Verify only one pending purchase exists
      const allPendingPurchases = await Purchase.find({
        userId: userId,
        programId: classRepProgram._id,
        status: "pending",
      });
      expect(allPendingPurchases).toHaveLength(1);
      expect(allPendingPurchases[0].isClassRep).toBe(true);
    });

    it("should correctly handle switching from Class Rep to regular purchase", async () => {
      // Setup: Create a program with Class Rep limit
      const classRepProgram = await Program.create({
        title: `Class Rep Switch Test ${Date.now()}`,
        programType: "EMBA Mentor Circles",
        introduction: "Test switching enrollment types",
        isFree: false,
        fullPriceTicket: 2000,
        classRepDiscount: 500,
        classRepLimit: 3,
        createdBy: new mongoose.Types.ObjectId(userId),
        published: true,
      });

      // Step 1: User clicks "Proceed to Payment" with Class Rep
      const response1 = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          programId: classRepProgram._id.toString(),
          isClassRep: true,
        });

      expect(response1.status).toBe(200);

      // Verify classRepCount = 1
      let program = await Program.findById(classRepProgram._id);
      expect(program?.classRepCount).toBe(1);

      // Step 2: User changes mind, clicks "Proceed to Payment" WITHOUT Class Rep
      const response2 = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          programId: classRepProgram._id.toString(),
          isClassRep: false,
        });

      expect(response2.status).toBe(200);

      // CRITICAL: classRepCount should be DECREMENTED back to 0
      program = await Program.findById(classRepProgram._id);
      expect(program?.classRepCount).toBe(0);

      // Verify purchase is now regular (not Class Rep)
      const pendingPurchase = await Purchase.findOne({
        userId: userId,
        programId: classRepProgram._id,
        status: "pending",
      });
      expect(pendingPurchase?.isClassRep).toBe(false);
    });

    it("should correctly handle switching from regular to Class Rep purchase", async () => {
      // Setup: Create a program with Class Rep limit
      const classRepProgram = await Program.create({
        title: `Regular to Class Rep Test ${Date.now()}`,
        programType: "EMBA Mentor Circles",
        introduction: "Test switching enrollment types",
        isFree: false,
        fullPriceTicket: 2000,
        classRepDiscount: 500,
        classRepLimit: 3,
        createdBy: new mongoose.Types.ObjectId(userId),
        published: true,
      });

      // Step 1: User clicks "Proceed to Payment" WITHOUT Class Rep
      const response1 = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          programId: classRepProgram._id.toString(),
          isClassRep: false,
        });

      expect(response1.status).toBe(200);

      // Verify classRepCount = 0
      let program = await Program.findById(classRepProgram._id);
      expect(program?.classRepCount || 0).toBe(0);

      // Step 2: User changes mind, clicks "Proceed to Payment" WITH Class Rep
      const response2 = await request(app)
        .post("/api/purchases/create-checkout-session")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
          programId: classRepProgram._id.toString(),
          isClassRep: true,
        });

      expect(response2.status).toBe(200);

      // CRITICAL: classRepCount should be incremented to 1
      program = await Program.findById(classRepProgram._id);
      expect(program?.classRepCount).toBe(1);

      // Verify purchase is now Class Rep
      const pendingPurchase = await Purchase.findOne({
        userId: userId,
        programId: classRepProgram._id,
        status: "pending",
      });
      expect(pendingPurchase?.isClassRep).toBe(true);
    });
  });
});
