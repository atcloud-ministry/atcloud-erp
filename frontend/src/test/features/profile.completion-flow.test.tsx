import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../contexts/AuthContext";
import { NotificationProvider } from "../../contexts/NotificationModalContext";
import Profile from "../../pages/Profile";

const mocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
}));

vi.mock("../../services/api", () => ({
  authService: {
    getProfile: mocks.getProfile,
    login: vi.fn(),
    logout: vi.fn(),
  },
  userService: { updateProfile: mocks.updateProfile },
  fileService: { uploadAvatar: vi.fn() },
}));

const legacyUser = {
  id: "legacy-user",
  username: "legacy",
  firstName: "Legacy",
  lastName: "User",
  email: "legacy@example.com",
  phone: "4155552671",
  birthYear: 1990,
  residenceCountryCode: "US",
  residenceRegion: "US-WA",
  residenceCity: "Seattle",
  employmentStatus: "employed",
  company: "Example Co",
  occupation: "Engineer",
  homeAddress: "legacy private street address",
  role: "Participant",
  isAtCloudLeader: false,
  roleInAtCloud: "",
  gender: "female",
  avatar: null,
};

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="current-location">
      {location.pathname}
      {location.search}
    </output>
  );
}

function renderProfile(path = "/dashboard/profile?mode=complete") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <NotificationProvider>
        <AuthProvider>
          <Profile />
          <LocationProbe />
        </AuthProvider>
      </NotificationProvider>
    </MemoryRouter>,
  );
}

describe("existing-user profile completion flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem("authToken", "test-token");
    mocks.getProfile.mockResolvedValue(legacyUser);
    mocks.updateProfile.mockImplementation(async (payload) => ({
      ...legacyUser,
      ...payload,
      isAtCloudLeader: false,
    }));
  });

  it("keeps a normal incomplete profile visit view-first with an inline entry", async () => {
    renderProfile("/dashboard/profile");

    await screen.findByTestId("profile-completion-callout");
    expect(screen.getByRole("button", { name: "Edit Profile" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Complete profile" })).toHaveAttribute(
      "href",
      "/dashboard/profile?mode=complete",
    );
    expect(screen.getByRole("textbox", { name: /^phone/i })).toBeDisabled();
  });

  it("auto-enters edit mode and force-submits a canonical complete profile", async () => {
    renderProfile();

    await screen.findByTestId("profile-completion-callout");
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: /^phone/i })).not.toBeDisabled();
    });

    // No persisted registration field changes are needed: completion mode must
    // still normalize and submit the full profile.
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mocks.updateProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          phone: "+14155552671",
          birthYear: 1990,
          residenceCountryCode: "US",
          residenceRegion: "US-WA",
          residenceCity: "Seattle",
          employmentStatus: "employed",
          company: "Example Co",
          occupation: "Engineer",
        }),
      );
    });
    expect(mocks.updateProfile.mock.calls[0][0]).not.toHaveProperty(
      "phoneCountryCode",
    );

    await waitFor(() => {
      expect(
        screen.queryByTestId("profile-completion-callout"),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Edit Profile" })).toBeInTheDocument();
      expect(screen.getByTestId("current-location")).toHaveTextContent(
        "/dashboard/profile",
      );
      expect(screen.getByTestId("current-location")).not.toHaveTextContent(
        "mode=complete",
      );
    });
  });

  it("cleans completion mode and restores the form when the user cancels", async () => {
    const { container } = renderProfile();

    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: /^phone/i })).not.toBeDisabled();
    });
    const firstName = container.querySelector(
      'input[name="firstName"]',
    ) as HTMLInputElement;
    fireEvent.change(firstName, { target: { value: "Changed" } });
    expect(firstName).toHaveValue("Changed");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.getByTestId("current-location")).toHaveTextContent(
        "/dashboard/profile",
      );
      expect(screen.getByTestId("current-location")).not.toHaveTextContent(
        "mode=complete",
      );
      expect(screen.getByRole("textbox", { name: /^phone/i })).toBeDisabled();
      expect(firstName).toHaveValue("Legacy");
    });
    expect(mocks.updateProfile).not.toHaveBeenCalled();
  });

  it("cleans a complete user's direct completion link without entering edit mode", async () => {
    mocks.getProfile.mockResolvedValue({
      ...legacyUser,
      phone: "+14155552671",
    });

    renderProfile();

    await waitFor(() => {
      expect(screen.getByTestId("current-location")).toHaveTextContent(
        "/dashboard/profile",
      );
      expect(screen.getByTestId("current-location")).not.toHaveTextContent(
        "mode=complete",
      );
    });
    expect(
      screen.queryByTestId("profile-completion-callout"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit Profile" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /^phone/i })).toBeDisabled();
    expect(mocks.updateProfile).not.toHaveBeenCalled();
  });
});
