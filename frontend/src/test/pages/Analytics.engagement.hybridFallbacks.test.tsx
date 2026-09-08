import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { NotificationProvider } from "../../contexts/NotificationModalContext";

// Mock auth to allow access to Analytics page
vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({ currentUser: { id: "admin", role: "Administrator" } }),
}));

// Mock users/role stats (not under test here)
vi.mock("../../hooks/useUserData", () => ({
  useUserData: () => ({ users: [] }),
}));
vi.mock("../../hooks/useRoleStats", () => ({
  useRoleStats: () => ({
    total: 0,
    superAdmin: 0,
    administrators: 0,
    leaders: 0,
    participants: 0,
    atCloudLeaders: 0,
  }),
}));

// Mock tab-specific analytics resources to provide a hybrid payload
// Here, one role contains BOTH currentSignups and registrations.
// Our logic should prefer currentSignups when present.
vi.mock("../../hooks/useAnalyticsResources", () => ({
  useUserAnalyticsResource: () => ({
    data: {
      demographics: {
        roleStats: {
          total: 0,
          superAdmin: 0,
          administrators: 0,
          leaders: 0,
          guestExperts: 0,
          participants: 0,
          atCloudLeaders: 0,
        },
        churchAnalytics: {
          weeklyChurchStats: {},
          churchAddressStats: {},
          usersWithChurchInfo: 0,
          usersWithoutChurchInfo: 0,
          totalChurches: 0,
          totalChurchLocations: 0,
          churchParticipationRate: 0,
        },
        occupationAnalytics: {
          occupationStats: {},
          usersWithOccupation: 0,
          usersWithoutOccupation: 0,
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
    data: {
      upcomingEvents: [
        {
          id: "evt-1",
          title: "Event One",
          format: "online",
          roles: [
            {
              id: "r1",
              name: "Participant",
              maxParticipants: 10,
              // Precedence: currentSignups should be used over registrations
              currentSignups: [
                {
                  userId: "u1",
                  username: "ann",
                  firstName: "Ann",
                  lastName: "Lee",
                  systemAuthorizationLevel: "Leader",
                },
                {
                  userId: "u2",
                  username: "bob",
                  firstName: "Bob",
                  lastName: "K",
                  systemAuthorizationLevel: "Participant",
                },
              ],
              // Present but should be ignored because currentSignups exists
              registrations: [
                {
                  userId: "uX",
                  user: {
                    id: "uX",
                    username: "extra",
                    firstName: "Extra",
                    lastName: "User",
                    systemAuthorizationLevel: "Participant",
                  },
                },
              ],
            },
          ],
        },
      ],
      completedEvents: [
        {
          id: "evt-2",
          title: "Event Two",
          format: "in-person",
          roles: [
            {
              id: "r1",
              name: "Participant",
              maxParticipants: 10,
              registrations: [
                {
                  userId: "u1",
                  user: {
                    id: "u1",
                    username: "ann",
                    firstName: "Ann",
                    lastName: "Lee",
                    systemAuthorizationLevel: "Leader",
                  },
                },
              ],
            },
          ],
        },
      ],
    },
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

import Analytics from "../../pages/Analytics";

describe("Analytics engagement hybrid fallbacks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefers currentSignups over registrations and computes engagement correctly", async () => {
    render(
      <MemoryRouter initialEntries={["/analytics?tab=people"]}>
        <NotificationProvider>
          <Analytics />
        </NotificationProvider>
      </MemoryRouter>
    );

    // Most Active Participants should show Ann Lee with 2 events
    const mostActiveHeading = await screen.findByText(
      /Most Active Participants/i
    );
    expect(mostActiveHeading).toBeInTheDocument();

    const mostActiveSection = mostActiveHeading.closest("div") as HTMLElement;
    expect(mostActiveSection).toBeTruthy();

    // Ann Lee should be listed
    const ann = screen.getByText("Ann Lee");
    expect(ann).toBeInTheDocument();

    // Badge should display "2 events" for Ann (evt-1 via currentSignups, evt-2 via registrations)
    expect(
      within(mostActiveSection).getByText(/2 events/i)
    ).toBeInTheDocument();

    // Engagement Summary
    const engagementHeading = screen.getByText(/Engagement Summary/i);
    const engagementSection = engagementHeading.closest("div") as HTMLElement;
    expect(engagementSection).toBeTruthy();

    // Total Role Signups = 2 (currentSignups in evt-1) + 1 (registrations in evt-2) = 3
    const totalSignupsRow = within(engagementSection).getByText(
      /Total Role Signups:/i
    ).parentElement as HTMLElement;
    expect(within(totalSignupsRow).getByText(/^3$/)).toBeInTheDocument();

    // Unique Participants = {u1, u2} = 2
    const uniqueRow = within(engagementSection).getByText(
      /Unique Participants:/i
    ).parentElement as HTMLElement;
    expect(within(uniqueRow).getByText(/^2$/)).toBeInTheDocument();

    // Total Unique Events = 2
    const totalEventsRow = within(engagementSection).getByText(
      /Total Unique Events:/i
    ).parentElement as HTMLElement;
    expect(within(totalEventsRow).getByText(/^2$/)).toBeInTheDocument();

    // Avg. Roles per Participant = 3 / 2 = 1.5
    const avgRow = within(engagementSection).getByText(
      /Avg\. Roles per Participant:/i
    ).parentElement as HTMLElement;
    expect(within(avgRow).getByText(/^1\.5$/)).toBeInTheDocument();
  });
});
