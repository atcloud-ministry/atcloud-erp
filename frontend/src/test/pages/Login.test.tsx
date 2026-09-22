import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import "@testing-library/jest-dom/vitest";
import Login from "../../pages/Login";

// Mock auth-related hooks to isolate UI behaviour
vi.mock("../../hooks/useLogin");
vi.mock("../../hooks/useForgotPassword");
vi.mock("../../hooks/useAuthForm");
vi.mock("../../hooks/useAuth");

import { useLogin } from "../../hooks/useLogin";
import { useForgotPassword } from "../../hooks/useForgotPassword";
import { useAuthForm } from "../../hooks/useAuthForm";
import { useAuth } from "../../hooks/useAuth";

const mockedUseLogin = useLogin as unknown as ReturnType<typeof vi.fn>;
const mockedUseForgotPassword = useForgotPassword as unknown as ReturnType<
  typeof vi.fn
>;
const mockedUseAuthForm = useAuthForm as unknown as ReturnType<typeof vi.fn>;
const mockedUseAuth = useAuth as unknown as ReturnType<typeof vi.fn>;

describe("Login page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();

    // Default: not authenticated
    mockedUseAuth.mockReturnValue({
      currentUser: null,
      isLoading: false,
    } as any);

    mockedUseLogin.mockReturnValue({
      isSubmitting: false,
      loginAttempts: 0,
      needsVerification: false,
      userEmailForResend: "",
      isResendingVerification: false,
      handleLogin: vi.fn(),
      handleResendVerificationFromLogin: vi.fn(),
      resetLoginAttempts: vi.fn(),
    } as any);

    mockedUseForgotPassword.mockReturnValue({
      isSubmitting: false,
      handleForgotPassword: vi.fn().mockResolvedValue(true),
    } as any);

    mockedUseAuthForm.mockReturnValue({
      showForgotPassword: false,
      showForgotPasswordForm: vi.fn(),
      showLoginForm: vi.fn(),
    } as any);
  });

  it("renders login form with core fields", () => {
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    const emailInput = screen.getByPlaceholderText(
      /Enter your username or email/i,
    );
    const passwordInput = screen.getByPlaceholderText(/Enter your password/i);

    expect(emailInput).toBeInTheDocument();
    expect(passwordInput).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Login/i })).toBeInTheDocument();
  });

  it("submits login form through useLogin hook", async () => {
    const handleLogin = vi.fn().mockResolvedValue(undefined);

    mockedUseLogin.mockReturnValue({
      isSubmitting: false,
      loginAttempts: 0,
      needsVerification: false,
      userEmailForResend: "",
      isResendingVerification: false,
      handleLogin,
      handleResendVerificationFromLogin: vi.fn(),
      resetLoginAttempts: vi.fn(),
    } as any);

    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    fireEvent.change(
      screen.getByPlaceholderText(/Enter your username or email/i),
      {
        target: { value: "test@example.com" },
      },
    );
    fireEvent.change(screen.getByPlaceholderText(/Enter your password/i), {
      target: { value: "password123" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Login/i }));

    await waitFor(() => {
      expect(handleLogin).toHaveBeenCalledWith({
        emailOrUsername: "test@example.com",
        password: "password123",
        rememberMe: false,
      });
    });
  });

  it("shows forgot password flow when toggled", () => {
    mockedUseAuthForm.mockReturnValue({
      showForgotPassword: true,
      showForgotPasswordForm: vi.fn(),
      showLoginForm: vi.fn(),
    } as any);

    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    // Forgot password form has its own heading/submit button; we just
    // assert that the login form fields are no longer present.
    expect(
      screen.queryByLabelText(/Username or Email/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Password/i)).not.toBeInTheDocument();
  });

  it("submits forgot password form through useForgotPassword hook", async () => {
    const handleForgotPassword = vi.fn().mockResolvedValue(true);
    const showLoginForm = vi.fn();
    const resetLoginAttempts = vi.fn();

    mockedUseForgotPassword.mockReturnValue({
      isSubmitting: false,
      handleForgotPassword,
    } as any);

    mockedUseAuthForm.mockReturnValue({
      showForgotPassword: true,
      showForgotPasswordForm: vi.fn(),
      showLoginForm,
    } as any);

    mockedUseLogin.mockReturnValue({
      isSubmitting: false,
      loginAttempts: 1,
      needsVerification: false,
      userEmailForResend: "",
      isResendingVerification: false,
      handleLogin: vi.fn(),
      handleResendVerificationFromLogin: vi.fn(),
      resetLoginAttempts,
    } as any);

    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    const emailInput = screen.getByPlaceholderText(/Enter your email address/i);
    fireEvent.change(emailInput, { target: { value: "recover@example.com" } });

    fireEvent.click(
      screen.getByRole("button", { name: /Send Recovery Email/i }),
    );

    await waitFor(() => {
      expect(handleForgotPassword).toHaveBeenCalledWith({
        email: "recover@example.com",
      });
      expect(showLoginForm).toHaveBeenCalled();
      expect(resetLoginAttempts).toHaveBeenCalled();
    });
  });

  describe("authenticated user redirect", () => {
    it("redirects authenticated user to /dashboard by default", async () => {
      mockedUseAuth.mockReturnValue({
        currentUser: { id: "user1", username: "testuser" },
        isLoading: false,
      } as any);

      render(
        <MemoryRouter initialEntries={["/login"]}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/dashboard" element={<div>Dashboard Page</div>} />
          </Routes>
        </MemoryRouter>,
      );

      expect(await screen.findByText("Dashboard Page")).toBeInTheDocument();
    });

    it("redirects authenticated user to ?redirect param if present", async () => {
      mockedUseAuth.mockReturnValue({
        currentUser: { id: "user1", username: "testuser" },
        isLoading: false,
      } as any);

      render(
        <MemoryRouter initialEntries={["/login?redirect=/dashboard/event/123"]}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route
              path="/dashboard/event/:id"
              element={<div>Event Detail Page</div>}
            />
          </Routes>
        </MemoryRouter>,
      );

      expect(await screen.findByText("Event Detail Page")).toBeInTheDocument();
    });

    it("redirects authenticated user to program detail ?redirect param", async () => {
      mockedUseAuth.mockReturnValue({
        currentUser: { id: "user1", username: "testuser" },
        isLoading: false,
      } as any);

      render(
        <MemoryRouter
          initialEntries={[
            "/login?redirect=%2Fdashboard%2Fprograms%2Fprogram-123%3Fref%3Dshare",
          ]}
        >
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route
              path="/dashboard/programs/:id"
              element={<div>Program Detail Page</div>}
            />
          </Routes>
        </MemoryRouter>,
      );

      expect(await screen.findByText("Program Detail Page")).toBeInTheDocument();
    });

    it("ignores unsafe authenticated-user redirect params", async () => {
      mockedUseAuth.mockReturnValue({
        currentUser: { id: "user1", username: "testuser" },
        isLoading: false,
      } as any);

      render(
        <MemoryRouter initialEntries={["/login?redirect=//evil.example"]}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/dashboard" element={<div>Dashboard Page</div>} />
          </Routes>
        </MemoryRouter>,
      );

      expect(await screen.findByText("Dashboard Page")).toBeInTheDocument();
    });

    it("restores the session-expired deep link and cannot overwrite it with /dashboard", async () => {
      mockedUseAuth.mockReturnValue({
        currentUser: { id: "user1", username: "testuser" },
        isLoading: false,
      } as any);

      window.sessionStorage.setItem(
        "returnUrl",
        "/dashboard/chat-rooms/507f1f77bcf86cd799439011",
      );

      render(
        <MemoryRouter initialEntries={["/login"]}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route
              path="/dashboard/chat-rooms/:conversationId"
              element={<div>Restored Chat Room</div>}
            />
            <Route path="/dashboard" element={<div>Dashboard Page</div>} />
            <Route path="*" element={<div>Not Found</div>} />
          </Routes>
        </MemoryRouter>,
      );

      expect(await screen.findByText("Restored Chat Room")).toBeInTheDocument();
      expect(screen.queryByText("Dashboard Page")).not.toBeInTheDocument();
      expect(window.sessionStorage.getItem("returnUrl")).toBeNull();
    });
  });
});
