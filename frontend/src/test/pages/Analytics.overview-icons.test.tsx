import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Analytics from "../../pages/Analytics";
import { NotificationProvider } from "../../contexts/NotificationModalContext";

vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({
    currentUser: { id: "u1", role: "Super Admin" },
    isAuthenticated: true,
    isLoading: false,
    canCreateEvents: true,
    canManageUsers: true,
    hasRole: () => true,
  }),
}));

vi.mock("../../services/socketService", () => ({
  socketService: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    joinEventRoom: vi.fn(),
    leaveEventRoom: vi.fn(),
  },
}));

vi.mock("../../hooks/useAnalyticsResources", () => ({
  useUserAnalyticsResource: () => ({
    data: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
  useAnalyticsOverviewResource: () => ({
    data: {
      overview: {
        totalEvents: 42,
        completedEvents: 18,
        totalUsers: 120,
        totalRegistrations: 80,
        activeParticipants: 18,
        averageSignupRate: 57.3,
        activeUsers: 12,
        upcomingEvents: 10,
        recentRegistrations: 4,
      },
      growth: {
        userGrowthRate: 0,
        eventGrowthRate: 0,
        registrationGrowthRate: 0,
      },
      last30Days: {
        newUsers: 6,
        newEvents: 3,
        registrations: 14,
        attendanceCompletionRate: 75,
        attendanceRate: 80,
      },
      needsAttention: {
        lowSignupUpcomingEvents: 2,
        completedEventsMissingAttendance: 1,
        unrecordedAttendance: 5,
        waitlistedRegistrations: 3,
      },
      topEvents: [
        {
          id: "event-1",
          title: "Leadership Night",
          date: "2026-01-02",
          type: "Meeting",
          status: "completed",
          registrations: 32,
          totalSlots: 40,
          signupRate: 80,
        },
      ],
      topPrograms: [
        {
          id: "program-1",
          title: "EMBA",
          programType: "EMBA Mentor Circles",
          registrations: 28,
          events: 4,
        },
      ],
      recentActivity: [
        {
          id: "registration-1",
          type: "registration",
          person: "Ann Lee",
          eventTitle: "Leadership Night",
          eventDate: "2026-01-02",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
  useEventAnalyticsResource: () => ({
    data: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
  useAttendanceAnalyticsResource: () => ({
    data: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
  useProgramAnalyticsResource: () => ({
    data: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
  useFinancialSummaryResource: () => ({
    data: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
  useDonationAnalyticsResource: () => ({
    data: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

describe("Analytics overview cards icons", () => {
  it("renders enriched overview cards and command-center panels", () => {
    render(
      <MemoryRouter>
        <NotificationProvider>
          <Analytics />
        </NotificationProvider>
      </MemoryRouter>
    );

    const container = screen.getByTestId("analytics-overview-cards");
    const cards = container.querySelectorAll(
      "[data-testid^='analytics-card-']"
    );
    expect(cards.length).toBe(8);
    cards.forEach((card) => {
      const svg = card.querySelector("svg");
      expect(svg).toBeTruthy();
      const valueEl = card.querySelector("p[aria-label$='value']");
      expect(valueEl?.textContent).toMatch(/\d|%/);
    });
    expect(screen.getByText("Needs Attention")).toBeInTheDocument();
    expect(screen.getByText("Recent Activity")).toBeInTheDocument();
    expect(screen.getByText("30-Day Pulse")).toBeInTheDocument();
    expect(screen.getByText("Top Events")).toBeInTheDocument();
    expect(screen.getByText("Top Programs")).toBeInTheDocument();
    expect(screen.getByText("Leadership Night")).toBeInTheDocument();
    expect(screen.getByText("EMBA")).toBeInTheDocument();
  });
});
