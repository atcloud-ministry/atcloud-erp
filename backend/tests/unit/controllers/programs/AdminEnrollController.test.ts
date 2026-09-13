import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";
import AdminEnrollController from "../../../../src/controllers/programs/AdminEnrollController";
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
vi.mock(
  "../../../../src/services/programs/ProgramMembershipMutationSyncTrigger",
  () => ({
    programMembershipMutationSyncTrigger: {
      programAssignmentsChanged: vi.fn(),
    },
  }),
);

import { programMembershipMutationSyncTrigger } from "../../../../src/services/programs/ProgramMembershipMutationSyncTrigger";

describe("AdminEnrollController", () => {
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
      correlationId: "admin-enroll-1",
    };

    mockRes = {
      status: statusMock as any,
      json: jsonMock as any,
    };

    // Mock console methods
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  describe("adminEnroll", () => {
    const userId = new mongoose.Types.ObjectId();
    const programId = new mongoose.Types.ObjectId();

    describe("authentication and authorization", () => {
      it("should return 401 if user not authenticated", async () => {
        mockReq.user = undefined;

        await AdminEnrollController.adminEnroll(
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
        mockReq.body = { enrollAs: "mentee" };

        await AdminEnrollController.adminEnroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(403);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Only Super Admin and Administrator can enroll for free.",
        });
      });

      it("should return 403 if user is Leader", async () => {
        mockReq.user = {
          _id: userId,
          role: "Leader",
          email: "leader@test.com",
        } as any;
        mockReq.params = { id: programId.toString() };
        mockReq.body = { enrollAs: "mentee" };

        await AdminEnrollController.adminEnroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(403);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Only Super Admin and Administrator can enroll for free.",
        });
      });

      it("should allow Super Admin to enroll", async () => {
        mockReq.user = {
          _id: userId,
          role: "Super Admin",
          email: "superadmin@test.com",
        } as any;
        mockReq.params = { id: programId.toString() };
        mockReq.body = { enrollAs: "mentee" };

        const mockProgram = {
          _id: programId,
          title: "Test Program",
          adminEnrollments: {
            mentees: [],
            classReps: [],
          },
          save: vi.fn().mockResolvedValue({}),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(AuditLog.create).mockResolvedValue({} as any);

        await AdminEnrollController.adminEnroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          message: "Successfully enrolled as mentee.",
          data: mockProgram,
        });
        expect(
          programMembershipMutationSyncTrigger.programAssignmentsChanged,
        ).toHaveBeenCalledWith(programId.toString(), {
          actor: {
            type: "user",
            id: userId.toString(),
            role: "Super Admin",
          },
          source: "http",
          correlationId: "admin-enroll-1",
        });
      });

      it("should allow Administrator to enroll", async () => {
        mockReq.user = {
          _id: userId,
          role: "Administrator",
          email: "admin@test.com",
        } as any;
        mockReq.params = { id: programId.toString() };
        mockReq.body = { enrollAs: "classRep" };

        const mockProgram = {
          _id: programId,
          title: "Test Program",
          adminEnrollments: {
            mentees: [],
            classReps: [],
          },
          save: vi.fn().mockResolvedValue({}),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(AuditLog.create).mockResolvedValue({} as any);

        await AdminEnrollController.adminEnroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          message: "Successfully enrolled as classRep.",
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
        mockReq.body = { enrollAs: "mentee" };

        await AdminEnrollController.adminEnroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Invalid program ID.",
        });
      });

      it("should return 400 if enrollAs is missing", async () => {
        mockReq.params = { id: programId.toString() };
        mockReq.body = {};

        await AdminEnrollController.adminEnroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "enrollAs must be 'mentee' or 'classRep'.",
        });
      });

      it("should return 400 if enrollAs is invalid", async () => {
        mockReq.params = { id: programId.toString() };
        mockReq.body = { enrollAs: "invalid" };

        await AdminEnrollController.adminEnroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "enrollAs must be 'mentee' or 'classRep'.",
        });
      });

      it("should return 404 if program not found", async () => {
        mockReq.params = { id: programId.toString() };
        mockReq.body = { enrollAs: "mentee" };

        vi.mocked(Program.findById).mockResolvedValue(null);

        await AdminEnrollController.adminEnroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(404);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Program not found.",
        });
      });
    });

    describe("enrollment logic", () => {
      beforeEach(() => {
        mockReq.user = {
          _id: userId,
          role: "Super Admin",
          email: "admin@test.com",
        } as any;
        mockReq.params = { id: programId.toString() };
      });

      it("should enroll admin as mentee", async () => {
        mockReq.body = { enrollAs: "mentee" };

        const mockProgram = {
          _id: programId,
          title: "Test Program",
          adminEnrollments: {
            mentees: [],
            classReps: [],
          },
          save: vi.fn().mockResolvedValue({}),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(AuditLog.create).mockResolvedValue({} as any);

        await AdminEnrollController.adminEnroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(mockProgram.adminEnrollments.mentees).toHaveLength(1);
        expect(
          (mockProgram.adminEnrollments.mentees[0] as any).toString()
        ).toBe(userId.toString());
        expect(mockProgram.save).toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should enroll admin as classRep", async () => {
        mockReq.body = { enrollAs: "classRep" };

        const mockProgram = {
          _id: programId,
          title: "Test Program",
          adminEnrollments: {
            mentees: [],
            classReps: [],
          },
          save: vi.fn().mockResolvedValue({}),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(AuditLog.create).mockResolvedValue({} as any);

        await AdminEnrollController.adminEnroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(mockProgram.adminEnrollments.classReps).toHaveLength(1);
        expect(
          (mockProgram.adminEnrollments.classReps[0] as any).toString()
        ).toBe(userId.toString());
        expect(mockProgram.save).toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should initialize adminEnrollments if missing", async () => {
        mockReq.body = { enrollAs: "mentee" };

        const mockProgram = {
          _id: programId,
          title: "Test Program",
          adminEnrollments: undefined,
          save: vi.fn().mockResolvedValue({}),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(AuditLog.create).mockResolvedValue({} as any);

        await AdminEnrollController.adminEnroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(mockProgram.adminEnrollments).toBeDefined();
        expect((mockProgram.adminEnrollments as any).mentees).toHaveLength(1);
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should initialize mentees array if missing", async () => {
        mockReq.body = { enrollAs: "mentee" };

        const mockProgram = {
          _id: programId,
          title: "Test Program",
          adminEnrollments: {
            mentees: undefined,
            classReps: [],
          },
          save: vi.fn().mockResolvedValue({}),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(AuditLog.create).mockResolvedValue({} as any);

        await AdminEnrollController.adminEnroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(mockProgram.adminEnrollments.mentees).toBeDefined();
        expect(mockProgram.adminEnrollments.mentees).toHaveLength(1);
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should initialize classReps array if missing", async () => {
        mockReq.body = { enrollAs: "classRep" };

        const mockProgram = {
          _id: programId,
          title: "Test Program",
          adminEnrollments: {
            mentees: [],
            classReps: undefined,
          },
          save: vi.fn().mockResolvedValue({}),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(AuditLog.create).mockResolvedValue({} as any);

        await AdminEnrollController.adminEnroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(mockProgram.adminEnrollments.classReps).toBeDefined();
        expect(mockProgram.adminEnrollments.classReps).toHaveLength(1);
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should return 400 if already enrolled as mentee", async () => {
        mockReq.body = { enrollAs: "classRep" };

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

        await AdminEnrollController.adminEnroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message:
            "You are already enrolled. Please unenroll first before enrolling as a different type.",
        });
      });

      it("should return 400 if already enrolled as classRep", async () => {
        mockReq.body = { enrollAs: "mentee" };

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

        await AdminEnrollController.adminEnroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message:
            "You are already enrolled. Please unenroll first before enrolling as a different type.",
        });
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
        mockReq.body = { enrollAs: "mentee" };
      });

      it("should create audit log on successful enrollment", async () => {
        const mockProgram = {
          _id: programId,
          title: "Test Program",
          adminEnrollments: {
            mentees: [],
            classReps: [],
          },
          save: vi.fn().mockResolvedValue({}),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(AuditLog.create).mockResolvedValue({} as any);

        await AdminEnrollController.adminEnroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(AuditLog.create).toHaveBeenCalledWith({
          action: "program_admin_enroll",
          actor: {
            id: userId,
            role: "Super Admin",
            email: "admin@test.com",
          },
          targetModel: "Program",
          targetId: programId.toString(),
          details: {
            programTitle: "Test Program",
            enrollAs: "mentee",
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
            mentees: [],
            classReps: [],
          },
          save: vi.fn().mockResolvedValue({}),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(AuditLog.create).mockRejectedValue(
          new Error("Audit log failed")
        );

        await AdminEnrollController.adminEnroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          message: "Successfully enrolled as mentee.",
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
        mockReq.body = { enrollAs: "mentee" };
      });

      it("should handle database errors", async () => {
        vi.mocked(Program.findById).mockRejectedValue(
          new Error("Database error")
        );

        await AdminEnrollController.adminEnroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Failed to enroll admin.",
        });
      });

      it("should handle save errors", async () => {
        const mockProgram = {
          _id: programId,
          title: "Test Program",
          adminEnrollments: {
            mentees: [],
            classReps: [],
          },
          save: vi.fn().mockRejectedValue(new Error("Save failed")),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);

        await AdminEnrollController.adminEnroll(
          mockReq as Request,
          mockRes as Response
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Failed to enroll admin.",
        });
      });
    });
  });
});
