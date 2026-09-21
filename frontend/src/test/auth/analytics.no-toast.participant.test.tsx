import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Analytics from "../../pages/Analytics";

// Mock useAuth hook to return a Participant user
vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({
    currentUser: { role: "Participant" },
    isAuthenticated: true,
    hasRole: () => true,
  }),
}));

const analyticsResourceMocks = vi.hoisted(() => ({
  overview: vi.fn(),
  events: vi.fn(),
  attendance: vi.fn(),
  programs: vi.fn(),
  financialSummary: vi.fn(),
  donations: vi.fn(),
}));

const disabledResource = vi.hoisted(() => ({
  data: null,
  loading: false,
  error: null,
  refresh: vi.fn(),
}));

vi.mock("../../hooks/useAnalyticsResources", () => ({
  useUserAnalyticsResource: () => ({
    data: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
  useAnalyticsOverviewResource: (enabled: boolean) => {
    analyticsResourceMocks.overview(enabled);
    return disabledResource;
  },
  useEventAnalyticsResource: (enabled: boolean) => {
    analyticsResourceMocks.events(enabled);
    return disabledResource;
  },
  useAttendanceAnalyticsResource: (enabled: boolean) => {
    analyticsResourceMocks.attendance(enabled);
    return disabledResource;
  },
  useProgramAnalyticsResource: (enabled: boolean) => {
    analyticsResourceMocks.programs(enabled);
    return disabledResource;
  },
  useFinancialSummaryResource: (enabled: boolean) => {
    analyticsResourceMocks.financialSummary(enabled);
    return disabledResource;
  },
  useDonationAnalyticsResource: (enabled: boolean) => {
    analyticsResourceMocks.donations(enabled);
    return disabledResource;
  },
}));

// Mock toast replacement to ensure error would be visible if called
const toast = { info: vi.fn(), success: vi.fn(), error: vi.fn() };
vi.mock("../../contexts/NotificationModalContext", () => ({
  useToastReplacement: () => toast,
}));

describe("Analytics access (participant)", () => {
  beforeEach(() => {
    Object.values(analyticsResourceMocks).forEach((mock) => mock.mockClear());
    toast.error.mockClear();
  });

  it("gates analytics fetch and does not show error toast for participants", async () => {
    render(
      <MemoryRouter>
        <Analytics />
      </MemoryRouter>
    );

    // Access Restricted page is shown
    expect(await screen.findByText(/Access Restricted/i)).toBeInTheDocument();

    expect(analyticsResourceMocks.overview).toHaveBeenCalledWith(false);
    expect(analyticsResourceMocks.events).toHaveBeenCalledWith(false);
    expect(analyticsResourceMocks.attendance).toHaveBeenCalledWith(false);
    expect(analyticsResourceMocks.programs).toHaveBeenCalledWith(false);

    // No error toast should be raised
    expect(toast.error).not.toHaveBeenCalled();
  });
});
