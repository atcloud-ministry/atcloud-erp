import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Request, Response } from "express";
import UserAnalyticsController from "../../../../src/controllers/analytics/UserAnalyticsController";

// Mock dependencies
vi.mock("../../../../src/models", () => ({
  User: {
    aggregate: vi.fn(),
  },
}));

vi.mock("../../../../src/utils/roleUtils", () => ({
  hasPermission: vi.fn(),
  PERMISSIONS: {
    VIEW_SYSTEM_ANALYTICS: "view_system_analytics",
  },
  ROLES: {
    SUPER_ADMIN: "Super Admin",
    ADMINISTRATOR: "Administrator",
    LEADER: "Leader",
    GUEST_EXPERT: "Guest Expert",
    PARTICIPANT: "Participant",
  },
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

import { User } from "../../../../src/models";
import { hasPermission } from "../../../../src/utils/roleUtils";

describe("UserAnalyticsController", () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let consoleErrorSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();

    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    mockRes = {
      status: statusMock as unknown as Response["status"],
      json: jsonMock as unknown as Response["json"],
    };

    mockReq = {
      user: {
        _id: "user-id-123",
        role: "Super Admin",
      },
      query: {},
    } as unknown as Partial<Request>;
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe("getUserAnalytics", () => {
    describe("Authentication", () => {
      it("should return 401 if user is not authenticated", async () => {
        mockReq.user = undefined;

        await UserAnalyticsController.getUserAnalytics(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(401);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Authentication required.",
        });
      });
    });

    describe("Authorization", () => {
      it("should return 403 if user lacks VIEW_SYSTEM_ANALYTICS permission", async () => {
        vi.mocked(hasPermission).mockReturnValue(false);

        await UserAnalyticsController.getUserAnalytics(
          mockReq as Request,
          mockRes as Response,
        );

        expect(hasPermission).toHaveBeenCalledWith(
          "Super Admin",
          "view_system_analytics",
        );
        expect(statusMock).toHaveBeenCalledWith(403);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Insufficient permissions to view user analytics.",
        });
      });
    });

    describe("Successful Retrieval", () => {
      const mockUsersByRole = [
        { _id: "Participant", count: 50 },
        { _id: "Leader", count: 10 },
        { _id: "Administrator", count: 5 },
      ];

      const mockUsersByAtCloudStatus = [
        { _id: true, count: 15 },
        { _id: false, count: 50 },
      ];

      const mockUsersByChurch = [
        { _id: "First Baptist", count: 20 },
        { _id: "Grace Community", count: 15 },
      ];

      const mockRegistrationTrends = [
        { _id: { year: 2025, month: 1 }, count: 5 },
        { _id: { year: 2025, month: 2 }, count: 8 },
      ];

      const mockUsersByOccupation = [
        { _id: "Engineer", count: 2 },
        { _id: "Teacher", count: 1 },
      ];

      const mockDemographicRows = [
        {
          role: "Super Admin",
          isActive: true,
          isAtCloudLeader: true,
          weeklyChurch: "First Baptist",
          churchAddress: "1 Main St",
          occupation: "Engineer",
        },
        {
          role: "Participant",
          isActive: false,
          isAtCloudLeader: false,
          occupation: "Engineer",
        },
      ];

      beforeEach(() => {
        vi.mocked(hasPermission).mockReturnValue(true);
        vi.mocked(User.aggregate)
          .mockResolvedValueOnce(mockUsersByRole)
          .mockResolvedValueOnce(mockUsersByAtCloudStatus)
          .mockResolvedValueOnce(mockUsersByChurch)
          .mockResolvedValueOnce(mockRegistrationTrends)
          .mockResolvedValueOnce(mockUsersByOccupation)
          .mockResolvedValueOnce(mockDemographicRows);
      });

      it("should return user analytics data", async () => {
        await UserAnalyticsController.getUserAnalytics(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          data: {
            usersByRole: mockUsersByRole,
            usersByAtCloudStatus: mockUsersByAtCloudStatus,
            usersByChurch: mockUsersByChurch,
            registrationTrends: mockRegistrationTrends,
            usersByOccupation: mockUsersByOccupation,
            totalUsers: 2,
            activeUsers: 1,
            demographics: {
              roleStats: {
                total: 2,
                superAdmin: 1,
                administrators: 0,
                leaders: 0,
                guestExperts: 0,
                participants: 1,
                atCloudLeaders: 1,
              },
              churchAnalytics: {
                weeklyChurchStats: { "First Baptist": 1 },
                churchAddressStats: { "1 Main St": 1 },
                usersWithChurchInfo: 1,
                usersWithoutChurchInfo: 1,
                totalChurches: 1,
                totalChurchLocations: 1,
                churchParticipationRate: 50,
              },
              occupationAnalytics: {
                occupationStats: { Engineer: 2 },
                usersWithOccupation: 2,
                usersWithoutOccupation: 0,
                totalOccupationTypes: 1,
                topOccupations: [{ occupation: "Engineer", count: 2 }],
                occupationCompletionRate: 100,
              },
            },
          },
        });
      });

      it("should call User.aggregate six times for different analytics", async () => {
        await UserAnalyticsController.getUserAnalytics(
          mockReq as Request,
          mockRes as Response,
        );

        expect(User.aggregate).toHaveBeenCalledTimes(6);
      });
    });

    describe("Error Handling", () => {
      it("should return 500 on database error", async () => {
        vi.mocked(hasPermission).mockReturnValue(true);
        vi.mocked(User.aggregate).mockRejectedValue(
          new Error("Database connection failed"),
        );

        await UserAnalyticsController.getUserAnalytics(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Failed to retrieve user analytics.",
        });
      });

      it("should log error details on failure", async () => {
        vi.mocked(hasPermission).mockReturnValue(true);
        const testError = new Error("Test database error");
        vi.mocked(User.aggregate).mockRejectedValue(testError);

        await UserAnalyticsController.getUserAnalytics(
          mockReq as Request,
          mockRes as Response,
        );

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          "Get user analytics error:",
          testError,
        );
      });
    });
  });
});
