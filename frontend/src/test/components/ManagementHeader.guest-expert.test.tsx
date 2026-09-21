import { render, screen } from "@testing-library/react";
import { describe, test, expect } from "vitest";
import ManagementHeader from "../../components/management/ManagementHeader";
import type { RoleStats } from "../../types/management";

// Mock role stats data
const mockRoleStats: RoleStats = {
  total: 18,
  superAdmin: 1,
  administrators: 2,
  leaders: 3,
  guestExperts: 2,
  participants: 10,
  atCloudLeaders: 0,
};

describe("ManagementHeader - Guest Expert Support", () => {
  test("should show Community title and Guest Expert description for Guest Expert users", () => {
    render(
      <ManagementHeader
        currentUserRole="Guest Expert"
        roleStats={mockRoleStats}
      />
    );

    // Should show Community title (not User Management)
    expect(screen.getByText("Community")).toBeInTheDocument();
    expect(screen.queryByText("User Management")).not.toBeInTheDocument();

    // Should show Guest Expert specific description
    expect(
      screen.getByText(
        "Browse and connect with other community members in @Cloud Marketplace Ministry. As a Guest Expert, you can view members and discover who's part of our community."
      )
    ).toBeInTheDocument();
  });

  test("should show Community title for Participant users", () => {
    render(
      <ManagementHeader
        currentUserRole="Participant"
        roleStats={mockRoleStats}
      />
    );

    // Should show Community title (not User Management)
    expect(screen.getByText("Community")).toBeInTheDocument();
    expect(screen.queryByText("User Management")).not.toBeInTheDocument();

    // Should show Participant specific description
    expect(
      screen.getByText(
        "Browse and connect with other community members in @Cloud Marketplace Ministry. As a Participant, you can view fellow members and discover who's part of our community."
      )
    ).toBeInTheDocument();
  });

  test("should show User Management title for Administrator users", () => {
    render(
      <ManagementHeader
        currentUserRole="Administrator"
        roleStats={mockRoleStats}
      />
    );

    // Should show User Management title (not Community)
    expect(screen.getByText("User Management")).toBeInTheDocument();
    expect(screen.queryByText("Community")).not.toBeInTheDocument();

    // Should show Administrator specific description
    expect(
      screen.getByText(
        "Manage user roles and permissions for @Cloud Marketplace Ministry. As an Administrator, you can view all users and manage their access levels within your scope of authority."
      )
    ).toBeInTheDocument();
  });

  test("should show User Management title for Super Admin users", () => {
    render(
      <ManagementHeader
        currentUserRole="Super Admin"
        roleStats={mockRoleStats}
      />
    );

    // Should show User Management title (not Community)
    expect(screen.getByText("User Management")).toBeInTheDocument();
    expect(screen.queryByText("Community")).not.toBeInTheDocument();

    // Should show Super Admin specific description
    expect(
      screen.getByText(
        "Manage user roles and permissions for @Cloud Marketplace Ministry. As a Super Admin, you have full access to view all users and manage their access levels across the entire system."
      )
    ).toBeInTheDocument();
  });

  test("should show Community title for Leader users", () => {
    render(
      <ManagementHeader currentUserRole="Leader" roleStats={mockRoleStats} />
    );

    // Should show Community title (not User Management)
    expect(screen.getByText("Community")).toBeInTheDocument();
    expect(screen.queryByText("User Management")).not.toBeInTheDocument();

    // Should show Leader specific description
    expect(
      screen.getByText(
        "View community members and their information for @Cloud Marketplace Ministry. As a Leader, you can browse member profiles and see community statistics."
      )
    ).toBeInTheDocument();
  });

  test("uses Community copy for an Administrator on the Members page", () => {
    render(
      <ManagementHeader
        currentUserRole="Administrator"
        roleStats={mockRoleStats}
        scope="community"
      />,
    );

    expect(screen.getByText("Community")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Browse and connect with active, verified members of @Cloud Marketplace Ministry.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Manage user roles and permissions/),
    ).not.toBeInTheDocument();
  });
});
