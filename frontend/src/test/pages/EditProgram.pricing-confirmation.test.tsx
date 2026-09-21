import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { vi, describe, it, beforeEach, expect } from "vitest";
import EditProgram from "../../pages/EditProgram";
import { NotificationProvider } from "../../contexts/NotificationModalContext";

vi.mock("../../contexts/RuntimeConfigContext", () => ({
  useRuntimeConfig: () => ({
    status: "ready",
    config: {
      alumniNetwork: { mode: "off", readable: false, writable: false },
    },
  }),
}));

// Mock the API services
vi.mock("../../services/api", () => ({
  programService: {
    getById: vi.fn(),
    updateProgram: vi.fn(),
  },
  purchaseService: {
    checkProgramAccess: vi.fn().mockResolvedValue({
      hasAccess: true,
      reason: "admin",
    }),
  },
  fileService: {
    uploadFile: vi.fn(),
  },
  userService: {
    getUsers: vi.fn().mockResolvedValue({
      users: [],
      pagination: {
        currentPage: 1,
        totalPages: 0,
        totalUsers: 0,
        hasNext: false,
        hasPrev: false,
      },
    }),
  },
}));

// Mock useAuth hook
vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({
    currentUser: {
      id: "user1",
      firstName: "Test",
      lastName: "User",
      role: "Super Admin", // Must be "Super Admin" or "Administrator" to edit programs
    },
  }),
}));

// Mock program validation hook
vi.mock("../../hooks/useProgramValidation", () => ({
  useProgramValidation: () => ({
    validations: {
      // Provide default validation objects for all fields that might be used
      title: { isValid: true, message: "", color: "text-green-600" },
      programType: { isValid: true, message: "", color: "text-green-600" },
      hostedBy: { isValid: true, message: "", color: "text-green-600" },
      introduction: { isValid: true, message: "", color: "text-green-600" },
      flyerUrl: { isValid: true, message: "", color: "text-green-600" },
      fullPriceTicket: { isValid: true, message: "", color: "text-green-600" },
      classRepDiscount: { isValid: true, message: "", color: "text-green-600" },
      earlyBirdDiscount: {
        isValid: true,
        message: "",
        color: "text-green-600",
      },
      earlyBirdDeadline: {
        isValid: true,
        message: "",
        color: "text-green-600",
      },
      period: { isValid: true, message: "", color: "text-green-600" },
      mentors: { isValid: true, message: "", color: "text-green-600" },
      // Add the date-specific validations that the component uses
      startYear: { isValid: true, message: "", color: "text-green-600" },
      startMonth: { isValid: true, message: "", color: "text-green-600" },
      endYear: { isValid: true, message: "", color: "text-green-600" },
      endMonth: { isValid: true, message: "", color: "text-green-600" },
    },
    overallStatus: { isValid: true, errorCount: 0 },
  }),
}));

const mockProgram = {
  id: "program1",
  title: "Test Program",
  programType: "EMBA Mentor Circles",
  hostedBy: "@Cloud Marketplace Ministry",
  period: {
    startYear: "2026",
    startMonth: "01",
    endYear: "2026",
    endMonth: "12",
  },
  introduction: "Test introduction",
  flyerUrl: "",
  isFree: false,
  earlyBirdDeadline: "",
  fullPriceTicket: 10000, // in cents ($100.00)
  classRepDiscount: 1000, // in cents ($10.00)
  earlyBirdDiscount: 2000, // in cents ($20.00)
  mentors: [],
};

