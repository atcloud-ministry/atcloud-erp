import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import UserProfile from "../pages/UserProfile";
import { AuthProvider } from "../contexts/AuthContext";
import { NotificationProvider } from "../contexts/NotificationModalContext";
import { adminUsersService } from "../services/api";
import type { Gender, User as AppUser } from "../types";

// Mock the API service
vi.mock("../services/api", () => ({
  adminUsersService: {
    get: vi.fn(),
  },
  communityMembersService: {
    get: vi.fn(),
  },
  authService: {
    getProfile: vi.fn(async () => ({
      id: "admin123",
      username: "admin",
      firstName: "Admin",
      lastName: "User",
      email: "admin@example.com",
      role: "Administrator",
      isAtCloudLeader: false,
      roleInAtCloud: "Member",
      gender: "male",
    })),
    login: vi.fn(),
    logout: vi.fn(),
  },
}));

// Mock auth context to simulate Administrator user
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({
    currentUser: {
      id: "admin123",
      role: "Administrator",
      firstName: "Admin",
      lastName: "User",
    },
    canManageUsers: true,
    isLoading: false,
  }),
}));

describe("Profile Access Rules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Administrator can view Super Admin profile (new rule)", async () => {
    // Mock successful response for Super Admin profile
    const superAdminProfile: AppUser = {
      id: "super123",
      username: "superadmin",
      firstName: "Super",
      lastName: "Admin",
      email: "super@example.com",
      role: "Super Admin",
      isAtCloudLeader: "Yes",
      roleInAtCloud: "Director",
      gender: "female" as Gender,
      avatar: "/default-avatar-female.jpg",
      // Optional fields
      phone: "555-0000",
      joinDate: "2024-01-01T00:00:00Z",
      lastLogin: "2024-08-12T10:00:00Z",
      homeAddress: undefined,
      occupation: undefined,
      company: undefined,
      weeklyChurch: undefined,
      churchAddress: undefined,
    };

    vi.mocked(adminUsersService.get).mockResolvedValueOnce(superAdminProfile as never);

    render(
      <MemoryRouter initialEntries={["/dashboard/profile/super123"]}>
        <NotificationProvider>
          <AuthProvider>
            <Routes>
              <Route
                path="/dashboard/profile/:userId"
                element={<UserProfile />}
              />
            </Routes>
          </AuthProvider>
        </NotificationProvider>
      </MemoryRouter>
    );

    // Wait for API call and profile to load
    await waitFor(() => {
      expect(adminUsersService.get).toHaveBeenCalledWith("super123");
    });

    // Wait for profile to load and check that Super Admin info is displayed
    await waitFor(() => {
      expect(screen.getByText("superadmin")).toBeTruthy(); // Username is unique
      expect(screen.getByText("super@example.com")).toBeTruthy(); // Email is unique
      expect(screen.getByText("Director")).toBeTruthy(); // Role in @Cloud is unique
    });

    // Verify no error messages are shown
    expect(screen.queryByText(/Unable to load the user profile/)).toBeNull();
    expect(screen.queryByText(/Profile Loading Failed/)).toBeNull();
  });

  it("handles API errors gracefully", async () => {
    // Mock API to throw 403 error (access denied)
    const accessDeniedError = new Error("Access denied");
    (accessDeniedError as any).status = 403;
    vi.mocked(adminUsersService.get).mockRejectedValueOnce(accessDeniedError);

    render(
      <MemoryRouter initialEntries={["/dashboard/profile/other456"]}>
        <NotificationProvider>
          <AuthProvider>
            <Routes>
              <Route
                path="/dashboard/profile/:userId"
                element={<UserProfile />}
              />
            </Routes>
          </AuthProvider>
        </NotificationProvider>
      </MemoryRouter>
    );

    // Wait for API call
    await waitFor(() => {
      expect(adminUsersService.get).toHaveBeenCalledWith("other456");
    });

    // Wait for error handling to complete
    await waitFor(() => {
      expect(screen.getByText(/Unable to load the user profile/)).toBeTruthy();
    });
  });
});
