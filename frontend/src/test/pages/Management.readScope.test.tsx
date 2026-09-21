import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Management from "../../pages/Management";

const state = vi.hoisted(() => ({
  role: "Participant" as
    | "Super Admin"
    | "Administrator"
    | "Leader"
    | "Guest Expert"
    | "Participant",
  admin: false,
}));

const roleStats = {
  total: 1,
  superAdmin: 0,
  administrators: 0,
  leaders: 0,
  guestExperts: 0,
  participants: 1,
  atCloudLeaders: 0,
};

vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({ currentUser: { id: "viewer", role: state.role } }),
}));

vi.mock("../../hooks/useEnhancedManagement", () => ({
  useEnhancedManagement: () => ({
    users: state.admin
      ? [
          {
            id: "admin-target",
            username: "admin-target",
            firstName: "Admin",
            lastName: "Target",
            email: "admin-target@example.com",
            role: "Participant",
            gender: "male",
            joinDate: "2026-01-01",
            isAtCloudLeader: "No",
            isActive: true,
          },
        ]
      : [],
    communityMembers: state.admin
      ? []
      : [
          {
            id: "member-1",
            username: "safe-member",
            firstName: "Safe",
            lastName: "Member",
            avatar: null,
            gender: "female",
            roleInAtCloud: "Volunteer",
          },
        ],
    isAdminView: state.admin,
    currentUserRole: state.role,
    roleStats,
    roleStatsLoading: false,
    pagination: {
      currentPage: 1,
      totalPages: 1,
      totalUsers: 1,
      hasNext: false,
      hasPrev: false,
    },
    loading: false,
    error: null,
    currentFilters: {},
    onFiltersChange: vi.fn(),
    onPageChange: vi.fn(),
    onRefresh: vi.fn(),
  }),
}));

vi.mock("../../hooks/useManagement", () => ({
  useManagement: () => ({
    getActionsForUser: () => [],
    openDropdown: null,
    toggleDropdown: vi.fn(),
    confirmationAction: null,
    isProcessing: false,
    handleConfirmAction: vi.fn(),
    handleCancelConfirmation: vi.fn(),
  }),
}));

const renderPage = () =>
  render(
    <MemoryRouter>
      <Management />
    </MemoryRouter>,
  );

describe("Management read scopes", () => {
  beforeEach(() => {
    state.role = "Participant";
    state.admin = false;
  });

  it.each(["Participant", "Guest Expert"] as const)(
    "keeps search hidden for %s community viewers",
    (role) => {
      state.role = role;
      renderPage();

      expect(screen.queryByRole("textbox", { name: /search/i })).toBeNull();
      expect(screen.getAllByText("Safe Member").length).toBeGreaterThan(0);
      expect(screen.queryByText(/@example\.com/)).toBeNull();
    },
  );

  it("gives Leaders only the community-safe name/username controls", () => {
    state.role = "Leader";
    renderPage();

    expect(
      screen.getByPlaceholderText("Search members by name or username..."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/email/i)).toBeNull();
    expect(screen.queryByText(/system authorization level/i)).toBeNull();
  });

  it("uses the administrative table and controls for Administrators", () => {
    state.role = "Administrator";
    state.admin = true;
    renderPage();

    expect(
      screen.getByPlaceholderText("Search users by name, email, or username..."),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("admin-target@example.com").length,
    ).toBeGreaterThan(0);
  });
});
