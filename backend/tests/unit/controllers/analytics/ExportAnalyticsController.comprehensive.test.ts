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
    book_new: vi.fn(() => ({ SheetNames: [], Sheets: {} })),
    aoa_to_sheet: vi.fn((data) => ({ data })),
    book_append_sheet: vi.fn(),
  },
  write: vi.fn(() => Buffer.from("test-xlsx-content")),
}));

import { hasPermission } from "../../../../src/utils/roleUtils";
import {
  User,
  Event,
  Registration,
  GuestRegistration,
  Program,
} from "../../../../src/models";
import Purchase from "../../../../src/models/Purchase";
import DonationTransaction from "../../../../src/models/DonationTransaction";
import * as XLSX from "xlsx";

describe("ExportAnalyticsController - Comprehensive Coverage", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let jsonMock: ReturnType<typeof vi.fn>;
  let statusMock: ReturnType<typeof vi.fn>;
  let setHeaderMock: ReturnType<typeof vi.fn>;
  let sendMock: ReturnType<typeof vi.fn>;
  let writeMock: ReturnType<typeof vi.fn>;
  let endMock: ReturnType<typeof vi.fn>;

  // Comprehensive mock data for users with all columns
  const mockUsersComplete = [
    {
      username: "john.doe",
      firstName: "John",
      lastName: "Doe",
      email: "john@example.com",
      phone: "555-1234",
      birthYear: 1987,
      residenceCity: "Seattle",
      residenceRegion: "US-WA",
      residenceCountryCode: "US",
      employmentStatus: "employed",
      role: "member",
      isAtCloudLeader: true,
      roleInAtCloud: "Team Lead",
      gender: "male",
      occupation: "Software Engineer",
      company: "Tech Corp",
      weeklyChurch: "Grace Church",
      churchAddress: "123 Church St",
      isVerified: true,
      isActive: true,
      lastLogin: new Date("2025-12-01"),
      createdAt: new Date("2025-01-15"),
    },
    {
      username: "jane.smith",
      firstName: "Jane",
      lastName: "Smith",
      email: "jane@example.com",
      phone: "555-5678",
      birthYear: 1992,
      residenceCity: "Vancouver",
      residenceRegion: "CA-BC",
      residenceCountryCode: "CA",
      employmentStatus: "employed",
      role: "admin",
      isAtCloudLeader: false,
      roleInAtCloud: undefined,
      gender: "female",
      occupation: "Product Manager",
      company: "Startup Inc",
      weeklyChurch: undefined,
      churchAddress: undefined,
      isVerified: true,
      isActive: true,
      lastLogin: new Date("2025-12-10"),
      createdAt: new Date("2025-02-20"),
    },
    {
      // User with minimal/null fields
      username: "minimal.user",
      email: "minimal@example.com",
      role: "member",
      isAtCloudLeader: false,
      isVerified: false,
      isActive: false,
      createdAt: new Date("2025-03-01"),
    },
  ];

  // Comprehensive mock data for events with all columns
  const mockEventsComplete = [
    {
      title: "Annual Conference 2025",
      type: "conference",
      date: new Date("2025-06-15"),
      endDate: new Date("2025-06-17"),
      time: "09:00",
      endTime: "17:00",
      timeZone: "America/Los_Angeles",
      location: "San Francisco Convention Center",
      format: "in-person",
      status: "published",
      hostedBy: "Tech Community",
      organizer: "user-org-123",
      roles: [
        { name: "Speaker", maxParticipants: 20 },
        { name: "Attendee", maxParticipants: 500 },
      ],
      totalSlots: 520,
      signedUp: 125,
      createdBy: {
        username: "admin",
        firstName: "Admin",
        lastName: "User",
        email: "admin@example.com",
      },
      createdAt: new Date("2025-03-01"),
    },
    {
      title: "Virtual Workshop",
      type: "workshop",
      date: new Date("2025-07-20"),
      time: "14:00",
      endTime: "16:00",
      timeZone: "America/New_York",
      location: "Online",
      format: "virtual",
      status: "upcoming",
      createdBy: "simple-user-id",
      createdAt: new Date("2025-04-01"),
    },
    {
      // Event with minimal fields
      title: "Quick Meetup",
      type: "meetup",
      createdAt: new Date("2025-05-01"),
    },
  ];

  // Comprehensive mock data for registrations with all columns
  const mockRegistrationsComplete = [
    {
      userId: "user-123",
      eventId: "event-456",
      roleId: "role-speaker",
      status: "confirmed",
      registrationDate: new Date("2025-05-01"),
      attendanceConfirmed: true,
      notes: "VIP guest",
      specialRequirements: "Wheelchair access",
      registeredBy: "admin-user",
      userSnapshot: {
        username: "john.doe",
        firstName: "John",
        lastName: "Doe",
        email: "john@example.com",
      },
      eventSnapshot: {
        title: "Annual Conference",
        date: "2025-06-15",
        time: "09:00",
        location: "San Francisco",
        type: "conference",
        roleName: "Speaker",
      },
    },
    {
      userId: "user-789",
      eventId: "event-456",
      roleId: "role-attendee",
      status: "pending",
      registrationDate: new Date("2025-05-15"),
      attendanceConfirmed: false,
    },
    {
      // Registration with minimal fields
      userId: "user-minimal",
      eventId: "event-minimal",
      status: "cancelled",
    },
  ];

  // Comprehensive mock data for guest registrations
  const mockGuestRegistrationsComplete = [
    {
      fullName: "Guest User One",
      gender: "male",
      email: "guest1@example.com",
      phone: "555-9999",
      status: "confirmed",
      registrationDate: new Date("2025-05-20"),
      eventId: "event-456",
      roleId: "role-guest",
      migratedToUserId: "migrated-user-123",
      migrationStatus: "completed",
      eventSnapshot: {
        title: "Annual Conference",
        date: new Date("2025-06-15"),
        location: "San Francisco",
        roleName: "Guest Attendee",
      },
      notes: "First time guest",
    },
    {
      fullName: "Guest User Two",
      gender: "female",
      email: "guest2@example.com",
      status: "pending",
      registrationDate: new Date("2025-05-25"),
      eventId: "event-789",
    },
    {
      // Guest with minimal fields
      fullName: "Minimal Guest",
      status: "cancelled",
    },
  ];

  // Mock data for programs (purchases)
  const mockProgramsComplete = [
    {
      userId: "user-prog-1",
      programId: "prog-leadership",
      purchaseType: "program",
      orderNumber: "ORD-LEADERSHIP",
      finalPrice: 15000,
      status: "completed",
      purchaseDate: new Date("2025-02-01"),
      studentRoleName: "Participant",
      isClassRep: true,
      isEarlyBird: true,
      promoCode: "EARLY2025",
      stripePaymentIntentId: "pi_leadership123",
    },
    {
      userId: "user-prog-2",
      programId: "prog-mentorship",
      purchaseType: "program",
      orderNumber: "ORD-MENTORSHIP",
      finalPrice: 7500,
      status: "pending",
      purchaseDate: new Date("2025-03-15"),
      studentRoleName: "Mentee",
      isClassRep: false,
      isEarlyBird: false,
    },
  ];

  const mockProgramCatalogComplete = [
    {
      _id: "prog-leadership",
      title: "Leadership Program",
      programType: "NextGen",
      hostedBy: "@Cloud Marketplace Ministry",
      period: {
        startYear: "2025",
        startMonth: "06",
        endYear: "2025",
        endMonth: "08",
      },
      isFree: false,
      createdAt: new Date("2025-01-01"),
      updatedAt: new Date("2025-01-10"),
    },
    {
      _id: "prog-mentorship",
      title: "Mentorship Program",
      programType: "EMBA Mentor Circles",
      hostedBy: "@Cloud Marketplace Ministry",
      isFree: true,
      createdAt: new Date("2025-02-01"),
      updatedAt: new Date("2025-02-10"),
    },
  ];

  // Mock data for donations
  const mockDonationsComplete = [
    {
      userId: "donor-1",
      donationId: "don-monthly-1",
      amount: 5000,
      type: "recurring",
      status: "active",
      giftDate: new Date("2025-01-01"),
      stripePaymentIntentId: "pi_don_monthly",
    },
    {
      userId: "donor-2",
      donationId: "don-onetime-1",
      amount: 25000,
      type: "one-time",
      status: "completed",
      giftDate: new Date("2025-04-01"),
      stripePaymentIntentId: "pi_don_onetime",
    },
  ];

  const createChainedMock = (data: unknown[]) => ({
    select: vi.fn().mockReturnThis(),
    populate: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(data),
  });

  beforeEach(() => {
    vi.clearAllMocks();

    jsonMock = vi.fn();
    setHeaderMock = vi.fn();
    sendMock = vi.fn();
    writeMock = vi.fn().mockReturnValue(true);
    endMock = vi.fn();
    statusMock = vi.fn(() => ({ json: jsonMock })) as ReturnType<typeof vi.fn>;

    req = {
      query: { format: "json" },
      user: {
        _id: "admin-user-123",
        role: "Super Admin",
      },
    } as unknown as Partial<Request>;

    res = {
      status: statusMock,
      json: jsonMock,
      setHeader: setHeaderMock,
      send: sendMock,
      write: writeMock,
      end: endMock,
    } as unknown as Partial<Response>;

    vi.mocked(hasPermission).mockReturnValue(true);
    vi.mocked(XLSX.write).mockReturnValue(Buffer.from("test-xlsx-content"));

    // Default empty mocks
    vi.mocked(User.find).mockReturnValue(
      createChainedMock([]) as unknown as ReturnType<typeof User.find>,
    );
    vi.mocked(Event.find).mockReturnValue(
      createChainedMock([]) as unknown as ReturnType<typeof Event.find>,
    );
    vi.mocked(Registration.find).mockReturnValue(
      createChainedMock([]) as unknown as ReturnType<typeof Registration.find>,
    );
    vi.mocked(GuestRegistration.find).mockReturnValue(
      createChainedMock([]) as unknown as ReturnType<
        typeof GuestRegistration.find
      >,
    );
    vi.mocked(Program.find).mockReturnValue(
      createChainedMock([]) as unknown as ReturnType<typeof Program.find>,
    );
    vi.mocked(Purchase.find).mockReturnValue(
      createChainedMock([]) as unknown as ReturnType<typeof Purchase.find>,
    );
    vi.mocked(DonationTransaction.find).mockReturnValue(
      createChainedMock([]) as unknown as ReturnType<
        typeof DonationTransaction.find
      >,
    );
  });

  describe("JSON format - privacy-safe user allowlist", () => {
    it("should export only approved legacy user columns", async () => {
      req.query = { format: "json" };
      vi.mocked(User.find).mockReturnValue(
        createChainedMock(mockUsersComplete) as unknown as ReturnType<
          typeof User.find
        >,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      expect(setHeaderMock).toHaveBeenCalledWith(
        "Content-Type",
        "application/json",
      );
      expect(setHeaderMock).toHaveBeenCalledWith(
        "Content-Disposition",
        "attachment; filename=analytics.json",
      );
      expect(sendMock).toHaveBeenCalled();

      const sentData = JSON.parse(sendMock.mock.calls[0][0] as string);
      expect(sentData.users).toHaveLength(3);
      expect(sentData.users[0]).toMatchObject({
        username: "john.doe",
        firstName: "John",
        lastName: "Doe",
        email: "john@example.com",
        role: "member",
        isAtCloudLeader: true,
      });
      for (const privateField of [
        "phone",
        "birthYear",
        "residenceCity",
        "residenceRegion",
        "residenceCountryCode",
        "employmentStatus",
        "company",
        "occupation",
      ]) {
        expect(sentData.users[0]).not.toHaveProperty(privateField);
      }
    });

    it("should include meta information with filter dates", async () => {
      req.query = {
        format: "json",
        from: "2025-01-01",
        to: "2025-12-31",
        maxRows: "500",
      };

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const sentData = JSON.parse(sendMock.mock.calls[0][0] as string);
      expect(sentData.meta).toBeDefined();
      expect(sentData.meta.filteredFrom).toBeDefined();
      expect(sentData.meta.filteredTo).toBeDefined();
      expect(sentData.meta.rowLimit).toBe(500);
      expect(sentData.timestamp).toBeDefined();
    });
  });

  describe("JSON format - complete event data columns", () => {
    it("should export events with all columns including roles and createdBy", async () => {
      req.query = { format: "json" };
      vi.mocked(Event.find).mockReturnValue(
        createChainedMock(mockEventsComplete) as unknown as ReturnType<
          typeof Event.find
        >,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const sentData = JSON.parse(sendMock.mock.calls[0][0] as string);
      expect(sentData.events).toHaveLength(3);
      expect(sentData.events[0]).toMatchObject({
        title: "Annual Conference 2025",
        type: "conference",
        format: "in-person",
        status: "published",
        hostedBy: "Tech Community",
        totalSlots: 520,
        signedUp: 125,
      });
      expect(sentData.events[0].roles).toHaveLength(2);
      expect(sentData.events[0].createdBy).toMatchObject({
        username: "admin",
      });
    });

    it("should handle events with string createdBy", async () => {
      req.query = { format: "json" };
      vi.mocked(Event.find).mockReturnValue(
        createChainedMock([mockEventsComplete[1]]) as unknown as ReturnType<
          typeof Event.find
        >,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const sentData = JSON.parse(sendMock.mock.calls[0][0] as string);
      expect(sentData.events[0].createdBy).toBe("simple-user-id");
    });
  });

  describe("JSON format - complete registration data columns", () => {
    it("should export registrations with snapshots and all fields", async () => {
      req.query = { format: "json" };
      vi.mocked(Registration.find).mockReturnValue(
        createChainedMock(mockRegistrationsComplete) as unknown as ReturnType<
          typeof Registration.find
        >,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const sentData = JSON.parse(sendMock.mock.calls[0][0] as string);
      expect(sentData.registrations).toHaveLength(3);
      expect(sentData.registrations[0]).toMatchObject({
        userId: "user-123",
        eventId: "event-456",
        status: "confirmed",
        attendanceConfirmed: true,
        notes: "VIP guest",
        specialRequirements: "Wheelchair access",
      });
      expect(sentData.registrations[0].userSnapshot).toMatchObject({
        username: "john.doe",
      });
      expect(sentData.registrations[0].eventSnapshot).toMatchObject({
        title: "Annual Conference",
        roleName: "Speaker",
      });
    });

    it("should export registration ObjectId references as readable IDs", async () => {
      req.query = { format: "json" };
      vi.mocked(Registration.find).mockReturnValue(
        createChainedMock([
          {
            userId: { toHexString: () => "64f000000000000000000001" },
            eventId: { toHexString: () => "64f000000000000000000002" },
            registeredBy: { toHexString: () => "64f000000000000000000003" },
            roleId: "role-attendee",
            status: "attended",
            attendanceConfirmed: false,
          },
        ]) as unknown as ReturnType<typeof Registration.find>,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const sentData = JSON.parse(sendMock.mock.calls[0][0] as string);
      expect(sentData.registrations[0]).toMatchObject({
        userId: "64f000000000000000000001",
        eventId: "64f000000000000000000002",
        registeredBy: "64f000000000000000000003",
        attendanceStatus: "Attended",
      });
    });
  });

  describe("JSON format - guest registrations data", () => {
    it("should export guest registrations with all fields", async () => {
      req.query = { format: "json" };
      vi.mocked(GuestRegistration.find).mockReturnValue(
        createChainedMock(
          mockGuestRegistrationsComplete,
        ) as unknown as ReturnType<typeof GuestRegistration.find>,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const sentData = JSON.parse(sendMock.mock.calls[0][0] as string);
      expect(sentData.guestRegistrations).toHaveLength(3);
      expect(sentData.guestRegistrations[0]).toMatchObject({
        fullName: "Guest User One",
        gender: "male",
        email: "guest1@example.com",
        status: "confirmed",
        migrationStatus: "completed",
      });
      expect(sentData.guestRegistrations[0].eventSnapshot).toMatchObject({
        title: "Annual Conference",
        roleName: "Guest Attendee",
      });
    });

    it("should handle guest registrations with missing eventSnapshot", async () => {
      req.query = { format: "json" };
      const guestsWithoutSnapshot = [
        {
          fullName: "No Snapshot Guest",
          email: "nosnapshot@example.com",
          status: "pending",
        },
      ];
      vi.mocked(GuestRegistration.find).mockReturnValue(
        createChainedMock(guestsWithoutSnapshot) as unknown as ReturnType<
          typeof GuestRegistration.find
        >,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const sentData = JSON.parse(sendMock.mock.calls[0][0] as string);
      expect(sentData.guestRegistrations[0].eventSnapshot).toBeUndefined();
    });
  });

  describe("CSV summary mode", () => {
    it("should export summary counts including all types", async () => {
      req.query = { format: "csv" };

      vi.mocked(User.find).mockReturnValue(
        createChainedMock(mockUsersComplete) as unknown as ReturnType<
          typeof User.find
        >,
      );
      vi.mocked(Event.find).mockReturnValue(
        createChainedMock(mockEventsComplete) as unknown as ReturnType<
          typeof Event.find
        >,
      );
      vi.mocked(Registration.find).mockReturnValue(
        createChainedMock(mockRegistrationsComplete) as unknown as ReturnType<
          typeof Registration.find
        >,
      );
      vi.mocked(GuestRegistration.find).mockReturnValue(
        createChainedMock(
          mockGuestRegistrationsComplete,
        ) as unknown as ReturnType<typeof GuestRegistration.find>,
      );
      vi.mocked(Program.find).mockReturnValue(
        createChainedMock(mockProgramCatalogComplete) as unknown as ReturnType<
          typeof Program.find
        >,
      );
      vi.mocked(Purchase.find).mockReturnValue(
        createChainedMock(mockProgramsComplete) as unknown as ReturnType<
          typeof Purchase.find
        >,
      );
      vi.mocked(DonationTransaction.find).mockReturnValue(
        createChainedMock(mockDonationsComplete) as unknown as ReturnType<
          typeof DonationTransaction.find
        >,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      expect(setHeaderMock).toHaveBeenCalledWith("Content-Type", "text/csv");
      expect(setHeaderMock).toHaveBeenCalledWith(
        "Content-Disposition",
        "attachment; filename=analytics.csv",
      );

      const csvContent = sendMock.mock.calls[0][0] as string;
      expect(csvContent).toContain("Type,Count");
      expect(csvContent).toContain("Users,3");
      expect(csvContent).toContain("Events,3");
      expect(csvContent).toContain("Registrations,3");
      expect(csvContent).toContain("GuestRegistrations,3");
      expect(csvContent).toContain("Programs,2");
      expect(csvContent).toContain("Donations,2");
    });

    it("should exclude GuestRegistrations line when count is zero", async () => {
      req.query = { format: "csv" };

      vi.mocked(User.find).mockReturnValue(
        createChainedMock([{ username: "test" }]) as unknown as ReturnType<
          typeof User.find
        >,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const csvContent = sendMock.mock.calls[0][0] as string;
      expect(csvContent).toContain("Users,1");
      expect(csvContent).not.toContain("GuestRegistrations");
    });
  });

  describe("CSV rows mode - detailed streaming", () => {
    beforeEach(() => {
      req.query = { format: "csv", mode: "rows" };
    });

    it("should stream user rows with all fields replaced correctly", async () => {
      vi.mocked(User.find).mockReturnValue(
        createChainedMock(mockUsersComplete) as unknown as ReturnType<
          typeof User.find
        >,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      expect(writeMock).toHaveBeenCalledWith("# Users\n");
      expect(writeMock).toHaveBeenCalledWith("Username,Email,Role,CreatedAt\n");

      // Check that user data rows are written
      const userRowCalls = writeMock.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === "string" && call[0].includes("john.doe"),
      );
      expect(userRowCalls.length).toBeGreaterThan(0);

      expect(endMock).toHaveBeenCalled();
    });

    it("should stream event rows correctly", async () => {
      vi.mocked(Event.find).mockReturnValue(
        createChainedMock(mockEventsComplete) as unknown as ReturnType<
          typeof Event.find
        >,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      expect(writeMock).toHaveBeenCalledWith("# Events\n");
      expect(writeMock).toHaveBeenCalledWith("Title,Format,Status,CreatedAt\n");

      const eventRowCalls = writeMock.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === "string" &&
          call[0].includes("Annual Conference 2025"),
      );
      expect(eventRowCalls.length).toBeGreaterThan(0);
    });

    it("should stream registration rows correctly", async () => {
      vi.mocked(Registration.find).mockReturnValue(
        createChainedMock(mockRegistrationsComplete) as unknown as ReturnType<
          typeof Registration.find
        >,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      expect(writeMock).toHaveBeenCalledWith("# Registrations\n");
      expect(writeMock).toHaveBeenCalledWith(
        "UserId,UserEmail,UserName,EventId,EventTitle,RoleId,RoleName,Status,AttendanceStatus,AttendanceConfirmed,RegistrationDate\n",
      );

      const regRowCalls = writeMock.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === "string" && call[0].includes("user-123"),
      );
      expect(regRowCalls.length).toBeGreaterThan(0);
    });

    it("should handle empty data gracefully in rows mode", async () => {
      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      // Should still write headers even with no data
      expect(writeMock).toHaveBeenCalledWith("# Users\n");
      expect(writeMock).toHaveBeenCalledWith("# Events\n");
      expect(writeMock).toHaveBeenCalledWith("# Registrations\n");
      expect(endMock).toHaveBeenCalled();
    });

    it("should sanitize commas and newlines in user data", async () => {
      const usersWithSpecialChars = [
        {
          username: "user,with,commas",
          email: "test@email\n.com",
          role: "member\nwith\nnewlines",
          createdAt: new Date("2025-01-01"),
        },
      ];
      vi.mocked(User.find).mockReturnValue(
        createChainedMock(usersWithSpecialChars) as unknown as ReturnType<
          typeof User.find
        >,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      // Find the user data row (not header)
      const userRowCall = writeMock.mock.calls.find(
        (call: unknown[]) =>
          typeof call[0] === "string" &&
          call[0].includes("user with commas") &&
          !call[0].startsWith("#"),
      );
      expect(userRowCall).toBeDefined();
      // Should have replaced commas with spaces
      expect(userRowCall?.[0]).toContain("user with commas");
    });

    it("should sanitize commas and newlines in event data", async () => {
      const eventsWithSpecialChars = [
        {
          title: "Event, with, commas",
          format: "in-person\nvirtual",
          status: "published",
          createdAt: new Date("2025-01-01"),
        },
      ];
      vi.mocked(Event.find).mockReturnValue(
        createChainedMock(eventsWithSpecialChars) as unknown as ReturnType<
          typeof Event.find
        >,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const eventRowCall = writeMock.mock.calls.find(
        (call: unknown[]) =>
          typeof call[0] === "string" &&
          call[0].includes("Event  with  commas") &&
          !call[0].startsWith("#"),
      );
      expect(eventRowCall).toBeDefined();
    });
  });

  describe("XLSX format - complete sheets", () => {
    beforeEach(() => {
      req.query = { format: "xlsx" };
    });

    it("should create all sheets with complete data", async () => {
      vi.mocked(User.find).mockReturnValue(
        createChainedMock(mockUsersComplete) as unknown as ReturnType<
          typeof User.find
        >,
      );
      vi.mocked(Event.find).mockReturnValue(
        createChainedMock(mockEventsComplete) as unknown as ReturnType<
          typeof Event.find
        >,
      );
      vi.mocked(Registration.find).mockReturnValue(
        createChainedMock(mockRegistrationsComplete) as unknown as ReturnType<
          typeof Registration.find
        >,
      );
      vi.mocked(GuestRegistration.find).mockReturnValue(
        createChainedMock(
          mockGuestRegistrationsComplete,
        ) as unknown as ReturnType<typeof GuestRegistration.find>,
      );
      vi.mocked(Program.find).mockReturnValue(
        createChainedMock(mockProgramCatalogComplete) as unknown as ReturnType<
          typeof Program.find
        >,
      );
      vi.mocked(Purchase.find).mockReturnValue(
        createChainedMock(mockProgramsComplete) as unknown as ReturnType<
          typeof Purchase.find
        >,
      );
      vi.mocked(DonationTransaction.find).mockReturnValue(
        createChainedMock(mockDonationsComplete) as unknown as ReturnType<
          typeof DonationTransaction.find
        >,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      expect(setHeaderMock).toHaveBeenCalledWith(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      expect(setHeaderMock).toHaveBeenCalledWith(
        "Content-Disposition",
        "attachment; filename=analytics.xlsx",
      );

      // Verify sheets were created
      expect(XLSX.utils.book_append_sheet).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "Overview",
      );
      expect(XLSX.utils.book_append_sheet).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "Users",
      );
      expect(XLSX.utils.book_append_sheet).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "Events",
      );
      expect(XLSX.utils.book_append_sheet).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "Registrations",
      );
      expect(XLSX.utils.book_append_sheet).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "Guest Registrations",
      );
      expect(XLSX.utils.book_append_sheet).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "Programs",
      );
      expect(XLSX.utils.book_append_sheet).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "Program Catalog",
      );
      expect(XLSX.utils.book_append_sheet).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "Donations",
      );

      expect(sendMock).toHaveBeenCalled();
    });

    it("should not create Guest Registrations sheet when empty", async () => {
      // All empty
      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const sheetCalls = vi.mocked(XLSX.utils.book_append_sheet).mock.calls;
      const sheetNames = sheetCalls.map((call) => call[2]);
      expect(sheetNames).not.toContain("Guest Registrations");
    });

    it("should not create Programs sheet when empty", async () => {
      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const sheetCalls = vi.mocked(XLSX.utils.book_append_sheet).mock.calls;
      const sheetNames = sheetCalls.map((call) => call[2]);
      expect(sheetNames).not.toContain("Programs");
    });

    it("should not create Donations sheet when empty", async () => {
      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const sheetCalls = vi.mocked(XLSX.utils.book_append_sheet).mock.calls;
      const sheetNames = sheetCalls.map((call) => call[2]);
      expect(sheetNames).not.toContain("Donations");
    });

    it("should format user data correctly for XLSX", async () => {
      vi.mocked(User.find).mockReturnValue(
        createChainedMock(mockUsersComplete) as unknown as ReturnType<
          typeof User.find
        >,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      // Find the Users sheet data
      const aoaCalls = vi.mocked(XLSX.utils.aoa_to_sheet).mock.calls;
      const usersSheetCall = aoaCalls.find(
        (call) =>
          Array.isArray(call[0]) && call[0][0] && call[0][0][0] === "Username",
      );

      expect(usersSheetCall).toBeDefined();
      const userData = usersSheetCall?.[0] as unknown[][];
      // Header row
      expect(userData[0]).toEqual([
        "Username",
        "First Name",
        "Last Name",
        "Role",
        "@Cloud Co-worker",
        "Join Date",
      ]);
      // First data row
      expect(userData[1][0]).toBe("john.doe");
      expect(userData[1][1]).toBe("John");
      expect(userData[1][2]).toBe("Doe");
      expect(userData[1][3]).toBe("member");
      expect(userData[1][4]).toBe("Yes"); // isAtCloudLeader = true
    });

    it("should format event data correctly for XLSX", async () => {
      vi.mocked(Event.find).mockReturnValue(
        createChainedMock(mockEventsComplete) as unknown as ReturnType<
          typeof Event.find
        >,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const aoaCalls = vi.mocked(XLSX.utils.aoa_to_sheet).mock.calls;
      const eventsSheetCall = aoaCalls.find(
        (call) =>
          Array.isArray(call[0]) && call[0][0] && call[0][0][0] === "Title",
      );

      expect(eventsSheetCall).toBeDefined();
      const eventData = eventsSheetCall?.[0] as unknown[][];
      expect(eventData[0]).toEqual([
        "Title",
        "Type",
        "Date",
        "Location",
        "Format",
        "Status",
        "Created Date",
      ]);
    });

    it("should format registration data correctly for XLSX", async () => {
      vi.mocked(Registration.find).mockReturnValue(
        createChainedMock(mockRegistrationsComplete) as unknown as ReturnType<
          typeof Registration.find
        >,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const aoaCalls = vi.mocked(XLSX.utils.aoa_to_sheet).mock.calls;
      const regSheetCall = aoaCalls.find(
        (call) =>
          Array.isArray(call[0]) && call[0][0] && call[0][0][0] === "User ID",
      );

      expect(regSheetCall).toBeDefined();
      const regData = regSheetCall?.[0] as unknown[][];
      expect(regData[0]).toEqual([
        "User ID",
        "User Email",
        "User Name",
        "Event ID",
        "Event Title",
        "Role ID",
        "Role Name",
        "Registration Status",
        "Attendance Status",
        "Attendance Confirmed",
        "Registration Date",
        "Registered By",
        "Notes",
        "Special Requirements",
      ]);
      expect(regData[1][0]).toBe("user-123");
      expect(regData[1][1]).toBe("john@example.com");
      expect(regData[1][2]).toBe("John Doe");
      expect(regData[1][3]).toBe("event-456");
      expect(regData[1][4]).toBe("Annual Conference");
      expect(regData[1][8]).toBe("Attended");
      expect(regData[1][9]).toBe("Yes");
    });

    it("should format guest registration data correctly for XLSX", async () => {
      vi.mocked(GuestRegistration.find).mockReturnValue(
        createChainedMock(
          mockGuestRegistrationsComplete,
        ) as unknown as ReturnType<typeof GuestRegistration.find>,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const aoaCalls = vi.mocked(XLSX.utils.aoa_to_sheet).mock.calls;
      const guestSheetCall = aoaCalls.find(
        (call) =>
          Array.isArray(call[0]) && call[0][0] && call[0][0][0] === "Full Name",
      );

      expect(guestSheetCall).toBeDefined();
      const guestData = guestSheetCall?.[0] as unknown[][];
      expect(guestData[0]).toEqual([
        "Full Name",
        "Gender",
        "Email",
        "Phone",
        "Event ID",
        "Event Title",
        "Event Date",
        "Location",
        "Role Name",
        "Status",
        "Migrated To User ID",
        "Migration Status",
        "Notes",
        "Registration Date",
      ]);
    });

    it("should format programs data correctly for XLSX", async () => {
      vi.mocked(Program.find).mockReturnValue(
        createChainedMock(mockProgramCatalogComplete) as unknown as ReturnType<
          typeof Program.find
        >,
      );
      vi.mocked(Purchase.find).mockReturnValue(
        createChainedMock(mockProgramsComplete) as unknown as ReturnType<
          typeof Purchase.find
        >,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const aoaCalls = vi.mocked(XLSX.utils.aoa_to_sheet).mock.calls;
      const programsSheetCall = aoaCalls.find(
        (call) =>
          Array.isArray(call[0]) &&
          call[0][0] &&
          call[0][0][3] === "Program Title",
      );

      expect(programsSheetCall).toBeDefined();
      const progData = programsSheetCall?.[0] as unknown[][];
      expect(progData[0]).toEqual([
        "User ID",
        "Purchase Type",
        "Program ID",
        "Program Title",
        "Order Number",
        "Final Price (cents)",
        "Status",
        "Purchase Date",
        "Student Role",
        "Class Rep",
        "Early Bird",
        "Promo Code",
        "Stripe Payment Intent",
      ]);
      // First program row
      expect(progData[1][0]).toBe("user-prog-1");
      expect(progData[1][2]).toBe("prog-leadership");
      expect(progData[1][3]).toBe("Leadership Program");
      expect(progData[1][5]).toBe(15000);
      expect(progData[1][9]).toBe("Yes"); // isClassRep
      expect(progData[1][10]).toBe("Yes"); // isEarlyBird
      expect(progData[1][11]).toBe("EARLY2025");
    });

    it("should resolve program titles when purchase programId is an ObjectId reference", async () => {
      req.query = { format: "json" };
      vi.mocked(Program.find).mockReturnValue(
        createChainedMock(mockProgramCatalogComplete) as unknown as ReturnType<
          typeof Program.find
        >,
      );
      vi.mocked(Purchase.find).mockReturnValue(
        createChainedMock([
          {
            userId: { toHexString: () => "64f000000000000000000004" },
            programId: { toHexString: () => "prog-leadership" },
            finalPrice: 15000,
            status: "completed",
          },
        ]) as unknown as ReturnType<typeof Purchase.find>,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const sentData = JSON.parse(sendMock.mock.calls[0][0] as string);
      expect(sentData.programs[0]).toMatchObject({
        userId: "64f000000000000000000004",
        programId: "prog-leadership",
        programTitle: "Leadership Program",
      });
    });

    it("should include a program catalog lookup sheet for program names", async () => {
      vi.mocked(Program.find).mockReturnValue(
        createChainedMock(mockProgramCatalogComplete) as unknown as ReturnType<
          typeof Program.find
        >,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const aoaCalls = vi.mocked(XLSX.utils.aoa_to_sheet).mock.calls;
      const catalogSheetCall = aoaCalls.find(
        (call) =>
          Array.isArray(call[0]) &&
          call[0][0] &&
          call[0][0][0] === "Program ID" &&
          call[0][0][1] === "Program Name",
      );

      expect(catalogSheetCall).toBeDefined();
      const catalogData = catalogSheetCall?.[0] as unknown[][];
      expect(catalogData[1][0]).toBe("prog-leadership");
      expect(catalogData[1][1]).toBe("Leadership Program");
      expect(catalogData[1][2]).toBe("NextGen");
      expect(catalogData[1][4]).toBe("2025-06 to 2025-08");
    });

    it("should format donations data correctly for XLSX", async () => {
      vi.mocked(DonationTransaction.find).mockReturnValue(
        createChainedMock(mockDonationsComplete) as unknown as ReturnType<
          typeof DonationTransaction.find
        >,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const aoaCalls = vi.mocked(XLSX.utils.aoa_to_sheet).mock.calls;
      const donationsSheetCall = aoaCalls.find(
        (call) =>
          Array.isArray(call[0]) &&
          call[0][0] &&
          call[0][0][2] === "Amount (cents)",
      );

      expect(donationsSheetCall).toBeDefined();
      const donData = donationsSheetCall?.[0] as unknown[][];
      expect(donData[0]).toEqual([
        "User ID",
        "Donation ID",
        "Amount (cents)",
        "Type",
        "Status",
        "Gift Date",
        "Stripe Payment Intent",
      ]);
    });
  });

  describe("Date filtering parameters", () => {
    it("should export all-time data when no dates provided", async () => {
      req.query = { format: "json" };

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const sentData = JSON.parse(sendMock.mock.calls[0][0] as string);
      expect(sentData.meta.scope).toBe("all");
      expect(sentData.meta.filteredFrom).toBeNull();
      expect(sentData.meta.filteredTo).toBeNull();
    });

    it("should respect custom from and to dates", async () => {
      req.query = {
        format: "json",
        from: "2025-03-01",
        to: "2025-06-30",
      };

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const sentData = JSON.parse(sendMock.mock.calls[0][0] as string);
      expect(sentData.meta.filteredFrom).toContain("2025-03-01");
      expect(sentData.meta.filteredTo).toContain("2025-06-30");
    });

    it("should cap maxRows at 25000 (hard cap)", async () => {
      req.query = {
        format: "json",
        maxRows: "50000", // Exceeds hard cap
      };

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const sentData = JSON.parse(sendMock.mock.calls[0][0] as string);
      expect(sentData.meta.rowLimit).toBe(25000);
    });

    it("should use the hard cap as the default when maxRows is not provided", async () => {
      req.query = { format: "json" };

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const sentData = JSON.parse(sendMock.mock.calls[0][0] as string);
      expect(sentData.meta.rowLimit).toBe(25000);
    });

    it("should handle invalid maxRows gracefully", async () => {
      req.query = {
        format: "json",
        maxRows: "not-a-number",
      };

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const sentData = JSON.parse(sendMock.mock.calls[0][0] as string);
      expect(sentData.meta.rowLimit).toBe(25000); // Falls back to default
    });

    it("should handle negative maxRows by using 0 or default", async () => {
      req.query = {
        format: "json",
        maxRows: "-100",
      };

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const sentData = JSON.parse(sendMock.mock.calls[0][0] as string);
      // Math.max(0, -100) = 0, then || DEFAULT_ROW_CAP = 25000
      expect(sentData.meta.rowLimit).toBe(25000);
    });

    it("should respect valid custom maxRows within limits", async () => {
      req.query = {
        format: "json",
        maxRows: "1000",
      };

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const sentData = JSON.parse(sendMock.mock.calls[0][0] as string);
      expect(sentData.meta.rowLimit).toBe(1000);
    });
  });

  describe("Error handling", () => {
    it("should return 500 when User.find throws error", async () => {
      req.query = { format: "json" };
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

    it("should return 500 when Event.find throws error", async () => {
      req.query = { format: "json" };
      vi.mocked(Event.find).mockImplementation(() => {
        throw new Error("Event query failed");
      });

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      expect(statusMock).toHaveBeenCalledWith(500);
    });

    it("should return 500 when Registration.find throws error", async () => {
      req.query = { format: "json" };
      vi.mocked(Registration.find).mockImplementation(() => {
        throw new Error("Registration query failed");
      });

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      expect(statusMock).toHaveBeenCalledWith(500);
    });

    it("should continue when GuestRegistration.find throws (non-strict)", async () => {
      req.query = { format: "json" };
      vi.mocked(GuestRegistration.find).mockImplementation(() => {
        throw new Error("Guest registration query failed");
      });

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      // Should not return 500 since GuestRegistration fetch is wrapped in try-catch
      expect(sendMock).toHaveBeenCalled();
      const sentData = JSON.parse(sendMock.mock.calls[0][0] as string);
      expect(sentData.guestRegistrations).toEqual([]);
    });

    it("should continue when Purchase.find throws (non-strict)", async () => {
      req.query = { format: "json" };
      vi.mocked(Purchase.find).mockImplementation(() => {
        throw new Error("Purchase query failed");
      });

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      expect(sendMock).toHaveBeenCalled();
      const sentData = JSON.parse(sendMock.mock.calls[0][0] as string);
      expect(sentData.programs).toEqual([]);
    });

    it("should continue when DonationTransaction.find throws (non-strict)", async () => {
      req.query = { format: "json" };
      vi.mocked(DonationTransaction.find).mockImplementation(() => {
        throw new Error("Donation query failed");
      });

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      expect(sendMock).toHaveBeenCalled();
      const sentData = JSON.parse(sendMock.mock.calls[0][0] as string);
      expect(sentData.donations).toEqual([]);
    });

    it("should return 500 when XLSX.write throws error", async () => {
      req.query = { format: "xlsx" };
      vi.mocked(XLSX.write).mockImplementation(() => {
        throw new Error("XLSX generation failed");
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

  describe("Edge cases - null/undefined field handling", () => {
    it("should handle users with all undefined optional fields", async () => {
      req.query = { format: "json" };
      const usersWithUndefined = [
        {
          username: "minimal",
          email: undefined,
          role: undefined,
          createdAt: undefined,
        },
      ];
      vi.mocked(User.find).mockReturnValue(
        createChainedMock(usersWithUndefined) as unknown as ReturnType<
          typeof User.find
        >,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      expect(statusMock).not.toHaveBeenCalledWith(500);
    });

    it("should handle events with undefined status (defaults to 'upcoming')", async () => {
      req.query = { format: "xlsx" };
      const eventsWithUndefinedStatus = [
        {
          title: "No Status Event",
          type: "workshop",
          status: undefined,
          createdAt: new Date(),
        },
      ];
      vi.mocked(Event.find).mockReturnValue(
        createChainedMock(eventsWithUndefinedStatus) as unknown as ReturnType<
          typeof Event.find
        >,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const aoaCalls = vi.mocked(XLSX.utils.aoa_to_sheet).mock.calls;
      const eventsSheetCall = aoaCalls.find(
        (call) =>
          Array.isArray(call[0]) && call[0][0] && call[0][0][0] === "Title",
      );

      expect(eventsSheetCall).toBeDefined();
      const eventData = eventsSheetCall?.[0] as unknown[][];
      // Status should default to "upcoming" when not set
      expect(eventData[1][5]).toBe("upcoming");
    });

    it("should handle registrations with missing registrationDate", async () => {
      req.query = { format: "csv", mode: "rows" };
      const regsWithoutDate = [
        {
          userId: "user-no-date",
          eventId: "event-123",
          status: "confirmed",
          registrationDate: undefined,
        },
      ];
      vi.mocked(Registration.find).mockReturnValue(
        createChainedMock(regsWithoutDate) as unknown as ReturnType<
          typeof Registration.find
        >,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      // Should not crash
      expect(endMock).toHaveBeenCalled();
    });

    it("should handle guest registrations with null eventId and migratedToUserId", async () => {
      req.query = { format: "json" };
      const guestsWithNulls = [
        {
          fullName: "Guest Null Fields",
          eventId: null,
          migratedToUserId: null,
          status: "pending",
        },
      ];
      vi.mocked(GuestRegistration.find).mockReturnValue(
        createChainedMock(guestsWithNulls) as unknown as ReturnType<
          typeof GuestRegistration.find
        >,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const sentData = JSON.parse(sendMock.mock.calls[0][0] as string);
      expect(sentData.guestRegistrations[0].eventId).toBeUndefined();
      expect(sentData.guestRegistrations[0].migratedToUserId).toBeUndefined();
    });

    it("should handle programs with zero finalPrice", async () => {
      req.query = { format: "xlsx" };
      const programsWithZero = [
        {
          userId: "user-free",
          programId: "prog-free",
          finalPrice: 0,
          status: "completed",
          purchaseDate: new Date(),
          isClassRep: false,
          isEarlyBird: false,
        },
      ];
      vi.mocked(Purchase.find).mockReturnValue(
        createChainedMock(programsWithZero) as unknown as ReturnType<
          typeof Purchase.find
        >,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const aoaCalls = vi.mocked(XLSX.utils.aoa_to_sheet).mock.calls;
      const programsSheetCall = aoaCalls.find(
        (call) =>
          Array.isArray(call[0]) &&
          call[0][0] &&
          call[0][0][5] === "Final Price (cents)",
      );

      expect(programsSheetCall).toBeDefined();
      const progData = programsSheetCall?.[0] as unknown[][];
      expect(progData[1][5]).toBe(0);
    });

    it("should handle donations with zero amount", async () => {
      req.query = { format: "xlsx" };
      const donationsWithZero = [
        {
          userId: "donor-zero",
          donationId: "don-zero",
          amount: 0,
          type: "test",
          status: "completed",
          giftDate: new Date(),
        },
      ];
      vi.mocked(DonationTransaction.find).mockReturnValue(
        createChainedMock(donationsWithZero) as unknown as ReturnType<
          typeof DonationTransaction.find
        >,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const aoaCalls = vi.mocked(XLSX.utils.aoa_to_sheet).mock.calls;
      const donationsSheetCall = aoaCalls.find(
        (call) =>
          Array.isArray(call[0]) &&
          call[0][0] &&
          call[0][0][2] === "Amount (cents)",
      );

      expect(donationsSheetCall).toBeDefined();
      const donData = donationsSheetCall?.[0] as unknown[][];
      expect(donData[1][2]).toBe(0);
    });
  });

  describe("Default format handling", () => {
    it("should default to json format when format is not specified", async () => {
      req.query = {}; // No format specified

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      expect(setHeaderMock).toHaveBeenCalledWith(
        "Content-Type",
        "application/json",
      );
    });
  });

  describe("Overview sheet in XLSX", () => {
    it("should include correct overview metrics", async () => {
      req.query = { format: "xlsx" };
      vi.mocked(User.find).mockReturnValue(
        createChainedMock(mockUsersComplete) as unknown as ReturnType<
          typeof User.find
        >,
      );
      vi.mocked(Event.find).mockReturnValue(
        createChainedMock(mockEventsComplete) as unknown as ReturnType<
          typeof Event.find
        >,
      );
      vi.mocked(Registration.find).mockReturnValue(
        createChainedMock(mockRegistrationsComplete) as unknown as ReturnType<
          typeof Registration.find
        >,
      );
      vi.mocked(GuestRegistration.find).mockReturnValue(
        createChainedMock(
          mockGuestRegistrationsComplete,
        ) as unknown as ReturnType<typeof GuestRegistration.find>,
      );
      vi.mocked(Purchase.find).mockReturnValue(
        createChainedMock(mockProgramsComplete) as unknown as ReturnType<
          typeof Purchase.find
        >,
      );
      vi.mocked(DonationTransaction.find).mockReturnValue(
        createChainedMock(mockDonationsComplete) as unknown as ReturnType<
          typeof DonationTransaction.find
        >,
      );

      await ExportAnalyticsController.exportAnalytics(
        req as Request,
        res as Response,
      );

      const aoaCalls = vi.mocked(XLSX.utils.aoa_to_sheet).mock.calls;
      const overviewSheetCall = aoaCalls.find(
        (call) =>
          Array.isArray(call[0]) && call[0][0] && call[0][0][0] === "Metric",
      );

      expect(overviewSheetCall).toBeDefined();
      const overviewData = overviewSheetCall?.[0] as unknown[][];

      // Check header row
      expect(overviewData[0]).toEqual(["Metric", "Value", "Timestamp"]);

      // Check data rows
      expect(overviewData[1][0]).toBe("Total Users");
      expect(overviewData[1][1]).toBe(3);
      expect(overviewData[2][0]).toBe("Total Events");
      expect(overviewData[2][1]).toBe(3);
      expect(overviewData[3][0]).toBe("Total Registrations");
      expect(overviewData[3][1]).toBe(3);
      expect(overviewData[4][0]).toBe("Total Guest Registrations");
      expect(overviewData[4][1]).toBe(3);
      expect(overviewData[5][0]).toBe("Total Programs");
      expect(overviewData[5][1]).toBe(2);
      expect(overviewData[6][0]).toBe("Total Donations");
      expect(overviewData[6][1]).toBe(2);
    });
  });
});
