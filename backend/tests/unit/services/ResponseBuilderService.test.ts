import { describe, it, expect, vi, beforeEach } from "vitest";
import { Types } from "mongoose";
import { ResponseBuilderService } from "../../../src/services/ResponseBuilderService";
import {
  Event,
  GuestRegistration,
  Registration,
  User,
} from "../../../src/models";
import { RegistrationQueryService } from "../../../src/services/RegistrationQueryService";
import { withSilencedConsole } from "../../test-utils/silenceConsole";

// Mock the models
vi.mock("../../../src/models", () => ({
  Event: {
    findById: vi.fn(),
    find: vi.fn(),
    updateOne: vi.fn(),
  },
  Registration: {
    find: vi.fn(),
    findOne: vi.fn(),
    aggregate: vi.fn(),
  },
  GuestRegistration: {
    aggregate: vi.fn(),
  },
  User: {
    findById: vi.fn(),
    find: vi.fn(),
  },
}));

// Mock RegistrationQueryService
vi.mock("../../../src/services/RegistrationQueryService", () => ({
  RegistrationQueryService: {
    getEventSignupCounts: vi.fn(),
    getRoleAvailability: vi.fn(),
    getUserSignupInfo: vi.fn(),
    isUserRegisteredForRole: vi.fn(),
  },
}));

