import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Request, Response } from "express";
import CreationController from "../../../../src/controllers/programs/CreationController";
import { Program } from "../../../../src/models";
import { RoleUtils } from "../../../../src/utils/roleUtils";

// Mock dependencies
vi.mock("../../../../src/models");
vi.mock("../../../../src/utils/roleUtils");
vi.mock("../../../../src/services/UserAssignmentSnapshotService", () => {
  class AssignmentSnapshotError extends Error {}
  return {
    AssignmentSnapshotError,
    UserAssignmentSnapshotService: {
      resolveProgramMentors: vi.fn(),
    },
  };
});

import {
  AssignmentSnapshotError,
  UserAssignmentSnapshotService,
} from "../../../../src/services/UserAssignmentSnapshotService";

describe("CreationController", () => {
  let mockReq: any;
  let mockRes: Partial<Response>;
  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    mockRes = {
      status: statusMock as any,
      json: jsonMock as any,
    };

    mockReq = {
      body: {},
      user: undefined,
    };
    vi.mocked(
      UserAssignmentSnapshotService.resolveProgramMentors,
    ).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("create", () => {
    describe("authentication and authorization", () => {
      it("should return 401 if user is not authenticated", async () => {
        mockReq.user = undefined;

        await CreationController.create(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(401);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Authentication required.",
        });
      });

      it("should return 403 if user is not a Leader or higher", async () => {
        mockReq.user = {
          _id: "user123",
          role: "Participant",
          email: "user@test.com",
        } as any;

        vi.mocked(RoleUtils.isLeaderOrHigher).mockReturnValue(false);

        await CreationController.create(
          mockReq as Request,
          mockRes as Response,
        );

        expect(RoleUtils.isLeaderOrHigher).toHaveBeenCalledWith("Participant");
        expect(statusMock).toHaveBeenCalledWith(403);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Only Leaders and above can create programs.",
        });
      });

      it("should allow Super Admin to create program", async () => {
        mockReq.user = {
          _id: "admin123",
          role: "Super Admin",
          email: "admin@test.com",
        } as any;
        mockReq.body = { title: "Test Program" };

        vi.mocked(RoleUtils.isLeaderOrHigher).mockReturnValue(true);
        vi.mocked(Program.create).mockResolvedValue({
          _id: "program123",
          title: "Test Program",
          createdBy: "admin123",
        } as any);

        await CreationController.create(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(201);
      });

      it("should allow Administrator to create program", async () => {
        mockReq.user = {
          _id: "admin123",
          role: "Administrator",
          email: "admin@test.com",
        } as any;
        mockReq.body = { title: "Test Program" };

        vi.mocked(RoleUtils.isLeaderOrHigher).mockReturnValue(true);
        vi.mocked(Program.create).mockResolvedValue({
          _id: "program123",
          title: "Test Program",
          createdBy: "admin123",
        } as any);

        await CreationController.create(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(201);
      });

      it("should allow Leader to create program", async () => {
        mockReq.user = {
          _id: "leader123",
          role: "Leader",
          email: "leader@test.com",
        } as any;
        mockReq.body = { title: "Test Program" };

        vi.mocked(RoleUtils.isLeaderOrHigher).mockReturnValue(true);
        vi.mocked(Program.create).mockResolvedValue({
          _id: "program123",
          title: "Test Program",
          createdBy: "leader123",
        } as any);

        await CreationController.create(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(201);
      });
    });

    describe("program creation", () => {
      beforeEach(() => {
        mockReq.user = {
          _id: "admin123",
          role: "Administrator",
          email: "admin@test.com",
        } as any;

        vi.mocked(RoleUtils.isLeaderOrHigher).mockReturnValue(true);
      });

      it("should create program with minimal data", async () => {
        mockReq.body = { title: "Minimal Program" };

        vi.mocked(Program.create).mockResolvedValue({
          _id: "program123",
          title: "Minimal Program",
          createdBy: "admin123",
        } as any);

        await CreationController.create(
          mockReq as Request,
          mockRes as Response,
        );

        expect(Program.create).toHaveBeenCalledWith({
          title: "Minimal Program",
          classRepCount: 0,
          createdBy: "admin123",
        });
        expect(statusMock).toHaveBeenCalledWith(201);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          data: {
            _id: "program123",
            title: "Minimal Program",
            createdBy: "admin123",
          },
        });
      });

      it("should create program with full data", async () => {
        mockReq.body = {
          title: "Full Program",
          programType: "EMBA Mentor Circles",
          introduction: "A comprehensive mentorship program",
          period: {
            startYear: "2025",
            startMonth: "02",
            endYear: "2025",
            endMonth: "06",
          },
          classRepLimit: 5,
        };

        const createdProgram = {
          _id: "program123",
          title: "Full Program",
          programType: "EMBA Mentor Circles",
          introduction: "A comprehensive mentorship program",
          period: {
            startYear: "2025",
            startMonth: "02",
            endYear: "2025",
            endMonth: "06",
          },
          classRepLimit: 5,
          createdBy: "admin123",
        };

        vi.mocked(Program.create).mockResolvedValue(createdProgram as any);

        await CreationController.create(
          mockReq as Request,
          mockRes as Response,
        );

        expect(Program.create).toHaveBeenCalledWith({
          title: "Full Program",
          programType: "EMBA Mentor Circles",
          introduction: "A comprehensive mentorship program",
          period: {
            startYear: "2025",
            startMonth: "02",
            endYear: "2025",
            endMonth: "06",
          },
          classRepLimit: 5,
          classRepCount: 0,
          createdBy: "admin123",
        });
        expect(statusMock).toHaveBeenCalledWith(201);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          data: createdProgram,
        });
      });

      it("should add createdBy field automatically", async () => {
        mockReq.body = { title: "Test Program" };

        vi.mocked(Program.create).mockResolvedValue({
          _id: "program123",
          title: "Test Program",
          createdBy: "admin123",
        } as any);

        await CreationController.create(
          mockReq as Request,
          mockRes as Response,
        );

        expect(Program.create).toHaveBeenCalledWith(
          expect.objectContaining({
            createdBy: "admin123",
          }),
        );
      });

      it("should handle empty body gracefully", async () => {
        mockReq.body = undefined;

        vi.mocked(Program.create).mockResolvedValue({
          _id: "program123",
          createdBy: "admin123",
        } as any);

        await CreationController.create(
          mockReq as Request,
          mockRes as Response,
        );

        expect(Program.create).toHaveBeenCalledWith({
          classRepCount: 0,
          createdBy: "admin123",
        });
      });

      it("should select mutable fields and initialize nested counts", async () => {
        mockReq.body = {
          title: "Custom Program",
          programType: "Webinar",
          introduction: "Description",
          customField: "customValue",
          createdBy: "attacker",
          events: ["event123"],
          adminEnrollments: { classReps: ["user123"] },
          classRepCount: 99,
          programRoles: {
            teacherRoleName: "Coach",
            studentRoles: [
              {
                id: "ROLE A",
                name: "Role A",
                discountEligible: true,
                discountAmount: 100,
                limit: 5,
                count: 99,
              },
            ],
          },
        };

        vi.mocked(Program.create).mockResolvedValue({
          _id: "program123",
          ...mockReq.body,
          createdBy: "admin123",
        } as any);

        await CreationController.create(
          mockReq as Request,
          mockRes as Response,
        );

        expect(Program.create).toHaveBeenCalledWith({
          title: "Custom Program",
          programType: "Webinar",
          introduction: "Description",
          programRoles: {
            teacherRoleName: "Coach",
            studentRoles: [
              expect.objectContaining({ id: "role-a", count: 0 }),
            ],
          },
          classRepCount: 0,
          createdBy: "admin123",
        });
      });

      it("should reject a non-array studentRoles payload", async () => {
        mockReq.body = {
          title: "Invalid Roles",
          programRoles: {
            teacherRoleName: "Coach",
            studentRoles: { id: "replacement" },
          },
        };

        await CreationController.create(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(Program.create).not.toHaveBeenCalled();
      });
    });

    describe("error handling", () => {
      beforeEach(() => {
        mockReq.user = {
          _id: "admin123",
          role: "Administrator",
          email: "admin@test.com",
        } as any;

        vi.mocked(RoleUtils.isLeaderOrHigher).mockReturnValue(true);
      });

      it("should return 400 on validation error", async () => {
        mockReq.body = { title: "Test Program" };

        const validationError = new Error("Title is required");
        vi.mocked(Program.create).mockRejectedValue(validationError);

        await CreationController.create(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Title is required",
        });
      });

      it("should return 400 when a selected mentor is ineligible", async () => {
        mockReq.body = {
          title: "Test Program",
          mentors: [{ userId: "507f191e810c19729de860ea" }],
        };
        vi.mocked(
          UserAssignmentSnapshotService.resolveProgramMentors,
        ).mockRejectedValue(
          new AssignmentSnapshotError("Selected user is not eligible."),
        );

        await CreationController.create(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Selected user is not eligible.",
        });
        expect(Program.create).not.toHaveBeenCalled();
      });

      it("should return 400 on duplicate key error", async () => {
        mockReq.body = { title: "Duplicate Program" };

        const duplicateError = new Error("E11000 duplicate key error");
        vi.mocked(Program.create).mockRejectedValue(duplicateError);

        await CreationController.create(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "E11000 duplicate key error",
        });
      });

      it("should return 400 on schema validation error", async () => {
        mockReq.body = { title: "Test", invalidField: "value" };

        const schemaError = new Error("Path `invalidField` is not in schema");
        vi.mocked(Program.create).mockRejectedValue(schemaError);

        await CreationController.create(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Path `invalidField` is not in schema",
        });
      });

      it("should handle database connection errors", async () => {
        mockReq.body = { title: "Test Program" };

        const dbError = new Error("MongoError: connection lost");
        vi.mocked(Program.create).mockRejectedValue(dbError);

        await CreationController.create(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "MongoError: connection lost",
        });
      });
    });

    describe("edge cases", () => {
      beforeEach(() => {
        mockReq.user = {
          _id: "admin123",
          role: "Administrator",
          email: "admin@test.com",
        } as any;

        vi.mocked(RoleUtils.isLeaderOrHigher).mockReturnValue(true);
      });

      it("should handle null body", async () => {
        mockReq.body = null;

        vi.mocked(Program.create).mockResolvedValue({
          _id: "program123",
          createdBy: "admin123",
        } as any);

        await CreationController.create(
          mockReq as Request,
          mockRes as Response,
        );

        expect(Program.create).toHaveBeenCalledWith({
          classRepCount: 0,
          createdBy: "admin123",
        });
      });

      it("should handle special characters in title", async () => {
        mockReq.body = {
          title: "Test & Program <script>alert('xss')</script>",
        };

        vi.mocked(Program.create).mockResolvedValue({
          _id: "program123",
          title: "Test & Program <script>alert('xss')</script>",
          createdBy: "admin123",
        } as any);

        await CreationController.create(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(201);
      });

      it("should handle very long description", async () => {
        const longDescription = "a".repeat(10000);
        mockReq.body = { title: "Test", description: longDescription };

        vi.mocked(Program.create).mockResolvedValue({
          _id: "program123",
          title: "Test",
          description: longDescription,
          createdBy: "admin123",
        } as any);

        await CreationController.create(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(201);
      });

      it("should handle missing user._id", async () => {
        mockReq.user = {
          role: "Administrator",
          email: "admin@test.com",
        } as any;

        mockReq.body = { title: "Test Program" };

        vi.mocked(Program.create).mockResolvedValue({
          _id: "program123",
          title: "Test Program",
          createdBy: undefined,
        } as any);

        await CreationController.create(
          mockReq as Request,
          mockRes as Response,
        );

        expect(Program.create).toHaveBeenCalledWith(
          expect.objectContaining({
            createdBy: undefined,
          }),
        );
      });
    });
  });
});
