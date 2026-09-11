import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import request from "supertest";
import app from "../../../src/app";
import { User, Event, Program, Purchase } from "../../../src/models";
import { ensureIntegrationDB } from "../setup/connect";

/**
 * Integration Tests: Leader Event Creation - Program Access Validation
 *
 * Tests the validation logic that ensures Leader-level users can only associate
 * programs they have access to when creating or editing events.
 *
 * Access Rules:
 * 1. Free programs → Always accessible to everyone
 * 2. Purchased programs → Accessible if user has completed purchase
 * 3. Mentor programs → Accessible if user is a mentor of the program
 * 4. Class Rep programs → Editable if user is a class rep of the program
 */
describe("Leader Event Creation - Program Access Validation", () => {
  let leaderToken: string;
  let leaderUserId: string;
  let adminToken: string;
  let adminUserId: string;

  // Program IDs
  let freeProgramId: string;
  let purchasedProgramId: string;
  let mentorProgramId: string;
  let classRepProgramId: string;
  let inaccessibleProgramId: string;

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

    // Create Leader user
    const leaderResponse = await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      email: "leader@test.com",
      username: "leader",
      password: "TestPass123!",
      confirmPassword: "TestPass123!",
      firstName: "Test",
      lastName: "Leader",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
    });

    leaderUserId = leaderResponse.body.data.user.id;

    // Verify Leader user AND set role to Leader (registration always creates Participant)
    await User.findByIdAndUpdate(leaderUserId, {
      isVerified: true,
      role: "Leader",
    });

    // Login Leader
    const leaderLoginResponse = await request(app)
      .post("/api/auth/login")
      .send({
        emailOrUsername: "leader@test.com",
        password: "TestPass123!",
      });

    leaderToken = leaderLoginResponse.body.data.accessToken;

    // Create Admin user (for comparison - Admin should not be restricted)
    const adminResponse = await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      email: "admin@test.com",
      username: "admin",
      password: "TestPass123!",
      confirmPassword: "TestPass123!",
      firstName: "Test",
      lastName: "Admin",
      gender: "female",
      isAtCloudLeader: false,
      acceptTerms: true,
    });

    adminUserId = adminResponse.body.data.user.id;

    // Verify Admin user AND set role to Administrator
    await User.findByIdAndUpdate(adminUserId, {
      isVerified: true,
      role: "Administrator",
    });

    // Login Admin
    const adminLoginResponse = await request(app).post("/api/auth/login").send({
      emailOrUsername: "admin@test.com",
      password: "TestPass123!",
    });

    adminToken = adminLoginResponse.body.data.accessToken;

    // Create test programs

    // 1. Free Program (accessible to everyone)
    const freeProgram = await Program.create({
      title: "Free Community Circle",
      programType: "EMBA Mentor Circles",
      hostedBy: "@Cloud Marketplace Ministry",
      isFree: true, // FREE
      fullPriceTicket: 0,
      period: {
        startYear: "2025",
        startMonth: "1",
        endYear: "2025",
        endMonth: "12",
      },
      introduction: "Free program accessible to all",
      mentors: [],
      createdBy: adminUserId,
    });
    freeProgramId = freeProgram._id.toString();

    // 2. Purchased Program (Leader purchased this one)
    const purchasedProgram = await Program.create({
      title: "Leadership Workshop",
      programType: "Effective Communication Workshops",
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
      introduction: "Purchased program",
      mentors: [],
      createdBy: adminUserId,
    });
    purchasedProgramId = purchasedProgram._id.toString();

    // Create completed purchase for Leader
    await Purchase.create({
      userId: new mongoose.Types.ObjectId(leaderUserId),
      programId: new mongoose.Types.ObjectId(purchasedProgramId),
      fullPrice: 5000,
      finalPrice: 5000,
      isClassRep: false,
      isEarlyBird: false,
      status: "completed",
      orderNumber: "ORD-TEST-LEADER-001",
      stripeSessionId: "sess_test_leader_001",
      purchaseDate: new Date(),
      paymentMethod: { type: "card", cardBrand: "visa", last4: "4242" },
      billingInfo: { fullName: "Test Leader", email: "leader@test.com" },
    });

    // 3. Mentor Program (Leader is a mentor)
    const mentorProgram = await Program.create({
      title: "Business Excellence Circle",
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
      introduction: "Mentor program",
      mentors: [
        {
          userId: leaderUserId, // Leader is a mentor
          firstName: "Test",
          lastName: "Leader",
          email: "leader@test.com",
          gender: "male",
        },
      ],
      createdBy: adminUserId,
    });
    mentorProgramId = mentorProgram._id.toString();

    // 4. Class Rep Program (Leader is a class rep)
    const classRepProgram = await Program.create({
      title: "Class Rep Workshop",
      programType: "Effective Communication Workshops",
      hostedBy: "@Cloud Marketplace Ministry",
      isFree: false,
      fullPriceTicket: 6000,
      classRepDiscount: 1200,
      earlyBirdDiscount: 600,
      earlyBirdDeadline: "2025-06-30",
      period: {
        startYear: "2025",
        startMonth: "1",
        endYear: "2025",
        endMonth: "12",
      },
      introduction: "Class rep program",
      mentors: [],
      createdBy: adminUserId,
    });
    classRepProgramId = classRepProgram._id.toString();

    await Purchase.create({
      userId: new mongoose.Types.ObjectId(leaderUserId),
      programId: new mongoose.Types.ObjectId(classRepProgramId),
      fullPrice: 6000,
      classRepDiscount: 1200,
      finalPrice: 4800,
      isClassRep: true,
      isEarlyBird: false,
      status: "completed",
      orderNumber: "ORD-TEST-CLASSREP-001",
      stripeSessionId: "sess_test_classrep_001",
      purchaseDate: new Date(),
      paymentMethod: { type: "card", cardBrand: "visa", last4: "4242" },
      billingInfo: { fullName: "Test Leader", email: "leader@test.com" },
    });

    // 5. Inaccessible Program (Leader has no access)
    const inaccessibleProgram = await Program.create({
      title: "Premium Executive Program",
      programType: "EMBA Mentor Circles",
      hostedBy: "@Cloud Marketplace Ministry",
      isFree: false,
      fullPriceTicket: 10000, // $100
      classRepDiscount: 2000,
      earlyBirdDiscount: 1000,
      earlyBirdDeadline: "2025-06-30",
      period: {
        startYear: "2025",
        startMonth: "1",
        endYear: "2025",
        endMonth: "12",
      },
      introduction: "Inaccessible program",
      mentors: [],
      createdBy: adminUserId,
    });
    inaccessibleProgramId = inaccessibleProgram._id.toString();
  });

  // Helper function to create a valid event payload
  const createEventPayload = (programIds: string[]) => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0]; // 7 days from now

    return {
      title: "Test Event",
      type: "Mentor Circle", // Valid event type
      date: futureDate,
      time: "10:00",
      endTime: "12:00",
      location: "Test Location",
      organizer: "Test Organizer",
      agenda: "Test agenda for the event",
      format: "In-person",
      programLabels: programIds,
      roles: [
        {
          name: "Participant",
          description: "Event participant",
          maxParticipants: 50,
        },
      ],
    };
  };

  describe("Leader - Create Event Validation", () => {
    it("should ALLOW Leader to create event with FREE program", async () => {
      const payload = createEventPayload([freeProgramId]);

      const response = await request(app)
        .post("/api/events")
        .set("Authorization", `Bearer ${leaderToken}`)
        .send(payload);

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.event.programLabels).toHaveLength(1);
    });

    it("should ALLOW Leader to create event with PURCHASED program", async () => {
      const payload = createEventPayload([purchasedProgramId]);

      const response = await request(app)
        .post("/api/events")
        .set("Authorization", `Bearer ${leaderToken}`)
        .send(payload);

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.event.programLabels).toHaveLength(1);
    });

    it("should ALLOW Leader to create event with MENTOR program", async () => {
      const payload = createEventPayload([mentorProgramId]);

      const response = await request(app)
        .post("/api/events")
        .set("Authorization", `Bearer ${leaderToken}`)
        .send(payload);

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.event.programLabels).toHaveLength(1);
    });

    it("should ALLOW Leader to create event with CLASS REP program", async () => {
      const payload = createEventPayload([classRepProgramId]);

      const response = await request(app)
        .post("/api/events")
        .set("Authorization", `Bearer ${leaderToken}`)
        .send(payload);

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.event.programLabels).toHaveLength(1);
    });

    it("should ALLOW Leader to create event with MULTIPLE accessible programs", async () => {
      const payload = createEventPayload([
        freeProgramId,
        purchasedProgramId,
        mentorProgramId,
      ]);

      const response = await request(app)
        .post("/api/events")
        .set("Authorization", `Bearer ${leaderToken}`)
        .send(payload);

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.event.programLabels).toHaveLength(3);
    });

    it("should BLOCK Leader from creating event with INACCESSIBLE program", async () => {
      const payload = createEventPayload([inaccessibleProgramId]);

      const response = await request(app)
        .post("/api/events")
        .set("Authorization", `Bearer ${leaderToken}`)
        .send(payload);

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain(
        "You can only associate programs that you have access to"
      );
      expect(response.body.data.reason).toBe("no_access");
    });

    it("should BLOCK Leader from creating event with MIX of accessible and inaccessible programs", async () => {
      const payload = createEventPayload([
        freeProgramId,
        inaccessibleProgramId, // This one will block
      ]);

      const response = await request(app)
        .post("/api/events")
        .set("Authorization", `Bearer ${leaderToken}`)
        .send(payload);

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain(
        "You can only associate programs that you have access to"
      );
    });

    it("should ALLOW Leader to create event with NO programs", async () => {
      const payload = createEventPayload([]);

      const response = await request(app)
        .post("/api/events")
        .set("Authorization", `Bearer ${leaderToken}`)
        .send(payload);

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.event.programLabels).toHaveLength(0);
    });
  });

  describe("Leader - Update Event Validation", () => {
    let testEventId: string;

    beforeEach(async () => {
      // Create a test event with accessible program
      const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];

      const event = await Event.create({
        title: "Test Event for Update",
        type: "Mentor Circle", // Valid event type
        date: futureDate,
        time: "10:00",
        endTime: "12:00",
        location: "Test Location",
        organizer: "Test Organizer",
        agenda: "Test agenda",
        format: "In-person",
        programLabels: [freeProgramId], // Start with free program
        roles: [
          {
            id: "role-1",
            name: "Participant",
            description: "Event participant",
            maxParticipants: 50,
          },
        ],
        createdBy: leaderUserId,
        signedUp: 0,
        totalSlots: 50,
      });
      testEventId = event._id.toString();
    });

    it("should ALLOW Leader to update event with accessible program", async () => {
      const response = await request(app)
        .put(`/api/events/${testEventId}`)
        .set("Authorization", `Bearer ${leaderToken}`)
        .send({
          programLabels: [purchasedProgramId], // Change to purchased program
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it("should ALLOW Leader to edit event they did not create when they are mentor of an affiliated program", async () => {
      const event = await Event.create({
        title: "Mentor Editable Event",
        type: "Mentor Circle",
        date: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        time: "13:00",
        endTime: "14:00",
        location: "Test Location",
        organizer: "Admin Organizer",
        agenda: "Test agenda",
        format: "In-person",
        programLabels: [mentorProgramId],
        roles: [
          {
            id: "role-mentor-edit",
            name: "Participant",
            description: "Event participant",
            maxParticipants: 50,
          },
        ],
        createdBy: adminUserId,
        signedUp: 0,
        totalSlots: 50,
      });

      const response = await request(app)
        .put(`/api/events/${event._id}`)
        .set("Authorization", `Bearer ${leaderToken}`)
        .send({ title: "Updated by Mentor Leader" });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it("should ALLOW Leader to edit event they did not create when they are class rep of an affiliated program", async () => {
      const event = await Event.create({
        title: "Class Rep Editable Event",
        type: "Effective Communication Workshop",
        date: new Date(Date.now() + 9 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        time: "13:00",
        endTime: "14:00",
        location: "Test Location",
        organizer: "Admin Organizer",
        agenda: "Test agenda",
        format: "In-person",
        programLabels: [classRepProgramId],
        roles: [
          {
            id: "role-classrep-edit",
            name: "Participant",
            description: "Event participant",
            maxParticipants: 50,
          },
        ],
        createdBy: adminUserId,
        signedUp: 0,
        totalSlots: 50,
      });

      const response = await request(app)
        .put(`/api/events/${event._id}`)
        .set("Authorization", `Bearer ${leaderToken}`)
        .send({ title: "Updated by Class Rep Leader" });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it("should BLOCK Leader from updating event with inaccessible program", async () => {
      const response = await request(app)
        .put(`/api/events/${testEventId}`)
        .set("Authorization", `Bearer ${leaderToken}`)
        .send({
          programLabels: [inaccessibleProgramId], // Try to change to inaccessible
        });

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain(
        "You can only associate programs that you have access to"
      );
    });
  });

  describe("Admin - No Restrictions (Comparison)", () => {
    it("should ALLOW Admin to create event with ANY program (no restrictions)", async () => {
      const payload = createEventPayload([inaccessibleProgramId]);

      const response = await request(app)
        .post("/api/events")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(payload);

      // Admin should NOT be restricted
      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.event.programLabels).toHaveLength(1);
    });
  });

  describe("Edge Cases", () => {
    it("should handle pending purchase (not completed) as inaccessible", async () => {
      // Create another paid program
      const pendingProgram = await Program.create({
        title: "Pending Purchase Program",
        programType: "EMBA Mentor Circles",
        hostedBy: "@Cloud Marketplace Ministry",
        isFree: false,
        fullPriceTicket: 3000,
        classRepDiscount: 0,
        earlyBirdDiscount: 0,
        period: {
          startYear: "2025",
          startMonth: "1",
          endYear: "2025",
          endMonth: "12",
        },
        introduction: "Program with pending purchase",
        mentors: [],
        createdBy: adminUserId,
      });

      // Create PENDING purchase (not completed)
      await Purchase.create({
        userId: new mongoose.Types.ObjectId(leaderUserId),
        programId: pendingProgram._id,
        fullPrice: 3000,
        finalPrice: 3000,
        isClassRep: false,
        isEarlyBird: false,
        status: "pending", // NOT completed
        orderNumber: "ORD-TEST-PENDING",
        stripeSessionId: "sess_test_pending",
        purchaseDate: new Date(),
        paymentMethod: { type: "card", cardBrand: "visa", last4: "4242" },
        billingInfo: { fullName: "Test Leader", email: "leader@test.com" },
      });

      const payload = createEventPayload([pendingProgram._id.toString()]);

      const response = await request(app)
        .post("/api/events")
        .set("Authorization", `Bearer ${leaderToken}`)
        .send(payload);

      // Should be blocked (403) - purchase is not completed
      // (May be permission error or program access error depending on order of checks)
      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
    });

    it("should handle invalid program ID gracefully", async () => {
      const payload = createEventPayload(["invalid-id-format"]);

      const response = await request(app)
        .post("/api/events")
        .set("Authorization", `Bearer ${leaderToken}`)
        .send(payload);

      // Should reject (various status codes possible depending on validation order)
      expect([400, 403, 500]).toContain(response.status);
      expect(response.body.success).toBe(false);
    });

    it("should handle non-existent program ID", async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      const payload = createEventPayload([fakeId]);

      const response = await request(app)
        .post("/api/events")
        .set("Authorization", `Bearer ${leaderToken}`)
        .send(payload);

      // Should reject (various status codes possible)
      expect([400, 403, 404]).toContain(response.status);
      expect(response.body.success).toBe(false);
      // May return validation error or program not found message
    });
  });
});
