import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// Mock the authService.register call to succeed
vi.mock("../../services/api", async (orig) => {
  const actual: any = await (orig as any)();
  return {
    ...actual,
    authService: {
      ...actual.authService,
      register: vi.fn().mockResolvedValue({ success: true }),
      getRegistrationNotice: vi.fn().mockResolvedValue({
        version: "registration-privacy-v1",
        text: "Registration privacy notice for testing.",
        effectiveAt: "2026-09-18T00:00:00.000Z",
      }),
    },
  };
});

import { NotificationProvider } from "../../contexts/NotificationModalContext";
import SignUp from "../../pages/SignUp";
import CheckEmail from "../../pages/CheckEmail";
import { authService } from "../../services/api";

describe("SignUp modal sequence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(authService.getRegistrationNotice).mockResolvedValue({
      version: "registration-privacy-v1",
      text: "Registration privacy notice for testing.",
      effectiveAt: "2026-09-18T00:00:00.000Z",
    });
    vi.mocked(authService.register).mockResolvedValue({ success: true } as never);
  });

  it("shows 'We’ll keep your history' until OK, then 'Welcome to @Cloud!' until OK, then navigates", async () => {
    render(
      <MemoryRouter initialEntries={["/signup"]}>
        <NotificationProvider>
          <Routes>
            <Route path="/signup" element={<SignUp />} />
            <Route path="/check-email" element={<CheckEmail />} />
          </Routes>
        </NotificationProvider>
      </MemoryRouter>
    );

    // Fill required fields (use placeholders and display values due to markup)
    fireEvent.change(screen.getByPlaceholderText(/Choose a username/i), {
      target: { value: "johndoe" },
    });
    fireEvent.change(screen.getByPlaceholderText(/^Enter your password$/i), {
      target: { value: "Str0ngP@ss!" },
    });
    fireEvent.change(
      screen.getByPlaceholderText(/^Enter your confirm password$/i),
      {
        target: { value: "Str0ngP@ss!" },
      }
    );
    fireEvent.change(screen.getByPlaceholderText(/Enter your first name/i), {
      target: { value: "John" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Enter your last name/i), {
      target: { value: "Doe" },
    });
    // Gender select shows a disabled placeholder option that is selected initially
    fireEvent.change(screen.getByDisplayValue(/Select Gender/i), {
      target: { value: "male" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Enter your email address/i), {
      target: { value: "john@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/Birth Year/i), {
      target: { value: "1990" },
    });
    fireEvent.change(screen.getByLabelText(/Phone Country/i), {
      target: { value: "US" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Enter your phone number/i), {
      target: { value: "415 555 2671" },
    });
    fireEvent.change(screen.getByLabelText(/Country of Residence/i), {
      target: { value: "US" },
    });
    fireEvent.change(screen.getByLabelText(/^State/i), {
      target: { value: "US-CA" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Enter city/i), {
      target: { value: "San Francisco" },
    });
    fireEvent.change(screen.getByLabelText(/Employment Status/i), {
      target: { value: "employed" },
    });
    fireEvent.change(
      screen.getByPlaceholderText(/Enter company or organization/i),
      { target: { value: "Example Co" } },
    );

    // isAtCloudLeader defaults to "false"; no change needed.
    fireEvent.click(
      await screen.findByLabelText(/I have read and accept this notice/i),
    );

    // Submit the form
    fireEvent.click(screen.getByRole("button", { name: /sign up/i }));

    // First modal should appear and persist until user clicks OK
    const firstTitle = await screen.findByText(/We’ll keep your history/i);
    expect(firstTitle).toBeInTheDocument();
    expect(authService.register).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: "+14155552671",
        birthYear: 1990,
        residenceCountryCode: "US",
        residenceRegion: "US-CA",
        residenceCity: "San Francisco",
        employmentStatus: "employed",
        company: "Example Co",
        occupation: null,
        acceptTerms: true,
        registrationNoticeVersion: "registration-privacy-v1",
      }),
    );
    const submittedPayload = vi.mocked(authService.register).mock.calls[0]?.[0];
    expect(submittedPayload).not.toHaveProperty("phoneCountryCode");
    expect(submittedPayload).not.toHaveProperty("homeAddress");

    // No "X" close button (showCloseButton: false), but an OK button exists
    const ok1 = screen.getByRole("button", { name: /^OK$/i });
    fireEvent.click(ok1);

    // Second modal should now appear and persist until OK
    const secondTitle = await screen.findByText(/Welcome to @Cloud!/i);
    expect(secondTitle).toBeInTheDocument();

    const ok2 = screen.getByRole("button", { name: /^OK$/i });
    fireEvent.click(ok2);

    // After closing second modal, we should navigate to Check Email page
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /Check Your Email/i })
      ).toBeInTheDocument()
    );
  });
});
