/**
 * Unit tests for AuditLogController
 * Testing audit log retrieval and statistics for admin monitoring
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";
import { AuditLogController } from "../../../src/controllers/auditLogController";
import AuditLog from "../../../src/models/AuditLog";

// Mock dependencies
vi.mock("../../../src/models/AuditLog", () => ({
  default: {
    find: vi.fn(),
    countDocuments: vi.fn(),
    aggregate: vi.fn(),
  },
}));

vi.mock("../../../src/services/LoggerService", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  })),
}));

describe("AuditLogController", () => {
  let mockReq: Partial<Request> & { user?: any };
  let mockRes: Partial<Response>;
  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    mockReq = {
      query: {},
      user: {
        _id: "user123",
        role: "Administrator",
      } as any,
    };

    mockRes = {
      status: statusMock as any,
      json: jsonMock as any,
    };
  });

  describe("getAuditLogs", () => {
    describe("pagination", () => {
      beforeEach(() => {
        const mockFind = vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            skip: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                populate: vi.fn().mockReturnValue({
                  populate: vi.fn().mockReturnValue({
                    populate: vi.fn().mockReturnValue({
                      lean: vi.fn().mockResolvedValue([]),
                    }),
                  }),
                }),
              }),
            }),
          }),
        });

        vi.mocked(AuditLog.find).mockImplementation(mockFind as any);
        vi.mocked(AuditLog.countDocuments).mockResolvedValue(0);
      });

      it("should use default page 1 and limit 20 when not provided", async () => {
        mockReq.query = {};

        await AuditLogController.getAuditLogs(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
            data: expect.objectContaining({
              pagination: expect.objectContaining({
                currentPage: 1,
                limit: 20,
              }),
            }),
          }),
        );
      });

      it("should parse page and limit from query parameters", async () => {
        mockReq.query = { page: "2", limit: "50" };

        await AuditLogController.getAuditLogs(
          mockReq as Request,
          mockRes as Response,
        );

        const response = jsonMock.mock.calls[0][0];
        expect(response.data.pagination.currentPage).toBe(2);
        expect(response.data.pagination.limit).toBe(50);
      });

      it("should cap limit at 100", async () => {
        mockReq.query = { limit: "500" };

        await AuditLogController.getAuditLogs(
          mockReq as Request,
          mockRes as Response,
        );

        const response = jsonMock.mock.calls[0][0];
        expect(response.data.pagination.limit).toBe(100);
      });

      it("should enforce minimum page of 1", async () => {
        mockReq.query = { page: "-5" };

        await AuditLogController.getAuditLogs(
          mockReq as Request,
          mockRes as Response,
        );

        const response = jsonMock.mock.calls[0][0];
        expect(response.data.pagination.currentPage).toBe(1);
      });

      it("should enforce minimum limit of 1", async () => {
        mockReq.query = { limit: "0" };

        await AuditLogController.getAuditLogs(
          mockReq as Request,
          mockRes as Response,
        );

        const response = jsonMock.mock.calls[0][0];
        expect(response.data.pagination.limit).toBe(1);
      });

      it("should calculate pagination info correctly", async () => {
        vi.mocked(AuditLog.countDocuments).mockResolvedValue(95);
        mockReq.query = { page: "2", limit: "20" };

        await AuditLogController.getAuditLogs(
          mockReq as Request,
          mockRes as Response,
        );

        const response = jsonMock.mock.calls[0][0];
        expect(response.data.pagination).toEqual({
          currentPage: 2,
          totalPages: 5,
          totalCount: 95,
          hasNextPage: true,
          hasPrevPage: true,
          limit: 20,
        });
      });
    });

    describe("filtering", () => {
      let mockFindChain: any;

      beforeEach(() => {
        mockFindChain = {
          sort: vi.fn().mockReturnThis(),
          skip: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          populate: vi.fn().mockReturnThis(),
          lean: vi.fn().mockResolvedValue([]),
        };

        vi.mocked(AuditLog.find).mockReturnValue(mockFindChain);
        vi.mocked(AuditLog.countDocuments).mockResolvedValue(0);
      });

      it("should filter by action", async () => {
        mockReq.query = { action: "user_login" };

        await AuditLogController.getAuditLogs(
          mockReq as Request,
          mockRes as Response,
        );

        expect(AuditLog.find).toHaveBeenCalledWith(
          expect.objectContaining({ action: "user_login" }),
        );
      });

      it("should filter by eventId", async () => {
        mockReq.query = { eventId: "event123" };

        await AuditLogController.getAuditLogs(
          mockReq as Request,
          mockRes as Response,
        );

        expect(AuditLog.find).toHaveBeenCalledWith(
          expect.objectContaining({
            $and: [
              {
                $or: [{ targetModel: "Event", targetId: "event123" }],
              },
            ],
          }),
        );
      });

      it("should filter by actorId", async () => {
        mockReq.query = { actorId: "user123" };

        await AuditLogController.getAuditLogs(
          mockReq as Request,
          mockRes as Response,
        );

        expect(AuditLog.find).toHaveBeenCalledWith(
          expect.objectContaining({
            $and: [
              {
                $or: [{ actorKey: "user123" }],
              },
            ],
          }),
        );
      });

      it("should filter by date range", async () => {
        mockReq.query = { date: "2025-01-15" };

        await AuditLogController.getAuditLogs(
          mockReq as Request,
          mockRes as Response,
        );

        const filterCall = (vi.mocked(AuditLog.find).mock.calls[0] as any)[0];
        expect(filterCall).toHaveProperty("createdAt");
        expect(filterCall.createdAt).toHaveProperty("$gte");
        expect(filterCall.createdAt).toHaveProperty("$lt");
      });

      it("should combine multiple filters", async () => {
        mockReq.query = {
          action: "event_created",
          actorId: "user123",
          eventId: "event456",
        };

        await AuditLogController.getAuditLogs(
          mockReq as Request,
          mockRes as Response,
        );

        expect(AuditLog.find).toHaveBeenCalledWith({
          action: "event_created",
          $and: [
            {
              $or: [{ targetModel: "Event", targetId: "event456" }],
            },
            {
              $or: [{ actorKey: "user123" }],
            },
          ],
        });
      });

      it("includes legacy ObjectId fields only for cast-safe filters", async () => {
        const objectId = "507f1f77bcf86cd799439011";
        mockReq.query = { eventId: objectId, actorId: objectId };

        await AuditLogController.getAuditLogs(
          mockReq as Request,
          mockRes as Response,
        );

        expect(AuditLog.find).toHaveBeenCalledWith({
          $and: [
            {
              $or: [
                { eventId: objectId },
                { targetModel: "Event", targetId: objectId },
              ],
            },
            {
              $or: [
                { actorId: objectId },
                { "actor.id": objectId },
                { actorKey: objectId },
              ],
            },
          ],
        });
      });

      it("should ignore non-string filter values", async () => {
        mockReq.query = {
          action: ["array", "value"] as any,
          eventId: 123 as any,
        };

        await AuditLogController.getAuditLogs(
          mockReq as Request,
          mockRes as Response,
        );

        expect(AuditLog.find).toHaveBeenCalledWith({});
      });
    });

    describe("data formatting", () => {
      it("should format audit logs with new actor format", async () => {
        const mockLogs = [
          {
            _id: { toString: () => "log123" },
            action: "event_created",
            actor: {
              id: {
                _id: "user123",
                username: "adminuser",
                email: "admin@example.com",
                firstName: "Admin",
                lastName: "User",
              },
              role: "Administrator",
              email: "admin@example.com",
            },
            metadata: { test: "data" },
            createdAt: new Date("2025-01-15"),
          },
        ];

        const mockFind = vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            skip: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                populate: vi.fn().mockReturnValue({
                  populate: vi.fn().mockReturnValue({
                    populate: vi.fn().mockReturnValue({
                      lean: vi.fn().mockResolvedValue(mockLogs),
                    }),
                  }),
                }),
              }),
            }),
          }),
        });

        vi.mocked(AuditLog.find).mockImplementation(mockFind as any);
        vi.mocked(AuditLog.countDocuments).mockResolvedValue(1);

        await AuditLogController.getAuditLogs(
          mockReq as Request,
          mockRes as Response,
        );

        const response = jsonMock.mock.calls[0][0];
        expect(response.data.auditLogs[0]).toMatchObject({
          id: "log123",
          action: "event_created",
          actorId: "user123",
          actorInfo: {
            username: "adminuser",
            email: "admin@example.com",
            name: "Admin User",
          },
        });
      });

      it("should format audit logs with old populated actorId format", async () => {
        const mockLogs = [
          {
            _id: { toString: () => "log123" },
            action: "user_updated",
            actorId: {
              _id: "user123",
              username: "johndoe",
              email: "john@example.com",
              firstName: "John",
              lastName: "Doe",
            },
            metadata: {},
            createdAt: new Date("2025-01-15"),
          },
        ];

        const mockFind = vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            skip: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                populate: vi.fn().mockReturnValue({
                  populate: vi.fn().mockReturnValue({
                    populate: vi.fn().mockReturnValue({
                      lean: vi.fn().mockResolvedValue(mockLogs),
                    }),
                  }),
                }),
              }),
            }),
          }),
        });

        vi.mocked(AuditLog.find).mockImplementation(mockFind as any);
        vi.mocked(AuditLog.countDocuments).mockResolvedValue(1);

        await AuditLogController.getAuditLogs(
          mockReq as Request,
          mockRes as Response,
        );

        const response = jsonMock.mock.calls[0][0];
        expect(response.data.auditLogs[0].actorInfo).toEqual({
          username: "johndoe",
          email: "john@example.com",
          name: "John Doe",
          role: "User",
        });
      });

      it("should handle string actorId (unpopulated)", async () => {
        const mockLogs = [
          {
            _id: { toString: () => "log123" },
            action: "event_deleted",
            actorId: "user123",
            metadata: {},
            createdAt: new Date("2025-01-15"),
          },
        ];

        const mockFind = vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            skip: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                populate: vi.fn().mockReturnValue({
                  populate: vi.fn().mockReturnValue({
                    populate: vi.fn().mockReturnValue({
                      lean: vi.fn().mockResolvedValue(mockLogs),
                    }),
                  }),
                }),
              }),
            }),
          }),
        });

        vi.mocked(AuditLog.find).mockImplementation(mockFind as any);
        vi.mocked(AuditLog.countDocuments).mockResolvedValue(1);

        await AuditLogController.getAuditLogs(
          mockReq as Request,
          mockRes as Response,
        );

        const response = jsonMock.mock.calls[0][0];
        expect(response.data.auditLogs[0].actorId).toBe("user123");
        expect(response.data.auditLogs[0].actorInfo).toBeNull();
      });

      it("should expose a privacy-safe worker actor and version 2 fields", async () => {
        const mockLogs = [
          {
            _id: { toString: () => "log-worker" },
            version: 2,
            action: "event.reminder.send",
            actorType: "worker",
            actorKey: "event-reminder",
            source: "worker",
            correlationId: "run-123",
            outcome: "success",
            reasonCode: "allowed",
            createdAt: new Date("2025-01-15"),
          },
        ];
        const chain = {
          sort: vi.fn().mockReturnThis(),
          skip: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          populate: vi.fn().mockReturnThis(),
          lean: vi.fn().mockResolvedValue(mockLogs),
        };
        vi.mocked(AuditLog.find).mockReturnValue(chain as never);
        vi.mocked(AuditLog.countDocuments).mockResolvedValue(1);

        await AuditLogController.getAuditLogs(
          mockReq as Request,
          mockRes as Response,
        );

        expect(jsonMock.mock.calls[0][0].data.auditLogs[0]).toMatchObject({
          version: 2,
          actorType: "worker",
          actorKey: "event-reminder",
          source: "worker",
          correlationId: "run-123",
          outcome: "success",
          reasonCode: "allowed",
          actorInfo: {
            username: "event-reminder",
            email: "",
            name: "event-reminder",
            role: "Worker",
          },
        });
      });

      it("should format audit logs with new targetModel/targetId format", async () => {
        const mockLogs = [
          {
            _id: { toString: () => "log123" },
            action: "event_updated",
            actor: {
              id: "user123",
              role: "Organizer",
              email: "org@example.com",
            },
            targetModel: "Event",
            targetId: "event456",
            details: {
              targetEvent: {
                title: "Test Event",
              },
            },
            metadata: {},
            createdAt: new Date("2025-01-15"),
          },
        ];

        const mockFind = vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            skip: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                populate: vi.fn().mockReturnValue({
                  populate: vi.fn().mockReturnValue({
                    populate: vi.fn().mockReturnValue({
                      lean: vi.fn().mockResolvedValue(mockLogs),
                    }),
                  }),
                }),
              }),
            }),
          }),
        });

        vi.mocked(AuditLog.find).mockImplementation(mockFind as any);
        vi.mocked(AuditLog.countDocuments).mockResolvedValue(1);

        await AuditLogController.getAuditLogs(
          mockReq as Request,
          mockRes as Response,
        );

        const response = jsonMock.mock.calls[0][0];
        expect(response.data.auditLogs[0]).toMatchObject({
          eventId: "event456",
          eventTitle: "Test Event",
          targetModel: "Event",
          targetId: "event456",
        });
      });

      it("should handle targetEvent object without title", async () => {
        const mockLogs = [
          {
            _id: { toString: () => "log123" },
            action: "event_updated",
            actor: {
              id: "user123",
              role: "Organizer",
              email: "org@example.com",
            },
            targetModel: "Event",
            targetId: "event456",
            details: {
              targetEvent: {
                // No title property
                location: "Some Location",
              },
            },
            metadata: {},
            createdAt: new Date("2025-01-15"),
          },
        ];

        const mockFind = vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            skip: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                populate: vi.fn().mockReturnValue({
                  populate: vi.fn().mockReturnValue({
                    populate: vi.fn().mockReturnValue({
                      lean: vi.fn().mockResolvedValue(mockLogs),
                    }),
                  }),
                }),
              }),
            }),
          }),
        });

        vi.mocked(AuditLog.find).mockImplementation(mockFind as any);
        vi.mocked(AuditLog.countDocuments).mockResolvedValue(1);

        await AuditLogController.getAuditLogs(
          mockReq as Request,
          mockRes as Response,
        );

        const response = jsonMock.mock.calls[0][0];
        expect(response.data.auditLogs[0]).toMatchObject({
          eventId: "event456",
          eventTitle: null,
          targetModel: "Event",
          targetId: "event456",
        });
      });

      it("should format audit logs with old populated eventId format", async () => {
        const mockLogs = [
          {
            _id: { toString: () => "log123" },
            action: "event_published",
            actorId: "user123",
            eventId: {
              _id: "event456",
              title: "Published Event",
            },
            metadata: {},
            createdAt: new Date("2025-01-15"),
          },
        ];

        const mockFind = vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            skip: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                populate: vi.fn().mockReturnValue({
                  populate: vi.fn().mockReturnValue({
                    populate: vi.fn().mockReturnValue({
                      lean: vi.fn().mockResolvedValue(mockLogs),
                    }),
                  }),
                }),
              }),
            }),
          }),
        });

        vi.mocked(AuditLog.find).mockImplementation(mockFind as any);
        vi.mocked(AuditLog.countDocuments).mockResolvedValue(1);

        await AuditLogController.getAuditLogs(
          mockReq as Request,
          mockRes as Response,
        );

        const response = jsonMock.mock.calls[0][0];
        expect(response.data.auditLogs[0].eventId).toBe("event456");
        expect(response.data.auditLogs[0].eventTitle).toBe("Published Event");
      });

      it("should handle string eventId (unpopulated)", async () => {
        const mockLogs = [
          {
            _id: { toString: () => "log123" },
            action: "event_created",
            actorId: "user123",
            eventId: "event456",
            metadata: {},
            createdAt: new Date("2025-01-15"),
          },
        ];

        const mockFind = vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            skip: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                populate: vi.fn().mockReturnValue({
                  populate: vi.fn().mockReturnValue({
                    populate: vi.fn().mockReturnValue({
                      lean: vi.fn().mockResolvedValue(mockLogs),
                    }),
                  }),
                }),
              }),
            }),
          }),
        });

        vi.mocked(AuditLog.find).mockImplementation(mockFind as any);
        vi.mocked(AuditLog.countDocuments).mockResolvedValue(1);

        await AuditLogController.getAuditLogs(
          mockReq as Request,
          mockRes as Response,
        );

        const response = jsonMock.mock.calls[0][0];
        expect(response.data.auditLogs[0].eventId).toBe("event456");
        expect(response.data.auditLogs[0].eventTitle).toBeNull();
      });

      it("should include all relevant fields in response", async () => {
        const mockLogs = [
          {
            _id: { toString: () => "log123" },
            action: "user_login",
            actorId: "user123",
            metadata: { loginMethod: "password" },
            details: { additionalInfo: "test" },
            ipHash: "hashed_ip",
            emailHash: "hashed_email",
            ipAddress: "192.168.1.1",
            userAgent: "Mozilla/5.0",
            createdAt: new Date("2025-01-15"),
          },
        ];

        const mockFind = vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            skip: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                populate: vi.fn().mockReturnValue({
                  populate: vi.fn().mockReturnValue({
                    populate: vi.fn().mockReturnValue({
                      lean: vi.fn().mockResolvedValue(mockLogs),
                    }),
                  }),
                }),
              }),
            }),
          }),
        });

        vi.mocked(AuditLog.find).mockImplementation(mockFind as any);
        vi.mocked(AuditLog.countDocuments).mockResolvedValue(1);

        await AuditLogController.getAuditLogs(
          mockReq as Request,
          mockRes as Response,
        );

        const response = jsonMock.mock.calls[0][0];
        const log = response.data.auditLogs[0];
        expect(log).toHaveProperty("metadata");
        expect(log).toHaveProperty("details");
        expect(log).toHaveProperty("ipHash");
        expect(log).toHaveProperty("emailHash");
        expect(log).toHaveProperty("ipAddress");
        expect(log).toHaveProperty("userAgent");
        expect(log).toHaveProperty("createdAt");
      });
    });

    describe("response structure", () => {
      beforeEach(() => {
        const mockFind = vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            skip: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                populate: vi.fn().mockReturnValue({
                  populate: vi.fn().mockReturnValue({
                    populate: vi.fn().mockReturnValue({
                      lean: vi.fn().mockResolvedValue([]),
                    }),
                  }),
                }),
              }),
            }),
          }),
        });

        vi.mocked(AuditLog.find).mockImplementation(mockFind as any);
        vi.mocked(AuditLog.countDocuments).mockResolvedValue(0);
      });

      it("should return success response with correct structure", async () => {
        await AuditLogController.getAuditLogs(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          data: {
            auditLogs: expect.any(Array),
            pagination: expect.objectContaining({
              currentPage: expect.any(Number),
              totalPages: expect.any(Number),
              totalCount: expect.any(Number),
              hasNextPage: expect.any(Boolean),
              hasPrevPage: expect.any(Boolean),
              limit: expect.any(Number),
            }),
            filters: expect.objectContaining({
              action: null,
              date: null,
              eventId: null,
              actorId: null,
            }),
          },
        });
      });

      it("should include applied filters in response", async () => {
        mockReq.query = {
          action: "user_login",
          date: "2025-01-15",
          actorId: "user123",
        };

        await AuditLogController.getAuditLogs(
          mockReq as Request,
          mockRes as Response,
        );

        const response = jsonMock.mock.calls[0][0];
        expect(response.data.filters).toEqual({
          action: "user_login",
          date: "2025-01-15",
          eventId: null,
          actorId: "user123",
        });
      });
    });

    describe("error handling", () => {
      it("should return 500 when database query fails", async () => {
        vi.mocked(AuditLog.find).mockImplementation(() => {
          throw new Error("Database connection lost");
        });

        await AuditLogController.getAuditLogs(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Failed to fetch audit logs",
          error: undefined,
        });
      });

      it("should include error message in development mode", async () => {
        process.env.NODE_ENV = "development";
        vi.mocked(AuditLog.find).mockImplementation(() => {
          throw new Error("Database error");
        });

        await AuditLogController.getAuditLogs(
          mockReq as Request,
          mockRes as Response,
        );

        const response = jsonMock.mock.calls[0][0];
        expect(response.error).toBe("Database error");

        delete process.env.NODE_ENV;
      });
    });
  });

  describe("getAuditLogStats", () => {
    describe("date range calculation", () => {
      it("should default to 30 days when not specified", async () => {
        mockReq.query = {};

        vi.mocked(AuditLog.aggregate).mockResolvedValue([]);
        vi.mocked(AuditLog.countDocuments).mockResolvedValue(0);

        await AuditLogController.getAuditLogStats(
          mockReq as Request,
          mockRes as Response,
        );

        const response = jsonMock.mock.calls[0][0];
        expect(response.data.period.days).toBe(30);
      });

      it("should use custom days from query parameter", async () => {
        mockReq.query = { days: "7" };

        vi.mocked(AuditLog.aggregate).mockResolvedValue([]);
        vi.mocked(AuditLog.countDocuments).mockResolvedValue(0);

        await AuditLogController.getAuditLogStats(
          mockReq as Request,
          mockRes as Response,
        );

        const response = jsonMock.mock.calls[0][0];
        expect(response.data.period.days).toBe(7);
      });

      it("should calculate start date correctly", async () => {
        mockReq.query = { days: "15" };

        vi.mocked(AuditLog.aggregate).mockResolvedValue([]);
        vi.mocked(AuditLog.countDocuments).mockResolvedValue(0);

        const beforeTest = new Date();
        beforeTest.setDate(beforeTest.getDate() - 15);

        await AuditLogController.getAuditLogStats(
          mockReq as Request,
          mockRes as Response,
        );

        const afterTest = new Date();
        afterTest.setDate(afterTest.getDate() - 15);

        const response = jsonMock.mock.calls[0][0];
        const startDate = new Date(response.data.period.startDate);

        expect(startDate.getTime()).toBeGreaterThanOrEqual(
          beforeTest.getTime(),
        );
        expect(startDate.getTime()).toBeLessThanOrEqual(afterTest.getTime());
      });
    });

    describe("aggregation and statistics", () => {
      it("should aggregate audit logs by action", async () => {
        const mockStats = [
          {
            _id: "user_login",
            count: 150,
            lastOccurrence: new Date("2025-01-15"),
          },
          {
            _id: "event_created",
            count: 45,
            lastOccurrence: new Date("2025-01-14"),
          },
          {
            _id: "user_updated",
            count: 30,
            lastOccurrence: new Date("2025-01-13"),
          },
        ];

        vi.mocked(AuditLog.aggregate).mockResolvedValue(mockStats);
        vi.mocked(AuditLog.countDocuments).mockResolvedValue(225);

        await AuditLogController.getAuditLogStats(
          mockReq as Request,
          mockRes as Response,
        );

        expect(AuditLog.aggregate).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              $match: expect.objectContaining({
                createdAt: expect.objectContaining({ $gte: expect.any(Date) }),
              }),
            }),
            expect.objectContaining({
              $group: expect.objectContaining({
                _id: "$action",
                count: { $sum: 1 },
                lastOccurrence: { $max: "$createdAt" },
              }),
            }),
            expect.objectContaining({
              $sort: { count: -1 },
            }),
          ]),
        );

        const response = jsonMock.mock.calls[0][0];
        expect(response.data.actionStats).toEqual(mockStats);
        expect(response.data.totalLogs).toBe(225);
      });

      it("should handle empty statistics gracefully", async () => {
        vi.mocked(AuditLog.aggregate).mockResolvedValue([]);
        vi.mocked(AuditLog.countDocuments).mockResolvedValue(0);

        await AuditLogController.getAuditLogStats(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        const response = jsonMock.mock.calls[0][0];
        expect(response.data.actionStats).toEqual([]);
        expect(response.data.totalLogs).toBe(0);
      });
    });

    describe("response structure", () => {
      it("should return success response with correct structure", async () => {
        vi.mocked(AuditLog.aggregate).mockResolvedValue([]);
        vi.mocked(AuditLog.countDocuments).mockResolvedValue(0);

        await AuditLogController.getAuditLogStats(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          data: {
            period: {
              days: expect.any(Number),
              startDate: expect.any(Date),
              endDate: expect.any(Date),
            },
            totalLogs: expect.any(Number),
            actionStats: expect.any(Array),
          },
        });
      });

      it("should include period information in response", async () => {
        mockReq.query = { days: "7" };

        vi.mocked(AuditLog.aggregate).mockResolvedValue([]);
        vi.mocked(AuditLog.countDocuments).mockResolvedValue(0);

        await AuditLogController.getAuditLogStats(
          mockReq as Request,
          mockRes as Response,
        );

        const response = jsonMock.mock.calls[0][0];
        expect(response.data.period).toHaveProperty("days", 7);
        expect(response.data.period).toHaveProperty("startDate");
        expect(response.data.period).toHaveProperty("endDate");
      });
    });

    describe("error handling", () => {
      it("should return 500 when aggregation fails", async () => {
        vi.mocked(AuditLog.aggregate).mockRejectedValue(
          new Error("Aggregation failed"),
        );

        await AuditLogController.getAuditLogStats(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Failed to fetch audit log statistics",
          error: undefined,
        });
      });

      it("should include error message in development mode", async () => {
        process.env.NODE_ENV = "development";
        vi.mocked(AuditLog.aggregate).mockRejectedValue(
          new Error("Aggregation error"),
        );

        await AuditLogController.getAuditLogStats(
          mockReq as Request,
          mockRes as Response,
        );

        const response = jsonMock.mock.calls[0][0];
        expect(response.error).toBe("Aggregation error");

        delete process.env.NODE_ENV;
      });

      it("should handle countDocuments failure", async () => {
        vi.mocked(AuditLog.aggregate).mockResolvedValue([]);
        vi.mocked(AuditLog.countDocuments).mockRejectedValue(
          new Error("Count failed"),
        );

        await AuditLogController.getAuditLogStats(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(500);
      });
    });
  });
});
