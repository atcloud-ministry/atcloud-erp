import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Profile from "../../pages/Profile";
import { AuthProvider } from "../../contexts/AuthContext";
import { NotificationProvider } from "../../contexts/NotificationModalContext";

// Mock API services: getProfile returns a Participant; updateProfile throws
vi.mock("../../services/api", () => {
  return {
    authService: {
      getProfile: vi.fn(async () => ({
        id: "user-1",
        username: "testuser",
        firstName: "Test",
        lastName: "User",
        email: "test@example.com",
        phone: "+12065550123",
        birthYear: 1990,
        residenceCity: "Seattle",
        residenceRegion: "US-WA",
        residenceCountryCode: "US",
        employmentStatus: "employed",
        company: "AtCloud Test",
        occupation: "Tester",
        role: "Participant",
        isAtCloudLeader: false,
        roleInAtCloud: "",
        gender: "male",
        avatar: null,
      })),
    },
    userService: {
      updateProfile: vi.fn(async () => {
        throw new Error("Invalid email");
      }),
    },
    fileService: {
      uploadAvatar: vi.fn(),
    },
  };
});

describe("Profile validation error handling (service-level)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem("authToken", "test-token");
  });

  it("shows an error notification and stays in edit mode when updateProfile fails", async () => {
    render(
      <MemoryRouter initialEntries={["/dashboard/profile"]}>
        <NotificationProvider>
          <AuthProvider>
            <Profile />
          </AuthProvider>
        </NotificationProvider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/my profile/i)).toBeTruthy();
    });

    fireEvent.click(
      await screen.findByRole("button", { name: /edit profile/i })
    );

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    // Expect error notification from service failure
    await screen.findByText(/update failed/i); // Notification title
    await screen.findByText(/invalid email/i); // Error message

    // Still in edit mode: Save and Cancel buttons visible
    expect(
      screen.getByRole("button", { name: /save changes/i })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });
});
