import request from "supertest";
import mongoose from "mongoose";
import { describe, it, beforeAll, afterAll, beforeEach, expect } from "vitest";
import app from "../../../src/app";
import ProgramModel from "../../../src/models/Program";
import { createAndLoginTestUser } from "../../test-utils/createTestUser";

/**
 * Integration tests for PUT /api/programs/:id authorization
 *
 * Tests verify that Super Admin, Administrator, and assigned mentors can update programs.
 * Leader, Guest Expert, Participant, and non-assigned mentors should be denied access.
 */

describe("PUT /api/programs/:id - Authorization Tests", () => {
  let programId: string;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(
        process.env.MONGODB_URI ||
          "mongodb://127.0.0.1:27017/atcloud-signup-test",
      );
    }
  });

  afterAll(async () => {
    // Shared integration harness owns connection lifecycle.
  });

  beforeEach(async () => {
    // Clean up programs before each test
    await ProgramModel.deleteMany({});

    // Create a test program
    const createdProgram = await ProgramModel.create({
      title: "Test Program",
      programType: "EMBA Mentor Circles",
      fullPriceTicket: 1000,
      isFree: false,
      createdBy: new mongoose.Types.ObjectId(),
    });
    programId = createdProgram._id.toString();
  });

  describe("Authorized Roles", () => {
    it("should allow Super Admin to update a program", async () => {
      const { token } = await createAndLoginTestUser({ role: "Super Admin" });

      const updatedData = {
        title: "Updated by Super Admin",
        programType: "EMBA Mentor Circles",
        fullPriceTicket: 1200,
      };

      const response = await request(app)
        .put(`/api/programs/${programId}`)
        .set("Authorization", `Bearer ${token}`)
        .send(updatedData);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.title).toBe("Updated by Super Admin");
      expect(response.body.data.fullPriceTicket).toBe(1200);
    });

    it("should allow Administrator to update a program", async () => {
      const { token } = await createAndLoginTestUser({ role: "Administrator" });

      const updatedData = {
        title: "Updated by Administrator",
        programType: "Effective Communication Workshops",
        fullPriceTicket: 1500,
      };

      const response = await request(app)
        .put(`/api/programs/${programId}`)
        .set("Authorization", `Bearer ${token}`)
        .send(updatedData);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.title).toBe("Updated by Administrator");
      expect(response.body.data.fullPriceTicket).toBe(1500);
    });

    it("should allow assigned mentor to update their program", async () => {
      // Create mentor user
      const { userId, token } = await createAndLoginTestUser({
        role: "Leader",
      });

      // Create program with this mentor assigned
      const programWithMentor = await ProgramModel.create({
        title: "Mentor's Program",
        programType: "EMBA Mentor Circles",
        fullPriceTicket: 800,
        isFree: false,
        createdBy: new mongoose.Types.ObjectId(),
        mentors: [
          {
            userId,
            firstName: "Test",
            lastName: "User",
            email: "test@example.com",
            gender: "male",
            avatar: "",
            roleInAtCloud: "Leader",
          },
        ],
      });

      const updatedData = {
        title: "Updated by Assigned Mentor",
        programType: "EMBA Mentor Circles",
        fullPriceTicket: 900,
      };

      const response = await request(app)
        .put(`/api/programs/${programWithMentor._id}`)
        .set("Authorization", `Bearer ${token}`)
        .send(updatedData);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.title).toBe("Updated by Assigned Mentor");
      expect(response.body.data.fullPriceTicket).toBe(900);
    });

    it("should preserve ownership and server-maintained fields", async () => {
      const { userId, token } = await createAndLoginTestUser({
        role: "Participant",
      });
      const originalOwnerId = new mongoose.Types.ObjectId();
      const linkedEventId = new mongoose.Types.ObjectId();
      const program = await ProgramModel.create({
        title: "Class Rep Program",
        programType: "EMBA Mentor Circles",
        fullPriceTicket: 800,
        isFree: false,
        createdBy: originalOwnerId,
        classRepCount: 2,
        programRoles: {
          teacherRoleName: "Mentor",
          studentRoles: [
            {
              id: "role-a",
              name: "Role A",
              discountEligible: true,
              discountAmount: 100,
              limit: 5,
              count: 2,
            },
            {
              id: "role-b",
              name: "Role B",
              discountEligible: true,
              discountAmount: 200,
              limit: 5,
              count: 4,
            },
          ],
        },
        events: [linkedEventId],
        adminEnrollments: { classReps: [userId] },
      });

      const response = await request(app)
        .put(`/api/programs/${program._id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          title: "Updated by Class Rep",
          createdBy: userId,
          classRepCount: 99,
          events: [],
          adminEnrollments: { classReps: [] },
          programRoles: {
            teacherRoleName: "Coach",
            studentRoles: [
              {
                id: "ROLE B",
                name: "Role B",
                discountEligible: true,
                discountAmount: 250,
                limit: 5,
                count: 999,
              },
              {
                id: "role-new",
                name: "New Role",
                discountEligible: true,
                discountAmount: 50,
                limit: 5,
                count: 999,
              },
              {
                id: "ROLE A",
                name: "Role A",
                discountEligible: true,
                discountAmount: 150,
                limit: 5,
                count: 999,
              },
              {
                id: "role a",
                name: "Duplicate Role A",
                discountEligible: true,
                discountAmount: 75,
                limit: 5,
                count: 999,
              },
            ],
          },
        });

      expect(response.status).toBe(200);
      const stored = await ProgramModel.findById(program._id);
      expect(stored?.title).toBe("Updated by Class Rep");
      expect(String(stored?.createdBy)).toBe(String(originalOwnerId));
      expect(stored?.classRepCount).toBe(4);
      expect(stored?.programRoles?.studentRoles.map((role) => role.count)).toEqual(
        [4, 0, 2, 0],
      );
      expect(stored?.programRoles?.studentRoles.map((role) => role.id)).toEqual([
        "role-b",
        "role-new",
        "role-a",
        "role-a-2",
      ]);
      expect(stored?.events?.map(String)).toEqual([String(linkedEventId)]);
      expect(stored?.adminEnrollments?.classReps?.map(String)).toEqual([
        String(userId),
      ]);

      for (const programRoles of [
        null,
        {
          teacherRoleName: "Coach",
          studentRoles: {
            id: "replacement",
            name: "Replacement",
            discountEligible: true,
            count: 999,
          },
        },
      ]) {
        await request(app)
          .put(`/api/programs/${program._id}`)
          .set("Authorization", `Bearer ${token}`)
          .send({ programRoles })
          .expect(400);
      }

      const afterHostileUpdates = await ProgramModel.findById(program._id);
      expect(
        afterHostileUpdates?.programRoles?.studentRoles.map((role) => ({
          id: role.id,
          count: role.count,
        })),
      ).toEqual([
        { id: "role-b", count: 4 },
        { id: "role-new", count: 0 },
        { id: "role-a", count: 2 },
        { id: "role-a-2", count: 0 },
      ]);
    });
  });

  describe("Unauthorized Roles", () => {
    it("should deny mentor from updating program they are NOT assigned to", async () => {
      // Create mentor user
      const { userId: mentorId, token } = await createAndLoginTestUser({
        role: "Leader",
      });

      // Create program WITHOUT this mentor
      const programWithoutMentor = await ProgramModel.create({
        title: "Someone Else's Program",
        programType: "EMBA Mentor Circles",
        fullPriceTicket: 800,
        isFree: false,
        createdBy: new mongoose.Types.ObjectId(),
        mentors: [
          {
            userId: new mongoose.Types.ObjectId().toString(), // Different mentor
            firstName: "Other",
            lastName: "Mentor",
            email: "other@example.com",
            gender: "male",
            avatar: "",
            roleInAtCloud: "Leader",
          },
        ],
      });

      const updatedData = {
        title: "Attempted Update by Non-Assigned Mentor",
        programType: "EMBA Mentor Circles",
        fullPriceTicket: 2000,
      };

      const response = await request(app)
        .put(`/api/programs/${programWithoutMentor._id}`)
        .set("Authorization", `Bearer ${token}`)
        .send(updatedData);

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe(
        "You do not have permission to edit this program. Only Administrators, the program creator, assigned mentors, and class reps can edit programs.",
      );

      // Verify program was not updated
      const program = await ProgramModel.findById(programWithoutMentor._id);
      expect(program?.title).toBe("Someone Else's Program");
      expect(program?.fullPriceTicket).toBe(800);
    });

    it("should deny Leader from updating a program", async () => {
      const { token } = await createAndLoginTestUser({ role: "Leader" });

      const updatedData = {
        title: "Attempted Update by Leader",
        programType: "EMBA Mentor Circles",
        fullPriceTicket: 2000,
      };

      const response = await request(app)
        .put(`/api/programs/${programId}`)
        .set("Authorization", `Bearer ${token}`)
        .send(updatedData);

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe(
        "You do not have permission to edit this program. Only Administrators, the program creator, assigned mentors, and class reps can edit programs.",
      );

      // Verify program was not updated
      const program = await ProgramModel.findById(programId);
      expect(program?.title).toBe("Test Program");
      expect(program?.fullPriceTicket).toBe(1000);
    });

    it("should deny Guest Expert from updating a program", async () => {
      const { token } = await createAndLoginTestUser({ role: "Guest Expert" });

      const updatedData = {
        title: "Attempted Update by Guest Expert",
        programType: "EMBA Mentor Circles",
        fullPriceTicket: 2000,
      };

      const response = await request(app)
        .put(`/api/programs/${programId}`)
        .set("Authorization", `Bearer ${token}`)
        .send(updatedData);

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe(
        "You do not have permission to edit this program. Only Administrators, the program creator, assigned mentors, and class reps can edit programs.",
      );

      // Verify program was not updated
      const program = await ProgramModel.findById(programId);
      expect(program?.title).toBe("Test Program");
      expect(program?.fullPriceTicket).toBe(1000);
    });

    it("should deny Participant from updating a program", async () => {
      const { token } = await createAndLoginTestUser({ role: "Participant" });

      const updatedData = {
        title: "Attempted Update by Participant",
        programType: "EMBA Mentor Circles",
        fullPriceTicket: 2000,
      };

      const response = await request(app)
        .put(`/api/programs/${programId}`)
        .set("Authorization", `Bearer ${token}`)
        .send(updatedData);

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe(
        "You do not have permission to edit this program. Only Administrators, the program creator, assigned mentors, and class reps can edit programs.",
      );

      // Verify program was not updated
      const program = await ProgramModel.findById(programId);
      expect(program?.title).toBe("Test Program");
      expect(program?.fullPriceTicket).toBe(1000);
    });

    it("should deny unauthenticated users from updating a program", async () => {
      const updatedData = {
        title: "Attempted Update Without Auth",
        programType: "EMBA Mentor Circles",
        fullPriceTicket: 2000,
      };

      const response = await request(app)
        .put(`/api/programs/${programId}`)
        .send(updatedData);

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);

      // Verify program was not updated
      const program = await ProgramModel.findById(programId);
      expect(program?.title).toBe("Test Program");
      expect(program?.fullPriceTicket).toBe(1000);
    });
  });

  describe("Edge Cases", () => {
    it("should return 400 for invalid program ID", async () => {
      const { token } = await createAndLoginTestUser({ role: "Administrator" });

      const response = await request(app)
        .put("/api/programs/invalid-id")
        .set("Authorization", `Bearer ${token}`)
        .send({ title: "Test" });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe("Invalid program ID.");
    });

    it("should return 404 for non-existent program", async () => {
      const { token } = await createAndLoginTestUser({ role: "Administrator" });
      const fakeId = new mongoose.Types.ObjectId().toString();

      const response = await request(app)
        .put(`/api/programs/${fakeId}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ title: "Test" });

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe("Program not found.");
    });

    it("should validate program data during update", async () => {
      const { token } = await createAndLoginTestUser({ role: "Administrator" });

      // Try to update with invalid student role limit (max is 5)
      const invalidData = {
        title: "Test Program",
        programType: "EMBA Mentor Circles",
        programRoles: {
          teacherRoleName: "Mentor",
          studentRoles: [
            {
              id: "student",
              name: "Student",
              discountEligible: false,
              discountAmount: 0,
              limit: 0,
              count: 0,
            },
            {
              id: "class-rep",
              name: "Class Representative",
              discountEligible: true,
              discountAmount: 100,
              limit: 10,
              count: 0,
            },
          ],
        },
      };

      const response = await request(app)
        .put(`/api/programs/${programId}`)
        .set("Authorization", `Bearer ${token}`)
        .send(invalidData);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain("Class Rep limit must be <= 5");
    });
  });
});
