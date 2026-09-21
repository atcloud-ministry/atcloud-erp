import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Routes, Route } from "react-router-dom";

// A tiny smoke test to ensure header offset + footer presence in DashboardLayout

describe("DashboardLayout layout regression", () => {
  it("renders main with pt-16 and includes Footer", async () => {
    const user = userEvent.setup();
    // Mock auth hook to avoid requiring AuthProvider wrapping
    vi.doMock("../../hooks/useAuth", async () => ({
      __esModule: true,
      useAuth: () => ({
        isLoading: false,
        currentUser: {
          id: "u1",
          username: "admin",
          firstName: "Admin",
          lastName: "User",
          email: "admin@example.com",
          role: "Administrator",
          isAtCloudLeader: "Yes",
          roleInAtCloud: "Administrator",
          gender: "male",
          avatar: null,
        },
      }),
    }));
    // Also mock the underlying context in case any component imports it directly
    vi.doMock("../../contexts/AuthContext", async () => ({
      __esModule: true,
      useAuth: () => ({
        currentUser: {
          id: "u1",
          username: "admin",
          firstName: "Admin",
          lastName: "User",
          email: "admin@example.com",
          role: "Administrator",
          isAtCloudLeader: "Yes",
          roleInAtCloud: "Administrator",
          gender: "male",
          avatar: null,
        },
        isAuthenticated: true,
        isLoading: false,
        login: vi.fn(),
        logout: vi.fn(),
        updateUser: vi.fn(),
        canCreateEvents: true,
        canManageUsers: true,
        hasRole: () => true,
      }),
      useRequireRole: () => ({
        hasRole: () => true,
        redirectPath: "/login",
      }),
      withAuth: (Comp: any) => Comp,
    }));
    vi.doMock("../../layouts/dashboard/Header", async () => ({
      __esModule: true,
      default: () => <header data-testid="header" />,
    }));
    vi.doMock("../../layouts/dashboard/Sidebar", async () => ({
      __esModule: true,
      default: () => <aside data-testid="sidebar" />,
    }));
    vi.doMock("../../components/common/Footer", async () => ({
      __esModule: true,
      default: () => <footer data-testid="footer" />,
    }));

    const { default: Layout } = await import("../../layouts/DashboardLayout");

    function Dummy() {
      return <Link to="/dashboard/programs">Open programs</Link>;
    }

    render(
      <MemoryRouter initialEntries={["/dashboard/"]}>
        <Routes>
          <Route path="/dashboard" element={<Layout />}>
            <Route index element={<Dummy />} />
            <Route path="programs" element={<div>Programs</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    // main has pt-16 class to offset fixed header
    const main =
      screen.getByRole("main", { hidden: true }) ||
      document.querySelector("main");
    expect(main).toBeTruthy();
    if (main) {
      expect((main as HTMLElement).className).toContain("pt-16");
      expect(main).toHaveAttribute("id", "dashboard-main-content");
    }

    expect(
      screen.getByRole("link", { name: "Skip to main content" }),
    ).toHaveAttribute("href", "#dashboard-main-content");

    await user.click(screen.getByRole("link", { name: "Open programs" }));
    expect(await screen.findByText("Programs")).toBeInTheDocument();
    expect(screen.getByRole("main", { hidden: true })).toHaveFocus();

    // footer exists
    expect(screen.getByTestId("footer")).toBeInTheDocument();
  });
});
