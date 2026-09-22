import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Profile from "../../pages/Profile";

// Mock useProfileForm to avoid dealing with implementation details
vi.mock("../../hooks/useProfileForm", () => ({
  useProfileForm: () => ({
    form: {
      register: vi.fn(),
      watch: vi.fn(),
      formState: { errors: {} },
    },
    isEditing: false,
    avatarPreview: "",
    watchedValues: { isAtCloudLeader: "No" },
    onSubmit: vi.fn(),
    handleEdit: vi.fn(),
    handleCancel: vi.fn(),
    handleAvatarChange: vi.fn(),
  }),
}));

// Mock AuthContext-based useAuth so Profile doesn't require a real AuthProvider
vi.mock("../../contexts/AuthContext", async () => {
  const actual = await vi.importActual<
    typeof import("../../contexts/AuthContext")
  >("../../contexts/AuthContext");
  return {
    ...actual,
    useAuth: () => ({
      currentUser: {
        id: "user-1",
        firstName: "Test",
        lastName: "User",
        role: "Participant",
        gender: "male",
        isAtCloudLeader: "No",
        avatar: null,
      },
    }),
  };
});

describe("Profile", () => {
  it("renders profile header and actions in view mode", () => {
    render(
      <MemoryRouter>
        <Profile />
      </MemoryRouter>
    );

    expect(
      screen.getByRole("heading", { name: /my profile/i })
    ).toBeInTheDocument();

    // View-mode actions
    expect(
      screen.getByRole("link", { name: /change password/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /edit profile/i })
    ).toBeInTheDocument();

    expect(
      screen.getByRole("heading", { name: /contact and personal details/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: /^phone/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^birth year/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^country of residence/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^city/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^employment status/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^occupation/i)).toBeInTheDocument();
    expect(screen.queryByText(/^home address$/i)).not.toBeInTheDocument();

    // System info section
    expect(screen.getByText(/system authorization level/i)).toBeInTheDocument();
    expect(screen.getByText(/participant/i)).toBeInTheDocument();
  });
});
