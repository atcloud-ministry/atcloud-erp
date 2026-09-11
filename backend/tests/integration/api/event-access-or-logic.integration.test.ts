import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import request from "supertest";
import app from "../../../src/app";
import { User, Event, Program, Purchase } from "../../../src/models";
import { ensureIntegrationDB } from "../setup/connect";

describe("Event Access - OR Logic (Purchase ANY associated program)", () => {
  let authToken: string;
  let userId: string;
  let adminUserId: string;

  // Program IDs
  let programAId: string;
  let programBId: string;
  let programCId: string;

  // Event associated with all three programs
  let multiProgramEventId: string;

  beforeAll(async () => {
    await ensureIntegrationDB();
  });

  afterAll(async () => {
    // Shared integration harness owns connection lifecycle.
  });

  beforeEach(async () => {
    // Clean up
    await User.deleteMany({});
    await Event.deleteMany({});
    await Program.deleteMany({});
    await Purchase.deleteMany({});

    // Create test user
    const userResponse = await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      email: "participant@test.com",
      username: "participant",
      password: "TestPass123!",
      confirmPassword: "TestPass123!",
      firstName: "Test",
      lastName: "Participant",
      role: "Participant",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
    });

    userId = userResponse.body.data.user.id;

    // Verify user
    await User.findByIdAndUpdate(userId, { isVerified: true });

    // Create admin user to be the program creator (not the test participant)
    const adminUser = await User.create({
      email: "admin-creator@test.com",
      username: "admincreator",
      password: "TestPass123!",
      firstName: "Admin",
      lastName: "Creator",
      role: "Administrator",
      isVerified: true,
      isActive: true,
    });
    adminUserId = adminUser._id.toString();

    // Login
    const loginResponse = await request(app).post("/api/auth/login").send({
      emailOrUsername: "participant@test.com",
      password: "TestPass123!",
    });

    authToken = loginResponse.body.data.accessToken;

    // Create three programs (all paid)
    const programA = await Program.create({
      title: "2025 Business Circle",
      programType: "EMBA Mentor Circles",
      hostedBy: "@Cloud Marketplace Ministry",
      isFree: false,
      fullPriceTicket: 5000, // $50
      classRepDiscount: 1000,
      earlyBirdDiscount: 500,
      earlyBirdDeadline: "2025-06-30",
      period: {
        startYear: "2025",
        startMonth: "1",
        endYear: "2025",
        endMonth: "12",
      },
      introduction: "Program A",
      mentors: [],
      createdBy: adminUserId,
    });
    programAId = programA._id.toString();

    const programB = await Program.create({
      title: "2025 Communication Workshop",
      programType: "Effective Communication Workshops",
      hostedBy: "@Cloud Marketplace Ministry",
      isFree: false,
      fullPriceTicket: 3000, // $30
      classRepDiscount: 500,
      earlyBirdDiscount: 300,
      earlyBirdDeadline: "2025-06-30",
      period: {
        startYear: "2025",
        startMonth: "1",
        endYear: "2025",
        endMonth: "12",
      },
      introduction: "Program B",
      mentors: [],
      createdBy: adminUserId,
    });
    programBId = programB._id.toString();

    const programC = await Program.create({
      title: "2025 Leadership Development",
      programType: "EMBA Mentor Circles",
      hostedBy: "@Cloud Marketplace Ministry",
      isFree: false,
      fullPriceTicket: 7000, // $70
      classRepDiscount: 1500,
      earlyBirdDiscount: 700,
      earlyBirdDeadline: "2025-06-30",
      period: {
        startYear: "2025",
        startMonth: "1",
        endYear: "2025",
        endMonth: "12",
      },
      introduction: "Program C",
      mentors: [],
      createdBy: adminUserId,
    });
    programCId = programC._id.toString();

    // Create an event associated with ALL three programs
    const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0]; // 30 days from now

    const event = await Event.create({
      title: "Multi-Program Event",
      type: "Effective Communication Workshop",
      date: futureDate,
      time: "10:00",
      endTime: "12:00",
      location: "Test Location",
      organizer: "Test Organizer",
      agenda:
        "This is a test event to validate OR logic for program access control.",
      format: "In-person",
      publish: true,
      programLabels: [programAId, programBId, programCId],
      roles: [
        {
          id: "role-1",
          name: "Participant",
          description: "Event participant",
          maxParticipants: 50,
        },
      ],
      createdBy: adminUserId,
    });
    multiProgramEventId = event._id.toString();
  });

  it("should grant access when user purchased Program A only (OR logic)", async () => {
    // User purchases Program A only
    await Purchase.create({
      userId: new mongoose.Types.ObjectId(userId),
      programId: new mongoose.Types.ObjectId(programAId),
      fullPrice: 5000,
      finalPrice: 5000,
      isClassRep: false,
      isEarlyBird: false,
      status: "completed",
      orderNumber: "ORD-TEST-001",
      stripeSessionId: "sess_test_001",
      purchaseDate: new Date(),
      paymentMethod: { type: "card", cardBrand: "visa", last4: "4242" },
      billingInfo: { fullName: "Test User", email: "participant@test.com" },
    });

    // Check access to Program A - should have access
    const responseA = await request(app)
      .get(`/api/purchases/check-access/${programAId}`)
      .set("Authorization", `Bearer ${authToken}`);

    expect(responseA.status).toBe(200);
    expect(responseA.body.data.hasAccess).toBe(true);
    expect(responseA.body.data.reason).toBe("purchased");

    // Check access to Program B - should NOT have access
    const responseB = await request(app)
      .get(`/api/purchases/check-access/${programBId}`)
      .set("Authorization", `Bearer ${authToken}`);

    expect(responseB.status).toBe(200);
    expect(responseB.body.data.hasAccess).toBe(false);

    // Check access to Program C - should NOT have access
    const responseC = await request(app)
      .get(`/api/purchases/check-access/${programCId}`)
      .set("Authorization", `Bearer ${authToken}`);

    expect(responseC.status).toBe(200);
    expect(responseC.body.data.hasAccess).toBe(false);

    // The frontend OR logic should grant event access because user has access to Program A
  });

  it("should grant access when user purchased Program B only (OR logic)", async () => {
    // User purchases Program B only
    await Purchase.create({
      userId: new mongoose.Types.ObjectId(userId),
      programId: new mongoose.Types.ObjectId(programBId),
      fullPrice: 3000,
      finalPrice: 3000,
      isClassRep: false,
      isEarlyBird: false,
      status: "completed",
      orderNumber: "ORD-TEST-002",
      stripeSessionId: "sess_test_002",
      purchaseDate: new Date(),
      paymentMethod: { type: "card", cardBrand: "visa", last4: "4242" },
      billingInfo: { fullName: "Test User", email: "participant@test.com" },
    });

    // Check access to Program B
    const response = await request(app)
      .get(`/api/purchases/check-access/${programBId}`)
      .set("Authorization", `Bearer ${authToken}`);

    expect(response.status).toBe(200);
    expect(response.body.data.hasAccess).toBe(true);
    expect(response.body.data.reason).toBe("purchased");
    // Frontend will grant access to event because user has access to ANY program
  });

  it("should grant access when user purchased Program C only (OR logic)", async () => {
    // User purchases Program C only
    await Purchase.create({
      userId: new mongoose.Types.ObjectId(userId),
      programId: new mongoose.Types.ObjectId(programCId),
      fullPrice: 7000,
      finalPrice: 7000,
      isClassRep: false,
      isEarlyBird: false,
      status: "completed",
      orderNumber: "ORD-TEST-003",
      stripeSessionId: "sess_test_003",
      purchaseDate: new Date(),
      paymentMethod: { type: "card", cardBrand: "visa", last4: "4242" },
      billingInfo: { fullName: "Test User", email: "participant@test.com" },
    });

    // Check access to Program C
    const response = await request(app)
      .get(`/api/purchases/check-access/${programCId}`)
      .set("Authorization", `Bearer ${authToken}`);

    expect(response.status).toBe(200);
    expect(response.body.data.hasAccess).toBe(true);
    expect(response.body.data.reason).toBe("purchased");
    // Frontend will grant access to event because user has access to ANY program
  });

  it("should DENY access when user purchased NONE of the programs", async () => {
    // User has no purchases

    // Check access to all three programs
    const responseA = await request(app)
      .get(`/api/purchases/check-access/${programAId}`)
      .set("Authorization", `Bearer ${authToken}`);

    const responseB = await request(app)
      .get(`/api/purchases/check-access/${programBId}`)
      .set("Authorization", `Bearer ${authToken}`);

    const responseC = await request(app)
      .get(`/api/purchases/check-access/${programCId}`)
      .set("Authorization", `Bearer ${authToken}`);

    expect(responseA.body.data.hasAccess).toBe(false);
    expect(responseB.body.data.hasAccess).toBe(false);
    expect(responseC.body.data.hasAccess).toBe(false);
    // Frontend will BLOCK access to event because user has NO access to ANY program
  });

  it("should NOT require ALL programs - purchasing ONE is sufficient", async () => {
    // User purchases Program A only (not B or C)
    await Purchase.create({
      userId: new mongoose.Types.ObjectId(userId),
      programId: new mongoose.Types.ObjectId(programAId),
      fullPrice: 5000,
      finalPrice: 5000,
      isClassRep: false,
      isEarlyBird: false,
      status: "completed",
      orderNumber: "ORD-TEST-004",
      stripeSessionId: "sess_test_004",
      purchaseDate: new Date(),
      paymentMethod: { type: "card", cardBrand: "visa", last4: "4242" },
      billingInfo: { fullName: "Test User", email: "participant@test.com" },
    });

    // Check access to Program A - should have access
    const responseA = await request(app)
      .get(`/api/purchases/check-access/${programAId}`)
      .set("Authorization", `Bearer ${authToken}`);

    expect(responseA.body.data.hasAccess).toBe(true);
    expect(responseA.body.data.reason).toBe("purchased");

    // Check access to Program B - should NOT have access
    const responseB = await request(app)
      .get(`/api/purchases/check-access/${programBId}`)
      .set("Authorization", `Bearer ${authToken}`);

    expect(responseB.body.data.hasAccess).toBe(false);

    // Check access to Program C - should NOT have access
    const responseC = await request(app)
      .get(`/api/purchases/check-access/${programCId}`)
      .set("Authorization", `Bearer ${authToken}`);

    expect(responseC.body.data.hasAccess).toBe(false);

    // Frontend OR logic: User has access to Program A → Event access GRANTED
    // This is the correct OR logic behavior!
  });

  it("should require enrollment before granting access to a free program", async () => {
    // Make Program B free
    await Program.findByIdAndUpdate(programBId, { isFree: true });

    // User has no purchases
    // Check access to Program B
    const responseB = await request(app)
      .get(`/api/purchases/check-access/${programBId}`)
      .set("Authorization", `Bearer ${authToken}`);

    expect(responseB.body.data.hasAccess).toBe(false);
    expect(responseB.body.data.reason).toBe("not_purchased");
    // Current policy requires enrollment/purchase even when the program is free.
  });
});
