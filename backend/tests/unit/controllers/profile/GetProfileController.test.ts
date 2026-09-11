import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Request, Response } from "express";
import GetProfileController from "../../../../src/controllers/profile/GetProfileController";

vi.mock("../../../../src/models", () => ({
  User: { findById: vi.fn() },
}));

import { User } from "../../../../src/models";

interface MockUser {
  _id: string;
  username: string;
  email: string;
  phone?: string;
  birthYear?: number;
  residenceCity?: string;
  residenceRegion?: string | null;
  residenceCountryCode?: string;
  employmentStatus?: string;
  firstName: string;
  lastName: string;
  gender?: string;
  avatar?: string;
  role: string;
  isAtCloudLeader: boolean;
  roleInAtCloud?: string;
  homeAddress?: string;
  occupation?: string;
  company?: string;
  weeklyChurch?: string;
  churchAddress?: string;
  lastLogin?: Date;
  createdAt: Date;
  isVerified: boolean;
  isActive: boolean;
}

interface MockRequest {
  user?: MockUser;
}

describe("GetProfileController", () => {
  let mockReq: MockRequest;
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
        _id: "user123",
        username: "testuser",
        email: "test@example.com",
        phone: "555-1234",
        birthYear: 1990,
        residenceCity: "Seattle",
        residenceRegion: "US-WA",
        residenceCountryCode: "US",
        employmentStatus: "employed",
        firstName: "John",
        lastName: "Doe",
        gender: "male",
        avatar: "http://example.com/avatar.jpg",
        role: "Participant",
        isAtCloudLeader: false,
        roleInAtCloud: undefined,
        homeAddress: "123 Main St",
        occupation: "Developer",
        company: "Tech Corp",
        weeklyChurch: "Community Church",
        churchAddress: "456 Church Ave",
        lastLogin: new Date("2025-01-15"),
        createdAt: new Date("2024-01-01"),
        isVerified: true,
        isActive: true,
      },
    };
    vi.mocked(User.findById).mockImplementation(
      () =>
        ({
          select: vi.fn().mockImplementation(async () => mockReq.user),
        }) as never,
    );
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe("getProfile", () => {
    describe("Authentication", () => {
      it("should return 401 if user is not authenticated", async () => {
        mockReq.user = undefined;

        await GetProfileController.getProfile(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(401);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Authentication required.",
        });
      });
    });

    describe("Successful Retrieval", () => {
      it("should return user profile data", async () => {
        await GetProfileController.getProfile(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          data: {
            user: expect.objectContaining({
              id: "user123",
              username: "testuser",
              email: "test@example.com",
              firstName: "John",
              lastName: "Doe",
              role: "Participant",
            }),
          },
        });
      });

      it("should include all profile fields", async () => {
        await GetProfileController.getProfile(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        const response = jsonMock.mock.calls[0][0];
        const userData = response.data.user;

        expect(userData).toHaveProperty("id");
        expect(userData).toHaveProperty("username");
        expect(userData).toHaveProperty("email");
        expect(userData).toHaveProperty("phone");
        expect(userData).toHaveProperty("birthYear");
        expect(userData).toHaveProperty("residenceCity");
        expect(userData).toHaveProperty("residenceRegion");
        expect(userData).toHaveProperty("residenceCountryCode");
        expect(userData).toHaveProperty("employmentStatus");
        expect(userData).toHaveProperty("firstName");
        expect(userData).toHaveProperty("lastName");
        expect(userData).toHaveProperty("gender");
        expect(userData).toHaveProperty("avatar");
        expect(userData).toHaveProperty("role");
        expect(userData).toHaveProperty("isAtCloudLeader");
        expect(userData).toHaveProperty("roleInAtCloud");
        expect(userData).toHaveProperty("homeAddress");
        expect(userData).toHaveProperty("occupation");
        expect(userData).toHaveProperty("company");
        expect(userData).toHaveProperty("weeklyChurch");
        expect(userData).toHaveProperty("churchAddress");
        expect(userData).toHaveProperty("lastLogin");
        expect(userData).toHaveProperty("createdAt");
        expect(userData).toHaveProperty("isVerified");
        expect(userData).toHaveProperty("isActive");
      });

      it("returns 404 when the authenticated account no longer exists", async () => {
        vi.mocked(User.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue(null),
        } as never);

        await GetProfileController.getProfile(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(404);
      });

      it("should handle user with minimal fields", async () => {
        mockReq.user = {
          _id: "user456",
          username: "minimaluser",
          email: "minimal@example.com",
          firstName: "Jane",
          lastName: "Smith",
          role: "Participant",
          isAtCloudLeader: false,
          createdAt: new Date("2024-06-01"),
          isVerified: true,
          isActive: true,
        };

        await GetProfileController.getProfile(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        const response = jsonMock.mock.calls[0][0];
        expect(response.data.user.id).toBe("user456");
        expect(response.data.user.phone).toBeUndefined();
      });

      it("should return isAtCloudLeader true when set", async () => {
        mockReq.user!.isAtCloudLeader = true;
        mockReq.user!.roleInAtCloud = "Team Lead";

        await GetProfileController.getProfile(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        const response = jsonMock.mock.calls[0][0];
        expect(response.data.user.isAtCloudLeader).toBe(true);
        expect(response.data.user.roleInAtCloud).toBe("Team Lead");
      });
    });

    describe("Error Handling", () => {
      it("should return 500 on unexpected error", async () => {
        // Create a user object that throws when accessed
        const problematicUser = new Proxy({} as MockUser, {
          get: () => {
            throw new Error("Unexpected access error");
          },
        });

        mockReq.user = problematicUser;

        await GetProfileController.getProfile(
          mockReq as unknown as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Internal server error.",
        });
        expect(consoleErrorSpy).toHaveBeenCalled();
      });
    });
  });
});
