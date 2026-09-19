/**
 * Sidebar Component Tests
 *
 * Tests role-based navigation item visibility, especially for admin-only features
 * like Income History, Promo Codes, and Published Events.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import Sidebar from "../../layouts/dashboard/Sidebar";
import type { AuthUser } from "../../types";

// Mock useAuth hook
const mockUseAuth = vi.fn();
vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => mockUseAuth(),
}));

const mockUseRuntimeConfig = vi.fn();
vi.mock("../../contexts/RuntimeConfigContext", () => ({
  useRuntimeConfig: () => mockUseRuntimeConfig(),
}));

describe("Sidebar Component - Income History Link Visibility", () => {
  const mockSetSidebarOpen = vi.fn();

  const createMockUser = (role: string): Partial<AuthUser> => ({
    id: "test-user-id",
    username: "testuser",
    firstName: "Test",
    lastName: "User",
    email: "test@example.com",
    role: role as any,
    isAtCloudLeader: "No" as any,
    gender: "Male" as any,
  });

  const mockAuthContextBase = {
    isAuthenticated: true,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    register: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseRuntimeConfig.mockReturnValue({
      status: "ready",
      config: {
        alumniNetwork: { mode: "off", readable: false, writable: false },
      },
    });
  });

  describe("Super Admin Role", () => {
    it("shows Income History link for Super Admin", () => {
      mockUseAuth.mockReturnValue({
        currentUser: createMockUser("Super Admin"),
        ...mockAuthContextBase,
      });

      render(
        <MemoryRouter>
          <Sidebar
            userRole="Super Admin"
            sidebarOpen={true}
            setSidebarOpen={mockSetSidebarOpen}
          />
        </MemoryRouter>
      );

      expect(screen.getByText("Income History")).toBeInTheDocument();
    });
  });

  describe("Administrator Role", () => {
    it("shows Income History link for Administrator", () => {
      mockUseAuth.mockReturnValue({
        currentUser: createMockUser("Administrator"),
        ...mockAuthContextBase,
      });

      render(
        <MemoryRouter>
          <Sidebar
            userRole="Administrator"
            sidebarOpen={true}
            setSidebarOpen={mockSetSidebarOpen}
          />
        </MemoryRouter>
      );

      expect(screen.getByText("Income History")).toBeInTheDocument();
    });
  });

  describe("Leader Role", () => {
    it("does NOT show Income History link for Leader", () => {
      mockUseAuth.mockReturnValue({
        currentUser: createMockUser("Leader"),
        ...mockAuthContextBase,
      });

      render(
        <MemoryRouter>
          <Sidebar
            userRole="Leader"
            sidebarOpen={true}
            setSidebarOpen={mockSetSidebarOpen}
          />
        </MemoryRouter>
      );

      expect(screen.queryByText("Income History")).not.toBeInTheDocument();
    });
  });

  describe("Participant Role", () => {
    it("does NOT show Income History link for Participant", () => {
      mockUseAuth.mockReturnValue({
        currentUser: createMockUser("Participant"),
        ...mockAuthContextBase,
      });

      render(
        <MemoryRouter>
          <Sidebar
            userRole="Participant"
            sidebarOpen={true}
            setSidebarOpen={mockSetSidebarOpen}
          />
        </MemoryRouter>
      );

      expect(screen.queryByText("Income History")).not.toBeInTheDocument();
    });
  });

  describe("Guest Expert Role", () => {
    it("does NOT show Income History link for Guest Expert", () => {
      mockUseAuth.mockReturnValue({
        currentUser: createMockUser("Guest Expert"),
        ...mockAuthContextBase,
      });

      render(
        <MemoryRouter>
          <Sidebar
            userRole="Guest Expert"
            sidebarOpen={true}
            setSidebarOpen={mockSetSidebarOpen}
          />
        </MemoryRouter>
      );

      expect(screen.queryByText("Income History")).not.toBeInTheDocument();
    });
  });

  describe("Admin-Only Features Verification", () => {
    it("shows all admin features for Super Admin", () => {
      mockUseAuth.mockReturnValue({
        currentUser: createMockUser("Super Admin"),
        ...mockAuthContextBase,
      });

      render(
        <MemoryRouter>
          <Sidebar
            userRole="Super Admin"
            sidebarOpen={true}
            setSidebarOpen={mockSetSidebarOpen}
          />
        </MemoryRouter>
      );

      // Admin-only features
      expect(screen.getByText("Published Events")).toBeInTheDocument();
      expect(screen.getByText("Promo Codes")).toBeInTheDocument();
      expect(screen.getByText("Income History")).toBeInTheDocument();
      expect(screen.getByText("Management")).toBeInTheDocument();
    });

    it("shows all admin features for Administrator", () => {
      mockUseAuth.mockReturnValue({
        currentUser: createMockUser("Administrator"),
        ...mockAuthContextBase,
      });

      render(
        <MemoryRouter>
          <Sidebar
            userRole="Administrator"
            sidebarOpen={true}
            setSidebarOpen={mockSetSidebarOpen}
          />
        </MemoryRouter>
      );

      // Admin-only features
      expect(screen.getByText("Published Events")).toBeInTheDocument();
      expect(screen.getByText("Promo Codes")).toBeInTheDocument();
      expect(screen.getByText("Income History")).toBeInTheDocument();
      expect(screen.getByText("Management")).toBeInTheDocument();
    });

    it("does NOT show admin features for Leader", () => {
      mockUseAuth.mockReturnValue({
        currentUser: createMockUser("Leader"),
        ...mockAuthContextBase,
      });

      render(
        <MemoryRouter>
          <Sidebar
            userRole="Leader"
            sidebarOpen={true}
            setSidebarOpen={mockSetSidebarOpen}
          />
        </MemoryRouter>
      );

      // Leader should see Published Events but NOT other admin-only features
      expect(screen.getByText("Published Events")).toBeInTheDocument();
      expect(screen.queryByText("Promo Codes")).not.toBeInTheDocument();
      expect(screen.queryByText("Income History")).not.toBeInTheDocument();
      // Leader sees "Community" instead of "Management"
      expect(screen.queryByText("Management")).not.toBeInTheDocument();
      expect(screen.getByText("Community")).toBeInTheDocument();
    });
  });

  describe("Alumni Network navigation", () => {
    beforeEach(() => {
      mockUseRuntimeConfig.mockReturnValue({
        status: "ready",
        config: {
          alumniNetwork: {
            mode: "read_only",
            readable: true,
            writable: false,
          },
        },
      });
    });

    it("shows the canonical Community entry to a member", () => {
      mockUseAuth.mockReturnValue({
        currentUser: createMockUser("Participant"),
        canManageUsers: false,
        ...mockAuthContextBase,
      });

      render(
        <MemoryRouter initialEntries={["/dashboard/community/members"]}>
          <Sidebar
            userRole="Participant"
            sidebarOpen={true}
            setSidebarOpen={mockSetSidebarOpen}
          />
        </MemoryRouter>,
      );

      const communityLink = screen.getByRole("link", { name: "Community" });
      expect(communityLink).toHaveAttribute("href", "/dashboard/community");
      expect(communityLink).toHaveClass("text-blue-700");
      expect(screen.queryByText("Management")).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Chat Rooms" })).toHaveAttribute(
        "href",
        "/dashboard/chat-rooms",
      );
    });

    it("shows the accessible Chat Rooms unread badge capped at 99+", () => {
      mockUseAuth.mockReturnValue({
        currentUser: createMockUser("Participant"),
        canManageUsers: false,
        ...mockAuthContextBase,
      });

      render(
        <MemoryRouter initialEntries={["/dashboard/chat-rooms/room-id"]}>
          <Sidebar
            chatUnreadTotal={143}
            userRole="Participant"
            sidebarOpen={true}
            setSidebarOpen={mockSetSidebarOpen}
          />
        </MemoryRouter>,
      );

      const link = screen.getByRole("link", {
        name: "Chat Rooms, 143 unread messages",
      });
      expect(link).toHaveClass("text-blue-700");
      expect(link).toHaveTextContent("99+");
    });

    it("shows the authoritative System Messages unread badge", () => {
      mockUseAuth.mockReturnValue({
        currentUser: createMockUser("Participant"),
        canManageUsers: false,
        ...mockAuthContextBase,
      });

      render(
        <MemoryRouter>
          <Sidebar
            systemMessageUnreadCount={6}
            userRole="Participant"
            sidebarOpen={true}
            setSidebarOpen={mockSetSidebarOpen}
          />
        </MemoryRouter>,
      );

      expect(
        screen.getByRole("link", {
          name: "System Messages, 6 unread messages",
        }),
      ).toHaveTextContent("6");
    });

    it("adds Administration and User Management for account managers", () => {
      mockUseAuth.mockReturnValue({
        currentUser: createMockUser("Administrator"),
        canManageUsers: true,
        ...mockAuthContextBase,
      });

      render(
        <MemoryRouter>
          <Sidebar
            userRole="Administrator"
            sidebarOpen={true}
            setSidebarOpen={mockSetSidebarOpen}
          />
        </MemoryRouter>,
      );

      expect(screen.getByText("Administration")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "User Management" })).toHaveAttribute(
        "href",
        "/dashboard/admin/users",
      );
      expect(screen.getByRole("link", { name: "Community" })).toHaveAttribute(
        "href",
        "/dashboard/community",
      );
      expect(screen.queryByText("Management")).not.toBeInTheDocument();
    });

    it("does not expose User Management without its permission", () => {
      mockUseAuth.mockReturnValue({
        currentUser: createMockUser("Administrator"),
        canManageUsers: false,
        ...mockAuthContextBase,
      });

      render(
        <MemoryRouter>
          <Sidebar
            userRole="Administrator"
            sidebarOpen={true}
            setSidebarOpen={mockSetSidebarOpen}
          />
        </MemoryRouter>,
      );

      expect(screen.queryByText("Administration")).not.toBeInTheDocument();
      expect(screen.queryByText("User Management")).not.toBeInTheDocument();
    });
  });

  describe("Guest Login Redirect", () => {
    it("preserves the shared program detail page when guests log in", () => {
      mockUseAuth.mockReturnValue({
        currentUser: null,
        isAuthenticated: false,
        isLoading: false,
        logout: vi.fn(),
      });

      render(
        <MemoryRouter
          initialEntries={["/dashboard/programs/program-123?ref=share"]}
        >
          <Sidebar
            userRole="guest"
            sidebarOpen={true}
            setSidebarOpen={mockSetSidebarOpen}
          />
        </MemoryRouter>,
      );

      expect(screen.getByText("Log In").closest("a")).toHaveAttribute(
        "href",
        "/login?redirect=%2Fdashboard%2Fprograms%2Fprogram-123%3Fref%3Dshare",
      );
    });
  });

  describe("Mobile keyboard navigation", () => {
    function MobileSidebarHarness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <header>
            <button
              aria-controls="dashboard-primary-navigation"
              aria-expanded={open}
              id="dashboard-mobile-menu-button"
              onClick={() => setOpen((current) => !current)}
              type="button"
            >
              Menu
            </button>
            <button type="button">Header action</button>
          </header>
          <main id="dashboard-main-content">
            <button type="button">Main action</button>
          </main>
          <Sidebar
            userRole="Participant"
            sidebarOpen={open}
            setSidebarOpen={setOpen}
          />
        </>
      );
    }

    function useMobileViewport(): () => void {
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = vi.fn().mockReturnValue({
        addEventListener: vi.fn(),
        matches: false,
        removeEventListener: vi.fn(),
      });
      return () => {
        window.matchMedia = originalMatchMedia;
      };
    }

    it("moves focus into the navigation and makes the background inert", async () => {
      const restoreViewport = useMobileViewport();
      mockUseAuth.mockReturnValue({
        currentUser: createMockUser("Participant"),
        canManageUsers: false,
        ...mockAuthContextBase,
      });
      const user = userEvent.setup();

      render(
        <MemoryRouter>
          <MobileSidebarHarness />
        </MemoryRouter>,
      );

      await user.click(screen.getByRole("button", { name: "Menu" }));

      await waitFor(() =>
        expect(screen.getByRole("link", { name: "Welcome" })).toHaveFocus(),
      );
      expect(screen.getByRole("banner", { hidden: true })).toHaveAttribute(
        "inert",
      );
      expect(screen.getByRole("main", { hidden: true })).toHaveAttribute(
        "inert",
      );

      restoreViewport();
    });

    it("contains Tab and Shift+Tab focus inside the open navigation", async () => {
      const restoreViewport = useMobileViewport();
      mockUseAuth.mockReturnValue({
        currentUser: createMockUser("Participant"),
        canManageUsers: false,
        ...mockAuthContextBase,
      });
      const user = userEvent.setup();

      render(
        <MemoryRouter>
          <MobileSidebarHarness />
        </MemoryRouter>,
      );

      await user.click(screen.getByRole("button", { name: "Menu" }));
      const first = await screen.findByRole("link", { name: "Welcome" });
      const last = screen.getByRole("button", {
        name: "Close navigation menu",
      });
      await waitFor(() => expect(first).toHaveFocus());

      await user.tab({ shift: true });
      expect(last).toHaveFocus();
      await user.tab();
      expect(first).toHaveFocus();

      restoreViewport();
    });

    it("restores focus when the drawer close button is used", async () => {
      const restoreViewport = useMobileViewport();
      mockUseAuth.mockReturnValue({
        currentUser: createMockUser("Participant"),
        canManageUsers: false,
        ...mockAuthContextBase,
      });
      const user = userEvent.setup();

      render(
        <MemoryRouter>
          <MobileSidebarHarness />
        </MemoryRouter>,
      );

      const menuButton = screen.getByRole("button", { name: "Menu" });
      await user.click(menuButton);
      await waitFor(() =>
        expect(screen.getByRole("link", { name: "Welcome" })).toHaveFocus(),
      );
      await user.click(
        screen.getByRole("button", { name: "Close navigation menu" }),
      );

      await waitFor(() => expect(menuButton).toHaveFocus());
      expect(menuButton).toHaveAttribute("aria-expanded", "false");

      restoreViewport();
    });

    it("closes with Escape and returns focus to the menu button", async () => {
      const restoreViewport = useMobileViewport();
      mockUseAuth.mockReturnValue({
        currentUser: createMockUser("Participant"),
        canManageUsers: false,
        ...mockAuthContextBase,
      });
      const user = userEvent.setup();

      render(
        <MemoryRouter>
          <MobileSidebarHarness />
        </MemoryRouter>,
      );

      const menuButton = screen.getByRole("button", { name: "Menu" });
      await user.click(menuButton);
      await waitFor(() =>
        expect(screen.getByRole("link", { name: "Welcome" })).toHaveFocus(),
      );
      await user.keyboard("{Escape}");

      await waitFor(() => expect(menuButton).toHaveFocus());
      expect(menuButton).toHaveAttribute("aria-expanded", "false");
      expect(screen.getByRole("navigation", { hidden: true })).toHaveAttribute(
        "inert",
      );

      restoreViewport();
    });
  });
});
