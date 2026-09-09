import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Request, Response } from "express";
import mongoose from "mongoose";
import DeletionController from "../../../../src/controllers/programs/DeletionController";
import { Event, Program } from "../../../../src/models";
import AuditLog from "../../../../src/models/AuditLog";
import { EventCascadeService } from "../../../../src/services/EventCascadeService";
import { RoleUtils } from "../../../../src/utils/roleUtils";
import { resourceAuthorizationInvalidationService } from "../../../../src/services/authorization/ResourceAuthorizationInvalidationService";

// Mock dependencies
vi.mock("../../../../src/models");
vi.mock("../../../../src/models/AuditLog");
vi.mock("../../../../src/services/EventCascadeService");
vi.mock("../../../../src/utils/roleUtils");
vi.mock(
  "../../../../src/services/authorization/ResourceAuthorizationInvalidationService",
  () => ({
    resourceAuthorizationInvalidationService: {
      findEventIdsForPrograms: vi.fn().mockResolvedValue([]),
      invalidateEventRooms: vi.fn(),
    },
  }),
);

interface MockRequest extends Partial<Request> {
  user?: {
    _id: string;
    role: string;
    email: string;
  };
}

describe("DeletionController", () => {
  let mockReq: MockRequest;
  let mockRes: Partial<Response>;
  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;
  let testProgramId: string;
  let isValidSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    testProgramId = new mongoose.Types.ObjectId().toString();

    // Spy on mongoose.Types.ObjectId.isValid
    isValidSpy = vi.spyOn(mongoose.Types.ObjectId, "isValid");

    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    mockRes = {
      status: statusMock as any,
      json: jsonMock as any,
    };

    mockReq = {
      params: { id: testProgramId },
      query: {},
      user: undefined,
      ip: "127.0.0.1",
      get: vi.fn().mockReturnValue("test-agent"),
    };
  });

  afterEach(() => {
    isValidSpy.mockRestore();
    vi.restoreAllMocks();
  });

  describe("remove", () => {
    describe("authentication and authorization", () => {
      it("should return 401 if user is not authenticated", async () => {
        mockReq.user = undefined;

        await DeletionController.remove(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(401);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Authentication required.",
        });
      });

      it("should return 403 if user is not an admin and not the creator", async () => {
        mockReq.user = {
          _id: "user123",
          role: "Leader",
          email: "user@test.com",
        };

        isValidSpy.mockReturnValue(true);
        vi.mocked(RoleUtils.isAdmin).mockReturnValue(false);
        vi.mocked(Program.findById).mockReturnValue({
          lean: vi.fn().mockResolvedValue({
            _id: testProgramId,
            title: "Test Program",
            programType: "Mentorship",
            createdBy: "differentUser456", // Not the current user
          }),
        } as any);

        await DeletionController.remove(
          mockReq as Request,
          mockRes as Response,
        );

        expect(RoleUtils.isAdmin).toHaveBeenCalledWith("Leader");
        expect(statusMock).toHaveBeenCalledWith(403);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message:
            "You do not have permission to delete this program. Only Administrators or the program creator can delete programs.",
        });
      });

      it("should allow Leader to delete their own program", async () => {
        mockReq.user = {
          _id: "leader123",
          role: "Leader",
          email: "leader@test.com",
        };

        isValidSpy.mockReturnValue(true);
        vi.mocked(RoleUtils.isAdmin).mockReturnValue(false);
        vi.mocked(Program.findById).mockReturnValue({
          lean: vi.fn().mockResolvedValue({
            _id: testProgramId,
            title: "Test Program",
            programType: "Mentorship",
            createdBy: "leader123", // Same as current user
          }),
        } as any);
        vi.mocked(Event.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Program.findByIdAndDelete).mockResolvedValue({} as any);
        vi.mocked(AuditLog.create).mockResolvedValue({} as any);

        await DeletionController.remove(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should allow Super Admin to delete program", async () => {
        mockReq.user = {
          _id: "admin123",
          role: "Super Admin",
          email: "admin@test.com",
        };

        vi.mocked(RoleUtils.isAdmin).mockReturnValue(true);
        isValidSpy.mockReturnValue(true);
        vi.mocked(Program.findById).mockReturnValue({
          lean: vi.fn().mockResolvedValue({
            _id: testProgramId,
            title: "Test Program",
            programType: "Mentorship",
          }),
        } as any);
        vi.mocked(Event.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Program.findByIdAndDelete).mockResolvedValue({} as any);
        vi.mocked(AuditLog.create).mockResolvedValue({} as any);

        await DeletionController.remove(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should allow Administrator to delete program", async () => {
        mockReq.user = {
          _id: "admin123",
          role: "Administrator",
          email: "admin@test.com",
        };

        vi.mocked(RoleUtils.isAdmin).mockReturnValue(true);
        isValidSpy.mockReturnValue(true);
        vi.mocked(Program.findById).mockReturnValue({
          lean: vi.fn().mockResolvedValue({
            _id: testProgramId,
            title: "Test Program",
            programType: "Mentorship",
          }),
        } as any);
        vi.mocked(Event.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Program.findByIdAndDelete).mockResolvedValue({} as any);
        vi.mocked(AuditLog.create).mockResolvedValue({} as any);

        await DeletionController.remove(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
      });
    });

    describe("validation", () => {
      beforeEach(() => {
        mockReq.user = {
          _id: "admin123",
          role: "Administrator",
          email: "admin@test.com",
        };
        vi.mocked(RoleUtils.isAdmin).mockReturnValue(true);
      });

      it("should return 400 for invalid program ID", async () => {
        mockReq.params = { id: "invalid-id" };
        isValidSpy.mockReturnValue(false);

        await DeletionController.remove(
          mockReq as Request,
          mockRes as Response,
        );

        expect(mongoose.Types.ObjectId.isValid).toHaveBeenCalledWith(
          "invalid-id",
        );
        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Invalid program ID.",
        });
      });

      it("should return 404 if program does not exist", async () => {
        isValidSpy.mockReturnValue(true);
        vi.mocked(Program.findById).mockReturnValue({
          lean: vi.fn().mockResolvedValue(null),
        } as any);

        await DeletionController.remove(
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

    describe("unlink mode (deleteLinkedEvents=false)", () => {
      beforeEach(() => {
        mockReq.user = {
          _id: "admin123",
          role: "Administrator",
          email: "admin@test.com",
        };
        mockReq.query = { deleteLinkedEvents: "false" };

        vi.mocked(RoleUtils.isAdmin).mockReturnValue(true);
        isValidSpy.mockReturnValue(true);
        vi.mocked(Program.findById).mockReturnValue({
          lean: vi.fn().mockResolvedValue({
            _id: testProgramId,
            title: "Test Program",
            programType: "Mentorship",
          }),
        } as any);
        vi.mocked(AuditLog.create).mockResolvedValue({} as any);
      });

      it("should unlink events without deleting them", async () => {
        vi.mocked(
          resourceAuthorizationInvalidationService.findEventIdsForPrograms,
        ).mockResolvedValue([
          "507f1f77bcf86cd799439012",
          "507f1f77bcf86cd799439013",
        ]);
        vi.mocked(Event.updateMany).mockResolvedValue({
          modifiedCount: 3,
        } as any);
        vi.mocked(Program.findByIdAndDelete).mockResolvedValue({} as any);

        await DeletionController.remove(
          mockReq as Request,
          mockRes as Response,
        );

        expect(Event.updateMany).toHaveBeenCalledWith(
          { programLabels: testProgramId },
          { $pull: { programLabels: testProgramId } },
        );
        expect(
          resourceAuthorizationInvalidationService.findEventIdsForPrograms,
        ).toHaveBeenCalledWith([testProgramId]);
        expect(
          resourceAuthorizationInvalidationService.invalidateEventRooms,
        ).toHaveBeenCalledWith([
          "507f1f77bcf86cd799439012",
          "507f1f77bcf86cd799439013",
        ]);
        expect(
          vi.mocked(Event.updateMany).mock.invocationCallOrder[0],
        ).toBeLessThan(
          vi.mocked(
            resourceAuthorizationInvalidationService.invalidateEventRooms,
          ).mock.invocationCallOrder[0],
        );
        expect(Program.findByIdAndDelete).toHaveBeenCalledWith(testProgramId);
        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          message: "Program deleted. Unlinked 3 related events.",
          unlinkedEvents: 3,
        });
      });

      it("should handle zero unlinked events", async () => {
        vi.mocked(Event.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Program.findByIdAndDelete).mockResolvedValue({} as any);

        await DeletionController.remove(
          mockReq as Request,
          mockRes as Response,
        );

        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          message: "Program deleted. Unlinked 0 related events.",
          unlinkedEvents: 0,
        });
      });

      it("should handle undefined modifiedCount", async () => {
        vi.mocked(Event.updateMany).mockResolvedValue({
          modifiedCount: undefined,
        } as any);
        vi.mocked(Program.findByIdAndDelete).mockResolvedValue({} as any);

        await DeletionController.remove(
          mockReq as Request,
          mockRes as Response,
        );

        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          message: "Program deleted. Unlinked 0 related events.",
          unlinkedEvents: 0,
        });
      });

      it("should default to unlink mode when deleteLinkedEvents is omitted", async () => {
        mockReq.query = {};

        vi.mocked(Event.updateMany).mockResolvedValue({
          modifiedCount: 2,
        } as any);
        vi.mocked(Program.findByIdAndDelete).mockResolvedValue({} as any);

        await DeletionController.remove(
          mockReq as Request,
          mockRes as Response,
        );

        expect(Event.updateMany).toHaveBeenCalled();
        expect(EventCascadeService.deleteEventFully).not.toHaveBeenCalled();
      });

      it("should create audit log in unlink mode", async () => {
        vi.mocked(Event.updateMany).mockResolvedValue({
          modifiedCount: 5,
        } as any);
        vi.mocked(Program.findByIdAndDelete).mockResolvedValue({} as any);

        await DeletionController.remove(
          mockReq as Request,
          mockRes as Response,
        );

        expect(AuditLog.create).toHaveBeenCalledWith({
          action: "program_deletion",
          actor: {
            id: "admin123",
            role: "Administrator",
            email: "admin@test.com",
          },
          targetModel: "Program",
          targetId: testProgramId,
          details: {
            targetProgram: {
              id: testProgramId,
              title: "Test Program",
              programType: "Mentorship",
            },
            cascadeMode: "unlink",
            unlinkedEvents: 5,
          },
          ipAddress: "127.0.0.1",
          userAgent: "test-agent",
        });
      });

      it("should continue if audit log creation fails", async () => {
        vi.mocked(Event.updateMany).mockResolvedValue({
          modifiedCount: 2,
        } as any);
        vi.mocked(Program.findByIdAndDelete).mockResolvedValue({} as any);
        vi.mocked(AuditLog.create).mockRejectedValue(new Error("Audit error"));

        const consoleErrorSpy = vi
          .spyOn(console, "error")
          .mockImplementation(() => {});

        await DeletionController.remove(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          "Failed to create audit log for program deletion:",
          expect.any(Error),
        );

        consoleErrorSpy.mockRestore();
      });
    });

    describe("cascade mode (deleteLinkedEvents=true)", () => {
      beforeEach(() => {
        mockReq.user = {
          _id: "admin123",
          role: "Administrator",
          email: "admin@test.com",
        };
        mockReq.query = { deleteLinkedEvents: "true" };

        vi.mocked(RoleUtils.isAdmin).mockReturnValue(true);
        isValidSpy.mockReturnValue(true);
        vi.mocked(Program.findById).mockReturnValue({
          lean: vi.fn().mockResolvedValue({
            _id: testProgramId,
            title: "Test Program",
            programType: "Mentorship",
          }),
        } as any);
        vi.mocked(AuditLog.create).mockResolvedValue({} as any);
      });

      it("should cascade delete all linked events", async () => {
        const eventIds = [
          new mongoose.Types.ObjectId(),
          new mongoose.Types.ObjectId(),
          new mongoose.Types.ObjectId(),
        ];

        vi.mocked(Event.find).mockReturnValue({
          select: vi
            .fn()
            .mockResolvedValue(eventIds.map((id) => ({ _id: id }))),
        } as any);

        vi.mocked(EventCascadeService.deleteEventFully).mockResolvedValue({
          deletedRegistrations: 5,
          deletedGuestRegistrations: 3,
        });

        vi.mocked(Program.findByIdAndDelete).mockResolvedValue({} as any);

        await DeletionController.remove(
          mockReq as Request,
          mockRes as Response,
        );

        expect(Event.find).toHaveBeenCalledWith({
          programLabels: testProgramId,
        });
        expect(EventCascadeService.deleteEventFully).toHaveBeenCalledTimes(3);
        expect(Program.findByIdAndDelete).toHaveBeenCalledWith(testProgramId);

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          message: "Program and 3 events deleted with cascades.",
          deletedEvents: 3,
          deletedRegistrations: 15, // 5 * 3
          deletedGuestRegistrations: 9, // 3 * 3
        });
      });

      it("should handle program with no linked events", async () => {
        vi.mocked(Event.find).mockReturnValue({
          select: vi.fn().mockResolvedValue([]),
        } as any);

        vi.mocked(Program.findByIdAndDelete).mockResolvedValue({} as any);

        await DeletionController.remove(
          mockReq as Request,
          mockRes as Response,
        );

        expect(EventCascadeService.deleteEventFully).not.toHaveBeenCalled();
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          message: "Program and 0 events deleted with cascades.",
          deletedEvents: 0,
          deletedRegistrations: 0,
          deletedGuestRegistrations: 0,
        });
      });

      it("should sum up deletion counts from multiple events", async () => {
        const eventIds = [
          new mongoose.Types.ObjectId(),
          new mongoose.Types.ObjectId(),
        ];

        vi.mocked(Event.find).mockReturnValue({
          select: vi
            .fn()
            .mockResolvedValue(eventIds.map((id) => ({ _id: id }))),
        } as any);

        vi.mocked(EventCascadeService.deleteEventFully)
          .mockResolvedValueOnce({
            deletedRegistrations: 10,
            deletedGuestRegistrations: 5,
          })
          .mockResolvedValueOnce({
            deletedRegistrations: 8,
            deletedGuestRegistrations: 3,
          });

        vi.mocked(Program.findByIdAndDelete).mockResolvedValue({} as any);

        await DeletionController.remove(
          mockReq as Request,
          mockRes as Response,
        );

        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          message: "Program and 2 events deleted with cascades.",
          deletedEvents: 2,
          deletedRegistrations: 18, // 10 + 8
          deletedGuestRegistrations: 8, // 5 + 3
        });
      });

      it("should create audit log in cascade mode", async () => {
        const eventIds = [new mongoose.Types.ObjectId()];

        vi.mocked(Event.find).mockReturnValue({
          select: vi
            .fn()
            .mockResolvedValue(eventIds.map((id) => ({ _id: id }))),
        } as any);

        vi.mocked(EventCascadeService.deleteEventFully).mockResolvedValue({
          deletedRegistrations: 7,
          deletedGuestRegistrations: 4,
        });

        vi.mocked(Program.findByIdAndDelete).mockResolvedValue({} as any);

        await DeletionController.remove(
          mockReq as Request,
          mockRes as Response,
        );

        expect(AuditLog.create).toHaveBeenCalledWith({
          action: "program_deletion",
          actor: {
            id: "admin123",
            role: "Administrator",
            email: "admin@test.com",
          },
          targetModel: "Program",
          targetId: testProgramId,
          details: {
            targetProgram: {
              id: testProgramId,
              title: "Test Program",
              programType: "Mentorship",
            },
            cascadeMode: "delete",
            deletedEvents: 1,
            deletedRegistrations: 7,
            deletedGuestRegistrations: 4,
          },
          ipAddress: "127.0.0.1",
          userAgent: "test-agent",
        });
      });

      it("should handle deleteLinkedEvents=TRUE (uppercase)", async () => {
        mockReq.query = { deleteLinkedEvents: "TRUE" };

        vi.mocked(Event.find).mockReturnValue({
          select: vi.fn().mockResolvedValue([]),
        } as any);

        vi.mocked(Program.findByIdAndDelete).mockResolvedValue({} as any);

        await DeletionController.remove(
          mockReq as Request,
          mockRes as Response,
        );

        expect(Event.find).toHaveBeenCalledWith({
          programLabels: testProgramId,
        });
      });

      it("should continue if audit log creation fails in cascade mode", async () => {
        vi.mocked(Event.find).mockReturnValue({
          select: vi.fn().mockResolvedValue([]),
        } as any);

        vi.mocked(Program.findByIdAndDelete).mockResolvedValue({} as any);
        vi.mocked(AuditLog.create).mockRejectedValue(new Error("Audit error"));

        const consoleErrorSpy = vi
          .spyOn(console, "error")
          .mockImplementation(() => {});

        await DeletionController.remove(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(consoleErrorSpy).toHaveBeenCalled();

        consoleErrorSpy.mockRestore();
      });
    });

    describe("error handling", () => {
      beforeEach(() => {
        mockReq.user = {
          _id: "admin123",
          role: "Administrator",
          email: "admin@test.com",
        };

        vi.mocked(RoleUtils.isAdmin).mockReturnValue(true);
        isValidSpy.mockReturnValue(true);
      });

      it("should return 500 on unexpected error", async () => {
        vi.mocked(Program.findById).mockReturnValue({
          lean: vi.fn().mockRejectedValue(new Error("Database error")),
        } as any);

        await DeletionController.remove(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Failed to delete program.",
        });
      });

      it("should return 500 if Event.updateMany fails in unlink mode", async () => {
        mockReq.query = { deleteLinkedEvents: "false" };

        vi.mocked(Program.findById).mockReturnValue({
          lean: vi.fn().mockResolvedValue({
            _id: testProgramId,
            title: "Test Program",
          }),
        } as any);

        vi.mocked(Event.updateMany).mockRejectedValue(
          new Error("Update failed"),
        );

        await DeletionController.remove(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Failed to delete program.",
        });
      });

      it("should return 500 if Event.find fails in cascade mode", async () => {
        mockReq.query = { deleteLinkedEvents: "true" };

        vi.mocked(Program.findById).mockReturnValue({
          lean: vi.fn().mockResolvedValue({
            _id: testProgramId,
            title: "Test Program",
          }),
        } as any);

        vi.mocked(Event.find).mockReturnValue({
          select: vi.fn().mockRejectedValue(new Error("Find failed")),
        } as any);

        await DeletionController.remove(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(500);
      });

      it("should return 500 if EventCascadeService fails", async () => {
        mockReq.query = { deleteLinkedEvents: "true" };

        vi.mocked(Program.findById).mockReturnValue({
          lean: vi.fn().mockResolvedValue({
            _id: testProgramId,
            title: "Test Program",
          }),
        } as any);

        vi.mocked(Event.find).mockReturnValue({
          select: vi
            .fn()
            .mockResolvedValue([{ _id: new mongoose.Types.ObjectId() }]),
        } as any);

        vi.mocked(EventCascadeService.deleteEventFully).mockRejectedValue(
          new Error("Cascade failed"),
        );

        await DeletionController.remove(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(500);
      });
    });

    describe("edge cases", () => {
      beforeEach(() => {
        mockReq.user = {
          _id: "admin123",
          role: "Administrator",
          email: "admin@test.com",
        };

        vi.mocked(RoleUtils.isAdmin).mockReturnValue(true);
        isValidSpy.mockReturnValue(true);
        vi.mocked(Program.findById).mockReturnValue({
          lean: vi.fn().mockResolvedValue({
            _id: testProgramId,
            title: "Test Program",
          }),
        } as any);
        vi.mocked(AuditLog.create).mockResolvedValue({} as any);
      });

      it("should handle missing IP address", async () => {
        const reqWithoutIp = { ...mockReq, ip: undefined };
        reqWithoutIp.query = { deleteLinkedEvents: "false" };

        vi.mocked(Event.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Program.findByIdAndDelete).mockResolvedValue({} as any);

        await DeletionController.remove(
          reqWithoutIp as Request,
          mockRes as Response,
        );

        expect(AuditLog.create).toHaveBeenCalledWith(
          expect.objectContaining({
            ipAddress: undefined,
          }),
        );
      });

      it("should handle missing user-agent", async () => {
        mockReq.get = vi.fn().mockReturnValue(undefined);
        mockReq.query = { deleteLinkedEvents: "false" };

        vi.mocked(Event.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Program.findByIdAndDelete).mockResolvedValue({} as any);

        await DeletionController.remove(
          mockReq as Request,
          mockRes as Response,
        );

        expect(AuditLog.create).toHaveBeenCalledWith(
          expect.objectContaining({
            userAgent: "unknown",
          }),
        );
      });

      it("should handle program without title or programType", async () => {
        vi.mocked(Program.findById).mockReturnValue({
          lean: vi.fn().mockResolvedValue({
            _id: testProgramId,
          }),
        } as any);

        mockReq.query = { deleteLinkedEvents: "false" };

        vi.mocked(Event.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Program.findByIdAndDelete).mockResolvedValue({} as any);

        await DeletionController.remove(
          mockReq as Request,
          mockRes as Response,
        );

        expect(AuditLog.create).toHaveBeenCalledWith(
          expect.objectContaining({
            details: expect.objectContaining({
              targetProgram: {
                id: testProgramId,
                title: undefined,
                programType: undefined,
              },
            }),
          }),
        );
      });

      it("should handle very large number of events in cascade mode", async () => {
        mockReq.query = { deleteLinkedEvents: "true" };

        const manyEvents = Array.from({ length: 100 }, () => ({
          _id: new mongoose.Types.ObjectId(),
        }));

        vi.mocked(Event.find).mockReturnValue({
          select: vi.fn().mockResolvedValue(manyEvents),
        } as any);

        vi.mocked(EventCascadeService.deleteEventFully).mockResolvedValue({
          deletedRegistrations: 1,
          deletedGuestRegistrations: 1,
        });

        vi.mocked(Program.findByIdAndDelete).mockResolvedValue({} as any);

        await DeletionController.remove(
          mockReq as Request,
          mockRes as Response,
        );

        expect(EventCascadeService.deleteEventFully).toHaveBeenCalledTimes(100);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          message: "Program and 100 events deleted with cascades.",
          deletedEvents: 100,
          deletedRegistrations: 100,
          deletedGuestRegistrations: 100,
        });
      });
    });
  });
});
