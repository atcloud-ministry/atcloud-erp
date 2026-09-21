import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Analytics from "../../pages/Analytics";
import { NotificationProvider } from "../../contexts/NotificationModalContext";

// Auth mock granting access
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

// Socket service noop
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

vi.mock("../../hooks/useUserData", () => ({
  useUserData: () => ({ users: [], loading: false }),
}));

vi.mock("../../hooks/useRoleStats", () => ({
  useRoleStats: () => ({
    total: 21,
    superAdmin: 1,
    administrators: 2,
    leaders: 3,
    guestExperts: 4,
    participants: 5,
    atCloudLeaders: 6,
  }),
}));

vi.mock("../../hooks/useAnalyticsResources", () => ({
  useUserAnalyticsResource: () => ({
    data: {
      demographics: {
        roleStats: {
          total: 21,
          superAdmin: 1,
          administrators: 2,
          leaders: 3,
          guestExperts: 4,
          participants: 5,
          atCloudLeaders: 6,
        },
        churchAnalytics: {
          weeklyChurchStats: {},
          churchAddressStats: {},
          usersWithChurchInfo: 0,
          usersWithoutChurchInfo: 21,
          totalChurches: 0,
          totalChurchLocations: 0,
          churchParticipationRate: 0,
        },
        occupationAnalytics: {
          occupationStats: {},
          usersWithOccupation: 0,
          usersWithoutOccupation: 21,
          totalOccupationTypes: 0,
          topOccupations: [],
          occupationCompletionRate: 0,
        },
      },
    },
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
  useAnalyticsOverviewResource: () => ({
    data: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
  useEventAnalyticsResource: () => ({
    data: { upcomingEvents: [], completedEvents: [] },
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

describe("Analytics Authorization Distribution styling & icons", () => {
  it("renders colored badges and an icon for each role row", () => {
    render(
      <MemoryRouter initialEntries={["/analytics?tab=people"]}>
        <NotificationProvider>
          <Analytics />
        </NotificationProvider>
      </MemoryRouter>
    );

    const rows = [
      {
        label: /^Super Admin:$/i,
        testId: /role-dist-super-admin/,
        classes: ["bg-purple-100", "text-purple-800"],
      },
      {
        label: /^Administrators:$/i,
        testId: /role-dist-administrator/,
        classes: ["bg-red-100", "text-red-800"],
      },
      {
        label: /^Leaders:$/i,
        testId: /role-dist-leader/,
        classes: ["bg-yellow-100", "text-yellow-800"],
      },
      {
        label: /^Guest Experts:$/i,
        testId: /role-dist-guest-expert/,
        classes: ["bg-cyan-100", "text-cyan-800"],
      },
      {
        label: /^Participants:$/i,
        testId: /role-dist-participant/,
        classes: ["bg-green-100", "text-green-800"],
      },
      {
        label: /^@Cloud Co-workers:$/i,
        testId: /role-dist-cloud-co-workers/,
        classes: ["bg-orange-100", "text-orange-800"],
      },
    ];

    rows.forEach(({ label, testId, classes }) => {
      const heading = screen.getByText(label);
      // Check icon (svg) exists within the same parent element
      const parent = heading.closest("span")?.parentElement;
      expect(parent).toBeTruthy();
      const svgs = parent?.querySelectorAll("svg");
      expect(svgs && svgs.length).toBeGreaterThan(0);

      const badge = screen.getByTestId(testId);
      classes.forEach((cls) => expect(badge.className).toContain(cls));
    });
  });
});
