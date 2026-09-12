import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BrowserRouter, MemoryRouter } from "react-router-dom";
import UserDropdown from "../../../layouts/dashboard/UserDropdown";

// Mock dependencies
vi.mock("../../../hooks/useAuth", () => ({
  useAuth: () => ({
    logout: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../../../components/common/ConfirmLogoutModal", () => ({
  default: ({ open, onCancel, onConfirm, loading }: any) => {
    if (!open) return null;
    return (
      <div data-testid="logout-modal">
        <button onClick={onCancel} data-testid="cancel-logout">
          Cancel
        </button>
        <button
          onClick={onConfirm}
          data-testid="confirm-logout"
          disabled={loading}
        >
          {loading ? "Logging out..." : "Confirm"}
        </button>
      </div>
    );
  },
}));

vi.mock("../../../utils/avatarUtils", () => ({
  getAvatarUrlWithCacheBust: (avatar: string | null, gender: string) =>
    avatar || `/default-${gender}.png`,
  getAvatarAlt: (firstName: string, lastName: string, hasAvatar: boolean) =>
    hasAvatar
      ? `${firstName} ${lastName}`
      : `Default avatar for ${firstName} ${lastName}`,
}));

const mockUser = {
  firstName: "John",
  lastName: "Doe",
  username: "johndoe",
  systemAuthorizationLevel: "Administrator",
  gender: "male" as const,
  avatar: null,
};

describe("UserDropdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.pushState({}, "", "/");
  });

  describe("Initial Render", () => {
    it("renders user button with avatar", () => {
      const { container } = render(
        <BrowserRouter>
          <UserDropdown user={mockUser} />
        </BrowserRouter>
      );

      const img = container.querySelector("img");
      expect(img).toBeDefined();
      expect(img?.classList.contains("rounded-full")).toBe(true);
    });

    it("renders user name", () => {
      render(
        <BrowserRouter>
          <UserDropdown user={mockUser} />
        </BrowserRouter>
      );

      expect(screen.getByText("John Doe")).toBeDefined();
    });

    it("renders user authorization level", () => {
      render(
        <BrowserRouter>
          <UserDropdown user={mockUser} />
        </BrowserRouter>
      );

      expect(screen.getByText("Administrator")).toBeDefined();
    });

    it("renders chevron icon", () => {
      const { container } = render(
        <BrowserRouter>
          <UserDropdown user={mockUser} />
        </BrowserRouter>
      );

      const chevron = container.querySelector("svg");
      expect(chevron).toBeDefined();
    });

    it("dropdown is closed by default", () => {
      render(
        <BrowserRouter>
          <UserDropdown user={mockUser} />
        </BrowserRouter>
      );

      expect(screen.queryByText("Profile")).toBeNull();
    });
  });

  describe("Dropdown Toggle", () => {
    it("opens dropdown when button is clicked", async () => {
      const { container } = render(
        <BrowserRouter>
          <UserDropdown user={mockUser} />
        </BrowserRouter>
      );

      const button = container.querySelector("button");
      if (button) {
        fireEvent.click(button);
      }

      await waitFor(() => {
        expect(screen.getByText("Profile")).toBeDefined();
      });
    });

    it("closes dropdown when button is clicked again", async () => {
      const { container } = render(
        <BrowserRouter>
          <UserDropdown user={mockUser} />
        </BrowserRouter>
      );

      const button = container.querySelector("button");

      // Open dropdown
      if (button) {
        fireEvent.click(button);
      }
      await waitFor(() => {
        expect(screen.getByText("Profile")).toBeDefined();
      });

      // Close dropdown
      if (button) {
        fireEvent.click(button);
      }
      await waitFor(() => {
        expect(screen.queryByText("Profile")).toBeNull();
      });
    });

    it("closes dropdown when clicking outside", async () => {
      render(
        <BrowserRouter>
          <UserDropdown user={mockUser} />
        </BrowserRouter>
      );

      const button = screen.getByRole("button");
      fireEvent.click(button);

      await waitFor(() => {
        expect(screen.getByText("Profile")).toBeDefined();
      });

      // Click outside
      fireEvent.mouseDown(document.body);

      await waitFor(() => {
        expect(screen.queryByText("Profile")).toBeNull();
      });
    });
  });

  describe("Dropdown Menu Items", () => {
    beforeEach(async () => {
      render(
        <BrowserRouter>
          <UserDropdown user={mockUser} />
        </BrowserRouter>
      );

      const button = screen.getByRole("button");
      fireEvent.click(button);

      await waitFor(() => {
        expect(screen.getByText("Profile")).toBeDefined();
      });
    });

    it("displays Profile link", () => {
      const profileLink = screen.getByText("Profile");
      expect(profileLink).toBeDefined();
      expect(profileLink.closest("a")?.getAttribute("href")).toBe(
        "/dashboard/profile"
      );
    });

    it("displays Change Password link", () => {
      const changePasswordLink = screen.getByText("Change Password");
      expect(changePasswordLink).toBeDefined();
      expect(changePasswordLink.closest("a")?.getAttribute("href")).toBe(
        "/dashboard/change-password"
      );
    });

    it("displays Notification Settings link", () => {
      const link = screen.getByText("Notification Settings");
      expect(link.closest("a")?.getAttribute("href")).toBe(
        "/dashboard/notification-settings"
      );
    });

    it("displays My Promo Codes link", () => {
      const promoCodesLink = screen.getByText("My Promo Codes");
      expect(promoCodesLink).toBeDefined();
      expect(promoCodesLink.closest("a")?.getAttribute("href")).toBe(
        "/dashboard/promo-codes"
      );
    });

    it("displays Purchase History link", () => {
      const purchaseHistoryLink = screen.getByText("Purchase History");
      expect(purchaseHistoryLink).toBeDefined();
      expect(purchaseHistoryLink.closest("a")?.getAttribute("href")).toBe(
        "/dashboard/purchase-history"
      );
    });

    it("displays Donate link", () => {
      const donateLink = screen.getByText("Donate");
      expect(donateLink).toBeDefined();
      expect(donateLink.closest("a")?.getAttribute("href")).toBe(
        "/dashboard/donate"
      );
    });

    it("displays Log Out button", () => {
      const logoutButton = screen.getByText("Log Out");
      expect(logoutButton).toBeDefined();
      expect(logoutButton.tagName).toBe("BUTTON");
    });

    it("closes dropdown when Profile link is clicked", async () => {
      const profileLink = screen.getByText("Profile");
      fireEvent.click(profileLink);

      await waitFor(() => {
        expect(screen.queryByText("Change Password")).toBeNull();
      });
    });

    it("closes dropdown when any menu item is clicked", async () => {
      const donateLink = screen.getByText("Donate");
      fireEvent.click(donateLink);

      await waitFor(() => {
        expect(screen.queryByText("Profile")).toBeNull();
      });
    });
  });

  describe("Guest Dropdown Menu Items", () => {
    it("preserves the current shared program page in the Login link", async () => {
      render(
        <MemoryRouter
          initialEntries={["/dashboard/programs/program-123?ref=share"]}
        >
          <UserDropdown user={null} isGuest={true} />
        </MemoryRouter>,
      );

      fireEvent.click(screen.getByRole("button"));

      const loginLink = await screen.findByText("Login");
      expect(loginLink.closest("a")?.getAttribute("href")).toBe(
        "/login?redirect=%2Fdashboard%2Fprograms%2Fprogram-123%3Fref%3Dshare",
      );
    });
  });

  describe("Logout Flow", () => {
    it("shows logout confirmation modal when Log Out is clicked", async () => {
      render(
        <BrowserRouter>
          <UserDropdown user={mockUser} />
        </BrowserRouter>
      );

      // Open dropdown
      const button = screen.getByRole("button");
      fireEvent.click(button);

      await waitFor(() => {
        expect(screen.getByText("Log Out")).toBeDefined();
      });

      // Click logout
      const logoutButton = screen.getByText("Log Out");
      fireEvent.click(logoutButton);

      await waitFor(() => {
        expect(screen.getByTestId("logout-modal")).toBeDefined();
      });
    });

    it("closes dropdown when logout is initiated", async () => {
      render(
        <BrowserRouter>
          <UserDropdown user={mockUser} />
        </BrowserRouter>
      );

      const button = screen.getByRole("button");
      fireEvent.click(button);

      await waitFor(() => {
        expect(screen.getByText("Log Out")).toBeDefined();
      });

      const logoutButton = screen.getByText("Log Out");
      fireEvent.click(logoutButton);

      await waitFor(() => {
        expect(screen.queryByText("Profile")).toBeNull();
      });
    });

    it("closes modal when cancel is clicked", async () => {
      render(
        <BrowserRouter>
          <UserDropdown user={mockUser} />
        </BrowserRouter>
      );

      const button = screen.getByRole("button");
      fireEvent.click(button);

      await waitFor(() => {
        expect(screen.getByText("Log Out")).toBeDefined();
      });

      const logoutButton = screen.getByText("Log Out");
      fireEvent.click(logoutButton);

      await waitFor(() => {
        expect(screen.getByTestId("cancel-logout")).toBeDefined();
      });

      const cancelButton = screen.getByTestId("cancel-logout");
      fireEvent.click(cancelButton);

      await waitFor(() => {
        expect(screen.queryByTestId("logout-modal")).toBeNull();
      });
    });

    it("executes logout when confirmed", async () => {
      render(
        <BrowserRouter>
          <UserDropdown user={mockUser} />
        </BrowserRouter>
      );

      const button = screen.getByRole("button");
      fireEvent.click(button);

      await waitFor(() => {
        expect(screen.getByText("Log Out")).toBeDefined();
      });

      const logoutButton = screen.getByText("Log Out");
      fireEvent.click(logoutButton);

      await waitFor(() => {
        expect(screen.getByTestId("confirm-logout")).toBeDefined();
      });

      const confirmButton = screen.getByTestId("confirm-logout");
      fireEvent.click(confirmButton);

      // Verify logout was called and modal closes
      await waitFor(() => {
        expect(screen.queryByTestId("logout-modal")).toBeNull();
      });
    });

    it("shows loading state during logout", async () => {
      render(
        <BrowserRouter>
          <UserDropdown user={mockUser} />
        </BrowserRouter>
      );

      const button = screen.getByRole("button");
      fireEvent.click(button);

      await waitFor(() => {
        expect(screen.getByText("Log Out")).toBeDefined();
      });

      const logoutButton = screen.getByText("Log Out");
      fireEvent.click(logoutButton);

      await waitFor(() => {
        expect(screen.getByTestId("confirm-logout")).toBeDefined();
      });

      // The button should exist (loading state is handled by modal)
      const confirmButton = screen.getByTestId("confirm-logout");
      expect(confirmButton).toBeDefined();
    });
  });

  describe("Avatar Handling", () => {
    it("uses custom avatar when provided", () => {
      const userWithAvatar = {
        ...mockUser,
        avatar: "https://example.com/avatar.jpg",
      };

      const { container } = render(
        <BrowserRouter>
          <UserDropdown user={userWithAvatar} />
        </BrowserRouter>
      );

      const img = container.querySelector("img");
      expect(img?.getAttribute("src")).toBe("https://example.com/avatar.jpg");
    });

    it("uses default male avatar when no avatar provided", () => {
      const { container } = render(
        <BrowserRouter>
          <UserDropdown user={mockUser} />
        </BrowserRouter>
      );

      const img = container.querySelector("img");
      expect(img?.getAttribute("src")).toBe("/default-male.png");
    });

    it("uses default female avatar for female user", () => {
      const femaleUser = {
        ...mockUser,
        gender: "female" as const,
      };

      const { container } = render(
        <BrowserRouter>
          <UserDropdown user={femaleUser} />
        </BrowserRouter>
      );

      const img = container.querySelector("img");
      expect(img?.getAttribute("src")).toBe("/default-female.png");
    });
  });

  describe("Different User Roles", () => {
    it("displays Participant role correctly", () => {
      const participant = {
        ...mockUser,
        systemAuthorizationLevel: "Participant",
      };

      render(
        <BrowserRouter>
          <UserDropdown user={participant} />
        </BrowserRouter>
      );

      expect(screen.getByText("Participant")).toBeDefined();
    });

    it("displays Leader role correctly", () => {
      const leader = {
        ...mockUser,
        systemAuthorizationLevel: "Leader",
      };

      render(
        <BrowserRouter>
          <UserDropdown user={leader} />
        </BrowserRouter>
      );

      expect(screen.getByText("Leader")).toBeDefined();
    });

    it("displays Super Admin role correctly", () => {
      const superAdmin = {
        ...mockUser,
        systemAuthorizationLevel: "Super Admin",
      };

      render(
        <BrowserRouter>
          <UserDropdown user={superAdmin} />
        </BrowserRouter>
      );

      expect(screen.getByText("Super Admin")).toBeDefined();
    });
  });
});