describe("EditProgram - Pricing Confirmation", () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    // Mock the program service to return test data
    const { programService } = await import("../../services/api");
    vi.mocked(programService.getById).mockResolvedValue(mockProgram);
    vi.mocked(programService.updateProgram).mockResolvedValue({
      success: true,
    });
  });

  const renderEditProgram = () => {
    return render(
      <NotificationProvider>
        <MemoryRouter initialEntries={["/dashboard/programs/program1/edit"]}>
          <Routes>
            <Route
              path="/dashboard/programs/:id/edit"
              element={<EditProgram />}
            />
            {/* Fallback route to avoid routing errors when component navigates after update */}
            <Route
              path="/dashboard/programs/:id"
              element={<div>Program Detail</div>}
            />
          </Routes>
        </MemoryRouter>
      </NotificationProvider>
    );
  };

  it("shows confirmation modal when pricing changes are detected", async () => {
    renderEditProgram();

    // Wait for the program to load
    await waitFor(() => {
      expect(screen.getByDisplayValue("Test Program")).toBeInTheDocument();
    });

    // Change the full price ticket value (this should trigger pricing confirmation)
    // Note: form input is in dollars, so 150 = $150.00
    const fullPriceInput = screen.getByLabelText(/full price ticket/i);
    fireEvent.change(fullPriceInput, { target: { value: "150" } });

    // Submit the form
    const updateButton = screen.getByRole("button", {
      name: /update program/i,
    });
    fireEvent.click(updateButton);

    // Should show the first step of confirmation modal
    expect(
      await screen.findByText("Tuition Changes Detected")
    ).toBeInTheDocument();
    expect(
      await screen.findByText(
        /You have made changes to the program's tuition section/
      )
    ).toBeInTheDocument();

    // Should show the pricing change details
    const priceChangeElements = await screen.findAllByText(
      (_content, element) => {
        return (
          element?.textContent === "• Full price: $100.00 → $150.00" ||
          element?.textContent?.includes("Full price: $100.00 → $150.00") ||
          false
        );
      }
    );
    expect(priceChangeElements.length).toBeGreaterThan(0);
  });

  it("shows second confirmation step after clicking Continue", async () => {
    renderEditProgram();

    // Wait for the program to load
    await waitFor(() => {
      expect(screen.getByDisplayValue("Test Program")).toBeInTheDocument();
    });

    // Change the full price ticket value
    const fullPriceInput = screen.getByLabelText(/full price ticket/i);
    fireEvent.change(fullPriceInput, { target: { value: "150" } });

    // Submit the form
    const updateButton = screen.getByRole("button", {
      name: /update program/i,
    });
    fireEvent.click(updateButton);

    // Click Continue on first confirmation step (wait until it appears)
    const continueButton = await screen.findByRole("button", {
      name: /continue/i,
    });
    fireEvent.click(continueButton);

    // Should show the second step of confirmation
    expect(screen.getByText("Final Confirmation")).toBeInTheDocument();
    expect(
      screen.getByText(/Are you absolutely sure you want to update the tuition/)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /yes, update tuition/i })
    ).toBeInTheDocument();
  });

  it("submits form after final confirmation", async () => {
    const { programService } = await import("../../services/api");

    renderEditProgram();

    // Wait for the program to load
    await waitFor(() => {
      expect(screen.getByDisplayValue("Test Program")).toBeInTheDocument();
    });

    // Change the full price ticket value
    const fullPriceInput = screen.getByLabelText(/full price ticket/i);
    fireEvent.change(fullPriceInput, { target: { value: "150" } }); // $150.00 in dollars

    // Submit the form
    const updateButton = screen.getByRole("button", {
      name: /update program/i,
    });
    fireEvent.click(updateButton);

    // Click Continue on first confirmation step
    const continueButton = await screen.findByRole("button", {
      name: /continue/i,
    });
    fireEvent.click(continueButton);

    // Click final confirmation
    const finalConfirmButton = screen.getByRole("button", {
      name: /yes, update tuition/i,
    });
    fireEvent.click(finalConfirmButton);

    // Should call the update API with new pricing
    await waitFor(() => {
      expect(programService.updateProgram).toHaveBeenCalledWith(
        "program1",
        expect.objectContaining({
          fullPriceTicket: 15000, // in cents ($150.00)
        })
      );
    });
  });

  it("cancels confirmation and returns to form", async () => {
    renderEditProgram();

    // Wait for the program to load
    await waitFor(() => {
      expect(screen.getByDisplayValue("Test Program")).toBeInTheDocument();
    });

    // Change the full price ticket value
    const fullPriceInput = screen.getByLabelText(/full price ticket/i);
    fireEvent.change(fullPriceInput, { target: { value: "150" } });

    // Submit the form
    const updateButton = screen.getByRole("button", {
      name: /update program/i,
    });
    fireEvent.click(updateButton);

    // Cancel the confirmation (wait until it appears). There are two "Cancel" buttons in the DOM
    // (form-level and modal). Click the modal one by selecting the last match.
    // Find the dialog and click its Cancel
    const dialog = await screen.findByRole("dialog");
    const cancelInDialog = await within(dialog).findByRole("button", {
      name: /cancel/i,
    });
    fireEvent.click(cancelInDialog);

    // Should return to the form without modal
    await waitFor(() => {
      expect(
        screen.queryByText("Tuition Changes Detected")
      ).not.toBeInTheDocument();
    });
    expect(await screen.findByDisplayValue("Test Program")).toBeInTheDocument();
  });

  it("skips confirmation when no pricing changes are made", async () => {
    const { programService } = await import("../../services/api");

    renderEditProgram();

    // Wait for the program to load
    await waitFor(() => {
      expect(screen.getByDisplayValue("Test Program")).toBeInTheDocument();
    });

    // Change non-pricing field (title)
    const titleInput = screen.getByLabelText(/program title/i);
    fireEvent.change(titleInput, { target: { value: "Updated Test Program" } });

    // Submit the form
    const updateButton = screen.getByRole("button", {
      name: /update program/i,
    });
    fireEvent.click(updateButton);

    // Should not show confirmation modal and submit directly
    expect(
      screen.queryByText("Tuition Changes Detected")
    ).not.toBeInTheDocument();

    await waitFor(() => {
      expect(programService.updateProgram).toHaveBeenCalledWith(
        "program1",
        expect.objectContaining({
          title: "Updated Test Program",
        })
      );
    });
  });
});
