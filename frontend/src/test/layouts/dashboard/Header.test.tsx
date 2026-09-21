import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import Header from "../../../layouts/dashboard/Header";

// Mock the UserDropdown and NotificationDropdown components
vi.mock("../../../layouts/dashboard/UserDropdown", () => ({
  default: () => <div data-testid="user-dropdown">User Dropdown</div>,
}));

vi.mock("../../../components/common", () => ({
  NotificationDropdown: () => (
    <div data-testid="notification-dropdown">Notifications</div>
  ),
}));

const mockUser = {
  firstName: "John",
  lastName: "Doe",
  username: "johndoe",
  systemAuthorizationLevel: "Administrator",
  gender: "male" as const,
  avatar: null,
};

describe("Dashboard Header", () => {
  describe("Layout and Structure", () => {
    it("renders header with proper styling", () => {
      const setSidebarOpen = vi.fn();
      const { container } = render(
        <BrowserRouter>
          <Header
            user={mockUser}
            sidebarOpen={false}
            setSidebarOpen={setSidebarOpen}
          />
        </BrowserRouter>
      );

      const header = container.querySelector("header");
      expect(header).toBeDefined();
      expect(header?.classList.contains("bg-white")).toBe(true);
      expect(header?.classList.contains("shadow-sm")).toBe(true);
      expect(header?.classList.contains("fixed")).toBe(true);
    });

    it("renders logo image", () => {
      const setSidebarOpen = vi.fn();
      const { container } = render(
        <BrowserRouter>
          <Header
            user={mockUser}
            sidebarOpen={false}
            setSidebarOpen={setSidebarOpen}
          />
        </BrowserRouter>
      );

      const logo = container.querySelector("img[alt='@Cloud Logo']");
      expect(logo).toBeDefined();
      expect(logo?.getAttribute("src")).toBe("/@Cloud.jpg");
    });

    it("renders full organization name on large screens", () => {
      const setSidebarOpen = vi.fn();
      render(
        <BrowserRouter>
          <Header
            user={mockUser}
            sidebarOpen={false}
            setSidebarOpen={setSidebarOpen}
          />
        </BrowserRouter>
      );

      expect(screen.getByText("@Cloud Marketplace Ministry")).toBeDefined();
    });

    it("renders short organization name for mobile", () => {
      const setSidebarOpen = vi.fn();
      render(
        <BrowserRouter>
          <Header
            user={mockUser}
            sidebarOpen={false}
            setSidebarOpen={setSidebarOpen}
          />
        </BrowserRouter>
      );

      expect(screen.getByText("@Cloud")).toBeDefined();
    });

    it("renders notification dropdown", () => {
      const setSidebarOpen = vi.fn();
      render(
        <BrowserRouter>
          <Header
            user={mockUser}
            sidebarOpen={false}
            setSidebarOpen={setSidebarOpen}
          />
        </BrowserRouter>
      );

      expect(screen.getByTestId("notification-dropdown")).toBeDefined();
    });

    it("renders user dropdown", () => {
      const setSidebarOpen = vi.fn();
      render(
        <BrowserRouter>
          <Header
            user={mockUser}
            sidebarOpen={false}
            setSidebarOpen={setSidebarOpen}
          />
        </BrowserRouter>
      );

      expect(screen.getByTestId("user-dropdown")).toBeDefined();
    });
  });

  describe("Mobile Menu Button", () => {
    it("renders mobile menu button", () => {
      const setSidebarOpen = vi.fn();
      const { container } = render(
        <BrowserRouter>
          <Header
            user={mockUser}
            sidebarOpen={false}
            setSidebarOpen={setSidebarOpen}
          />
        </BrowserRouter>
      );

      const button = container.querySelector("button");
      expect(button).toBeDefined();
    });

    it("displays Bars3Icon when sidebar is closed", () => {
      const setSidebarOpen = vi.fn();
      const { container } = render(
        <BrowserRouter>
          <Header
            user={mockUser}
            sidebarOpen={false}
            setSidebarOpen={setSidebarOpen}
          />
        </BrowserRouter>
      );

      const button = container.querySelector("button");
      const svg = button?.querySelector("svg");
      expect(svg).toBeDefined();
    });

    it("displays XMarkIcon when sidebar is open", () => {
      const setSidebarOpen = vi.fn();
      const { container } = render(
        <BrowserRouter>
          <Header
            user={mockUser}
            sidebarOpen={true}
            setSidebarOpen={setSidebarOpen}
          />
        </BrowserRouter>
      );

      const button = container.querySelector("button");
      const svg = button?.querySelector("svg");
      expect(svg).toBeDefined();
    });

    it("calls setSidebarOpen with opposite value when clicked", () => {
      const setSidebarOpen = vi.fn();
      const { container } = render(
        <BrowserRouter>
          <Header
            user={mockUser}
            sidebarOpen={false}
            setSidebarOpen={setSidebarOpen}
          />
        </BrowserRouter>
      );

      const button = container.querySelector("button");
      if (button) {
        fireEvent.click(button);
      }

      expect(setSidebarOpen).toHaveBeenCalledWith(true);
    });

    it("exposes the navigation target and expanded state", () => {
      const setSidebarOpen = vi.fn();
      render(
        <BrowserRouter>
          <Header
            user={mockUser}
            sidebarOpen={false}
            setSidebarOpen={setSidebarOpen}
          />
        </BrowserRouter>,
      );

      const button = screen.getByRole("button", {
        name: "Open navigation menu",
      });
      expect(button).toHaveAttribute("aria-controls", "dashboard-primary-navigation");
      expect(button).toHaveAttribute("aria-expanded", "false");
    });

    it("toggles sidebar from open to closed when clicked", () => {
      const setSidebarOpen = vi.fn();
      const { container } = render(
        <BrowserRouter>
          <Header
            user={mockUser}
            sidebarOpen={true}
            setSidebarOpen={setSidebarOpen}
          />
        </BrowserRouter>
      );

      const button = container.querySelector("button");
      if (button) {
        fireEvent.click(button);
      }

      expect(setSidebarOpen).toHaveBeenCalledWith(false);
    });
  });

  describe("User Prop Handling", () => {
    it("accepts user with avatar", () => {
      const userWithAvatar = {
        ...mockUser,
        avatar: "https://example.com/avatar.jpg",
      };
      const setSidebarOpen = vi.fn();

      render(
        <BrowserRouter>
          <Header
            user={userWithAvatar}
            sidebarOpen={false}
            setSidebarOpen={setSidebarOpen}
          />
        </BrowserRouter>
      );

      expect(screen.getByTestId("user-dropdown")).toBeDefined();
    });

    it("accepts user without avatar", () => {
      const setSidebarOpen = vi.fn();

      render(
        <BrowserRouter>
          <Header
            user={mockUser}
            sidebarOpen={false}
            setSidebarOpen={setSidebarOpen}
          />
        </BrowserRouter>
      );

      expect(screen.getByTestId("user-dropdown")).toBeDefined();
    });

    it("accepts female user", () => {
      const femaleUser = {
        ...mockUser,
        gender: "female" as const,
      };
      const setSidebarOpen = vi.fn();

      render(
        <BrowserRouter>
          <Header
            user={femaleUser}
            sidebarOpen={false}
            setSidebarOpen={setSidebarOpen}
          />
        </BrowserRouter>
      );

      expect(screen.getByTestId("user-dropdown")).toBeDefined();
    });
  });
});
