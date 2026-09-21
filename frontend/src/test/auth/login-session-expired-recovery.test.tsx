import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import Login from "../../pages/Login";

const authStore = vi.hoisted(() => {
  type Listener = () => void;
  const listeners = new Set<Listener>();
  let currentUser: { id: string; username: string } | null = null;
  let finishLogin: (() => void) | null = null;

  const login = vi.fn(async () => {
    currentUser = { id: "user-1", username: "member" };
    listeners.forEach((listener) => listener());
    await new Promise<void>((resolve) => {
      finishLogin = resolve;
    });
    return { success: true as const };
  });

  return {
    login,
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return currentUser;
    },
    finishLogin() {
      const finish = finishLogin;
      finishLogin = null;
      finish?.();
    },
    reset() {
      currentUser = null;
      finishLogin = null;
      login.mockClear();
    },
  };
});

vi.mock("../../hooks/useAuth", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    useAuth: () => ({
      currentUser: React.useSyncExternalStore(
        authStore.subscribe,
        authStore.getSnapshot,
        authStore.getSnapshot,
      ),
      isLoading: false,
      login: authStore.login,
    }),
  };
});

vi.mock("../../contexts/NotificationModalContext", () => ({
  useToastReplacement: () => ({
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  }),
}));

vi.mock("../../hooks/useForgotPassword", () => ({
  useForgotPassword: () => ({
    isSubmitting: false,
    handleForgotPassword: vi.fn(),
  }),
}));

vi.mock("../../hooks/useAuthForm", () => ({
  useAuthForm: () => ({
    showForgotPassword: false,
    showForgotPasswordForm: vi.fn(),
    showLoginForm: vi.fn(),
  }),
}));

function Destination() {
  const location = useLocation();
  return (
    <output data-testid="restored-location">
      {location.pathname}
      {location.search}
      {location.hash}
    </output>
  );
}

describe("session-expired login recovery", () => {
  beforeEach(() => {
    authStore.reset();
    sessionStorage.clear();
  });

  it("keeps the original deep link after auth state changes before login resolves", async () => {
    const returnUrl =
      "/dashboard/chat-rooms/507f1f77bcf86cd799439011?source=session-expired#latest";
    sessionStorage.setItem("returnUrl", returnUrl);

    render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/dashboard/chat-rooms/:conversationId"
            element={<Destination />}
          />
          <Route path="/dashboard" element={<div>Dashboard fallback</div>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.change(
      screen.getByPlaceholderText("Enter your username or email"),
      { target: { value: "member@example.org" } },
    );
    fireEvent.change(screen.getByPlaceholderText("Enter your password"), {
      target: { value: "Password123!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Login" }));

    expect(await screen.findByTestId("restored-location")).toHaveTextContent(
      returnUrl,
    );
    expect(sessionStorage.getItem("returnUrl")).toBeNull();

    await act(async () => {
      authStore.finishLogin();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("restored-location")).toHaveTextContent(
        returnUrl,
      );
    });
    expect(screen.queryByText("Dashboard fallback")).not.toBeInTheDocument();
  });
});
