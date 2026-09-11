import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Profile from "../../pages/Profile";
import { AuthProvider } from "../../contexts/AuthContext";
import { NotificationProvider } from "../../contexts/NotificationModalContext";

// Mock API services for schema validation tests
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
      updateProfile: vi.fn(async (updates: any) => ({
        id: "user-1",
        username: updates.username || "testuser",
        firstName: updates.firstName || "Test",
        lastName: updates.lastName || "User",
        email: updates.email || "test@example.com",
        phone: updates.phone || "+12065550123",
        birthYear: updates.birthYear ?? 1990,
        residenceCity: updates.residenceCity || "Seattle",
        residenceRegion: updates.residenceRegion ?? "US-WA",
        residenceCountryCode: updates.residenceCountryCode || "US",
        employmentStatus: updates.employmentStatus || "employed",
        company: updates.company ?? "AtCloud Test",
        occupation: updates.occupation ?? "Tester",
        role: "Participant",
        isAtCloudLeader: updates.isAtCloudLeader === "Yes",
        roleInAtCloud: updates.roleInAtCloud || "",
        gender: updates.gender || "male",
        avatar: null,
      })),
    },
    fileService: {
      uploadAvatar: vi.fn(),
    },
  };
});

function renderProfile() {
  return render(
    <MemoryRouter initialEntries={["/dashboard/profile"]}>
      <NotificationProvider>
        <AuthProvider>
          <Profile />
        </AuthProvider>
      </NotificationProvider>
    </MemoryRouter>
  );
}

describe("Profile editing flows (no inline schema validation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem("authToken", "test-token");
  });

  it("allows editing fields and saving profile (shows success notification)", async () => {
    const { container } = renderProfile();
    await screen.findByText(/my profile/i);

    fireEvent.click(
      await screen.findByRole("button", { name: /edit profile/i })
    );

    // Inputs lack programmatic label association; select by name attribute
    const username = container.querySelector(
      'input[name="username"]'
    ) as HTMLInputElement;
    const firstName = container.querySelector(
      'input[name="firstName"]'
    ) as HTMLInputElement;
    const lastName = container.querySelector(
      'input[name="lastName"]'
    ) as HTMLInputElement;
    const email = container.querySelector(
      'input[name="email"]'
    ) as HTMLInputElement;

    // Edit several fields
    fireEvent.change(username, { target: { value: "tester" } });
    fireEvent.change(firstName, { target: { value: "Alice" } });
    fireEvent.change(lastName, { target: { value: "Lee" } });
    fireEvent.change(email, { target: { value: "alice@example.com" } });

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    const { userService } = await import("../../services/api");
    await waitFor(() => {
      expect((userService.updateProfile as any).mock.calls.length).toBe(1);
    });

    // Success notification from NotificationModalContext
    await screen.findByText(/profile saved/i);

    // Unmount cleanly
    container.remove();
  });

  it("shows conditional 'Role in @Cloud' when Co-worker is Yes and saves value", async () => {
    renderProfile();
    await screen.findByText(/my profile/i);
    fireEvent.click(
      await screen.findByRole("button", { name: /edit profile/i })
    );

    // Toggle to Yes
    const coworkerSelect = screen.getByLabelText(
      /are you an @cloud co-worker\?/i
    ) as HTMLSelectElement;
    fireEvent.change(coworkerSelect, { target: { value: "Yes" } });

    // Role field becomes visible
    const roleInput = screen.getByLabelText(
      /role in @cloud/i
    ) as HTMLInputElement;
    expect(roleInput).toBeTruthy();

    fireEvent.change(roleInput, { target: { value: "Founder" } });

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    const { userService } = await import("../../services/api");
    await waitFor(() => {
      const calls = (userService.updateProfile as any).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[calls.length - 1][0]).toMatchObject({
        roleInAtCloud: "Founder",
      });
    });

    await screen.findByText(/profile saved/i);
  });
});
