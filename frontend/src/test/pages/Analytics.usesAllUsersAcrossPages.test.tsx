import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Analytics from "../../pages/Analytics";

vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({ currentUser: { id: "admin", role: "Administrator" } }),
}));

vi.mock("../../contexts/NotificationModalContext", () => ({
  useToastReplacement: () => ({ success: vi.fn(), error: vi.fn() }),
}));

const demographics = {
  roleStats: {
    total: 25,
    superAdmin: 0,
    administrators: 0,
    leaders: 13,
    guestExperts: 0,
    participants: 12,
    atCloudLeaders: 0,
  },
  churchAnalytics: {
    weeklyChurchStats: {},
    churchAddressStats: {},
    usersWithChurchInfo: 0,
    usersWithoutChurchInfo: 25,
    totalChurches: 0,
    totalChurchLocations: 0,
    churchParticipationRate: 0,
  },
  occupationAnalytics: {
    occupationStats: {},
    usersWithOccupation: 0,
    usersWithoutOccupation: 25,
    totalOccupationTypes: 0,
    topOccupations: [],
    occupationCompletionRate: 0,
  },
};

describe("Analytics people aggregate", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const data = url.includes("/analytics/users")
        ? {
            usersByRole: [],
            usersByAtCloudStatus: [],
            usersByChurch: [],
            registrationTrends: [],
            usersByOccupation: [],
            totalUsers: 25,
            activeUsers: 25,
            demographics,
          }
        : url.includes("/analytics/events")
          ? { upcomingEvents: [], completedEvents: [] }
          : null;
      if (!data) throw new Error(`Unexpected request: ${url}`);
      return new Response(JSON.stringify({ success: true, data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders server-computed demographics without requesting a user list", async () => {
    render(
      <MemoryRouter initialEntries={["/analytics?tab=people"]}>
        <Routes>
          <Route path="/analytics" element={<Analytics />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("role-dist-leader")).toHaveTextContent("13");
      expect(screen.getByTestId("role-dist-participant")).toHaveTextContent(
        "12",
      );
    });

    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => /\/analytics\/users(?:\?|$)/.test(url))).toBe(
      true,
    );
    const pathnames = urls.map((url) => new URL(url, "http://test").pathname);
    expect(
      pathnames.some((path) => path === "/users" || path === "/api/users"),
    ).toBe(false);
  });
});
