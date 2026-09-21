import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";
import UpdateController from "../../../../src/controllers/programs/UpdateController";
import { Program, Purchase } from "../../../../src/models";
import { RoleUtils } from "../../../../src/utils/roleUtils";
import mongoose from "mongoose";

// Mock dependencies
vi.mock("../../../../src/models", () => ({
  Program: {
    findById: vi.fn(),
    findByIdAndUpdate: vi.fn(),
  },
  Purchase: {
    findOne: vi.fn(),
  },
}));

vi.mock("../../../../src/utils/roleUtils", () => ({
  RoleUtils: {
    isAdmin: vi.fn(),
  },
}));
vi.mock("../../../../src/services/UserAssignmentSnapshotService", () => {
  class AssignmentSnapshotError extends Error {}
  return {
    AssignmentSnapshotError,
    UserAssignmentSnapshotService: {
      resolveProgramMentors: vi.fn(),
    },
  };
});
vi.mock(
  "../../../../src/services/infrastructure/SocketService",
  () => ({
    socketService: {
      disconnectUser: vi.fn(),
    },
  }),
);
vi.mock(
  "../../../../src/services/programs/ProgramMembershipMutationSyncTrigger",
  () => ({
    programMembershipMutationSyncTrigger: {
      programAssignmentsChanged: vi.fn(),
    },
  }),
);

import {
  AssignmentSnapshotError,
  UserAssignmentSnapshotService,
} from "../../../../src/services/UserAssignmentSnapshotService";
import { socketService } from "../../../../src/services/infrastructure/SocketService";
import { programMembershipMutationSyncTrigger } from "../../../../src/services/programs/ProgramMembershipMutationSyncTrigger";

