import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({
  currentUser: {
    id: "legacy-user",
    username: "legacy",
    firstName: "Legacy",
    lastName: "User",
    email: "legacy@example.com",
    role: "Participant",
    isAtCloudLeader: "No",
    gender: "female",
    phone: "+14155552671",
  } as Record<string, unknown> | null,
}));

vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({
    currentUser: authState.currentUser,
    isLoading: false,
  }),
}));

vi.mock("../../layouts/dashboard/Header", () => ({
  default: () => <header data-testid="header" />,
}));

vi.mock("../../layouts/dashboard/Sidebar", () => ({
  default: () => <aside data-testid="sidebar" />,
}));

vi.mock("../../components/common/Footer", () => ({
  default: () => <footer data-testid="footer" />,
}));

import DashboardLayout from "../../layouts/DashboardLayout";

function renderLayout(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/dashboard" element={<DashboardLayout />}>
          <Route path="programs" element={<div>Programs content</div>} />
          <Route path="profile" element={<div>Profile content</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("DashboardLayout profile completion banner", () => {
  beforeEach(() => {
    authState.currentUser = {
      id: "legacy-user",
      username: "legacy",
      firstName: "Legacy",
      lastName: "User",
      email: "legacy@example.com",
      role: "Participant",
      isAtCloudLeader: "No",
      gender: "female",
      phone: "+14155552671",
    };
  });

  it("shows a non-blocking banner while preserving the requested page", () => {
    renderLayout("/dashboard/programs");

    expect(screen.getByTestId("profile-completion-banner")).toBeInTheDocument();
    expect(screen.getByText("Programs content")).toBeInTheDocument();
  });

  it("leaves the self-profile route to its inline completion callout", () => {
    renderLayout("/dashboard/profile");

    expect(
      screen.queryByTestId("profile-completion-banner"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Profile content")).toBeInTheDocument();
  });
});
