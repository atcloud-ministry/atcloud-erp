import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";
import AdminUnenrollController from "../../../../src/controllers/programs/AdminUnenrollController";
import { Program } from "../../../../src/models";
import AuditLog from "../../../../src/models/AuditLog";
import mongoose from "mongoose";

// Mock dependencies
vi.mock("../../../../src/models", () => ({
  Program: {
    findById: vi.fn(),
  },
}));

vi.mock("../../../../src/models/AuditLog");

vi.mock("../../../../src/services/infrastructure/SocketService", () => ({
  socketService: {
    disconnectUser: vi.fn(),
  },
}));
vi.mock(
  "../../../../src/services/programs/ProgramMembershipMutationSyncTrigger",
  () => ({
    programMembershipMutationSyncTrigger: {
      programAssignmentsChanged: vi.fn(),
    },
  }),
);

import { socketService } from "../../../../src/services/infrastructure/SocketService";
import { programMembershipMutationSyncTrigger } from "../../../../src/services/programs/ProgramMembershipMutationSyncTrigger";

describe("AdminUnenrollController", () => {
  let mockReq: any;
  let mockRes: Partial<Response>;
  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    mockReq = {
      params: {},
      body: {},
      ip: "127.0.0.1",
      get: vi.fn().mockReturnValue("test-agent"),
      correlationId: "admin-unenroll-1",
    };

    mockRes = {
      status: statusMock as any,
      json: jsonMock as any,
    };

    // Mock console methods
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  describe("adminUnenroll", () => {
    const userId = new mongoose.Types.ObjectId();
    const programId = new mongoose.Types.ObjectId();

    describe("authentication and authorization", () => {
      it("should return 401 if user not authenticated", async () => {
        mockReq.user = undefined;

        await AdminUnenrollController.adminUnenroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(401);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Authentication required.",
        });
      });

      it("should return 403 if user is Member", async () => {
        mockReq.user = {
          _id: userId,
          role: "Member",
          email: "member@test.com",
        } as any;
        mockReq.params = { id: programId.toString() };

        await AdminUnenrollController.adminUnenroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(403);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Only Super Admin and Administrator can unenroll.",
        });
      });

      it("should return 403 if user is Leader", async () => {
        mockReq.user = {
          _id: userId,
          role: "Leader",
          email: "leader@test.com",
        } as any;
        mockReq.params = { id: programId.toString() };

        await AdminUnenrollController.adminUnenroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(403);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Only Super Admin and Administrator can unenroll.",
        });
      });

      it("should allow Super Admin to unenroll", async () => {
        mockReq.user = {
          _id: userId,
          role: "Super Admin",
          email: "superadmin@test.com",
        } as any;
        mockReq.params = { id: programId.toString() };

        const mockProgram = {
          _id: programId,
          title: "Test Program",
          adminEnrollments: {
            mentees: [userId],
            classReps: [],
          },
          save: vi.fn().mockResolvedValue({}),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(AuditLog.create).mockResolvedValue({} as any);

        await AdminUnenrollController.adminUnenroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          message: "Successfully unenrolled from program.",
          data: mockProgram,
        });
        expect(socketService.disconnectUser).toHaveBeenCalledWith(
          userId.toString(),
        );
        expect(mockProgram.save.mock.invocationCallOrder[0]).toBeLessThan(
          vi.mocked(socketService.disconnectUser).mock.invocationCallOrder[0],
        );
        expect(
          programMembershipMutationSyncTrigger.programAssignmentsChanged,
        ).toHaveBeenCalledWith(programId.toString(), {
          actor: {
            type: "user",
            id: userId.toString(),
            role: "Super Admin",
          },
          source: "http",
          correlationId: "admin-unenroll-1",
        });
      });

      it("should allow Administrator to unenroll", async () => {
        mockReq.user = {
          _id: userId,
          role: "Administrator",
          email: "admin@test.com",
        } as any;
        mockReq.params = { id: programId.toString() };

        const mockProgram = {
          _id: programId,
          title: "Test Program",
          adminEnrollments: {
            mentees: [],
            classReps: [userId],
          },
          save: vi.fn().mockResolvedValue({}),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(AuditLog.create).mockResolvedValue({} as any);

        await AdminUnenrollController.adminUnenroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          message: "Successfully unenrolled from program.",
          data: mockProgram,
        });
      });
    });

    describe("validation", () => {
      beforeEach(() => {
        mockReq.user = {
          _id: userId,
          role: "Super Admin",
          email: "admin@test.com",
        } as any;
      });

      it("should return 400 for invalid program ID", async () => {
        mockReq.params = { id: "invalid-id" };

        await AdminUnenrollController.adminUnenroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Invalid program ID.",
        });
      });

      it("should return 404 if program not found", async () => {
        mockReq.params = { id: programId.toString() };

        vi.mocked(Program.findById).mockResolvedValue(null);

        await AdminUnenrollController.adminUnenroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(404);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Program not found.",
        });
      });

      it("should return 400 if adminEnrollments is missing", async () => {
        mockReq.params = { id: programId.toString() };

        const mockProgram = {
          _id: programId,
          title: "Test Program",
          adminEnrollments: undefined,
          save: vi.fn().mockResolvedValue({}),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);

        await AdminUnenrollController.adminUnenroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "You are not enrolled in this program.",
        });
      });

      it("should return 400 if user not enrolled in either list", async () => {
        mockReq.params = { id: programId.toString() };

        const otherUserId = new mongoose.Types.ObjectId();
        const mockProgram = {
          _id: programId,
          title: "Test Program",
          adminEnrollments: {
            mentees: [otherUserId],
            classReps: [],
          },
          save: vi.fn().mockResolvedValue({}),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);

        await AdminUnenrollController.adminUnenroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "You are not enrolled in this program.",
        });
      });
    });

    describe("unenrollment logic", () => {
      beforeEach(() => {
        mockReq.user = {
          _id: userId,
          role: "Super Admin",
          email: "admin@test.com",
        } as any;
        mockReq.params = { id: programId.toString() };
      });

      it("should unenroll admin from mentees list", async () => {
        const mockProgram = {
          _id: programId,
          title: "Test Program",
          adminEnrollments: {
            mentees: [userId],
            classReps: [],
          },
          save: vi.fn().mockResolvedValue({}),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(AuditLog.create).mockResolvedValue({} as any);

        await AdminUnenrollController.adminUnenroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(mockProgram.adminEnrollments.mentees).toHaveLength(0);
        expect(mockProgram.save).toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should unenroll admin from classReps list", async () => {
        const mockProgram = {
          _id: programId,
          title: "Test Program",
          adminEnrollments: {
            mentees: [],
            classReps: [userId],
          },
          save: vi.fn().mockResolvedValue({}),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(AuditLog.create).mockResolvedValue({} as any);

        await AdminUnenrollController.adminUnenroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(mockProgram.adminEnrollments.classReps).toHaveLength(0);
        expect(mockProgram.save).toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should remove only the specific user from mentees list", async () => {
        const otherUserId = new mongoose.Types.ObjectId();
        const mockProgram = {
          _id: programId,
          title: "Test Program",
          adminEnrollments: {
            mentees: [userId, otherUserId],
            classReps: [],
          },
          save: vi.fn().mockResolvedValue({}),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(AuditLog.create).mockResolvedValue({} as any);

        await AdminUnenrollController.adminUnenroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(mockProgram.adminEnrollments.mentees).toHaveLength(1);
        expect(
          (mockProgram.adminEnrollments.mentees[0] as any).toString()
        ).toBe(otherUserId.toString());
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should remove only the specific user from classReps list", async () => {
        const otherUserId = new mongoose.Types.ObjectId();
        const mockProgram = {
          _id: programId,
          title: "Test Program",
          adminEnrollments: {
            mentees: [],
            classReps: [otherUserId, userId],
          },
          save: vi.fn().mockResolvedValue({}),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(AuditLog.create).mockResolvedValue({} as any);

        await AdminUnenrollController.adminUnenroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(mockProgram.adminEnrollments.classReps).toHaveLength(1);
        expect(
          (mockProgram.adminEnrollments.classReps[0] as any).toString()
        ).toBe(otherUserId.toString());
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should handle empty mentees array gracefully", async () => {
        const mockProgram = {
          _id: programId,
          title: "Test Program",
          adminEnrollments: {
            mentees: [],
            classReps: [userId],
          },
          save: vi.fn().mockResolvedValue({}),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(AuditLog.create).mockResolvedValue({} as any);

        await AdminUnenrollController.adminUnenroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(mockProgram.adminEnrollments.classReps).toHaveLength(0);
        expect(statusMock).toHaveBeenCalledWith(200);
      });
    });

    describe("audit logging", () => {
      beforeEach(() => {
        mockReq.user = {
          _id: userId,
          role: "Super Admin",
          email: "admin@test.com",
        } as any;
        mockReq.params = { id: programId.toString() };
      });

      it("should create audit log on successful unenrollment from mentees", async () => {
        const mockProgram = {
          _id: programId,
          title: "Test Program",
          adminEnrollments: {
            mentees: [userId],
            classReps: [],
          },
          save: vi.fn().mockResolvedValue({}),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(AuditLog.create).mockResolvedValue({} as any);

        await AdminUnenrollController.adminUnenroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(AuditLog.create).toHaveBeenCalledWith({
          action: "program_admin_unenroll",
          actor: {
            id: userId,
            role: "Super Admin",
            email: "admin@test.com",
          },
          targetModel: "Program",
          targetId: programId.toString(),
          details: {
            programTitle: "Test Program",
            enrollmentType: "mentee",
          },
          ipAddress: "127.0.0.1",
          userAgent: "test-agent",
        });
      });

      it("should create audit log on successful unenrollment from classReps", async () => {
        const mockProgram = {
          _id: programId,
          title: "Test Program",
          adminEnrollments: {
            mentees: [],
            classReps: [userId],
          },
          save: vi.fn().mockResolvedValue({}),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(AuditLog.create).mockResolvedValue({} as any);

        await AdminUnenrollController.adminUnenroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(AuditLog.create).toHaveBeenCalledWith({
          action: "program_admin_unenroll",
          actor: {
            id: userId,
            role: "Super Admin",
            email: "admin@test.com",
          },
          targetModel: "Program",
          targetId: programId.toString(),
          details: {
            programTitle: "Test Program",
            enrollmentType: "classRep",
          },
          ipAddress: "127.0.0.1",
          userAgent: "test-agent",
        });
      });

      it("should continue if audit log creation fails", async () => {
        const mockProgram = {
          _id: programId,
          title: "Test Program",
          adminEnrollments: {
            mentees: [userId],
            classReps: [],
          },
          save: vi.fn().mockResolvedValue({}),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(AuditLog.create).mockRejectedValue(
          new Error("Audit log failed")
        );

        await AdminUnenrollController.adminUnenroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          message: "Successfully unenrolled from program.",
          data: mockProgram,
        });
      });
    });

    describe("error handling", () => {
      beforeEach(() => {
        mockReq.user = {
          _id: userId,
          role: "Super Admin",
          email: "admin@test.com",
        } as any;
        mockReq.params = { id: programId.toString() };
      });

      it("should handle database errors", async () => {
        vi.mocked(Program.findById).mockRejectedValue(
          new Error("Database error")
        );

        await AdminUnenrollController.adminUnenroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Failed to unenroll admin.",
        });
      });

      it("should handle save errors", async () => {
        const mockProgram = {
          _id: programId,
          title: "Test Program",
          adminEnrollments: {
            mentees: [userId],
            classReps: [],
          },
          save: vi.fn().mockRejectedValue(new Error("Save failed")),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);

        await AdminUnenrollController.adminUnenroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Failed to unenroll admin.",
        });
      });
    });
  });
});