describe("UpdateController", () => {
  let mockReq: any;
  let mockRes: Partial<Response>;
  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;

  const programId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const mentorId = new mongoose.Types.ObjectId();

  const createMockProgram = (overrides: Record<string, unknown> = {}) => {
    const program: Record<string, unknown> & {
      set: ReturnType<typeof vi.fn>;
      save: ReturnType<typeof vi.fn>;
    } = {
      _id: programId,
      title: "Original Title",
      mentors: [],
      ...overrides,
      set: vi.fn(),
      save: vi.fn(),
    };
    program.set.mockImplementation((update: Record<string, unknown>) => {
      Object.assign(program, update);
      return program;
    });
    program.save.mockResolvedValue(program);
    return program;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    mockReq = {
      params: { id: programId.toString() },
      body: { title: "Updated Title" },
      user: {
        _id: userId,
        role: "Super Admin",
      },
      correlationId: "program-update-1",
    };

    mockRes = {
      status: statusMock as any,
      json: jsonMock as any,
    };
    vi.mocked(
      UserAssignmentSnapshotService.resolveProgramMentors,
    ).mockResolvedValue([]);
  });

  describe("update", () => {
    describe("authentication", () => {
      it("should return 401 if user not authenticated", async () => {
        mockReq.user = undefined;

        await UpdateController.update(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(401);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Authentication required.",
        });
      });
    });

    describe("validation", () => {
      it("should return 400 for invalid program ID", async () => {
        mockReq.params.id = "invalid-id";

        await UpdateController.update(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Invalid program ID.",
        });
      });

      it("should return 404 if program not found", async () => {
        vi.mocked(Program.findById).mockResolvedValue(null);

        await UpdateController.update(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(404);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Program not found.",
        });
      });
    });

    describe("authorization", () => {
      it("should allow Super Admin to update any program", async () => {
        const mockProgram = createMockProgram();

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(RoleUtils.isAdmin).mockReturnValue(true);

        await UpdateController.update(mockReq as Request, mockRes as Response);

        expect(RoleUtils.isAdmin).toHaveBeenCalledWith("Super Admin");
        expect(mockProgram.set).toHaveBeenCalledWith(mockReq.body);
        expect(mockProgram.save).toHaveBeenCalled();
        expect(
          programMembershipMutationSyncTrigger.programAssignmentsChanged,
        ).toHaveBeenCalledWith(programId.toString(), {
          actor: {
            type: "user",
            id: userId.toString(),
            role: "Super Admin",
          },
          source: "http",
          correlationId: "program-update-1",
        });
        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          data: mockProgram,
        });
      });

      it("should allow Administrator to update any program", async () => {
        mockReq.user.role = "Administrator";

        const mockProgram = createMockProgram();

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(RoleUtils.isAdmin).mockReturnValue(true);

        await UpdateController.update(mockReq as Request, mockRes as Response);

        expect(RoleUtils.isAdmin).toHaveBeenCalledWith("Administrator");
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should allow assigned mentor to update their program", async () => {
        mockReq.user = {
          _id: mentorId,
          role: "Member",
        };

        const mockProgram = createMockProgram({
          mentors: [{ userId: mentorId }],
        });

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(RoleUtils.isAdmin).mockReturnValue(false);

        await UpdateController.update(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should reject non-admin non-creator non-mentor users", async () => {
        mockReq.user = {
          _id: userId,
          role: "Member",
        };

        const mockProgram = {
          _id: programId,
          title: "Original Title",
          createdBy: "differentUser456", // Different creator
          mentors: [{ userId: mentorId }], // Different mentor
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(RoleUtils.isAdmin).mockReturnValue(false);
        vi.mocked(Purchase.findOne).mockReturnValue({
          select: vi.fn().mockResolvedValue(null),
        } as any);

        await UpdateController.update(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(403);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message:
            "You do not have permission to edit this program. Only Administrators, the program creator, assigned mentors, and class reps can edit programs.",
        });
      });

      it("should allow admin-enrolled class reps to update their program", async () => {
        const classRepId = new mongoose.Types.ObjectId();
        mockReq.user = {
          _id: classRepId,
          role: "Participant",
        };

        const mockProgram = createMockProgram({
          adminEnrollments: {
            classReps: [classRepId],
          },
        });

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(RoleUtils.isAdmin).mockReturnValue(false);

        await UpdateController.update(mockReq as Request, mockRes as Response);

        expect(Purchase.findOne).not.toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          data: mockProgram,
        });
      });

      it("should allow paid class reps to update their program", async () => {
        const classRepId = new mongoose.Types.ObjectId();
        mockReq.user = {
          _id: classRepId,
          role: "Participant",
        };

        const mockProgram = createMockProgram();

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(RoleUtils.isAdmin).mockReturnValue(false);
        vi.mocked(Purchase.findOne).mockReturnValue({
          select: vi.fn().mockResolvedValue({ _id: "purchase-1" }),
        } as any);

        await UpdateController.update(mockReq as Request, mockRes as Response);

        expect(Purchase.findOne).toHaveBeenCalledWith({
          purchaseType: "program",
          programId: mockProgram._id,
          userId: classRepId,
          status: "completed",
          isClassRep: true,
          unenrolledAt: { $exists: false },
        });
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should reject Leader role for programs they don't mentor", async () => {
        mockReq.user = {
          _id: userId,
          role: "Leader",
        };

        const mockProgram = {
          _id: programId,
          title: "Original Title",
          mentors: [],
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(RoleUtils.isAdmin).mockReturnValue(false);
        vi.mocked(Purchase.findOne).mockReturnValue({
          select: vi.fn().mockResolvedValue(null),
        } as any);

        await UpdateController.update(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(403);
      });

      it("should handle program with no mentors array", async () => {
        mockReq.user = {
          _id: userId,
          role: "Member",
        };

        const mockProgram = {
          _id: programId,
          title: "Original Title",
          mentors: undefined,
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(RoleUtils.isAdmin).mockReturnValue(false);
        vi.mocked(Purchase.findOne).mockReturnValue({
          select: vi.fn().mockResolvedValue(null),
        } as any);

        await UpdateController.update(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(403);
      });

      it("should handle program with empty mentors array", async () => {
        mockReq.user = {
          _id: userId,
          role: "Member",
        };

        const mockProgram = {
          _id: programId,
          title: "Original Title",
          mentors: [],
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(RoleUtils.isAdmin).mockReturnValue(false);
        vi.mocked(Purchase.findOne).mockReturnValue({
          select: vi.fn().mockResolvedValue(null),
        } as any);

        await UpdateController.update(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(403);
      });
    });

    describe("update execution", () => {
      let mockProgram: ReturnType<typeof createMockProgram>;

      beforeEach(() => {
        mockProgram = createMockProgram();

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(RoleUtils.isAdmin).mockReturnValue(true);
      });

      it("should update program with provided fields", async () => {
        mockReq.body = {
          title: "New Title",
          introduction: "New Description",
        };

        await UpdateController.update(mockReq as Request, mockRes as Response);

        expect(mockProgram.set).toHaveBeenCalledWith(mockReq.body);
        expect(mockProgram.save).toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          data: mockProgram,
        });
      });

      it("should exclude ownership and server-maintained fields", async () => {
        const attemptedOwner = new mongoose.Types.ObjectId();
        mockReq.body = {
          title: "Allowed Title",
          createdBy: attemptedOwner,
          _id: attemptedOwner,
          id: attemptedOwner.toString(),
          adminEnrollments: { classReps: [attemptedOwner] },
          classRepCount: 99,
          events: [attemptedOwner],
          createdAt: new Date(0),
          updatedAt: new Date(0),
          __v: 99,
        };

        await UpdateController.update(mockReq as Request, mockRes as Response);

        expect(mockProgram.set).toHaveBeenCalledWith({
          title: "Allowed Title",
        });
        expect(mockProgram.save).toHaveBeenCalledTimes(1);
      });

      it("should preserve existing role counts by id and initialize new roles at zero", async () => {
        mockProgram = createMockProgram({
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
        });
        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        mockReq.body = {
          programRoles: {
            teacherRoleName: "Coach",
            studentRoles: [
              {
                id: "ROLE B",
                name: "Role B",
                discountEligible: true,
                count: 999,
              },
              {
                id: "role-new",
                name: "New Role",
                discountEligible: true,
                count: 999,
              },
              {
                id: "ROLE A",
                name: "Role A",
                discountEligible: true,
                count: 999,
              },
              {
                id: "role a",
                name: "Duplicate Role A",
                discountEligible: true,
                count: 999,
              },
            ],
          },
        };

        await UpdateController.update(mockReq as Request, mockRes as Response);

        expect(mockProgram.set).toHaveBeenCalledWith({
          programRoles: {
            teacherRoleName: "Coach",
            studentRoles: [
              expect.objectContaining({ id: "role-b", count: 4 }),
              expect.objectContaining({ id: "role-new", count: 0 }),
              expect.objectContaining({ id: "role-a", count: 2 }),
              expect.objectContaining({ id: "role-a-2", count: 0 }),
            ],
          },
        });
        expect(mockProgram.classRepCount).toBe(4);
      });

      it("should reject castable discount flags that could clear an occupied role", async () => {
        mockProgram = createMockProgram({
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
            ],
          },
        });
        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        mockReq.body = {
          programRoles: {
            teacherRoleName: "Mentor",
            studentRoles: [
              {
                id: "role-a",
                name: "Role A",
                discountEligible: "true",
                count: 999,
              },
            ],
          },
        };

        await UpdateController.update(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message:
            "Student role at index 0 must use a boolean discountEligible value.",
        });
        expect(mockProgram.save).not.toHaveBeenCalled();
      });

      it.each([
        null,
        { teacherRoleName: "Coach", studentRoles: { id: "replacement" } },
        { teacherRoleName: "Coach", studentRoles: [] },
      ])("should reject a non-canonical programRoles shape", async (programRoles) => {
        mockReq.body = { programRoles };

        await UpdateController.update(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(mockProgram.save).not.toHaveBeenCalled();
      });

      it("should save the document so model validation hooks run", async () => {
        await UpdateController.update(mockReq as Request, mockRes as Response);

        expect(mockProgram.save).toHaveBeenCalledTimes(1);
      });

      it("should disconnect removed mentors after the update persists", async () => {
        const removedMentorId = new mongoose.Types.ObjectId();
        mockProgram = createMockProgram({
          mentors: [{ userId: removedMentorId }],
        });
        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        mockReq.body = { mentors: [] };

        await UpdateController.update(mockReq as Request, mockRes as Response);

        expect(socketService.disconnectUser).toHaveBeenCalledWith(
          removedMentorId.toString(),
        );
        expect(mockProgram.save.mock.invocationCallOrder[0]).toBeLessThan(
          vi.mocked(socketService.disconnectUser).mock.invocationCallOrder[0],
        );
      });
    });

    describe("error handling", () => {
      let mockProgram: ReturnType<typeof createMockProgram>;

      beforeEach(() => {
        mockProgram = createMockProgram();

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(RoleUtils.isAdmin).mockReturnValue(true);
      });

      it("should handle validation errors", async () => {
        const validationError = new Error("Validation failed");

        mockProgram.save.mockRejectedValue(validationError);

        await UpdateController.update(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Validation failed",
        });
      });

      it("should return 400 when a newly selected mentor is ineligible", async () => {
        mockReq.body = {
          mentors: [{ userId: new mongoose.Types.ObjectId().toString() }],
        };
        vi.mocked(
          UserAssignmentSnapshotService.resolveProgramMentors,
        ).mockRejectedValue(
          new AssignmentSnapshotError("Selected user is not eligible."),
        );

        await UpdateController.update(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Selected user is not eligible.",
        });
        expect(mockProgram.save).not.toHaveBeenCalled();
      });

      it("should handle database errors", async () => {
        mockProgram.save.mockRejectedValue(new Error("Database error"));

        await UpdateController.update(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Database error",
        });
      });

      it("should handle errors during permission check", async () => {
        vi.mocked(Program.findById).mockRejectedValue(
          new Error("Database error"),
        );

        await UpdateController.update(mockReq as Request, mockRes as Response);

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Database error",
        });
      });
    });
  });
});
