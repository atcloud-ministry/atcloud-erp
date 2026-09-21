import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";
import ParticipantsController from "../../../../src/controllers/programs/ParticipantsController";
import { Program, Purchase, User } from "../../../../src/models";
import mongoose from "mongoose";

// Mock dependencies
vi.mock("../../../../src/models", () => ({
  Program: {
    findById: vi.fn(),
  },
  Purchase: {
    find: vi.fn(),
  },
  User: {
    find: vi.fn(),
  },
}));

describe("ParticipantsController", () => {
  let mockReq: any;
  let mockRes: Partial<Response>;
  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;

  const programId = new mongoose.Types.ObjectId();
  const userId1 = new mongoose.Types.ObjectId();
  const userId2 = new mongoose.Types.ObjectId();
  const userId3 = new mongoose.Types.ObjectId();
  const userId4 = new mongoose.Types.ObjectId();

  beforeEach(() => {
    vi.clearAllMocks();

    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    mockReq = {
      params: { id: programId.toString() },
      // Set up admin user so contact info is visible in tests
      user: {
        _id: new mongoose.Types.ObjectId(),
        role: "Administrator",
      },
    };

    mockRes = {
      status: statusMock as any,
      json: jsonMock as any,
    };
  });

  describe("getParticipants", () => {
    describe("validation", () => {
      it("should return 400 for invalid program ID", async () => {
        mockReq.params.id = "invalid-id";

        await ParticipantsController.getParticipants(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Invalid program ID.",
        });
      });

      it("should return 404 if program not found", async () => {
        vi.mocked(Program.findById).mockResolvedValue(null);

        await ParticipantsController.getParticipants(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(404);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Program not found.",
        });
      });
    });

    describe("participants retrieval", () => {
      const mockProgram = {
        _id: programId,
        title: "Test Program",
        updatedAt: new Date("2024-01-15"),
        adminEnrollments: {
          mentees: [userId3],
          classReps: [userId4],
        },
      };

      it("should return empty lists when no participants", async () => {
        const programWithoutAdminEnrollments = {
          ...mockProgram,
          adminEnrollments: undefined,
        };

        vi.mocked(Program.findById).mockResolvedValue(
          programWithoutAdminEnrollments as any,
        );

        const mockPurchaseFind = vi.fn().mockReturnValue({
          populate: vi.fn().mockReturnValue({
            sort: vi.fn().mockResolvedValue([]),
          }),
        });
        vi.mocked(Purchase.find).mockImplementation(mockPurchaseFind);

        vi.mocked(User.find).mockReturnValue({
          select: vi.fn().mockResolvedValue([]),
        } as any);

        await ParticipantsController.getParticipants(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          data: {
            mentees: [],
            classReps: [],
            studentRoles: [
              {
                roleId: "mentee",
                name: "Mentee",
                discountEligible: false,
                participants: [],
              },
              {
                roleId: "classRep",
                name: "Class Representative",
                discountEligible: true,
                participants: [],
              },
            ],
          },
        });
      });

      it("should retrieve paid mentees from purchases", async () => {
        vi.mocked(Program.findById).mockResolvedValue({
          ...mockProgram,
          adminEnrollments: undefined,
        } as any);

        const mockPurchases = [
          {
            userId: {
              _id: userId1,
              firstName: "John",
              lastName: "Doe",
              email: "john@example.com",
            },
            isClassRep: false,
            purchaseDate: new Date("2024-01-10"),
          },
        ];

        const mockPurchaseFind = vi.fn().mockReturnValue({
          populate: vi.fn().mockReturnValue({
            sort: vi.fn().mockResolvedValue(mockPurchases),
          }),
        });
        vi.mocked(Purchase.find).mockImplementation(mockPurchaseFind);

        vi.mocked(User.find).mockReturnValue({
          select: vi.fn().mockResolvedValue([]),
        } as any);

        await ParticipantsController.getParticipants(
          mockReq as Request,
          mockRes as Response,
        );

        expect(Purchase.find).toHaveBeenCalledWith({
          purchaseType: "program",
          programId: programId.toString(),
          status: "completed",
          unenrolledAt: { $exists: false },
        });

        const response = jsonMock.mock.calls[0][0];
        expect(response.data.mentees).toHaveLength(1);
        expect(response.data.mentees[0]).toEqual({
          user: mockPurchases[0].userId,
          isPaid: true,
          enrollmentDate: mockPurchases[0].purchaseDate,
          studentRoleId: "mentee",
          studentRoleName: "Mentee",
        });
      });

      it("should retrieve paid class reps from purchases", async () => {
        vi.mocked(Program.findById).mockResolvedValue({
          ...mockProgram,
          adminEnrollments: undefined,
        } as any);

        const mockPurchases = [
          {
            userId: {
              _id: userId2,
              firstName: "Jane",
              lastName: "Smith",
              email: "jane@example.com",
            },
            isClassRep: true,
            purchaseDate: new Date("2024-01-12"),
          },
        ];

        const mockPurchaseFind = vi.fn().mockReturnValue({
          populate: vi.fn().mockReturnValue({
            sort: vi.fn().mockResolvedValue(mockPurchases),
          }),
        });
        vi.mocked(Purchase.find).mockImplementation(mockPurchaseFind);

        vi.mocked(User.find).mockReturnValue({
          select: vi.fn().mockResolvedValue([]),
        } as any);

        await ParticipantsController.getParticipants(
          mockReq as Request,
          mockRes as Response,
        );

        const response = jsonMock.mock.calls[0][0];
        expect(response.data.classReps).toHaveLength(1);
        expect(response.data.classReps[0]).toEqual({
          user: mockPurchases[0].userId,
          isPaid: true,
          enrollmentDate: mockPurchases[0].purchaseDate,
          studentRoleId: "classRep",
          studentRoleName: "Class Representative",
        });
      });

      it("should retrieve admin-enrolled mentees", async () => {
        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);

        const mockPurchaseFind = vi.fn().mockReturnValue({
          populate: vi.fn().mockReturnValue({
            sort: vi.fn().mockResolvedValue([]),
          }),
        });
        vi.mocked(Purchase.find).mockImplementation(mockPurchaseFind);

        const mockAdminMentees = [
          {
            _id: userId3,
            firstName: "Admin",
            lastName: "Mentee",
            email: "admin.mentee@example.com",
          },
        ];

        // Mock User.find to handle different calls
        const mockUserFind = vi.fn((query) => {
          const ids = (query._id as any)?.$in || [];
          if (ids.includes(userId3)) {
            return {
              select: vi.fn().mockResolvedValue(mockAdminMentees),
            };
          }
          return {
            select: vi.fn().mockResolvedValue([]),
          };
        });

        vi.mocked(User.find).mockImplementation(mockUserFind as any);

        await ParticipantsController.getParticipants(
          mockReq as Request,
          mockRes as Response,
        );

        const response = jsonMock.mock.calls[0][0];
        expect(response.data.mentees).toHaveLength(1);
        expect(response.data.mentees[0]).toEqual({
          user: mockAdminMentees[0],
          isPaid: false,
          enrollmentDate: mockProgram.updatedAt,
          studentRoleId: "mentee",
          studentRoleName: "Mentee",
        });
      });

      it("should retrieve admin-enrolled class reps", async () => {
        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);

        const mockPurchaseFind = vi.fn().mockReturnValue({
          populate: vi.fn().mockReturnValue({
            sort: vi.fn().mockResolvedValue([]),
          }),
        });
        vi.mocked(Purchase.find).mockImplementation(mockPurchaseFind);

        const mockAdminClassReps = [
          {
            _id: userId4,
            firstName: "Admin",
            lastName: "ClassRep",
            email: "admin.classrep@example.com",
          },
        ];

        const mockUserFind = vi.fn((query) => {
          const ids = (query._id as any)?.$in || [];
          if (ids.includes(userId4)) {
            return {
              select: vi.fn().mockResolvedValue(mockAdminClassReps),
            };
          }
          return {
            select: vi.fn().mockResolvedValue([]),
          };
        });

        vi.mocked(User.find).mockImplementation(mockUserFind as any);

        await ParticipantsController.getParticipants(
          mockReq as Request,
          mockRes as Response,
        );

        const response = jsonMock.mock.calls[0][0];
        expect(response.data.classReps).toHaveLength(1);
        expect(response.data.classReps[0]).toEqual({
          user: mockAdminClassReps[0],
          isPaid: false,
          enrollmentDate: mockProgram.updatedAt,
          studentRoleId: "classRep",
          studentRoleName: "Class Representative",
        });
      });

      it("should combine paid and admin participants", async () => {
        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);

        const mockPurchases = [
          {
            userId: {
              _id: userId1,
              firstName: "Paid",
              lastName: "Mentee",
              email: "paid@example.com",
            },
            isClassRep: false,
            purchaseDate: new Date("2024-01-10"),
          },
          {
            userId: {
              _id: userId2,
              firstName: "Paid",
              lastName: "ClassRep",
              email: "paidrep@example.com",
            },
            isClassRep: true,
            purchaseDate: new Date("2024-01-11"),
          },
        ];

        const mockPurchaseFind = vi.fn().mockReturnValue({
          populate: vi.fn().mockReturnValue({
            sort: vi.fn().mockResolvedValue(mockPurchases),
          }),
        });
        vi.mocked(Purchase.find).mockImplementation(mockPurchaseFind);

        const mockAdminMentees = [
          {
            _id: userId3,
            firstName: "Admin",
            lastName: "Mentee",
            email: "admin.mentee@example.com",
          },
        ];

        const mockAdminClassReps = [
          {
            _id: userId4,
            firstName: "Admin",
            lastName: "ClassRep",
            email: "admin.classrep@example.com",
          },
        ];

        const mockUserFind = vi.fn((query) => {
          const ids = (query._id as any)?.$in || [];
          if (ids.includes(userId3)) {
            return {
              select: vi.fn().mockResolvedValue(mockAdminMentees),
            };
          }
          if (ids.includes(userId4)) {
            return {
              select: vi.fn().mockResolvedValue(mockAdminClassReps),
            };
          }
          return {
            select: vi.fn().mockResolvedValue([]),
          };
        });

        vi.mocked(User.find).mockImplementation(mockUserFind as any);

        await ParticipantsController.getParticipants(
          mockReq as Request,
          mockRes as Response,
        );

        const response = jsonMock.mock.calls[0][0];
        expect(response.data.mentees).toHaveLength(2);
        expect(response.data.classReps).toHaveLength(2);

        // First mentee should be paid
        expect(response.data.mentees[0].isPaid).toBe(true);
        // Second mentee should be admin (free)
        expect(response.data.mentees[1].isPaid).toBe(false);

        // First classRep should be paid
        expect(response.data.classReps[0].isPaid).toBe(true);
        // Second classRep should be admin (free)
        expect(response.data.classReps[1].isPaid).toBe(false);
      });

      it("should show participant contact info to class reps", async () => {
        mockReq.user = {
          _id: userId4,
          role: "Participant",
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);

        const mockPurchases = [
          {
            userId: {
              _id: userId1,
              firstName: "Paid",
              lastName: "Mentee",
              email: "paid@example.com",
              phone: "555-0101",
            },
            isClassRep: false,
            purchaseDate: new Date("2024-01-10"),
          },
        ];

        const mockPurchaseFind = vi.fn().mockReturnValue({
          populate: vi.fn().mockReturnValue({
            sort: vi.fn().mockResolvedValue(mockPurchases),
          }),
        });
        vi.mocked(Purchase.find).mockImplementation(mockPurchaseFind);

        vi.mocked(User.find).mockImplementation(((query: any) => {
          const ids = query._id?.$in || [];
          if (ids.includes(userId4)) {
            return {
              select: vi.fn().mockResolvedValue([
                {
                  _id: userId4,
                  firstName: "Admin",
                  lastName: "ClassRep",
                  email: "admin.classrep@example.com",
                  phone: "555-0104",
                },
              ]),
            };
          }
          return {
            select: vi.fn().mockResolvedValue([]),
          };
        }) as any);

        await ParticipantsController.getParticipants(
          mockReq as Request,
          mockRes as Response,
        );

        const response = jsonMock.mock.calls[0][0];
        expect(response.data.mentees[0].user.email).toBe("paid@example.com");
        expect(response.data.mentees[0].user.phone).toBeUndefined();
        expect(response.data.classReps[0].user.email).toBe(
          "admin.classrep@example.com",
        );
        expect(response.data.classReps[0].user.phone).toBe("555-0104");
      });

      it("should sort purchases by purchaseDate ascending", async () => {
        vi.mocked(Program.findById).mockResolvedValue({
          ...mockProgram,
          adminEnrollments: undefined,
        } as any);

        const mockPurchaseFind = vi.fn().mockReturnValue({
          populate: vi.fn().mockReturnValue({
            sort: vi.fn().mockResolvedValue([]),
          }),
        });
        vi.mocked(Purchase.find).mockImplementation(mockPurchaseFind);

        vi.mocked(User.find).mockReturnValue({
          select: vi.fn().mockResolvedValue([]),
        } as any);

        await ParticipantsController.getParticipants(
          mockReq as Request,
          mockRes as Response,
        );

        const sortCall =
          mockPurchaseFind.mock.results[0].value.populate.mock.results[0].value
            .sort;
        expect(sortCall).toHaveBeenCalledWith({ purchaseDate: 1 });
      });

      it("should populate user fields from purchases", async () => {
        vi.mocked(Program.findById).mockResolvedValue({
          ...mockProgram,
          adminEnrollments: undefined,
        } as any);

        const mockPurchaseFind = vi.fn().mockReturnValue({
          populate: vi.fn().mockReturnValue({
            sort: vi.fn().mockResolvedValue([]),
          }),
        });
        vi.mocked(Purchase.find).mockImplementation(mockPurchaseFind);

        vi.mocked(User.find).mockReturnValue({
          select: vi.fn().mockResolvedValue([]),
        } as any);

        await ParticipantsController.getParticipants(
          mockReq as Request,
          mockRes as Response,
        );

        const populateCall = mockPurchaseFind.mock.results[0].value.populate;
        expect(populateCall).toHaveBeenCalledWith(
          "userId",
          "firstName lastName email phone avatar gender roleInAtCloud",
        );
      });

      it("should select correct user fields for admin enrollments", async () => {
        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);

        const mockPurchaseFind = vi.fn().mockReturnValue({
          populate: vi.fn().mockReturnValue({
            sort: vi.fn().mockResolvedValue([]),
          }),
        });
        vi.mocked(Purchase.find).mockImplementation(mockPurchaseFind);

        const selectMock = vi.fn().mockResolvedValue([]);
        vi.mocked(User.find).mockReturnValue({
          select: selectMock,
        } as any);

        await ParticipantsController.getParticipants(
          mockReq as Request,
          mockRes as Response,
        );

        expect(selectMock).toHaveBeenCalledWith(
          "_id firstName lastName email phone avatar gender roleInAtCloud",
        );
      });

      it("should handle empty adminEnrollments arrays", async () => {
        const programWithEmptyArrays = {
          ...mockProgram,
          adminEnrollments: {
            mentees: [],
            classReps: [],
          },
        };

        vi.mocked(Program.findById).mockResolvedValue(
          programWithEmptyArrays as any,
        );

        const mockPurchaseFind = vi.fn().mockReturnValue({
          populate: vi.fn().mockReturnValue({
            sort: vi.fn().mockResolvedValue([]),
          }),
        });
        vi.mocked(Purchase.find).mockImplementation(mockPurchaseFind);

        vi.mocked(User.find).mockReturnValue({
          select: vi.fn().mockResolvedValue([]),
        } as any);

        await ParticipantsController.getParticipants(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        const response = jsonMock.mock.calls[0][0];
        expect(response.data.mentees).toEqual([]);
        expect(response.data.classReps).toEqual([]);
      });
    });

    describe("error handling", () => {
      it("should handle database errors when fetching program", async () => {
        vi.mocked(Program.findById).mockRejectedValue(
          new Error("Database error"),
        );

        await ParticipantsController.getParticipants(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Failed to fetch program participants.",
        });
      });

      it("should handle errors when fetching purchases", async () => {
        const mockProgram = {
          _id: programId,
          adminEnrollments: undefined,
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);

        const mockPurchaseFind = vi.fn().mockReturnValue({
          populate: vi.fn().mockReturnValue({
            sort: vi.fn().mockRejectedValue(new Error("Purchase query error")),
          }),
        });
        vi.mocked(Purchase.find).mockImplementation(mockPurchaseFind);

        await ParticipantsController.getParticipants(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Failed to fetch program participants.",
        });
      });

      it("should handle errors when fetching admin users", async () => {
        const mockProgram = {
          _id: programId,
          updatedAt: new Date(),
          adminEnrollments: {
            mentees: [userId3],
            classReps: [],
          },
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);

        const mockPurchaseFind = vi.fn().mockReturnValue({
          populate: vi.fn().mockReturnValue({
            sort: vi.fn().mockResolvedValue([]),
          }),
        });
        vi.mocked(Purchase.find).mockImplementation(mockPurchaseFind);

        vi.mocked(User.find).mockReturnValue({
          select: vi.fn().mockRejectedValue(new Error("User query error")),
        } as any);

        await ParticipantsController.getParticipants(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Failed to fetch program participants.",
        });
      });
    });
  });
});
