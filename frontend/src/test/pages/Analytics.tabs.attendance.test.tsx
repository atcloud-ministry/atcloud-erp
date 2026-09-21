import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Analytics from "../../pages/Analytics";
import { NotificationProvider } from "../../contexts/NotificationModalContext";

vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({
    currentUser: { id: "admin", role: "Administrator" },
  }),
}));

vi.mock("../../hooks/useUserData", () => ({
  useUserData: () => ({ users: [], loading: false }),
}));

vi.mock("../../hooks/useRoleStats", () => ({
  useRoleStats: () => ({
    total: 0,
    superAdmin: 0,
    administrators: 0,
    leaders: 0,
    guestExperts: 0,
    participants: 0,
    atCloudLeaders: 0,
  }),
}));

const resourceMocks = vi.hoisted(() => ({
  overview: vi.fn(),
  events: vi.fn(),
  attendance: vi.fn(),
  programs: vi.fn(),
  financialSummary: vi.fn(),
  donations: vi.fn(),
  users: vi.fn(),
}));

vi.mock("../../hooks/useAnalyticsResources", () => ({
  useUserAnalyticsResource: (enabled: boolean) => {
    resourceMocks.users(enabled);
    return {
      data: null,
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
  },
  useAnalyticsOverviewResource: (enabled: boolean) => {
    resourceMocks.overview(enabled);
    return {
      data: {
        overview: {
          totalUsers: 12,
          totalEvents: 7,
          completedEvents: 3,
          totalRegistrations: 20,
          activeParticipants: 8,
          averageSignupRate: 50,
          activeUsers: 3,
          upcomingEvents: 2,
          recentRegistrations: 1,
        },
        growth: {
          userGrowthRate: 0,
          eventGrowthRate: 0,
          registrationGrowthRate: 0,
        },
        last30Days: {
          newUsers: 2,
          newEvents: 1,
          registrations: 4,
          attendanceCompletionRate: 80,
          attendanceRate: 75,
        },
        needsAttention: {
          lowSignupUpcomingEvents: 0,
          completedEventsMissingAttendance: 1,
          unrecordedAttendance: 2,
          waitlistedRegistrations: 0,
        },
        topEvents: [],
        topPrograms: [],
        recentActivity: [],
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
  },
  useEventAnalyticsResource: (enabled: boolean) => {
    resourceMocks.events(enabled);
    return {
      data: { upcomingEvents: [], completedEvents: [] },
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
  },
  useAttendanceAnalyticsResource: (enabled: boolean) => {
    resourceMocks.attendance(enabled);
    return {
      data: {
        summary: {
          registered: 3,
          attended: 2,
          absent: 1,
          unrecorded: 0,
          recorded: 3,
          attendanceRate: 66.6667,
          noShowRate: 33.3333,
          completionRate: 100,
        },
        byPerson: [
          {
            userId: "u1",
            name: "Ann Lee",
            roleInAtCloud: "Mentor",
            systemAuthorizationLevel: "Leader",
            programs: ["EMBA"],
            completedEvents: 2,
            registered: 2,
            attended: 2,
            absent: 0,
            unrecorded: 0,
            recorded: 2,
            attendanceRate: 100,
            noShowRate: 0,
            completionRate: 100,
            lastAttendedAt: "2026-01-02T00:00:00.000Z",
            lastAttendedEvent: "Leadership Night",
          },
          {
            userId: "u2",
            name: "Bob Kim",
            roleInAtCloud: "",
            systemAuthorizationLevel: "Participant",
            programs: ["EMBA"],
            completedEvents: 1,
            registered: 1,
            attended: 0,
            absent: 1,
            unrecorded: 0,
            recorded: 1,
            attendanceRate: 0,
            noShowRate: 100,
            completionRate: 100,
          },
          {
            userId: "u3",
            name: "Cora Chen",
            roleInAtCloud: "Participant",
            systemAuthorizationLevel: "Participant",
            programs: ["Finance"],
            completedEvents: 1,
            registered: 1,
            attended: 1,
            absent: 0,
            unrecorded: 0,
            recorded: 1,
            attendanceRate: 100,
            noShowRate: 0,
            completionRate: 100,
          },
          {
            userId: "u4",
            name: "Daniel Fox",
            roleInAtCloud: "Participant",
            systemAuthorizationLevel: "Participant",
            programs: ["EMBA"],
            completedEvents: 1,
            registered: 1,
            attended: 1,
            absent: 0,
            unrecorded: 0,
            recorded: 1,
            attendanceRate: 100,
            noShowRate: 0,
            completionRate: 100,
          },
          {
            userId: "u5",
            name: "Eden Smith",
            roleInAtCloud: "Participant",
            systemAuthorizationLevel: "Participant",
            programs: ["Leadership"],
            completedEvents: 1,
            registered: 1,
            attended: 1,
            absent: 0,
            unrecorded: 0,
            recorded: 1,
            attendanceRate: 100,
            noShowRate: 0,
            completionRate: 100,
          },
          {
            userId: "u6",
            name: "Felix Young",
            roleInAtCloud: "Participant",
            systemAuthorizationLevel: "Participant",
            programs: ["Leadership"],
            completedEvents: 1,
            registered: 1,
            attended: 1,
            absent: 0,
            unrecorded: 0,
            recorded: 1,
            attendanceRate: 100,
            noShowRate: 0,
            completionRate: 100,
          },
          {
            userId: "u7",
            name: "Grace Lin",
            roleInAtCloud: "Participant",
            systemAuthorizationLevel: "Participant",
            programs: ["EMBA"],
            completedEvents: 1,
            registered: 1,
            attended: 1,
            absent: 0,
            unrecorded: 0,
            recorded: 1,
            attendanceRate: 100,
            noShowRate: 0,
            completionRate: 100,
          },
          {
            userId: "u8",
            name: "Hannah Wu",
            roleInAtCloud: "Participant",
            systemAuthorizationLevel: "Participant",
            programs: ["Finance"],
            completedEvents: 1,
            registered: 1,
            attended: 1,
            absent: 0,
            unrecorded: 0,
            recorded: 1,
            attendanceRate: 100,
            noShowRate: 0,
            completionRate: 100,
          },
          {
            userId: "u9",
            name: "Ivan Park",
            roleInAtCloud: "Participant",
            systemAuthorizationLevel: "Participant",
            programs: ["EMBA"],
            completedEvents: 1,
            registered: 1,
            attended: 1,
            absent: 0,
            unrecorded: 0,
            recorded: 1,
            attendanceRate: 100,
            noShowRate: 0,
            completionRate: 100,
          },
          {
            userId: "u10",
            name: "Molly Zhang",
            roleInAtCloud: "Participant",
            systemAuthorizationLevel: "Participant",
            programs: ["Leadership"],
            completedEvents: 1,
            registered: 1,
            attended: 1,
            absent: 0,
            unrecorded: 0,
            recorded: 1,
            attendanceRate: 100,
            noShowRate: 0,
            completionRate: 100,
          },
          {
            userId: "u11",
            name: "Yara Stone",
            roleInAtCloud: "Guest Expert",
            systemAuthorizationLevel: "Guest Expert",
            programs: ["Finance"],
            completedEvents: 1,
            registered: 1,
            attended: 1,
            absent: 0,
            unrecorded: 0,
            recorded: 1,
            attendanceRate: 100,
            noShowRate: 0,
            completionRate: 100,
          },
          {
            userId: "u12",
            name: "Zara Park",
            roleInAtCloud: "Participant",
            systemAuthorizationLevel: "Participant",
            programs: ["Leadership"],
            completedEvents: 3,
            registered: 3,
            attended: 3,
            absent: 0,
            unrecorded: 0,
            recorded: 3,
            attendanceRate: 100,
            noShowRate: 0,
            completionRate: 100,
            lastAttendedAt: "2026-02-02T00:00:00.000Z",
            lastAttendedEvent: "Strategic Planning",
          },
        ],
        byProgram: [
          {
            programId: "p1",
            programTitle: "EMBA",
            programType: "EMBA Mentor Circles",
            completedEvents: 1,
            registered: 3,
            attended: 2,
            absent: 1,
            unrecorded: 0,
            recorded: 3,
            attendanceRate: 66.6667,
            noShowRate: 33.3333,
            completionRate: 100,
          },
        ],
        byEvent: [
          {
            eventId: "e1",
            eventTitle: "Leadership Night",
            eventDate: "2026-01-02T00:00:00.000Z",
            eventType: "Meeting",
            programs: [
              {
                id: "p1",
                title: "EMBA",
                programType: "EMBA Mentor Circles",
              },
            ],
            registered: 3,
            attended: 2,
            absent: 1,
            unrecorded: 0,
            recorded: 3,
            attendanceRate: 66.6667,
            noShowRate: 33.3333,
            completionRate: 100,
          },
        ],
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
  },
  useProgramAnalyticsResource: (enabled: boolean) => {
    resourceMocks.programs(enabled);
    return { data: null, loading: false, error: null, refresh: vi.fn() };
  },
  useFinancialSummaryResource: (enabled: boolean) => {
    resourceMocks.financialSummary(enabled);
    return { data: null, loading: false, error: null, refresh: vi.fn() };
  },
  useDonationAnalyticsResource: (enabled: boolean) => {
    resourceMocks.donations(enabled);
    return { data: null, loading: false, error: null, refresh: vi.fn() };
  },
}));

describe("Analytics tabs", () => {
  beforeEach(() => {
    Object.values(resourceMocks).forEach((mock) => mock.mockClear());
  });

  it("enables only the overview resource on the default tab", () => {
    render(
      <MemoryRouter initialEntries={["/analytics"]}>
        <NotificationProvider>
          <Analytics />
        </NotificationProvider>
      </MemoryRouter>
    );

    expect(screen.getByTestId("analytics-overview-cards")).toBeInTheDocument();
    expect(resourceMocks.overview).toHaveBeenCalledWith(true);
    expect(resourceMocks.events).toHaveBeenCalledWith(false);
    expect(resourceMocks.attendance).toHaveBeenCalledWith(false);
    expect(resourceMocks.programs).toHaveBeenCalledWith(false);
    expect(resourceMocks.financialSummary).toHaveBeenCalledWith(false);
    expect(resourceMocks.donations).toHaveBeenCalledWith(false);
  });

  it("renders attendance analysis in nested tabs and keeps unrelated resources disabled", () => {
    render(
      <MemoryRouter initialEntries={["/analytics?tab=attendance"]}>
        <NotificationProvider>
          <Analytics />
        </NotificationProvider>
      </MemoryRouter>
    );

    expect(screen.getByText("Attendance By Person")).toBeInTheDocument();
    expect(screen.queryByText("Attendance By Program")).not.toBeInTheDocument();
    expect(screen.queryByText("Attendance By Event")).not.toBeInTheDocument();
    expect(screen.getByText("Ann Lee")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "By Program" }));
    expect(screen.getByText("Attendance By Program")).toBeInTheDocument();
    expect(screen.getAllByText("EMBA").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("tab", { name: "By Event" }));
    expect(screen.getByText("Attendance By Event")).toBeInTheDocument();
    expect(screen.getByText("Leadership Night")).toBeInTheDocument();

    expect(resourceMocks.attendance).toHaveBeenCalledWith(true);
    expect(resourceMocks.events).toHaveBeenCalledWith(false);
    expect(resourceMocks.programs).toHaveBeenCalledWith(false);
  });

  it("applies person search, filters, and sorting before pagination", () => {
    render(
      <MemoryRouter initialEntries={["/analytics?tab=attendance"]}>
        <NotificationProvider>
          <Analytics />
        </NotificationProvider>
      </MemoryRouter>
    );

    expect(screen.getByText("Attendance By Person")).toBeInTheDocument();
    expect(screen.queryByText("Zara Park")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search"), {
      target: { value: "Zra" },
    });
    expect(screen.getByText("Zara Park")).toBeInTheDocument();
    expect(screen.getByText(/1 of 12 records/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByLabelText("Role"), {
      target: { value: "Guest Expert" },
    });
    expect(screen.getByText("Yara Stone")).toBeInTheDocument();
    expect(screen.getByText(/1 of 12 records/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Role"), {
      target: { value: "__all" },
    });
    fireEvent.change(screen.getByLabelText("Sort"), {
      target: { value: "attended" },
    });
    fireEvent.change(screen.getByLabelText("Direction"), {
      target: { value: "desc" },
    });

    const rows = screen.getAllByRole("row");
    expect(within(rows[1]).getByText("Zara Park")).toBeInTheDocument();
  });
});
