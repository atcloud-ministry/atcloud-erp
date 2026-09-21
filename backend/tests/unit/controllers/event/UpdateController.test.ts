import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";
import { UpdateController } from "../../../../src/controllers/event/UpdateController";

// Mock dependencies
vi.mock("../../../../src/models", () => ({
  Event: {
    findById: vi.fn(),
  },
  Registration: {
    find: vi.fn(),
  },
}));

vi.mock("../../../../src/utils/roleUtils", () => ({
  hasPermission: vi.fn(),
  PERMISSIONS: {
    EDIT_ANY_EVENT: "edit_any_event",
    EDIT_OWN_EVENT: "edit_own_event",
  },
  ROLES: {
    SUPER_ADMIN: "super-admin",
    ADMIN: "admin",
    LEADER: "leader",
    MEMBER: "member",
    PARTICIPANT: "participant",
  },
}));

vi.mock("../../../../src/utils/event/eventPermissions", () => ({
  isEventOrganizer: vi.fn(),
  isAffiliatedProgramEditor: vi.fn(),
}));

vi.mock("../../../../src/services/CorrelatedLogger", () => ({
  CorrelatedLogger: {
    fromRequest: vi.fn(() => ({
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));

vi.mock("../../../../src/controllers/eventController", () => ({
  EventController: {
    toIdString: vi.fn((id) => id?.toString()),
  },
}));

vi.mock("../../../../src/services/event/FieldNormalizationService", () => ({
  FieldNormalizationService: {
    extractSuppressionFlags: vi.fn(() => ({ suppressNotifications: false })),
    prepareUpdateData: vi.fn((data) => data),
    normalizeAndValidate: vi.fn(),
  },
}));

vi.mock("../../../../src/services/event/RoleUpdateService", () => ({
  RoleUpdateService: {
    processRoleUpdate: vi.fn(),
  },
}));

vi.mock("../../../../src/services/event/OrganizerManagementService", () => ({
  OrganizerManagementService: vi.fn().mockImplementation(() => ({
    trackOldOrganizers: vi.fn(() => []),
    normalizeOrganizerDetails: vi.fn((d) => d),
  })),
}));

vi.mock("../../../../src/services/event/ProgramLinkageService", () => ({
  ProgramLinkageService: {
    extractPreviousLabels: vi.fn(() => []),
    processAndValidate: vi.fn(),
    toObjectIdArray: vi.fn((arr) => arr),
  },
}));

vi.mock(
  "../../../../src/services/event/CoOrganizerProgramAccessService",
  () => ({
    CoOrganizerProgramAccessService: {
      validateCoOrganizerAccess: vi.fn(() => ({ valid: true })),
    },
  }),
);

vi.mock("../../../../src/services/event/AutoUnpublishService", () => ({
  AutoUnpublishService: {
    checkAndApplyAutoUnpublish: vi.fn(() => ({
      autoUnpublished: false,
      missingFields: [],
    })),
    sendAutoUnpublishNotifications: vi.fn(),
  },
}));

vi.mock(
  "../../../../src/services/event/CoOrganizerNotificationService",
  () => ({
    CoOrganizerNotificationService: {
      sendNewCoOrganizerNotifications: vi.fn(),
    },
  }),
);

vi.mock(
  "../../../../src/services/event/ParticipantNotificationService",
  () => ({
    ParticipantNotificationService: {
      sendEventUpdateNotifications: vi.fn(),
    },
  }),
);

vi.mock("../../../../src/services/infrastructure/CacheService", () => ({
  CachePatterns: {
    invalidateEventCache: vi.fn(),
    invalidateAnalyticsCache: vi.fn(),
  },
}));

vi.mock(
  "../../../../src/services/authorization/ResourceAuthorizationInvalidationService",
  () => ({
    resourceAuthorizationInvalidationService: {
      invalidateEventRoom: vi.fn(),
    },
  }),
);

vi.mock("../../../../src/services/ResponseBuilderService", () => ({
  ResponseBuilderService: {
    buildEventWithRegistrations: vi
      .fn()
      .mockResolvedValue({ _id: "test-event" }),
  },
}));

vi.mock("../../../../src/utils/event/eventValidation", () => ({
  validatePricing: vi.fn(() => ({ valid: true })),
}));

vi.mock("../../../../src/models/AuditLog", () => ({
  default: {
    create: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("../../../../src/models/Program", () => ({
  default: {
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  },
}));

import { hasPermission } from "../../../../src/utils/roleUtils";
import {
  isAffiliatedProgramEditor,
  isEventOrganizer,
} from "../../../../src/utils/event/eventPermissions";
import { Event } from "../../../../src/models";
import { FieldNormalizationService } from "../../../../src/services/event/FieldNormalizationService";
import { validatePricing } from "../../../../src/utils/event/eventValidation";
import { RoleUpdateService } from "../../../../src/services/event/RoleUpdateService";
import { ProgramLinkageService } from "../../../../src/services/event/ProgramLinkageService";
import { CoOrganizerProgramAccessService } from "../../../../src/services/event/CoOrganizerProgramAccessService";
import { AutoUnpublishService } from "../../../../src/services/event/AutoUnpublishService";
import { CoOrganizerNotificationService } from "../../../../src/services/event/CoOrganizerNotificationService";
import { ParticipantNotificationService } from "../../../../src/services/event/ParticipantNotificationService";
import { ResponseBuilderService } from "../../../../src/services/ResponseBuilderService";
import { CachePatterns } from "../../../../src/services/infrastructure/CacheService";
import { resourceAuthorizationInvalidationService } from "../../../../src/services/authorization/ResourceAuthorizationInvalidationService";

import AuditLog from "../../../../src/models/AuditLog";
import Program from "../../../../src/models/Program";

describe("UpdateController", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let jsonMock: ReturnType<typeof vi.fn>;
  let statusMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    jsonMock = vi.fn();
    statusMock = vi.fn(() => ({ json: jsonMock })) as ReturnType<typeof vi.fn>;

    req = {
      params: { id: "507f1f77bcf86cd799439011" },
      body: {},
      user: {
        _id: "user-id-123",
        role: "admin",
      },
    } as unknown as Partial<Request>;

    res = {
      status: statusMock,
      json: jsonMock,
    } as unknown as Partial<Response>;

    vi.mocked(isAffiliatedProgramEditor).mockResolvedValue(false);
  });

  describe("updateEvent - validation", () => {
    it("should return 400 for invalid event ID", async () => {
      req.params = { id: "invalid-id" };

      await UpdateController.updateEvent(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Invalid event ID.",
      });
    });

    it("should return 401 if user is not authenticated", async () => {
      req.user = undefined;

      await UpdateController.updateEvent(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Authentication required.",
      });
    });

    it("should return 404 if event is not found", async () => {
      vi.mocked(Event.findById).mockResolvedValue(null);

      await UpdateController.updateEvent(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(404);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Event not found.",
      });
    });
  });

  describe("updateEvent - authorization", () => {
    const mockEvent = {
      _id: "507f1f77bcf86cd799439011",
      title: "Test Event",
      createdBy: "other-user-id",
      roles: [],
      save: vi.fn().mockResolvedValue(true),
    };

    it("should return 403 if user lacks edit permissions", async () => {
      vi.mocked(Event.findById).mockResolvedValue(mockEvent);
      vi.mocked(hasPermission).mockReturnValue(false);
      vi.mocked(isEventOrganizer).mockReturnValue(false);

      await UpdateController.updateEvent(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(403);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message:
          "Insufficient permissions to edit this event. You must be the event creator, a co-organizer, or a mentor/class rep of an affiliated program.",
      });
    });

    it("should allow editing with EDIT_ANY_EVENT permission", async () => {
      vi.mocked(Event.findById).mockResolvedValue(mockEvent);
      vi.mocked(hasPermission).mockImplementation((role, perm) => {
        return perm === "edit_any_event";
      });
      vi.mocked(isEventOrganizer).mockReturnValue(false);

      // Mock the rest of the update flow to prevent errors
      const { FieldNormalizationService } =
        await import("../../../../src/services/event/FieldNormalizationService");
      vi.mocked(
        FieldNormalizationService.normalizeAndValidate,
      ).mockResolvedValue({
        success: false,
        errors: ["Validation error"],
      } as any);

      await UpdateController.updateEvent(req as Request, res as Response);

      // Should not have 403
      expect(statusMock).not.toHaveBeenCalledWith(403);
    });

    it("should allow editing by organizer with EDIT_OWN_EVENT permission", async () => {
      vi.mocked(Event.findById).mockResolvedValue(mockEvent);
      vi.mocked(hasPermission).mockImplementation((role, perm) => {
        return perm === "edit_own_event";
      });
      vi.mocked(isEventOrganizer).mockReturnValue(true);

      const { FieldNormalizationService } =
        await import("../../../../src/services/event/FieldNormalizationService");
      vi.mocked(
        FieldNormalizationService.normalizeAndValidate,
      ).mockResolvedValue({
        success: false,
        errors: ["Validation error"],
      } as any);

      await UpdateController.updateEvent(req as Request, res as Response);

      // Should not have 403
      expect(statusMock).not.toHaveBeenCalledWith(403);
    });

    it("should allow Leader editing when they are a mentor/class rep of an affiliated program", async () => {
      req.user = {
        _id: "leader-id-123",
        role: "Leader",
      } as any;
      vi.mocked(Event.findById).mockResolvedValue(mockEvent);
      vi.mocked(hasPermission).mockReturnValue(false);
      vi.mocked(isEventOrganizer).mockReturnValue(false);
      vi.mocked(isAffiliatedProgramEditor).mockResolvedValue(true);

      const { FieldNormalizationService } =
        await import("../../../../src/services/event/FieldNormalizationService");
      vi.mocked(
        FieldNormalizationService.normalizeAndValidate,
      ).mockResolvedValue({
        success: false,
        errors: ["Validation error"],
      } as any);

      await UpdateController.updateEvent(req as Request, res as Response);

      expect(statusMock).not.toHaveBeenCalledWith(403);
    });
  });

  describe("updateEvent - validation errors", () => {
    const mockEvent = {
      _id: "507f1f77bcf86cd799439011",
      title: "Test Event",
      createdBy: "user-id-123",
      roles: [],
      save: vi.fn().mockResolvedValue(true),
    };

    beforeEach(() => {
      vi.mocked(Event.findById).mockResolvedValue(mockEvent);
      vi.mocked(hasPermission).mockReturnValue(true);
      vi.mocked(isEventOrganizer).mockReturnValue(true);
    });

    it("should return 400 if field normalization returns errors", async () => {
      const { FieldNormalizationService } =
        await import("../../../../src/services/event/FieldNormalizationService");

      // Mock normalizeAndValidate to return null (validation failed)
      // and call res.status(400).json directly
      vi.mocked(
        FieldNormalizationService.normalizeAndValidate,
      ).mockImplementation(async (_data, _event, _id, response) => {
        (response as Response).status(400).json({
          success: false,
          message: "Invalid field value",
        });
        return undefined;
      });

      await UpdateController.updateEvent(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(400);
    });
  });

  describe("updateEvent - pricing validation", () => {
    const mockEvent = {
      _id: "507f1f77bcf86cd799439011",
      title: "Test Event",
      createdBy: "user-id-123",
      roles: [],
      isPublished: true,
      save: vi.fn().mockResolvedValue(true),
    };

    beforeEach(() => {
      vi.mocked(Event.findById).mockResolvedValue(mockEvent);
      vi.mocked(hasPermission).mockReturnValue(true);
      vi.mocked(isEventOrganizer).mockReturnValue(true);
      // Ensure pricing is in the normalized data so validation triggers
      vi.mocked(
        FieldNormalizationService.normalizeAndValidate,
      ).mockResolvedValue({
        pricing: { isFree: false, price: 100 },
      } as any);
    });

    it("should return 400 if pricing validation fails", async () => {
      vi.mocked(validatePricing).mockReturnValue({
        valid: false,
        error: "Early bird price cannot exceed base price",
      });

      await UpdateController.updateEvent(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Early bird price cannot exceed base price",
      });
    });
  });

  describe("updateEvent - role update handling", () => {
    const mockEvent = {
      _id: "507f1f77bcf86cd799439011",
      title: "Test Event",
      createdBy: "user-id-123",
      roles: [],
      isPublished: true,
      save: vi.fn().mockResolvedValue(true),
    };

    beforeEach(() => {
      vi.mocked(Event.findById).mockResolvedValue(mockEvent);
      vi.mocked(hasPermission).mockReturnValue(true);
      vi.mocked(isEventOrganizer).mockReturnValue(true);
      // normalizedData is returned directly, not wrapped in {success, updateData}
      vi.mocked(
        FieldNormalizationService.normalizeAndValidate,
      ).mockResolvedValue({
        roles: [{ roleName: "Attendee", capacity: 10 }],
      } as any);
      vi.mocked(validatePricing).mockReturnValue({ valid: true });
    });

    it("should return error if role update fails", async () => {
      vi.mocked(RoleUpdateService.processRoleUpdate).mockResolvedValue({
        success: false,
        error: {
          status: 400,
          message: "Cannot reduce capacity below current registrations",
        },
      } as any);

      await UpdateController.updateEvent(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          message: "Cannot reduce capacity below current registrations",
        }),
      );
    });

    it("should continue with update when role update succeeds", async () => {
      vi.mocked(RoleUpdateService.processRoleUpdate).mockResolvedValue({
        success: true,
        mergedRoles: [{ name: "Attendee", maxParticipants: 10 }] as any,
      });
      vi.mocked(ProgramLinkageService.processAndValidate).mockResolvedValue({
        valid: true,
        programIds: [],
      } as any);
      vi.mocked(
        CoOrganizerProgramAccessService.validateCoOrganizerAccess,
      ).mockResolvedValue({
        valid: true,
      });
      vi.mocked(
        AutoUnpublishService.checkAndApplyAutoUnpublish,
      ).mockResolvedValue({
        autoUnpublished: false,
        missingFields: [],
      });

      await UpdateController.updateEvent(req as Request, res as Response);

      expect(RoleUpdateService.processRoleUpdate).toHaveBeenCalled();
    });
  });

  describe("updateEvent - program linkage", () => {
    const mockEvent = {
      _id: "507f1f77bcf86cd799439011",
      title: "Test Event",
      createdBy: "user-id-123",
      roles: [],
      isPublished: true,
      save: vi.fn().mockResolvedValue(true),
    };

    beforeEach(() => {
      vi.mocked(Event.findById).mockResolvedValue(mockEvent);
      vi.mocked(hasPermission).mockReturnValue(true);
      vi.mocked(isEventOrganizer).mockReturnValue(true);
      // normalizedData returned directly with programLabels
      vi.mocked(
        FieldNormalizationService.normalizeAndValidate,
      ).mockResolvedValue({
        programLabels: ["invalid-label"],
      } as any);
      vi.mocked(validatePricing).mockReturnValue({ valid: true });
      // No roles in normalizedData, so role update won't be called
    });

    it("should return 400 if program linkage validation fails", async () => {
      vi.mocked(ProgramLinkageService.processAndValidate).mockResolvedValue({
        success: false,
        error: {
          status: 400,
          message: "Invalid program label: invalid-label",
        },
      } as any);

      await UpdateController.updateEvent(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          message: "Invalid program label: invalid-label",
        }),
      );
    });
  });

  describe("updateEvent - co-organizer access validation", () => {
    const mockEvent = {
      _id: "507f1f77bcf86cd799439011",
      title: "Test Event",
      createdBy: "user-id-123",
      roles: [],
      isPublished: true,
      organizerDetails: [{ _id: "co-org-1", email: "coorg@example.com" }],
      save: vi.fn().mockResolvedValue(true),
    };

    beforeEach(() => {
      vi.mocked(Event.findById).mockResolvedValue(mockEvent);
      vi.mocked(hasPermission).mockReturnValue(true);
      vi.mocked(isEventOrganizer).mockReturnValue(true);
      // Return normalized data directly with programLabels
      vi.mocked(
        FieldNormalizationService.normalizeAndValidate,
      ).mockResolvedValue({
        programLabels: ["valid-label"],
      } as any);
      vi.mocked(validatePricing).mockReturnValue({ valid: true });
      // No roles, so role update won't be called
      vi.mocked(ProgramLinkageService.processAndValidate).mockResolvedValue({
        success: true,
        programIds: ["program-id-1"],
      } as any);
    });

    it("should return 400 if co-organizer lacks program access", async () => {
      vi.mocked(
        CoOrganizerProgramAccessService.validateCoOrganizerAccess,
      ).mockResolvedValue({
        valid: false,
        error: {
          status: 400,
          message:
            "Co-organizer coorg@example.com does not have access to program 'Youth'",
        },
      } as any);

      await UpdateController.updateEvent(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          message:
            "Co-organizer coorg@example.com does not have access to program 'Youth'",
        }),
      );
    });
  });

  describe("updateEvent - auto-unpublish", () => {
    const mockEvent = {
      _id: "507f1f77bcf86cd799439011",
      title: "Test Event",
      createdBy: "user-id-123",
      roles: [{ roleName: "Attendee" }],
      isPublished: true,
      save: vi.fn().mockResolvedValue(true),
    };

    beforeEach(() => {
      vi.mocked(Event.findById).mockResolvedValue(mockEvent);
      vi.mocked(hasPermission).mockReturnValue(true);
      vi.mocked(isEventOrganizer).mockReturnValue(true);
      // Normalized data returned directly - no roles/programLabels to trigger those checks
      vi.mocked(
        FieldNormalizationService.normalizeAndValidate,
      ).mockResolvedValue({
        title: "Updated Event",
      } as any);
      vi.mocked(validatePricing).mockReturnValue({ valid: true });
      // Co-organizer access mock
      vi.mocked(
        CoOrganizerProgramAccessService.validateCoOrganizerAccess,
      ).mockResolvedValue({
        valid: true,
      });
    });

    it("should include warning message when event is auto-unpublished", async () => {
      vi.mocked(
        AutoUnpublishService.checkAndApplyAutoUnpublish,
      ).mockResolvedValue({
        autoUnpublished: true,
        missingFields: ["startDate", "endDate"],
      });
      vi.mocked(
        ResponseBuilderService.buildEventWithRegistrations,
      ).mockResolvedValue({
        _id: "507f1f77bcf86cd799439011",
        title: "Updated Event",
      } as any);

      await UpdateController.updateEvent(req as Request, res as Response);

      expect(
        AutoUnpublishService.sendAutoUnpublishNotifications,
      ).toHaveBeenCalled();
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: expect.stringContaining("unpublished"),
        }),
      );
    });

    it("should not send auto-unpublish notifications when event remains published", async () => {
      vi.mocked(
        AutoUnpublishService.checkAndApplyAutoUnpublish,
      ).mockResolvedValue({
        autoUnpublished: false,
        missingFields: [],
      });
      vi.mocked(
        ResponseBuilderService.buildEventWithRegistrations,
      ).mockResolvedValue({
        _id: "507f1f77bcf86cd799439011",
        title: "Updated Event",
      } as any);

      await UpdateController.updateEvent(req as Request, res as Response);

      expect(
        AutoUnpublishService.sendAutoUnpublishNotifications,
      ).not.toHaveBeenCalled();
    });
  });

  describe("updateEvent - successful flow", () => {
    const mockEvent = {
      _id: "507f1f77bcf86cd799439011",
      title: "Test Event",
      createdBy: "user-id-123",
      roles: [{ roleName: "Attendee" }],
      isPublished: true,
      organizerDetails: [],
      save: vi.fn().mockResolvedValue(true),
    };

    beforeEach(() => {
      vi.mocked(Event.findById).mockResolvedValue(mockEvent);
      vi.mocked(hasPermission).mockReturnValue(true);
      vi.mocked(isEventOrganizer).mockReturnValue(true);
      // Normalized data returned directly - no roles/programLabels
      vi.mocked(
        FieldNormalizationService.normalizeAndValidate,
      ).mockResolvedValue({
        title: "Updated Event",
      } as any);
      vi.mocked(validatePricing).mockReturnValue({ valid: true });
      vi.mocked(
        CoOrganizerProgramAccessService.validateCoOrganizerAccess,
      ).mockResolvedValue({
        valid: true,
      });
      vi.mocked(
        AutoUnpublishService.checkAndApplyAutoUnpublish,
      ).mockResolvedValue({
        autoUnpublished: false,
        missingFields: [],
      });
      vi.mocked(
        ResponseBuilderService.buildEventWithRegistrations,
      ).mockResolvedValue({
        _id: "507f1f77bcf86cd799439011",
        title: "Updated Event",
      } as any);
    });

    it("should send notifications when not suppressed", async () => {
      vi.mocked(
        FieldNormalizationService.extractSuppressionFlags,
      ).mockReturnValue({
        suppressNotifications: false,
      });

      await UpdateController.updateEvent(req as Request, res as Response);

      expect(
        CoOrganizerNotificationService.sendNewCoOrganizerNotifications,
      ).toHaveBeenCalled();
      expect(
        ParticipantNotificationService.sendEventUpdateNotifications,
      ).toHaveBeenCalled();
    });

    it("should skip notifications when suppressed", async () => {
      vi.mocked(
        FieldNormalizationService.extractSuppressionFlags,
      ).mockReturnValue({
        suppressNotifications: true,
      });

      await UpdateController.updateEvent(req as Request, res as Response);

      expect(
        CoOrganizerNotificationService.sendNewCoOrganizerNotifications,
      ).not.toHaveBeenCalled();
      expect(
        ParticipantNotificationService.sendEventUpdateNotifications,
      ).not.toHaveBeenCalled();
    });

    it("should invalidate caches after update", async () => {
      await UpdateController.updateEvent(req as Request, res as Response);

      expect(CachePatterns.invalidateEventCache).toHaveBeenCalledWith(
        "507f1f77bcf86cd799439011",
      );
      expect(CachePatterns.invalidateAnalyticsCache).toHaveBeenCalled();
    });

    it("invalidates live room authorization after an access input is persisted", async () => {
      vi.mocked(
        FieldNormalizationService.normalizeAndValidate,
      ).mockResolvedValue({
        title: "Updated Event",
        pricing: { isFree: false, price: 1000 },
      } as any);

      await UpdateController.updateEvent(req as Request, res as Response);

      expect(
        resourceAuthorizationInvalidationService.invalidateEventRoom,
      ).toHaveBeenCalledWith("507f1f77bcf86cd799439011");
      expect(mockEvent.save.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(
          resourceAuthorizationInvalidationService.invalidateEventRoom,
        ).mock.invocationCallOrder[0],
      );
    });

    it("keeps live room authorization for a non-access field update", async () => {
      await UpdateController.updateEvent(req as Request, res as Response);

      expect(
        resourceAuthorizationInvalidationService.invalidateEventRoom,
      ).not.toHaveBeenCalled();
    });

    it("should return 200 with updated event on success", async () => {
      await UpdateController.updateEvent(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            event: expect.objectContaining({ _id: "507f1f77bcf86cd799439011" }),
          }),
        }),
      );
    });
  });

  describe("updateEvent - error handling", () => {
    const mockEvent = {
      _id: "507f1f77bcf86cd799439011",
      title: "Test Event",
      createdBy: "user-id-123",
      roles: [],
      save: vi.fn().mockResolvedValue(true),
    };

    beforeEach(() => {
      vi.mocked(Event.findById).mockResolvedValue(mockEvent);
      vi.mocked(hasPermission).mockReturnValue(true);
      vi.mocked(isEventOrganizer).mockReturnValue(true);
    });

    it("should return 400 for ValidationError", async () => {
      const validationError = new Error("Title is required") as Error & {
        errors: Record<string, { message: string }>;
      };
      validationError.name = "ValidationError";
      validationError.errors = {
        title: { message: "Title is required" },
      };
      vi.mocked(
        FieldNormalizationService.normalizeAndValidate,
      ).mockRejectedValue(validationError);

      await UpdateController.updateEvent(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Validation failed: Title is required",
      });
    });

    it("should return 500 for generic errors", async () => {
      vi.mocked(
        FieldNormalizationService.normalizeAndValidate,
      ).mockRejectedValue(new Error("Database connection failed"));

      await UpdateController.updateEvent(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(500);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Failed to update event.",
      });
    });
  });

  describe("updateEvent - event cancellation audit logging", () => {
    const mockEvent = {
      _id: "507f1f77bcf86cd799439011",
      title: "Test Event",
      type: "Workshop",
      date: new Date("2025-01-15"),
      location: "Building A",
      createdBy: "user-id-123",
      roles: [],
      isPublished: true,
      organizerDetails: [],
      status: "published",
      save: vi.fn().mockImplementation(function (this: typeof mockEvent) {
        // Simulate the save updating the status
        this.status = "cancelled";
        return Promise.resolve(true);
      }),
    };

    beforeEach(() => {
      vi.mocked(Event.findById).mockResolvedValue(mockEvent);
      vi.mocked(hasPermission).mockReturnValue(true);
      vi.mocked(isEventOrganizer).mockReturnValue(true);
      vi.mocked(validatePricing).mockReturnValue({ valid: true });
      vi.mocked(
        CoOrganizerProgramAccessService.validateCoOrganizerAccess,
      ).mockResolvedValue({ valid: true });
      vi.mocked(
        AutoUnpublishService.checkAndApplyAutoUnpublish,
      ).mockResolvedValue({ autoUnpublished: false, missingFields: [] });
      vi.mocked(
        ResponseBuilderService.buildEventWithRegistrations,
      ).mockResolvedValue({ _id: "507f1f77bcf86cd799439011" } as any);
    });

    it("should create audit log when event is cancelled", async () => {
      req.body = { status: "cancelled" };
      (req as any).ip = "192.168.1.1";
      (req as any).get = vi.fn().mockReturnValue("Test Browser");
      (req as any).user = {
        _id: "user-id-123",
        role: "Administrator",
        email: "admin@example.com",
      };

      vi.mocked(
        FieldNormalizationService.normalizeAndValidate,
      ).mockResolvedValue({
        status: "cancelled",
      } as any);

      await UpdateController.updateEvent(req as Request, res as Response);

      expect(AuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "event_cancelled",
          actor: expect.objectContaining({
            id: "user-id-123",
            role: "Administrator",
            email: "admin@example.com",
          }),
          targetModel: "Event",
          targetId: "507f1f77bcf86cd799439011",
          details: expect.objectContaining({
            targetEvent: expect.objectContaining({
              title: "Test Event",
              type: "Workshop",
            }),
          }),
        }),
      );
    });

    it("should continue when audit log creation fails", async () => {
      req.body = { status: "cancelled" };
      (req as any).ip = "192.168.1.1";
      (req as any).get = vi.fn().mockReturnValue("Test Browser");
      (req as any).user = {
        _id: "user-id-123",
        role: "Administrator",
        email: "admin@example.com",
      };

      vi.mocked(
        FieldNormalizationService.normalizeAndValidate,
      ).mockResolvedValue({
        status: "cancelled",
      } as any);

      vi.mocked(AuditLog.create).mockRejectedValue(
        new Error("Audit log DB error"),
      );
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      try {
        await UpdateController.updateEvent(req as Request, res as Response);

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          "Failed to create audit log for event cancellation:",
          expect.any(Error),
        );
        // Should still return success
        expect(statusMock).toHaveBeenCalledWith(200);
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });
  });

  describe("updateEvent - program sync on programLabels change", () => {
    const mockEvent = {
      _id: "507f1f77bcf86cd799439011",
      title: "Test Event",
      createdBy: "user-id-123",
      roles: [],
      isPublished: true,
      organizerDetails: [],
      save: vi.fn().mockResolvedValue(true),
    };

    beforeEach(() => {
      vi.mocked(Event.findById).mockResolvedValue(mockEvent);
      vi.mocked(hasPermission).mockReturnValue(true);
      vi.mocked(isEventOrganizer).mockReturnValue(true);
      vi.mocked(validatePricing).mockReturnValue({ valid: true });
      vi.mocked(
        CoOrganizerProgramAccessService.validateCoOrganizerAccess,
      ).mockResolvedValue({ valid: true });
      vi.mocked(
        AutoUnpublishService.checkAndApplyAutoUnpublish,
      ).mockResolvedValue({ autoUnpublished: false, missingFields: [] });
      vi.mocked(
        ResponseBuilderService.buildEventWithRegistrations,
      ).mockResolvedValue({ _id: "507f1f77bcf86cd799439011" } as any);
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    it("should log program changes when programLabels are updated", async () => {
      // This test verifies the console.log that indicates program changes are detected
      vi.mocked(ProgramLinkageService.extractPreviousLabels).mockReturnValue(
        [],
      );

      vi.mocked(
        FieldNormalizationService.normalizeAndValidate,
      ).mockResolvedValue({
        programLabels: ["507f1f77bcf86cd799439021"],
      } as any);

      vi.mocked(ProgramLinkageService.processAndValidate).mockResolvedValue({
        valid: true,
        programIds: ["507f1f77bcf86cd799439021"],
      } as any);

      vi.mocked(ProgramLinkageService.toObjectIdArray).mockReturnValue([
        "507f1f77bcf86cd799439021",
      ] as any);

      await UpdateController.updateEvent(req as Request, res as Response);

      // The code logs whether there are program changes
      expect(console.log).toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(200);
    });
  });

  describe("updateYoutubeUrl", () => {
    let statusMock: ReturnType<typeof vi.fn>;
    let jsonMock: ReturnType<typeof vi.fn>;
    let req: Partial<Request>;
    let res: Partial<Response>;

    beforeEach(() => {
      jsonMock = vi.fn();
      statusMock = vi.fn().mockReturnValue({ json: jsonMock });
      res = {
        status: statusMock as unknown as Response["status"],
        json: jsonMock as unknown as Response["json"],
      };
      req = {
        params: { id: "507f1f77bcf86cd799439011" },
        body: { youtubeUrl: "https://www.youtube.com/watch?v=test123" },
        user: {
          _id: "user-id-123",
          role: "Administrator",
          email: "admin@test.com",
        } as any,
        ip: "127.0.0.1",
        get: vi.fn().mockReturnValue("test-agent"),
      };
    });

    it("should return 400 for invalid event ID", async () => {
      req.params = { id: "invalid-id" };

      await UpdateController.updateYoutubeUrl(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Invalid event ID.",
      });
    });

    it("should return 401 if user is not authenticated", async () => {
      req.user = undefined;

      await UpdateController.updateYoutubeUrl(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Authentication required.",
      });
    });

    it("should return 404 if event is not found", async () => {
      vi.mocked(Event.findById).mockResolvedValue(null);

      await UpdateController.updateYoutubeUrl(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(404);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Event not found.",
      });
    });

    it("should return 400 if event is not completed", async () => {
      vi.mocked(Event.findById).mockResolvedValue({
        _id: "507f1f77bcf86cd799439011",
        status: "upcoming",
        createdBy: "user-id-123",
        save: vi.fn(),
      } as any);

      await UpdateController.updateYoutubeUrl(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "YouTube URL can only be added to completed events.",
      });
    });

    it("should return 403 if user lacks permission", async () => {
      vi.mocked(Event.findById).mockResolvedValue({
        _id: "507f1f77bcf86cd799439011",
        status: "completed",
        createdBy: "other-user-id",
        organizerDetails: [],
        save: vi.fn(),
      } as any);
      req.user = {
        _id: "user-id-123",
        role: "Participant",
        email: "participant@test.com",
      } as any;

      await UpdateController.updateYoutubeUrl(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(403);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message:
          "You do not have permission to update this event's YouTube URL.",
      });
    });

    it("should return 400 for invalid YouTube URL format", async () => {
      vi.mocked(Event.findById).mockResolvedValue({
        _id: "507f1f77bcf86cd799439011",
        status: "completed",
        createdBy: "user-id-123",
        organizerDetails: [],
        save: vi.fn(),
      } as any);
      req.body = { youtubeUrl: "https://vimeo.com/123456" };

      await UpdateController.updateYoutubeUrl(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Invalid YouTube URL. Please provide a valid YouTube link.",
      });
    });

    it("should update YouTube URL successfully for admin", async () => {
      const mockEvent: any = {
        _id: "507f1f77bcf86cd799439011",
        status: "completed",
        createdBy: "other-user-id",
        organizerDetails: [],
        save: vi.fn(),
      };
      vi.mocked(Event.findById).mockResolvedValue(mockEvent as any);
      vi.mocked(CachePatterns.invalidateEventCache).mockResolvedValue(
        undefined,
      );
      vi.mocked(
        ResponseBuilderService.buildEventWithRegistrations,
      ).mockResolvedValue({ _id: "507f1f77bcf86cd799439011" } as any);

      await UpdateController.updateYoutubeUrl(req as Request, res as Response);

      expect(mockEvent.save).toHaveBeenCalled();
      expect(mockEvent.youtubeUrl).toBe(
        "https://www.youtube.com/watch?v=test123",
      );
      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: "YouTube URL updated successfully.",
        }),
      );
    });

    it("should update YouTube URL for event creator", async () => {
      const mockEvent: any = {
        _id: "507f1f77bcf86cd799439011",
        status: "completed",
        createdBy: "user-id-123",
        organizerDetails: [],
        save: vi.fn(),
      };
      vi.mocked(Event.findById).mockResolvedValue(mockEvent as any);
      req.user = {
        _id: "user-id-123",
        role: "Participant",
        email: "member@test.com",
      } as any;

      await UpdateController.updateYoutubeUrl(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
    });

    it("should update YouTube URL for co-organizer", async () => {
      const mockEvent: any = {
        _id: "507f1f77bcf86cd799439011",
        status: "completed",
        createdBy: "other-user-id",
        organizerDetails: [{ userId: "user-id-123" }],
        save: vi.fn(),
      };
      vi.mocked(Event.findById).mockResolvedValue(mockEvent as any);
      req.user = {
        _id: "user-id-123",
        role: "Participant",
        email: "member@test.com",
      } as any;

      await UpdateController.updateYoutubeUrl(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
    });

    it("should clear YouTube URL when empty value provided", async () => {
      const mockEvent = {
        _id: "507f1f77bcf86cd799439011",
        status: "completed",
        createdBy: "user-id-123",
        organizerDetails: [],
        youtubeUrl: "https://www.youtube.com/watch?v=old",
        save: vi.fn(),
      };
      vi.mocked(Event.findById).mockResolvedValue(mockEvent as any);
      req.body = { youtubeUrl: "" };

      await UpdateController.updateYoutubeUrl(req as Request, res as Response);

      expect(mockEvent.youtubeUrl).toBeUndefined();
      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: "YouTube URL removed successfully.",
        }),
      );
    });

    it("should accept youtu.be short URLs", async () => {
      const mockEvent: any = {
        _id: "507f1f77bcf86cd799439011",
        status: "completed",
        createdBy: "user-id-123",
        organizerDetails: [],
        save: vi.fn(),
      };
      vi.mocked(Event.findById).mockResolvedValue(mockEvent as any);
      req.body = { youtubeUrl: "https://youtu.be/test123" };

      await UpdateController.updateYoutubeUrl(req as Request, res as Response);

      expect(mockEvent.youtubeUrl).toBe("https://youtu.be/test123");
      expect(statusMock).toHaveBeenCalledWith(200);
    });

    it("should return 500 on database error", async () => {
      vi.mocked(Event.findById).mockRejectedValue(new Error("Database error"));
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      try {
        await UpdateController.updateYoutubeUrl(
          req as Request,
          res as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Failed to update YouTube URL.",
        });
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });
  });
});
