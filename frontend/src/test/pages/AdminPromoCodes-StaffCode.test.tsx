import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import userEvent from "@testing-library/user-event";
import { BrowserRouter } from "react-router-dom";
import AdminPromoCodes from "../../pages/AdminPromoCodes";
import * as api from "../../services/api";

// Mock API client
vi.mock("../../services/api");
vi.mock("../../services/api/events.api", () => ({
  eventsService: {
    getEvents: vi.fn().mockResolvedValue({ events: [] }),
  },
}));

// Mock hooks
vi.mock("../../hooks/useUserData", () => ({
  useUserData: vi.fn(() => ({
    users: [],
    loading: false,
    refreshUsers: vi.fn(),
    pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    loadPage: vi.fn(),
  })),
}));

vi.mock("../../hooks/useUsersApi", () => ({
  useUsers: vi.fn(() => ({
    users: [],
    loading: false,
    error: null,
    refreshUsers: vi.fn(),
    pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    loadPage: vi.fn(),
  })),
}));

vi.mock("../../hooks/useAvatarUpdates", () => ({
  useAvatarUpdates: vi.fn(() => ({
    avatarVersion: 0,
  })),
}));

// Mock NotificationModalContext
vi.mock("../../contexts/NotificationModalContext", () => ({
  useToastReplacement: vi.fn(() => ({
    show: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  })),
}));

// Mock AuthContext
vi.mock("../../contexts/AuthContext", () => ({
  useAuth: vi.fn(() => ({
    user: {
      _id: "admin123",
      role: "Super Admin",
      firstName: "Admin",
      lastName: "User",
      email: "admin@example.com",
    },
  })),
}));

