import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Request, Response, NextFunction } from "express";

// Mock the models before importing auth
vi.mock("../../../src/models", () => ({
  User: {
    findById: vi.fn().mockReturnThis(),
    select: vi.fn(),
  },
  Event: {
    findById: vi.fn(),
  },
}));

vi.mock("../../../src/utils/event/eventPermissions", () => ({
  isAffiliatedProgramEditor: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../../src/services/authorization/AuthorizationAuditService", () => ({
  recordAuthorizationDenial: vi.fn(),
}));

import { authorizeEventManagement } from "../../../src/middleware/auth";
import { Event, User } from "../../../src/models";
import { isAffiliatedProgramEditor } from "../../../src/utils/event/eventPermissions";

function activeUser(_id: string, role: string) {
  return {
    _id,
    role: role === "member" ? "Participant" : role,
    isActive: true,
    isVerified: true,
  } as any;
}

describe("authorizeEventManagement middleware", () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;
  let jsonMock: ReturnType<typeof vi.fn>;
  let statusMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAffiliatedProgramEditor).mockResolvedValue(false);

    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });
    mockNext = vi.fn() as unknown as NextFunction;

    mockReq = {
      user: undefined,
      params: {},
    };

    mockRes = {
      status: statusMock,
      json: jsonMock,
    } as unknown as Partial<Response>;

    // Suppress console.log and console.error in tests
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return 401 when user is not authenticated", async () => {
    mockReq.user = undefined;

    await authorizeEventManagement(
      mockReq as Request,
      mockRes as Response,
      mockNext,
    );

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(jsonMock).toHaveBeenCalledWith({
      success: false,
      message: "Authentication required.",
    });
    expect(mockNext).not.toHaveBeenCalled();
  });

  it("should allow Administrator role to manage any event", async () => {
    mockReq.user = activeUser("admin-user-id", "Administrator");

    await authorizeEventManagement(
      mockReq as Request,
      mockRes as Response,
      mockNext,
    );

    expect(mockNext).toHaveBeenCalled();
    expect(statusMock).not.toHaveBeenCalled();
  });

  it("should allow Super Admin role to manage any event", async () => {
    mockReq.user = activeUser("super-admin-id", "Super Admin");

    await authorizeEventManagement(
      mockReq as Request,
      mockRes as Response,
      mockNext,
    );

    expect(mockNext).toHaveBeenCalled();
    expect(statusMock).not.toHaveBeenCalled();
  });

  it("should return 400 when event ID is not provided", async () => {
    mockReq.user = activeUser("regular-user", "Participant");
    mockReq.params = {};

    await authorizeEventManagement(
      mockReq as Request,
      mockRes as Response,
      mockNext,
    );

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith({
      success: false,
      message: "Event ID is required.",
    });
    expect(mockNext).not.toHaveBeenCalled();
  });

  it("should use params.id if params.eventId is not present", async () => {
    mockReq.user = activeUser("creator-user-id", "Participant");
    mockReq.params = { id: "event-123" };

    vi.mocked(Event.findById).mockResolvedValue({
      _id: "event-123",
      createdBy: "creator-user-id",
      organizerDetails: [],
    });

    await authorizeEventManagement(
      mockReq as Request,
      mockRes as Response,
      mockNext,
    );

    expect(Event.findById).toHaveBeenCalledWith("event-123");
    expect(mockNext).toHaveBeenCalled();
  });

  it("should return 404 when event is not found", async () => {
    mockReq.user = activeUser("user-id", "Participant");
    mockReq.params = { eventId: "nonexistent-event" };

    vi.mocked(Event.findById).mockResolvedValue(null);

    await authorizeEventManagement(
      mockReq as Request,
      mockRes as Response,
      mockNext,
    );

    expect(statusMock).toHaveBeenCalledWith(404);
    expect(jsonMock).toHaveBeenCalledWith({
      success: false,
      message: "Event not found.",
    });
    expect(mockNext).not.toHaveBeenCalled();
  });

  it("should allow event creator to manage the event", async () => {
    mockReq.user = activeUser("creator-user-id", "Participant");
    mockReq.params = { eventId: "event-123" };

    vi.mocked(Event.findById).mockResolvedValue({
      _id: "event-123",
      createdBy: "creator-user-id",
      organizerDetails: [],
    });

    await authorizeEventManagement(
      mockReq as Request,
      mockRes as Response,
      mockNext,
    );

    expect(mockNext).toHaveBeenCalled();
    expect(statusMock).not.toHaveBeenCalled();
  });

  it("should allow listed organizer to manage the event", async () => {
    mockReq.user = activeUser("organizer-user-id", "Participant");
    mockReq.params = { eventId: "event-456" };

    vi.mocked(Event.findById).mockResolvedValue({
      _id: "event-456",
      createdBy: "different-creator",
      organizerDetails: [
        { userId: { toString: () => "organizer-user-id" } },
        { userId: { toString: () => "other-organizer" } },
      ],
    });

    await authorizeEventManagement(
      mockReq as Request,
      mockRes as Response,
      mockNext,
    );

    expect(mockNext).toHaveBeenCalled();
    expect(statusMock).not.toHaveBeenCalled();
  });

  it("should allow Leader mentor/class rep of an affiliated program to manage the event", async () => {
    mockReq.user = activeUser("program-leader-id", "Leader");
    mockReq.params = { eventId: "event-456" };

    vi.mocked(Event.findById).mockResolvedValue({
      _id: "event-456",
      createdBy: "different-creator",
      organizerDetails: [],
      programLabels: ["program-1"],
    });
    vi.mocked(isAffiliatedProgramEditor).mockResolvedValue(true);

    await authorizeEventManagement(
      mockReq as Request,
      mockRes as Response,
      mockNext,
    );

    expect(isAffiliatedProgramEditor).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "event-456" }),
      "program-leader-id",
      "Leader",
    );
    expect(mockNext).toHaveBeenCalled();
    expect(statusMock).not.toHaveBeenCalled();
  });

  it("should return 403 for non-admin, non-creator, non-organizer", async () => {
    mockReq.user = activeUser("random-user-id", "Participant");
    mockReq.params = { eventId: "event-789" };

    vi.mocked(Event.findById).mockResolvedValue({
      _id: "event-789",
      createdBy: "actual-creator",
      organizerDetails: [{ userId: { toString: () => "other-organizer" } }],
    });

    await authorizeEventManagement(
      mockReq as Request,
      mockRes as Response,
      mockNext,
    );

    expect(statusMock).toHaveBeenCalledWith(403);
    expect(jsonMock).toHaveBeenCalledWith({
      success: false,
      message:
        "Access denied. You must be an Administrator, Super Admin, event creator, listed organizer, or a mentor/class rep of an affiliated program to manage this event.",
    });
    expect(mockNext).not.toHaveBeenCalled();
  });

  it("should return 500 when an error occurs", async () => {
    mockReq.user = activeUser("user-id", "Participant");
    mockReq.params = { eventId: "event-error" };

    vi.mocked(Event.findById).mockRejectedValue(new Error("Database error"));

    await authorizeEventManagement(
      mockReq as Request,
      mockRes as Response,
      mockNext,
    );

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith({
      success: false,
      message: "Authorization check failed.",
    });
    expect(console.error).toHaveBeenCalledWith(
      "Application operation failed",
      {
        eventCode: "AUTH_EVENT_MANAGEMENT_POLICY_FAILED",
        errorName: "AuthorizationPolicyError",
      },
    );
    expect(mockNext).not.toHaveBeenCalled();
  });

  it("should handle event with null organizerDetails", async () => {
    mockReq.user = activeUser("random-user", "Participant");
    mockReq.params = { eventId: "event-no-organizers" };

    vi.mocked(Event.findById).mockResolvedValue({
      _id: "event-no-organizers",
      createdBy: "creator",
      organizerDetails: null,
    });

    await authorizeEventManagement(
      mockReq as Request,
      mockRes as Response,
      mockNext,
    );

    expect(statusMock).toHaveBeenCalledWith(403);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it("should handle organizer without userId", async () => {
    mockReq.user = activeUser("random-user", "Participant");
    mockReq.params = { eventId: "event-bad-organizers" };

    vi.mocked(Event.findById).mockResolvedValue({
      _id: "event-bad-organizers",
      createdBy: "creator",
      organizerDetails: [{ name: "Organizer without userId" }],
    });

    await authorizeEventManagement(
      mockReq as Request,
      mockRes as Response,
      mockNext,
    );

    expect(statusMock).toHaveBeenCalledWith(403);
    expect(mockNext).not.toHaveBeenCalled();
  });
});
