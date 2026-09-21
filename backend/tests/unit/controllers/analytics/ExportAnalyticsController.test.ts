import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";
import ExportAnalyticsController from "../../../../src/controllers/analytics/ExportAnalyticsController";

// Mock all dependencies before imports
vi.mock("../../../../src/models", () => ({
  User: {
    find: vi.fn(),
    countDocuments: vi.fn(),
  },
  Event: {
    find: vi.fn(),
    countDocuments: vi.fn(),
  },
  Registration: {
    find: vi.fn(),
    countDocuments: vi.fn(),
  },
  GuestRegistration: {
    find: vi.fn(),
  },
  Program: {
    find: vi.fn(),
  },
}));

vi.mock("../../../../src/models/Purchase", () => ({
  default: {
    find: vi.fn(),
  },
}));

vi.mock("../../../../src/models/DonationTransaction", () => ({
  default: {
    find: vi.fn(),
  },
}));

vi.mock("../../../../src/utils/roleUtils", () => ({
  hasPermission: vi.fn(),
  PERMISSIONS: {
    VIEW_SYSTEM_ANALYTICS: "view_system_analytics",
  },
}));

vi.mock("../../../../src/services/CorrelatedLogger", () => ({
  CorrelatedLogger: {
    fromRequest: vi.fn(() => ({
      error: vi.fn(),
      info: vi.fn(),
    })),
  },
}));

vi.mock("xlsx", () => ({
  utils: {
    book_new: vi.fn(),
    aoa_to_sheet: vi.fn(),
    book_append_sheet: vi.fn(),
  },
  write: vi.fn(),
}));

import { hasPermission, PERMISSIONS } from "../../../../src/utils/roleUtils";