describe("AdminPromoCodes - Staff Code Creation (Minimal Test)", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Setup minimal mocks
    vi.mocked(api.apiClient.getAllPromoCodes).mockResolvedValue({
      codes: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
    vi.mocked(api.apiClient.listPrograms).mockResolvedValue([]);
    vi.mocked(api.adminUsersService.list).mockResolvedValue({
      users: [],
      pagination: {
        currentPage: 1,
        totalPages: 0,
        totalUsers: 0,
        hasNext: false,
        hasPrev: false,
      },
    });
  });

  /**
   * MINIMAL TEST: Verify basic component renders and tab navigation works
   */
  it("should render and navigate to Create Staff Code tab", async () => {
    const user = userEvent.setup();

    render(
      <BrowserRouter>
        <AdminPromoCodes />
      </BrowserRouter>,
    );

    // Wait for component to load
    await waitFor(() => {
      expect(screen.getByText("Promo Codes Management")).toBeInTheDocument();
    });

    // Verify "Create Staff Code" tab exists
    const createStaffTab = screen.getByRole("button", {
      name: /create staff code/i,
    });
    expect(createStaffTab).toBeInTheDocument();

    // Click the tab
    await user.click(createStaffTab);

    // Verify the tab content loads (should see code type choice)
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /create personal staff code/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /create general staff code/i }),
      ).toBeInTheDocument();
    });
  });

  it("should show a newly created staff code in View All Codes after Done", async () => {
    const user = userEvent.setup();
    const mockCreatedCode = {
      _id: "code-general-123",
      code: "STAFF-GEN123",
      type: "staff_access" as const,
      discountPercent: 100,
      description: "Staff Discount 2026",
      isGeneral: true,
      ownerId: "",
      isActive: true,
      isUsed: false,
      createdAt: new Date().toISOString(),
      createdBy: "admin123",
    };

    vi.mocked(api.apiClient.createGeneralStaffPromoCode).mockResolvedValue({
      code: mockCreatedCode,
    });
    vi.mocked(api.apiClient.getAllPromoCodes)
      .mockResolvedValueOnce({
        codes: [],
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      })
      .mockResolvedValueOnce({
        codes: [mockCreatedCode],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      });

    render(
      <BrowserRouter>
        <AdminPromoCodes />
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("Promo Codes Management")).toBeInTheDocument();
    });

    await user.click(
      screen.getByRole("button", { name: /create staff code/i }),
    );

    await user.click(
      await screen.findByRole("button", {
        name: /create general staff code/i,
      }),
    );

    await user.type(
      screen.getByPlaceholderText(/staff discount 2025/i),
      "Staff Discount 2026",
    );

    const submitButtons = screen.getAllByRole("button", {
      name: /create general staff code/i,
    });
    const generateButton = submitButtons.find(
      (btn) => btn.getAttribute("type") === "submit",
    );
    expect(generateButton).toBeInTheDocument();
    await user.click(generateButton!);

    expect(await screen.findByText("Staff Code Created!")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /done/i }));

    await waitFor(() => {
      expect(screen.getByText("STAFF-GEN123")).toBeInTheDocument();
    });
    expect(api.apiClient.getAllPromoCodes).toHaveBeenCalledTimes(2);
  });

  /**
   * CORE TEST: Verify user search and selection flow with valid ID
   * This is the critical bug prevention test
   */
  it("should ensure selected user from search has valid ID", async () => {
    const user = userEvent.setup();

    // Mock user search with COMPLETE data including ID
    const mockUser = {
      id: "user123",
      username: "john.doe",
      email: "john.doe@example.com",
      firstName: "John",
      lastName: "Doe",
      role: "Participant" as const,
      roleInAtCloud: "@Cloud Co-worker",
      gender: "male" as const,
      avatar: null,
      phone: "+1234567890",
      birthYear: 1990,
      residenceCity: "Seattle",
      residenceRegion: "US-WA",
      residenceCountryCode: "US" as const,
      employmentStatus: "employed" as const,
      isAtCloudLeader: false,
      homeAddress: null,
      occupation: null,
      company: null,
      weeklyChurch: null,
      churchAddress: null,
      isActive: true,
      isVerified: true,
      emailNotifications: true,
      lastLogin: null,
      createdAt: null,
      updatedAt: null,
    };

    vi.mocked(api.adminUsersService.list).mockResolvedValue({
      users: [mockUser],
      pagination: {
        currentPage: 1,
        totalPages: 1,
        totalUsers: 1,
        hasNext: false,
        hasPrev: false,
      },
    });

    // Mock staff code creation
    const mockCreatedCode = {
      _id: "code123",
      code: "STAFF-ABC123",
      type: "staff_access" as const,
      discountPercent: 40,
      ownerId: "user123",
      ownerEmail: "john.doe@example.com",
      ownerName: "John Doe",
      isActive: true,
      isUsed: false,
      createdAt: new Date().toISOString(),
      createdBy: "admin123",
    };

    vi.mocked(api.apiClient.createStaffPromoCode).mockResolvedValue({
      code: mockCreatedCode,
    });

    render(
      <BrowserRouter>
        <AdminPromoCodes />
      </BrowserRouter>,
    );

    // Navigate to Create Staff Code tab
    await waitFor(() => {
      expect(screen.getByText("Promo Codes Management")).toBeInTheDocument();
    });

    const createStaffTab = screen.getByRole("button", {
      name: /create staff code/i,
    });
    await user.click(createStaffTab);

    // Choose Personal Staff Code option
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /create personal staff code/i }),
      ).toBeInTheDocument();
    });

    const personalCodeButton = screen.getByRole("button", {
      name: /create personal staff code/i,
    });
    await user.click(personalCodeButton);

    // Wait for the form to appear with Select User button
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /select user/i }),
      ).toBeInTheDocument();
    });

    // Open user selection modal
    const selectUserButton = screen.getByRole("button", {
      name: /select user/i,
    });
    await user.click(selectUserButton);

    // Wait for modal to open
    await waitFor(() => {
      expect(
        screen.getByText("Select User for Staff Code"),
      ).toBeInTheDocument();
    });

    // Type in search box
    const searchInput = screen.getByPlaceholderText(/search by name or email/i);
    await user.type(searchInput, "john");

    // Wait for search to be called
    await waitFor(
      () => {
        expect(api.adminUsersService.list).toHaveBeenCalledWith(
          expect.objectContaining({ q: "john" }),
        );
      },
      { timeout: 2000 },
    );

    // Wait for user to appear in results
    await waitFor(
      () => {
        expect(screen.getByText("John Doe")).toBeInTheDocument();
      },
      { timeout: 2000 },
    );

    // Select the user
    const userCard = screen.getByText("John Doe").closest("button");
    expect(userCard).toBeInTheDocument();
    await user.click(userCard!);

    // Verify modal closes
    await waitFor(() => {
      expect(
        screen.queryByText("Select User for Staff Code"),
      ).not.toBeInTheDocument();
    });

    // Verify user is displayed in the form
    expect(screen.getByText("John Doe")).toBeInTheDocument();
    expect(screen.getByText("john.doe@example.com")).toBeInTheDocument();

    // Set a partial staff discount to verify the new control is wired through
    const discountSlider = screen.getByLabelText(/discount percentage/i);
    fireEvent.change(discountSlider, { target: { value: "40" } });
    expect(discountSlider).toHaveValue("40");

    // Submit the form (find the submit button, not the tab button)
    const submitButtons = screen.getAllByRole("button", {
      name: /create staff code/i,
    });
    const generateButton = submitButtons.find(
      (btn) => btn.getAttribute("type") === "submit",
    );
    expect(generateButton).toBeInTheDocument();
    await user.click(generateButton!);

    // CRITICAL ASSERTION: Verify API was called with user ID
    await waitFor(
      () => {
        expect(api.apiClient.createStaffPromoCode).toHaveBeenCalled();
      },
      { timeout: 2000 },
    );

    // Verify the API call included the user ID
    const apiCalls = vi.mocked(api.apiClient.createStaffPromoCode).mock.calls;
    expect(apiCalls.length).toBeGreaterThan(0);

    const firstCallArg = apiCalls[0][0];
    expect(firstCallArg).toHaveProperty("userId");
    expect(firstCallArg.userId).toBe("user123"); // Must match mock user ID
    expect(firstCallArg.userId).toBeTruthy(); // Guard: not null/undefined
    expect(firstCallArg.userId.length).toBeGreaterThan(0); // Guard: not empty string
    expect(firstCallArg.discountPercent).toBe(40);
  });

  /**
   * NEGATIVE TEST: Verify behavior with missing user ID
   */
  it("should handle user without ID gracefully", async () => {
    const user = userEvent.setup();

    // Mock user search with INVALID data (missing ID)
    const mockInvalidUser = {
      // id: 'user123', // INTENTIONALLY MISSING
      username: "broken.user",
      email: "broken@example.com",
      firstName: "Broken",
      lastName: "User",
      role: "User",
      roleInAtCloud: "@Cloud Co-worker",
      gender: "male" as const,
      avatar: null,
    };

    vi.mocked(api.adminUsersService.list).mockResolvedValue({
      users: [mockInvalidUser as any], // Cast to exercise defensive filtering
      pagination: {
        currentPage: 1,
        totalPages: 1,
        totalUsers: 1,
        hasNext: false,
        hasPrev: false,
      },
    });

    render(
      <BrowserRouter>
        <AdminPromoCodes />
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("Promo Codes Management")).toBeInTheDocument();
    });

    const createStaffTab = screen.getByRole("button", {
      name: /create staff code/i,
    });
    await user.click(createStaffTab);

    // Choose Personal Staff Code option
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /create personal staff code/i }),
      ).toBeInTheDocument();
    });

    const personalCodeButton = screen.getByRole("button", {
      name: /create personal staff code/i,
    });
    await user.click(personalCodeButton);

    // Wait for the form to appear with Select User button
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /select user/i }),
      ).toBeInTheDocument();
    });

    const selectUserButton = screen.getByRole("button", {
      name: /select user/i,
    });
    await user.click(selectUserButton);

    await waitFor(() => {
      expect(
        screen.getByText("Select User for Staff Code"),
      ).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/search by name or email/i);
    await user.type(searchInput, "broken");

    await waitFor(
      () => {
        expect(api.adminUsersService.list).toHaveBeenCalledWith(
          expect.objectContaining({ q: "broken" }),
        );
      },
      { timeout: 2000 },
    );

    // Try to submit if user is selected
    const allButtons = screen.queryAllByRole("button", {
      name: /create staff code/i,
    });
    const generateButton = allButtons.find(
      (btn) => btn.getAttribute("type") === "submit",
    );

    if (generateButton && !generateButton.hasAttribute("disabled")) {
      await user.click(generateButton);

    }

    expect(api.apiClient.createStaffPromoCode).not.toHaveBeenCalled();
  });
});
