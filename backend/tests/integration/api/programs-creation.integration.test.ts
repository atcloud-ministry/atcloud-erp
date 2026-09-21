import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../src/app";
import { Program, User } from "../../../src/models";
import { ensureIntegrationDB } from "../setup/connect";
import { TokenService } from "../../../src/middleware/auth";

describe("Programs Creation API Integration Tests", () => {
  describe("POST /api/programs", () => {
    let adminUser: any;
    let nonAdminUser: any;
    let leaderUser: any;
    let adminToken: string;
    let nonAdminToken: string;
    let leaderToken: string;

    beforeAll(async () => {
      await ensureIntegrationDB();

      // Create admin user
      adminUser = await User.create({
        username: "adminuser_programs",
        name: "Admin User",
        email: "admin-programs@test.com",
        phone: "1234567890",
        role: "Administrator",
        password: "AdminPass123!",
        isVerified: true,
        isActive: true,
      } as any);
      adminToken = TokenService.generateAccessToken({
        userId: adminUser._id.toString(),
        email: adminUser.email,
        role: adminUser.role,
      });

      // Create non-admin user
      nonAdminUser = await User.create({
        username: "regularuser_prog",
        name: "Regular User",
        email: "user-programs@test.com",
        phone: "0987654321",
        role: "Participant",
        password: "UserPass123!",
        isVerified: true,
        isActive: true,
      } as any);
      nonAdminToken = TokenService.generateAccessToken({
        userId: nonAdminUser._id.toString(),
        email: nonAdminUser.email,
        role: nonAdminUser.role,
      });

      leaderUser = await User.create({
        username: "leader_programs",
        email: "leader-programs@test.com",
        phone: "1234567891",
        role: "Leader",
        password: "LeaderPass123!",
        isVerified: true,
        isActive: true,
      } as any);
      leaderToken = TokenService.generateAccessToken({
        userId: leaderUser._id.toString(),
        email: leaderUser.email,
        role: leaderUser.role,
      });
    });

    afterEach(async () => {
      await Program.deleteMany({});
    });

    afterAll(async () => {
      await User.deleteMany({});
      // Shared integration harness owns connection lifecycle.
    });

    describe("Authentication and Authorization", () => {
      it("should return 401 when no token provided", async () => {
        const response = await request(app)
          .post("/api/programs")
          .send({
            title: "Test Program",
            programType: "EMBA Mentor Circles",
            fullPriceTicket: 5000,
          })
          .expect(401);

        expect(response.body.success).toBe(false);
        expect(response.body.message).toBe(
          "Access denied. No token provided or invalid format.",
        );
      });

      it("should return 403 when non-admin user attempts to create", async () => {
        const response = await request(app)
          .post("/api/programs")
          .set("Authorization", `Bearer ${nonAdminToken}`)
          .send({
            title: "Test Program",
            programType: "EMBA Mentor Circles",
            fullPriceTicket: 5000,
          })
          .expect(403);

        expect(response.body.success).toBe(false);
        expect(response.body.message).toBe(
          "Only Leaders and above can create programs.",
        );
      });

      it("should allow admin to create program", async () => {
        const response = await request(app)
          .post("/api/programs")
          .set("Authorization", `Bearer ${adminToken}`)
          .send({
            title: "Admin Test Program",
            programType: "EMBA Mentor Circles",
            fullPriceTicket: 5000,
            isFree: false,
          })
          .expect(201);

        expect(response.body.success).toBe(true);
        expect(response.body.data).toBeDefined();
        expect(response.body.data.title).toBe("Admin Test Program");
      });

      it("should initialize ownership, enrollment lists, links, and role counts on the server", async () => {
        const injectedUserId = new mongoose.Types.ObjectId();
        const injectedEventId = new mongoose.Types.ObjectId();
        const response = await request(app)
          .post("/api/programs")
          .set("Authorization", `Bearer ${leaderToken}`)
          .send({
            title: "Leader Program",
            programType: "Webinar",
            fullPriceTicket: 0,
            isFree: true,
            createdBy: injectedUserId,
            adminEnrollments: { classReps: [injectedUserId] },
            events: [injectedEventId],
            classRepCount: 99,
            programRoles: {
              teacherRoleName: "Coach",
              studentRoles: [
                {
                  id: "DISCOUNT ROLE",
                  name: "Discount Role",
                  discountEligible: true,
                  discountAmount: 0,
                  limit: 5,
                  count: 99,
                },
              ],
            },
          })
          .expect(201);

        const stored = await Program.findById(response.body.data.id);
        expect(String(stored?.createdBy)).toBe(String(leaderUser._id));
        expect(stored?.adminEnrollments).toBeUndefined();
        expect(stored?.events).toHaveLength(0);
        expect(stored?.classRepCount).toBe(0);
        expect(stored?.programRoles?.studentRoles).toEqual([
          expect.objectContaining({ id: "discount-role", count: 0 }),
        ]);
      });

      it.each([
        null,
        {
          teacherRoleName: "Coach",
          studentRoles: { id: "replacement", count: 99 },
        },
      ])("should reject a non-canonical programRoles payload", async (programRoles) => {
        await request(app)
          .post("/api/programs")
          .set("Authorization", `Bearer ${leaderToken}`)
          .send({
            title: "Invalid Role Program",
            programType: "Webinar",
            fullPriceTicket: 0,
            isFree: true,
            programRoles,
          })
          .expect(400);

        expect(
          await Program.countDocuments({ title: "Invalid Role Program" }),
        ).toBe(0);
      });
    });

    describe("Successful Program Creation", () => {
      it("should create program with minimal required fields", async () => {
        const response = await request(app)
          .post("/api/programs")
          .set("Authorization", `Bearer ${adminToken}`)
          .send({
            title: "Minimal Program",
            programType: "EMBA Mentor Circles",
            fullPriceTicket: 0,
            isFree: true,
          })
          .expect(201);

        expect(response.body.success).toBe(true);
        const { data } = response.body;
        expect(data.title).toBe("Minimal Program");
        expect(data.programType).toBe("EMBA Mentor Circles");
        expect(data.fullPriceTicket).toBe(0);
        expect(data.isFree).toBe(true);

        // Verify createdBy is set to admin user
        const program = await Program.findById(data.id);
        expect(program?.createdBy.toString()).toBe(adminUser._id.toString());
      });

      it("should create program with all optional fields", async () => {
        const response = await request(app)
          .post("/api/programs")
          .set("Authorization", `Bearer ${adminToken}`)
          .send({
            title: "Complete Program",
            programType: "Marketplace Church Incubator Program (MCIP)",
            hostedBy: "Test Host Organization",
            period: {
              startYear: "2024",
              startMonth: "01",
              endYear: "2024",
              endMonth: "12",
            },
            introduction: "Comprehensive program description",
            flyerUrl: "https://example.com/flyer.jpg",
            earlyBirdDeadline: new Date("2024-12-31"),
            isFree: false,
            fullPriceTicket: 50000,
            classRepDiscount: 5000,
            earlyBirdDiscount: 10000,
            classRepLimit: 5,
          })
          .expect(201);

        expect(response.body.success).toBe(true);
        const { data } = response.body;
        expect(data.title).toBe("Complete Program");
        expect(data.hostedBy).toBe("Test Host Organization");
        expect(data.introduction).toBe("Comprehensive program description");
        expect(data.flyerUrl).toBe("https://example.com/flyer.jpg");
        expect(data.fullPriceTicket).toBe(50000);
        expect(data.classRepLimit).toBe(5);
      });

      it("should create free program correctly", async () => {
        const response = await request(app)
          .post("/api/programs")
          .set("Authorization", `Bearer ${adminToken}`)
          .send({
            title: "Free Workshop",
            programType: "Effective Communication Workshops",
            fullPriceTicket: 0,
            isFree: true,
          })
          .expect(201);

        expect(response.body.success).toBe(true);
        expect(response.body.data.isFree).toBe(true);
        expect(response.body.data.fullPriceTicket).toBe(0);
      });

      it("should create paid program with pricing details", async () => {
        const response = await request(app)
          .post("/api/programs")
          .set("Authorization", `Bearer ${adminToken}`)
          .send({
            title: "Paid Workshop",
            programType: "Effective Communication Workshops",
            fullPriceTicket: 25000,
            isFree: false,
            classRepDiscount: 2500,
            earlyBirdDiscount: 5000,
            earlyBirdDeadline: new Date("2024-12-31"),
            classRepLimit: 3,
          })
          .expect(201);

        expect(response.body.success).toBe(true);
        const { data } = response.body;
        expect(data.fullPriceTicket).toBe(25000);
        expect(data.classRepDiscount).toBe(2500);
        expect(data.earlyBirdDiscount).toBe(5000);
        expect(data.classRepLimit).toBe(3);
      });

      it("should create program for each program type", async () => {
        const programTypes = [
          "EMBA Mentor Circles",
          "Effective Communication Workshops",
          "Marketplace Church Incubator Program (MCIP)",
        ];

        for (const programType of programTypes) {
          const response = await request(app)
            .post("/api/programs")
            .set("Authorization", `Bearer ${adminToken}`)
            .send({
              title: `${programType} Program`,
              programType,
              fullPriceTicket: 5000,
              isFree: false,
            })
            .expect(201);

          expect(response.body.success).toBe(true);
          expect(response.body.data.programType).toBe(programType);
        }

        // Verify all 3 programs were created
        const count = await Program.countDocuments();
        expect(count).toBe(3);
      });
    });

    describe("Validation Errors", () => {
      it("should return 400 when title is missing", async () => {
        const response = await request(app)
          .post("/api/programs")
          .set("Authorization", `Bearer ${adminToken}`)
          .send({
            programType: "EMBA Mentor Circles",
            fullPriceTicket: 5000,
          })
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.message).toContain("title");
      });

      it("should return 400 when programType is missing", async () => {
        const response = await request(app)
          .post("/api/programs")
          .set("Authorization", `Bearer ${adminToken}`)
          .send({
            title: "Test Program",
            fullPriceTicket: 5000,
          })
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.message).toContain("programType");
      });

      it("should return 400 when programType is invalid", async () => {
        const response = await request(app)
          .post("/api/programs")
          .set("Authorization", `Bearer ${adminToken}`)
          .send({
            title: "Test Program",
            programType: "Invalid Type",
            fullPriceTicket: 5000,
          })
          .expect(400);

        expect(response.body.success).toBe(false);
      });

      it("should return 400 when paid program has zero price", async () => {
        const response = await request(app)
          .post("/api/programs")
          .set("Authorization", `Bearer ${adminToken}`)
          .send({
            title: "Invalid Paid Program",
            programType: "EMBA Mentor Circles",
            fullPriceTicket: 0,
            isFree: false,
          })
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.message).toContain("price");
      });

      it("should return 400 when classRepLimit exceeds maximum", async () => {
        const response = await request(app)
          .post("/api/programs")
          .set("Authorization", `Bearer ${adminToken}`)
          .send({
            title: "Invalid Limit Program",
            programType: "EMBA Mentor Circles",
            fullPriceTicket: 5000,
            classRepLimit: 10,
          })
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.message).toContain("limit");
      });

      it("should return 400 when discount exceeds price", async () => {
        const response = await request(app)
          .post("/api/programs")
          .set("Authorization", `Bearer ${adminToken}`)
          .send({
            title: "Invalid Discount Program",
            programType: "EMBA Mentor Circles",
            fullPriceTicket: 5000,
            earlyBirdDiscount: 10000,
          })
          .expect(400);

        expect(response.body.success).toBe(false);
      });

      it("should return 400 when earlyBirdDeadline missing with discount", async () => {
        const response = await request(app)
          .post("/api/programs")
          .set("Authorization", `Bearer ${adminToken}`)
          .send({
            title: "Missing Deadline Program",
            programType: "EMBA Mentor Circles",
            fullPriceTicket: 5000,
            earlyBirdDiscount: 1000,
          })
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.message).toContain("Deadline");
      });
    });

    describe("Edge Cases", () => {
      it("should handle empty request body gracefully", async () => {
        const response = await request(app)
          .post("/api/programs")
          .set("Authorization", `Bearer ${adminToken}`)
          .send({})
          .expect(400);

        expect(response.body.success).toBe(false);
      });

      it("should create program with maximum pricing values", async () => {
        const response = await request(app)
          .post("/api/programs")
          .set("Authorization", `Bearer ${adminToken}`)
          .send({
            title: "Max Price Program",
            programType: "EMBA Mentor Circles",
            fullPriceTicket: 100000,
            earlyBirdDiscount: 100000,
            earlyBirdDeadline: new Date("2024-12-31"),
            isFree: false,
          })
          .expect(201);

        expect(response.body.success).toBe(true);
        expect(response.body.data.fullPriceTicket).toBe(100000);
      });

      it("should create program with empty mentors array", async () => {
        const response = await request(app)
          .post("/api/programs")
          .set("Authorization", `Bearer ${adminToken}`)
          .send({
            title: "No Mentors Program",
            programType: "EMBA Mentor Circles",
            fullPriceTicket: 5000,
            mentors: [],
          })
          .expect(201);

        expect(response.body.success).toBe(true);
        expect(response.body.data.mentors).toEqual([]);
      });

      it("should create program with unlimited class reps", async () => {
        const response = await request(app)
          .post("/api/programs")
          .set("Authorization", `Bearer ${adminToken}`)
          .send({
            title: "Unlimited Reps Program",
            programType: "EMBA Mentor Circles",
            fullPriceTicket: 5000,
            classRepLimit: 0,
          })
          .expect(201);

        expect(response.body.success).toBe(true);
        expect(response.body.data.classRepLimit).toBe(0);
      });
    });

    describe("Concurrent Creation", () => {
      it("should handle multiple concurrent program creations", async () => {
        const requests = Array(3)
          .fill(null)
          .map((_, index) =>
            request(app)
              .post("/api/programs")
              .set("Authorization", `Bearer ${adminToken}`)
              .send({
                title: `Concurrent Program ${index + 1}`,
                programType: "EMBA Mentor Circles",
                fullPriceTicket: 5000,
                isFree: false,
              }),
          );

        const responses = await Promise.all(requests);

        responses.forEach((response) => {
          expect(response.status).toBe(201);
          expect(response.body.success).toBe(true);
        });

        // Verify all 3 programs were created
        const count = await Program.countDocuments();
        expect(count).toBe(3);
      });
    });

    describe("Response Time", () => {
      it("should respond quickly (< 200ms)", async () => {
        const start = Date.now();

        await request(app)
          .post("/api/programs")
          .set("Authorization", `Bearer ${adminToken}`)
          .send({
            title: "Performance Test Program",
            programType: "EMBA Mentor Circles",
            fullPriceTicket: 5000,
            isFree: false,
          })
          .expect(201);

        const duration = Date.now() - start;
        expect(duration).toBeLessThan(200);
      });
    });
  });
});