describe("ExportAnalyticsController", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let jsonMock: ReturnType<typeof vi.fn>;
  let statusMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    jsonMock = vi.fn();
    statusMock = vi.fn(() => ({ json: jsonMock })) as ReturnType<typeof vi.fn>;

    req = {
      query: {},
      user: {
        _id: "user-id-123",
        role: "admin",
      },
    } as unknown as Partial<Request>;

    res = {
      status: statusMock,
      json: jsonMock,
      setHeader: vi.fn(),
      send: vi.fn(),
    } as unknown as Partial<Response>;
  });

  describe("exportAnalytics - authentication and authorization", () => {
    it("should return 401 if user is not authenticated", async () => {
      req.user = undefined;

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Authentication required.",
      });
    });

    it("should return 403 if user lacks VIEW_SYSTEM_ANALYTICS permission", async () => {
      vi.mocked(hasPermission).mockReturnValue(false);

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      expect(hasPermission).toHaveBeenCalledWith(
        "admin",
        PERMISSIONS.VIEW_SYSTEM_ANALYTICS,
      );
      expect(statusMock).toHaveBeenCalledWith(403);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Insufficient permissions to export analytics.",
      });
    });

    it("should return 400 for unsupported format xml", async () => {
      req.query = { format: "xml" };
      vi.mocked(hasPermission).mockReturnValue(true);

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Unsupported format. Use 'json', 'csv', or 'xlsx'.",
      });
    });

    it("should return 400 for unsupported format pdf", async () => {
      req.query = { format: "pdf" };
      vi.mocked(hasPermission).mockReturnValue(true);

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      expect(statusMock).toHaveBeenCalledWith(400);
    });

    it("should call permission check with correct role", async () => {
      req.user = {
        _id: "user-123",
        role: "Super Admin",
      } as unknown as Request["user"];
      vi.mocked(hasPermission).mockReturnValue(false);

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      expect(hasPermission).toHaveBeenCalledWith(
        "Super Admin",
        PERMISSIONS.VIEW_SYSTEM_ANALYTICS,
      );
    });
  });

  describe("exportAnalytics - format handling", () => {
    beforeEach(() => {
      vi.mocked(hasPermission).mockReturnValue(true);
    });

    it("should accept json format", async () => {
      req.query = { format: "json" };

      // Mock the database calls to return empty arrays
      const { User, Event, Registration, GuestRegistration } =
        await import("../../../../src/models");
      vi.mocked(User.find).mockReturnValue({
        populate: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof User.find>);
      vi.mocked(Event.find).mockReturnValue({
        populate: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof Event.find>);
      vi.mocked(Registration.find).mockReturnValue({
        populate: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof Registration.find>);
      vi.mocked(GuestRegistration.find).mockReturnValue({
        populate: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof GuestRegistration.find>);

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      // Should not return an error status
      expect(statusMock).not.toHaveBeenCalledWith(400);
      expect(statusMock).not.toHaveBeenCalledWith(401);
      expect(statusMock).not.toHaveBeenCalledWith(403);
    });

    it("should accept csv format", async () => {
      req.query = { format: "csv" };

      const { User, Event, Registration, GuestRegistration } =
        await import("../../../../src/models");
      vi.mocked(User.find).mockReturnValue({
        populate: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof User.find>);
      vi.mocked(Event.find).mockReturnValue({
        populate: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof Event.find>);
      vi.mocked(Registration.find).mockReturnValue({
        populate: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof Registration.find>);
      vi.mocked(GuestRegistration.find).mockReturnValue({
        populate: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof GuestRegistration.find>);

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      // Should not return an error status
      expect(statusMock).not.toHaveBeenCalledWith(400);
    });

    it("should accept xlsx format", async () => {
      req.query = { format: "xlsx" };

      const { User, Event, Registration, GuestRegistration } =
        await import("../../../../src/models");
      vi.mocked(User.find).mockReturnValue({
        populate: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof User.find>);
      vi.mocked(Event.find).mockReturnValue({
        populate: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof Event.find>);
      vi.mocked(Registration.find).mockReturnValue({
        populate: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof Registration.find>);
      vi.mocked(GuestRegistration.find).mockReturnValue({
        populate: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof GuestRegistration.find>);

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      // Should not return an error status
      expect(statusMock).not.toHaveBeenCalledWith(400);
    });
  });

  describe("exportAnalytics - CSV rows mode", () => {
    let writeMock: ReturnType<typeof vi.fn>;
    let endMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      vi.mocked(hasPermission).mockReturnValue(true);
      writeMock = vi.fn().mockReturnValue(true);
      endMock = vi.fn().mockReturnValue(res);
      (res as Record<string, unknown>).write = writeMock;
      (res as Record<string, unknown>).end = endMock;
      (res as Record<string, unknown>).setHeader = vi.fn();
    });

    it("should export CSV in rows mode with users, events, and registrations", async () => {
      req.query = { format: "csv", mode: "rows" };

      const { User, Event, Registration, GuestRegistration } =
        await import("../../../../src/models");

      vi.mocked(User.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([
          {
            username: "testuser",
            email: "test@example.com",
            role: "member",
            createdAt: new Date("2025-01-01"),
          },
        ]),
      } as unknown as ReturnType<typeof User.find>);
      vi.mocked(Event.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([
          {
            title: "Test Event",
            format: "in-person",
            status: "upcoming",
            createdAt: new Date("2025-01-02"),
          },
        ]),
      } as unknown as ReturnType<typeof Event.find>);
      vi.mocked(Registration.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([
          {
            userId: "user-123",
            eventId: "event-456",
            status: "active",
            registrationDate: new Date("2025-01-03"),
          },
        ]),
      } as unknown as ReturnType<typeof Registration.find>);
      vi.mocked(GuestRegistration.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof GuestRegistration.find>);

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      // Should write headers and data
      expect(writeMock).toHaveBeenCalledWith("# Users\n");
      expect(writeMock).toHaveBeenCalledWith("Username,Email,Role,CreatedAt\n");
      expect(writeMock).toHaveBeenCalledWith("# Events\n");
      expect(writeMock).toHaveBeenCalledWith("Title,Format,Status,CreatedAt\n");
      expect(writeMock).toHaveBeenCalledWith("# Registrations\n");
      expect(writeMock).toHaveBeenCalledWith(
        "UserId,UserEmail,UserName,EventId,EventTitle,RoleId,RoleName,Status,AttendanceStatus,AttendanceConfirmed,RegistrationDate\n",
      );
      expect(endMock).toHaveBeenCalled();
    });

    it("should handle rows with commas and newlines", async () => {
      req.query = { format: "csv", mode: "rows" };

      const { User, Event, Registration, GuestRegistration } =
        await import("../../../../src/models");

      vi.mocked(User.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([
          {
            username: "user,\nwith,commas",
            email: "test\r@example.com",
            role: "=2+2",
            createdAt: new Date("2025-01-01"),
          },
        ]),
      } as unknown as ReturnType<typeof User.find>);
      vi.mocked(Event.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof Event.find>);
      vi.mocked(Registration.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof Registration.find>);
      vi.mocked(GuestRegistration.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof GuestRegistration.find>);

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      // Check that commas and newlines are replaced
      const userRow = writeMock.mock.calls.find(
        (call: unknown[]) =>
          typeof call[0] === "string" && call[0].includes("user with commas"),
      );
      expect(userRow).toBeDefined();
      expect(userRow?.[0]).toContain(",'=2+2,");
    });

    it("should serialize ObjectId-like registration references without recursing", async () => {
      req.query = { format: "csv", mode: "rows" };
      const objectIdHex = "507f1f77bcf86cd799439011";
      const objectIdLike = {
        toHexString: () => objectIdHex,
        toString: () => "should-not-use-to-string",
      } as Record<string, unknown> & {
        toHexString: () => string;
        toString: () => string;
      };
      Object.defineProperty(objectIdLike, "_id", {
        get: () => objectIdLike,
      });

      const { User, Event, Registration, GuestRegistration } =
        await import("../../../../src/models");

      vi.mocked(User.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof User.find>);
      vi.mocked(Event.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof Event.find>);
      vi.mocked(Registration.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([
          {
            userId: objectIdLike,
            eventId: objectIdLike,
            roleId: "role-1",
            status: "active",
            registrationDate: new Date("2025-01-03"),
            registeredBy: objectIdLike,
          },
        ]),
      } as unknown as ReturnType<typeof Registration.find>);
      vi.mocked(GuestRegistration.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof GuestRegistration.find>);

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      expect(statusMock).not.toHaveBeenCalledWith(500);
      expect(writeMock).toHaveBeenCalledWith(
        expect.stringContaining(objectIdHex),
      );
      expect(endMock).toHaveBeenCalled();
    });
  });

  describe("exportAnalytics - date filtering", () => {
    beforeEach(() => {
      vi.mocked(hasPermission).mockReturnValue(true);
      res.setHeader = vi.fn();
      res.send = vi.fn();
    });

    it("should accept from and to date parameters", async () => {
      req.query = {
        format: "json",
        from: "2025-01-01",
        to: "2025-12-31",
      };

      const { User, Event, Registration, GuestRegistration } =
        await import("../../../../src/models");
      vi.mocked(User.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof User.find>);
      vi.mocked(Event.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof Event.find>);
      vi.mocked(Registration.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof Registration.find>);
      vi.mocked(GuestRegistration.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof GuestRegistration.find>);

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      expect(statusMock).not.toHaveBeenCalledWith(400);
    });

    it("should accept maxRows parameter", async () => {
      req.query = { format: "json", maxRows: "100" };

      const { User, Event, Registration, GuestRegistration } =
        await import("../../../../src/models");
      vi.mocked(User.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof User.find>);
      vi.mocked(Event.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof Event.find>);
      vi.mocked(Registration.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof Registration.find>);
      vi.mocked(GuestRegistration.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      } as unknown as ReturnType<typeof GuestRegistration.find>);

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      expect(statusMock).not.toHaveBeenCalledWith(400);
    });
  });

  describe("exportAnalytics - error handling", () => {
    beforeEach(() => {
      vi.mocked(hasPermission).mockReturnValue(true);
    });

    it("should return 500 on unexpected errors", async () => {
      req.query = { format: "json" };

      const { User } = await import("../../../../src/models");
      vi.mocked(User.find).mockImplementation(() => {
        throw new Error("Database connection failed");
      });

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      expect(statusMock).toHaveBeenCalledWith(500);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Failed to export analytics.",
      });
    });
  });
});
