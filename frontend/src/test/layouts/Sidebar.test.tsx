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
import { MotionGlobalConfig } from "motion/react";
import Sidebar from "../../layouts/dashboard/Sidebar";
import type { AuthUser } from "../../types";

// jsdom cannot measure height: "auto", so let section panels open/close instantly.
MotionGlobalConfig.skipAnimations = true;

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

  const expandAllGroups = () =>
    window.localStorage.setItem(
      "atcloud.sidebar.groups",
      JSON.stringify({
        programs: true,
        events: true,
        community: true,
        admin: true,
      }),
    );

  beforeEach(() => {
    vi.clearAllMocks();
    // Most cases assert on links inside sections, so start with all open.
    expandAllGroups();
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

    it("expands Alumni Community into its sections and marks the current one", () => {
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

      expect(
        screen.getByRole("button", { name: "Alumni Community" }),
      ).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("link", { name: "Members" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      for (const [name, href] of [
        ["Alumni Directory", "/dashboard/community/alumni"],
        ["My Alumni Profile", "/dashboard/community/alumni/me"],
        ["Help Requests", "/dashboard/community/help-requests"],
        ["Chats", "/dashboard/chat-rooms"],
      ]) {
        expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
      }
      expect(screen.queryByText("Management")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: /^Chat Rooms/ }),
      ).not.toBeInTheDocument();
    });

    it("opens the section for the current page even if it was collapsed", () => {
      window.localStorage.removeItem("atcloud.sidebar.groups");
      mockUseAuth.mockReturnValue({
        currentUser: createMockUser("Participant"),
        canManageUsers: false,
        ...mockAuthContextBase,
      });

      render(
        <MemoryRouter initialEntries={["/dashboard/community/alumni/profile-1"]}>
          <Sidebar
            userRole="Participant"
            sidebarOpen={true}
            setSidebarOpen={mockSetSidebarOpen}
          />
        </MemoryRouter>,
      );

      expect(
        screen.getByRole("link", { name: "Alumni Directory" }),
      ).toHaveAttribute("aria-current", "page");
      expect(screen.getByRole("button", { name: "Events" })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      expect(
        screen.queryByRole("link", { name: "My Events" }),
      ).not.toBeInTheDocument();
    });

    it("toggles a section and remembers the choice", async () => {
      window.localStorage.removeItem("atcloud.sidebar.groups");
      mockUseAuth.mockReturnValue({
        currentUser: createMockUser("Participant"),
        canManageUsers: false,
        ...mockAuthContextBase,
      });
      const user = userEvent.setup();

      render(
        <MemoryRouter initialEntries={["/dashboard/welcome"]}>
          <Sidebar
            userRole="Participant"
            sidebarOpen={true}
            setSidebarOpen={mockSetSidebarOpen}
          />
        </MemoryRouter>,
      );

      const events = screen.getByRole("button", { name: "Events" });
      await user.click(events);
      expect(events).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("link", { name: "My Events" })).toHaveAttribute(
        "href",
        "/dashboard/my-events",
      );
      expect(
        JSON.parse(window.localStorage.getItem("atcloud.sidebar.groups") ?? "{}"),
      ).toMatchObject({ events: true });

      await user.click(events);
      expect(events).toHaveAttribute("aria-expanded", "false");
      await waitFor(() =>
        expect(
          screen.queryByRole("link", { name: "My Events" }),
        ).not.toBeInTheDocument(),
      );
    });

    it("shows the combined community badge on the collapsed section", () => {
      window.localStorage.removeItem("atcloud.sidebar.groups");
      mockUseAuth.mockReturnValue({
        currentUser: createMockUser("Participant"),
        canManageUsers: false,
        ...mockAuthContextBase,
      });
      const sidebar = (count: number) => (
        <MemoryRouter initialEntries={["/dashboard/my-events"]}>
          <Sidebar
            chatUnreadTotal={count === 0 ? 0 : 1}
            helpNotificationCount={count === 0 ? 0 : count - 1}
            userRole="Participant"
            sidebarOpen={true}
            setSidebarOpen={mockSetSidebarOpen}
          />
        </MemoryRouter>
      );
      const { rerender } = render(sidebar(0));
      expect(screen.getByRole("button", { name: "Alumni Community" }))
        .toHaveAttribute("aria-expanded", "false");

      rerender(sidebar(3));
      expect(screen.getByRole("button", {
        name: "Alumni Community, 3 help request updates and unread chat messages",
      })).toHaveTextContent("3");

      rerender(sidebar(123));
      expect(screen.getByRole("button", {
        name: "Alumni Community, 123 help request updates and unread chat messages",
      })).toHaveTextContent("99+");

      rerender(sidebar(0));
      expect(screen.getByRole("button", { name: "Alumni Community" }))
        .toHaveTextContent(/^Alumni Community$/);
    });

    it("highlights Chats in a Chat Room and badges each community section", () => {
      mockUseAuth.mockReturnValue({
        currentUser: createMockUser("Participant"),
        canManageUsers: false,
        ...mockAuthContextBase,
      });

      render(
        <MemoryRouter initialEntries={["/dashboard/chat-rooms/room-id"]}>
          <Sidebar
            chatUnreadTotal={140}
            helpNotificationCount={3}
            userRole="Participant"
            sidebarOpen={true}
            setSidebarOpen={mockSetSidebarOpen}
          />
        </MemoryRouter>,
      );

      const chats = screen.getByRole("link", {
        name: "Chats, 140 unread messages",
      });
      expect(chats).toHaveAttribute("aria-current", "page");
      expect(chats).toHaveTextContent("99+");
      expect(
        screen.getByRole("link", {
          name: "Help Requests, 3 requests with updates or actions needed",
        }),
      ).toHaveTextContent("3");
    });

    it("keeps the four bottom-bar shortcuts out of the phone menu but visible from tablet width", () => {
      mockUseAuth.mockReturnValue({
        currentUser: createMockUser("Participant"),
        canManageUsers: false,
        ...mockAuthContextBase,
      });

      render(
        <MemoryRouter>
          <Sidebar
            userRole="Participant"
            sidebarOpen={true}
            setSidebarOpen={mockSetSidebarOpen}
          />
        </MemoryRouter>,
      );

      for (const name of ["Event Calendar", "Donate", "Feedback", "Chats"]) {
        expect(screen.getByRole("link", { name }).closest("li")).toHaveClass(
          "hidden",
          "md:list-item",
        );
      }
      // The rest of Alumni Community stays reachable from the phone menu.
      expect(
        screen.getByRole("link", { name: "Alumni Directory" }).closest("li"),
      ).not.toHaveClass("hidden");
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

    it("puts User Management in the Administration section", () => {
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

      const administration = screen.getByRole("button", {
        name: "Administration",
      });
      expect(
        document.getElementById(administration.getAttribute("aria-controls") ?? ""),
      ).toContainElement(screen.getByRole("link", { name: "User Management" }));
      expect(screen.getByRole("link", { name: "User Management" })).toHaveAttribute(
        "href",
        "/dashboard/admin/users",
      );
      expect(
        screen.getByRole("button", { name: "Alumni Community" }),
      ).toBeInTheDocument();
      expect(screen.queryByText("Management")).not.toBeInTheDocument();
    });

    it("groups admin navigation into ordered sections", () => {
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

      const sections = screen
        .getAllByRole("button", { expanded: true })
        .map((button) => button.textContent ?? "");
      expect(sections).toEqual([
        "Programs",
        "Events",
        "Alumni Community",
        "Administration",
      ]);

      const panelOf = (section: string) =>
        document.getElementById(
          screen
            .getByRole("button", { name: section })
            .getAttribute("aria-controls") ?? "",
        );
      expect(panelOf("Events")).toContainElement(
        screen.getByRole("link", { name: "Role Templates" }),
      );
      expect(panelOf("Administration")).toContainElement(
        screen.getByRole("link", { name: "Promo Codes" }),
      );
      const names = screen
        .getAllByRole("link")
        .map((link) => link.textContent ?? "");
      expect(names).not.toContain("Chat Rooms");
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

      expect(screen.getByRole("link", { name: "Promo Codes" })).toBeInTheDocument();
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
              id="dashboard-tablet-menu-button"
              onClick={() => setOpen((current) => !current)}
              type="button"
            >
              Tablet menu
            </button>
            <button type="button">Header action</button>
          </header>
          <main id="dashboard-main-content">
            <button type="button">Main action</button>
          </main>
          <nav
            aria-label="Mobile primary navigation"
            id="dashboard-mobile-bottom-navigation"
          >
            <button
              aria-controls="dashboard-primary-navigation"
              aria-expanded={open}
              id="dashboard-mobile-menu-button"
              onClick={() => setOpen((current) => !current)}
              type="button"
            >
              Menu
            </button>
          </nav>
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
      expect(
        screen.getByRole("navigation", {
          hidden: true,
          name: "Mobile primary navigation",
        }),
      ).toHaveAttribute("inert");

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
      expect(
        screen.getByRole("navigation", {
          name: "Mobile primary navigation",
        }),
      ).not.toHaveAttribute("inert");

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
      expect(
        document.getElementById("dashboard-primary-navigation"),
      ).toHaveAttribute("inert");
      expect(
        screen.getByRole("navigation", {
          name: "Mobile primary navigation",
        }),
      ).not.toHaveAttribute("inert");

      restoreViewport();
    });
  });
});