describe("ResponseBuilderService", () => {
  // Test ObjectIds
  const eventId = new Types.ObjectId().toString();
  const userId = new Types.ObjectId().toString();
  const roleId = new Types.ObjectId().toString();

  const mockRegistrationQuery = (registrations: unknown[]) => {
    const query = {
      select: vi.fn().mockReturnThis(),
      populate: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue(registrations),
    };
    vi.mocked(Registration.find).mockReturnValue(query as any);
    return query;
  };

  const mockOrganizerQuery = (users: unknown[]) => {
    const query = {
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue(users),
    };
    vi.mocked(User.find).mockReturnValue(query as any);
    return query;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistrationQuery([]);
    mockOrganizerQuery([]);
    vi.mocked(GuestRegistration.aggregate).mockResolvedValue([]);
  });

  describe("buildEventWithRegistrations", () => {
    it("enriches organizer contacts while redacting exact phones from public reads", async () => {
      const organizerUserId = new Types.ObjectId().toString();
      const mockEvent = {
        _id: eventId,
        title: "Contact Enrichment Event",
        description: "desc",
        location: "loc",
        date: new Date(),
        time: "10:00",
        endTime: "11:00",
        status: "upcoming",
        createdBy: {
          _id: userId,
          username: "organizer",
          firstName: "Org",
          lastName: "User",
          role: "admin",
          avatar: "avatar.jpg",
        },
        roles: [
          {
            id: roleId,
            name: "Volunteer",
            description: "Help",
            maxParticipants: 10,
          },
        ],
        organizer: "Org Unit",
        organizerDetails: [
          { userId: organizerUserId, email: "old@x.com", phone: "old" },
          { email: "keep@x.com", phone: "keep" },
        ],
      } as any;

      vi.mocked(Event.findById).mockReturnValue({
        populate: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(mockEvent),
        }),
      } as any);

      mockOrganizerQuery([
        {
          _id: organizerUserId,
          email: "new@x.com",
          phone: "123",
          firstName: "New",
          lastName: "Name",
          avatar: "a.png",
        },
      ]);

      const result =
        await ResponseBuilderService.buildEventWithRegistrations(eventId);
      expect(result).toBeTruthy();
      const orgs = (result as any).organizerDetails as any[];
      expect(orgs[0].email).toBe("new@x.com");
      expect(orgs[0].name).toBe("New Name");
      expect(orgs[0]).not.toHaveProperty("phone");
      // Stored fallback contacts follow the same exact-phone boundary.
      expect(orgs[1].email).toBe("keep@x.com");
      expect(orgs[1]).not.toHaveProperty("phone");
      expect(User.find).toHaveBeenCalledOnce();
      expect(User.findById).not.toHaveBeenCalled();
    });

    it("returns organizer exact phones to a MANAGE_USERS viewer", async () => {
      const organizerUserId = new Types.ObjectId().toString();
      const mockEvent = {
        _id: eventId,
        title: "Managed Event",
        location: "loc",
        date: "2099-01-01",
        time: "10:00",
        createdBy: {
          _id: userId,
          username: "organizer",
          firstName: "Org",
          lastName: "User",
        },
        roles: [],
        organizerDetails: [
          { userId: organizerUserId, email: "old@x.com", phone: "old" },
        ],
      };
      vi.mocked(Event.findById).mockReturnValue({
        populate: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(mockEvent),
        }),
      } as any);
      mockOrganizerQuery([
        {
          _id: organizerUserId,
          email: "new@x.com",
          phone: "+12065550123",
          firstName: "New",
          lastName: "Name",
        },
      ]);

      const result = await ResponseBuilderService.buildEventWithRegistrations(
        eventId,
        new Types.ObjectId().toString(),
        "Administrator",
      );

      expect(result?.organizerDetails?.[0].phone).toBe("+12065550123");
    });
    it("should build complete event with registration data successfully", async () => {
      // Mock event data
      const mockEvent = {
        _id: eventId,
        title: "Test Event",
        description: "Test Description",
        location: "Test Location",
        startTime: new Date("2024-12-31T10:00:00Z"),
        endTime: new Date("2024-12-31T18:00:00Z"),
        status: "upcoming",
        createdBy: {
          _id: userId,
          username: "organizer",
          firstName: "John",
          lastName: "Doe",
          role: "admin",
          avatar: "avatar.jpg",
        },
        roles: [
          {
            id: roleId,
            name: "Volunteer",
            description: "Help with event",
            maxSignups: 10,
            requirements: "None",
          },
        ],
        organizer: {
          name: "John Doe",
          email: "john@example.com",
          phone: "123-456-7890",
        },
      };

      // Mock registrations
      const mockRegistrations = [
        {
          _id: new Types.ObjectId(),
          eventId: eventId,
          roleId: roleId,
          userId: {
            _id: userId,
            username: "testuser",
            firstName: "Jane",
            lastName: "Smith",
            email: "jane@example.com",
            gender: "female",
            systemAuthorizationLevel: "user",
            roleInAtCloud: "volunteer",
            role: "user",
            avatar: "jane.jpg",
          },
          registrationDate: new Date("2024-12-01T10:00:00Z"),
          preferences: { dietary: "vegetarian" },
          status: "confirmed",
        },
      ];

      // Setup mocks
      vi.mocked(Event.findById).mockReturnValue({
        populate: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(mockEvent),
        }),
      } as any);

      mockRegistrationQuery(mockRegistrations);
      vi.mocked(GuestRegistration.aggregate).mockResolvedValue([
        { _id: roleId, count: 4 },
      ] as any);

      const result =
        await ResponseBuilderService.buildEventWithRegistrations(eventId);

      expect(result).toBeDefined();
      expect(result!.id).toBe(eventId);
      expect(result!.title).toBe("Test Event");
      expect(result!.totalRegistrations).toBe(5);
      expect(result!.roles).toHaveLength(1);
      expect(result!.roles[0].currentCount).toBe(5);
      expect(result!.roles[0].availableSpots).toBe(5);
      expect(result!.roles[0].registrations).toHaveLength(1);
      expect(result!.roles[0].registrations[0].user.firstName).toBe("Jane");
    });

    it("keeps role registrations ordered by original creation time", async () => {
      const olderUserId = new Types.ObjectId();
      const newerUserId = new Types.ObjectId();
      const mockEvent = {
        _id: eventId,
        title: "Ordered Event",
        location: "Room A",
        date: "2026-06-01",
        time: "10:00",
        status: "completed",
        createdBy: {
          _id: userId,
          username: "organizer",
          firstName: "Org",
          lastName: "User",
        },
        roles: [
          {
            id: roleId,
            name: "Participant",
            description: "Participant role",
            maxParticipants: 10,
          },
        ],
      };

      const mockRegistrations = [
        {
          _id: new Types.ObjectId("665100000000000000000002"),
          eventId,
          roleId,
          createdAt: new Date("2026-05-02T10:00:00.000Z"),
          status: "attended",
          attendanceConfirmed: true,
          userId: {
            _id: newerUserId,
            username: "newer",
            firstName: "Newer",
            lastName: "Person",
            email: "newer@example.com",
          },
        },
        {
          _id: new Types.ObjectId("665000000000000000000001"),
          eventId,
          roleId,
          createdAt: new Date("2026-05-01T10:00:00.000Z"),
          status: "active",
          attendanceConfirmed: false,
          userId: {
            _id: olderUserId,
            username: "older",
            firstName: "Older",
            lastName: "Person",
            email: "older@example.com",
          },
        },
      ];

      vi.mocked(Event.findById).mockReturnValue({
        populate: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(mockEvent),
        }),
      } as any);

      mockRegistrationQuery(mockRegistrations);

      const result =
        await ResponseBuilderService.buildEventWithRegistrations(eventId);

      expect(
        result!.roles[0].registrations.map(
          (registration) => registration.user.firstName,
        ),
      ).toEqual(["Older", "Newer"]);
    });

    it("should return null when event is not found", async () => {
      vi.mocked(Event.findById).mockReturnValue({
        populate: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(null),
        }),
      } as any);

      const result =
        await ResponseBuilderService.buildEventWithRegistrations(eventId);

      expect(result).toBeNull();
      expect(Event.findById).toHaveBeenCalledWith(eventId);
    });

    it("keeps detail query count constant across roles and organizers", async () => {
      const secondRoleId = new Types.ObjectId().toString();
      const firstOrganizerId = new Types.ObjectId();
      const secondOrganizerId = new Types.ObjectId();
      const mockEvent = {
        _id: eventId,
        title: "Constant Query Event",
        date: "2099-01-01",
        time: "10:00",
        endTime: "11:00",
        roles: [
          { id: roleId, name: "Attendee", maxParticipants: 5 },
          { id: secondRoleId, name: "Volunteer", maxParticipants: 4 },
        ],
        organizerDetails: [
          { userId: firstOrganizerId, email: "old-1@example.com" },
          { userId: secondOrganizerId, email: "old-2@example.com" },
        ],
        createdBy: {
          _id: userId,
          username: "organizer",
          firstName: "Event",
          lastName: "Owner",
        },
      };
      const registration = {
        _id: new Types.ObjectId(),
        eventId,
        roleId,
        userId: {
          _id: new Types.ObjectId(),
          username: "participant",
          firstName: "Pat",
          lastName: "One",
        },
      };

      vi.mocked(Event.findById).mockReturnValue({
        populate: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(mockEvent),
        }),
      } as any);
      const registrationQuery = mockRegistrationQuery([registration]);
      vi.mocked(GuestRegistration.aggregate).mockResolvedValue([
        { _id: secondRoleId, count: 2 },
      ] as any);
      mockOrganizerQuery([
        {
          _id: firstOrganizerId,
          email: "fresh-1@example.com",
          firstName: "First",
          lastName: "Organizer",
        },
        {
          _id: secondOrganizerId,
          email: "fresh-2@example.com",
          firstName: "Second",
          lastName: "Organizer",
        },
      ]);

      const result =
        await ResponseBuilderService.buildEventWithRegistrations(eventId);

      expect(result).toMatchObject({ signedUp: 3, totalSlots: 9 });
      expect(result!.roles.map((role) => role.currentCount)).toEqual([1, 2]);
      expect(Event.findById).toHaveBeenCalledOnce();
      expect(Registration.find).toHaveBeenCalledOnce();
      expect(registrationQuery.select).toHaveBeenCalledOnce();
      expect(GuestRegistration.aggregate).toHaveBeenCalledOnce();
      expect(User.find).toHaveBeenCalledOnce();
      expect(
        RegistrationQueryService.getEventSignupCounts,
      ).not.toHaveBeenCalled();
      expect(Event.updateOne).not.toHaveBeenCalled();
    });

    it("should handle database errors gracefully", async () => {
      vi.mocked(Event.findById).mockReturnValue({
        populate: vi.fn().mockReturnValue({
          lean: vi.fn().mockRejectedValue(new Error("Database error")),
        }),
      } as any);

      const result = await withSilencedConsole(["error"], () =>
        ResponseBuilderService.buildEventWithRegistrations(eventId),
      );

      expect(result).toBeNull();
    });
  });

  describe("buildEventsWithRegistrations", () => {
    it("builds page summaries with one user and one guest aggregation", async () => {
      const event1Id = new Types.ObjectId();
      const event2Id = new Types.ObjectId();

      const mockEvents = [
        {
          _id: event1Id,
          title: "Event 1",
          date: "2099-01-01",
          time: "10:00",
          endTime: "11:00",
          roles: [
            {
              id: "attendee",
              name: "Attendee",
              maxParticipants: 5,
            },
          ],
          createdBy: {
            _id: new Types.ObjectId(),
            username: "organizer1",
            firstName: "One",
            lastName: "Organizer",
          },
        },
        {
          _id: event2Id,
          title: "Event 2",
          date: "2099-01-02",
          time: "10:00",
          endTime: "11:00",
          roles: [
            {
              id: "volunteer",
              name: "Volunteer",
              maxParticipants: 4,
            },
          ],
          createdBy: {
            _id: new Types.ObjectId(),
            username: "organizer2",
            firstName: "Two",
            lastName: "Organizer",
          },
        },
      ];

      vi.mocked(Registration.aggregate).mockResolvedValue([
        {
          _id: { eventId: event1Id, roleId: "attendee" },
          count: 2,
        },
        {
          _id: { eventId: event2Id, roleId: "volunteer" },
          count: 1,
        },
      ] as any);
      vi.mocked(GuestRegistration.aggregate).mockResolvedValue([
        {
          _id: { eventId: event1Id, roleId: "attendee" },
          count: 1,
        },
        {
          _id: { eventId: event2Id, roleId: "volunteer" },
          count: 2,
        },
      ] as any);

      const result =
        await ResponseBuilderService.buildEventsWithRegistrations(
          mockEvents as any,
        );

      expect(result).toHaveLength(2);
      expect(Registration.aggregate).toHaveBeenCalledOnce();
      expect(GuestRegistration.aggregate).toHaveBeenCalledOnce();
      expect(result[0]).toMatchObject({
        id: event1Id.toString(),
        signedUp: 3,
        totalSlots: 5,
        availableSpots: 2,
        status: "upcoming",
      });
      expect(result[0].roles[0]).toMatchObject({
        currentCount: 3,
        currentSignups: [],
      });
      expect(result[1]).toMatchObject({
        id: event2Id.toString(),
        signedUp: 3,
        totalSlots: 4,
        availableSpots: 1,
      });
      expect(Event.findById).not.toHaveBeenCalled();
    });

    it("returns immediately for an empty page", async () => {
      const result = await ResponseBuilderService.buildEventsWithRegistrations(
        [],
      );

      expect(result).toEqual([]);
      expect(Registration.aggregate).not.toHaveBeenCalled();
      expect(GuestRegistration.aggregate).not.toHaveBeenCalled();
    });

    it("surfaces aggregate failures to the controller", async () => {
      vi.mocked(Registration.aggregate).mockRejectedValue(
        new Error("aggregate failed"),
      );
      vi.mocked(GuestRegistration.aggregate).mockResolvedValue([]);

      await expect(
        ResponseBuilderService.buildEventsWithRegistrations([
          { _id: new Types.ObjectId() },
        ]),
      ).rejects.toThrow("aggregate failed");
    });
  });

  describe("buildAnalyticsEventData", () => {
    it("applies defaults when counts are missing and computes 0% registrationRate", async () => {
      const mockEvents = [
        {
          _id: eventId,
          title: "Analytics Defaults",
          time: "10:00",
          location: "loc",
          status: "upcoming",
          format: "in-person",
          type: "meetup",
          createdBy: {
            _id: userId,
            username: "creator",
            firstName: "A",
            lastName: "B",
          },
          roles: [
            {
              id: roleId,
              name: "Volunteer",
              maxParticipants: 10,
            },
          ],
        },
      ];

      vi.mocked(
        RegistrationQueryService.getEventSignupCounts,
      ).mockResolvedValue(undefined as any);
      vi.mocked(Registration.find).mockReturnValue({
        populate: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      const result = await ResponseBuilderService.buildAnalyticsEventData(
        mockEvents as any,
      );
      expect(result).toHaveLength(1);
      const analytics = result[0] as any;
      expect(analytics.totalCapacity).toBe(0);
      expect(analytics.totalRegistrations).toBe(0);
      expect(analytics.registrationRate).toBe(0);
      // hostedBy falls back to default when not provided on event
      expect(analytics.hostedBy).toBe("@Cloud Marketplace Ministry");
      // endTime falls back to time when missing on event
      expect(analytics.endTime).toBe("10:00");
    });
    it("should build analytics event data successfully", async () => {
      const mockEvents = [
        {
          _id: eventId,
          title: "Analytics Event",
          startTime: new Date("2024-12-31T10:00:00Z"),
          status: "upcoming",
          createdBy: {
            _id: userId,
            username: "creator",
            firstName: "John",
            lastName: "Doe",
          },
          roles: [
            {
              id: roleId,
              name: "Volunteer",
              maxParticipants: 10,
            },
          ],
        },
      ];

      const mockEventSignupCounts = {
        eventId: eventId,
        totalSignups: 8,
        totalSlots: 10,
        roles: [
          {
            roleId: roleId,
            roleName: "Volunteer",
            maxParticipants: 10,
            currentCount: 8,
            availableSpots: 2,
            isFull: false,
            waitlistCount: 0,
          },
        ],
      };

      const mockRegistrations = [
        {
          _id: new Types.ObjectId(),
          eventId: eventId,
          roleId: roleId,
          userId: {
            _id: userId,
            gender: "female",
          },
          registrationDate: new Date("2024-12-01T10:00:00Z"),
        },
      ];

      vi.mocked(
        RegistrationQueryService.getEventSignupCounts,
      ).mockResolvedValue(mockEventSignupCounts);

      vi.mocked(Registration.find).mockReturnValue({
        populate: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(mockRegistrations),
        }),
      } as any);

      const result =
        await ResponseBuilderService.buildAnalyticsEventData(mockEvents);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(eventId);
      expect(result[0].title).toBe("Analytics Event");
      expect(result[0].totalRegistrations).toBe(8);
      expect(result[0].registrationRate).toBeDefined();
    });

    it("should handle empty events array", async () => {
      vi.mocked(Event.find).mockReturnValue({
        lean: vi.fn().mockResolvedValue([]),
      } as any);

      const result = await ResponseBuilderService.buildAnalyticsEventData([]);

      expect(result).toEqual([]);
    });

    it("should handle database errors gracefully", async () => {
      vi.mocked(Event.find).mockReturnValue({
        lean: vi.fn().mockRejectedValue(new Error("Database error")),
      } as any);

      const result = await withSilencedConsole(["error"], () =>
        ResponseBuilderService.buildAnalyticsEventData([]),
      );

      expect(result).toEqual([]);
    });
  });

  describe("buildUserSignupStatus", () => {
    it("returns null if event is not found or user not found", async () => {
      vi.mocked(Registration.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as any);
      vi.mocked(RegistrationQueryService.getUserSignupInfo).mockResolvedValue({
        canSignupForMore: true,
        currentSignups: 0,
        maxAllowedSignups: 1,
      } as any);
      vi.mocked(
        RegistrationQueryService.getEventSignupCounts,
      ).mockResolvedValue({ roles: [] } as any);

      // Event missing -> null
      vi.mocked(Event.findById).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as any);
      let res = await ResponseBuilderService.buildUserSignupStatus(
        userId,
        eventId,
      );
      expect(res).toBeNull();

      // Event present but user missing -> null
      vi.mocked(Event.findById).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: eventId, roles: [] }),
      } as any);
      vi.mocked(User.findById).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as any);
      res = await ResponseBuilderService.buildUserSignupStatus(userId, eventId);
      expect(res).toBeNull();
    });

    it("applies Participant restrictions and available roles when counts allow", async () => {
      const mockEvent = {
        _id: eventId,
        roles: [
          { id: "r1", name: "Common Participant (on-site)" },
          { id: "r2", name: "Leader" },
        ],
      } as any;

      vi.mocked(Registration.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as any);
      vi.mocked(RegistrationQueryService.getUserSignupInfo).mockResolvedValue({
        canSignupForMore: true,
        currentSignups: 0,
        maxAllowedSignups: 1,
      } as any);
      vi.mocked(
        RegistrationQueryService.getEventSignupCounts,
      ).mockResolvedValue({
        roles: [
          { roleId: "r1", isFull: false },
          { roleId: "r2", isFull: false },
        ],
      } as any);
      vi.mocked(Event.findById).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockEvent),
      } as any);
      vi.mocked(User.findById).mockReturnValue({
        lean: vi
          .fn()
          .mockResolvedValue({ systemAuthorizationLevel: "Participant" }),
      } as any);

      const res = await ResponseBuilderService.buildUserSignupStatus(
        userId,
        eventId,
      );
      expect(res).toBeTruthy();
      expect(res!.availableRoles).toContain("Common Participant (on-site)");
      expect(res!.restrictedRoles).toContain("Leader");
      expect(res!.canSignup).toBe(true);
    });
    it("should build user signup status successfully", async () => {
      const mockUserInfo = {
        userId: userId,
        currentSignups: 3,
        maxAllowedSignups: 5,
        canSignupForMore: true,
        activeRegistrations: [],
      };

      const mockRegistration = {
        _id: new Types.ObjectId(),
        eventId: eventId,
        roleId: roleId,
        userId: userId,
      };

      const mockEvent = {
        _id: eventId,
        title: "User Event",
        startTime: new Date("2024-12-31T10:00:00Z"),
        location: "Test Location",
        roles: [
          {
            id: roleId,
            name: "Common Participant (on-site)",
            maxParticipants: 10,
          },
        ],
      };

      const mockUser = {
        _id: userId,
        systemAuthorizationLevel: "User",
        firstName: "Test",
        lastName: "User",
      };

      const mockEventSignupCounts = {
        eventId: eventId,
        totalSignups: 3,
        totalSlots: 10,
        roles: [
          {
            roleId: roleId,
            roleName: "Common Participant (on-site)",
            maxParticipants: 10,
            currentCount: 3,
            availableSpots: 7,
            isFull: false,
            waitlistCount: 0,
          },
        ],
      };

      vi.mocked(Registration.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockRegistration),
      } as any);

      vi.mocked(RegistrationQueryService.getUserSignupInfo).mockResolvedValue(
        mockUserInfo,
      );
      vi.mocked(
        RegistrationQueryService.getEventSignupCounts,
      ).mockResolvedValue(mockEventSignupCounts);

      vi.mocked(Event.findById).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockEvent),
      } as any);

      vi.mocked(User.findById).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockUser),
      } as any);

      const result = await ResponseBuilderService.buildUserSignupStatus(
        userId,
        eventId,
      );

      expect(result).toBeDefined();
      expect(result.userId).toBe(userId);
      expect(result.eventId).toBe(eventId);
      expect(result.isRegistered).toBe(true);
      expect(result.canSignupForMoreRoles).toBe(true);
      expect(result.currentSignupCount).toBe(3);
      expect(result.maxAllowedSignups).toBe(5);
    });

    it("should return null when user signup info is not available", async () => {
      vi.mocked(Registration.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as any);

      vi.mocked(RegistrationQueryService.getUserSignupInfo).mockResolvedValue(
        null,
      );

      const result = await ResponseBuilderService.buildUserSignupStatus(
        userId,
        eventId,
      );

      expect(result).toBeNull();
    });

    it("should handle database errors gracefully", async () => {
      vi.mocked(Registration.findOne).mockReturnValue({
        lean: vi.fn().mockRejectedValue(new Error("Database error")),
      } as any);

      const result = await withSilencedConsole(["error"], () =>
        ResponseBuilderService.buildUserSignupStatus(userId, eventId),
      );

      expect(result).toBeNull();
    });
  });
});
