import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import SessionExpiredModal from "../../components/common/SessionExpiredModal";
import {
  handleSessionExpired,
  __resetSessionPromptFlag,
} from "../../services/session";

// Mock useLocation
let mockLocation = {
  pathname: "/dashboard/event/123",
  search: "?tab=details",
  hash: "#registration",
  state: null,
  key: "test",
};
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useLocation: () => mockLocation,
  };
});

describe("SessionExpiredModal", () => {
  // Store original window.location
  const originalLocation = window.location;

  beforeEach(() => {
    mockLocation = {
      pathname: "/dashboard/event/123",
      search: "?tab=details",
      hash: "#registration",
      state: null,
      key: "test",
    };
    __resetSessionPromptFlag();
    localStorage.setItem("authToken", "test-token");
    sessionStorage.clear();

    // Mock window.location.href
    Object.defineProperty(window, "location", {
      writable: true,
      value: { ...originalLocation, href: "" },
    });
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    // Restore window.location
    Object.defineProperty(window, "location", {
      writable: true,
      value: originalLocation,
    });
  });

  it("shows custom modal when session expires", async () => {
    render(
      <BrowserRouter>
        <SessionExpiredModal />
      </BrowserRouter>,
    );

    // Initially, modal should not be visible
    expect(screen.queryByText("Session Expired")).not.toBeInTheDocument();

    // Trigger session expiration
    handleSessionExpired();

    // Wait for modal to appear
    await waitFor(() => {
      expect(screen.getByText("Session Expired")).toBeInTheDocument();
    });

    expect(
      screen.getByText("Your session has expired. Please login again."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Login" })).toBeInTheDocument();
  });

  it("redirects to login and stores return URL when Login button is clicked", async () => {
    const user = userEvent.setup();

    render(
      <BrowserRouter>
        <SessionExpiredModal />
      </BrowserRouter>,
    );

    // Trigger session expiration
    handleSessionExpired();

    // Wait for modal to appear
    await waitFor(() => {
      expect(screen.getByText("Session Expired")).toBeInTheDocument();
    });

    // Click Login button
    const loginButton = screen.getByRole("button", { name: "Login" });
    await user.click(loginButton);

    // Verify returnUrl is stored in sessionStorage for post-login redirect
    expect(sessionStorage.getItem("returnUrl")).toBe(
      "/dashboard/event/123?tab=details#registration",
    );

    // Verify hard navigation to login page was triggered
    expect(window.location.href).toBe("/#/login");
  });

  it("captures the protected deep link before auth redirects the router to login", async () => {
    const user = userEvent.setup();
    const rendered = render(
      <BrowserRouter>
        <SessionExpiredModal />
      </BrowserRouter>,
    );

    handleSessionExpired();
    await waitFor(() => {
      expect(screen.getByText("Session Expired")).toBeInTheDocument();
    });
    expect(sessionStorage.getItem("returnUrl")).toBe(
      "/dashboard/event/123?tab=details#registration",
    );

    mockLocation = {
      pathname: "/login",
      search: "",
      hash: "",
      state: null,
      key: "login",
    };
    rendered.rerender(
      <BrowserRouter>
        <SessionExpiredModal />
      </BrowserRouter>,
    );
    await user.click(screen.getByRole("button", { name: "Login" }));

    expect(sessionStorage.getItem("returnUrl")).toBe(
      "/dashboard/event/123?tab=details#registration",
    );
    expect(window.location.href).toBe("/#/login");
  });

  it("only shows modal once even if handleSessionExpired is called multiple times", async () => {
    render(
      <BrowserRouter>
        <SessionExpiredModal />
      </BrowserRouter>,
    );

    // Call handleSessionExpired multiple times
    handleSessionExpired();
    handleSessionExpired();
    handleSessionExpired();

    // Wait for modal to appear
    await waitFor(() => {
      expect(screen.getByText("Session Expired")).toBeInTheDocument();
    });

    // Modal should only appear once (no duplicate modals)
    const modals = screen.getAllByText("Session Expired");
    expect(modals).toHaveLength(1);
  });

  it("clears auth token from localStorage when session expires", async () => {
    render(
      <BrowserRouter>
        <SessionExpiredModal />
      </BrowserRouter>,
    );

    expect(localStorage.getItem("authToken")).toBe("test-token");

    // Trigger session expiration
    handleSessionExpired();

    // Wait for modal to appear
    await waitFor(() => {
      expect(screen.getByText("Session Expired")).toBeInTheDocument();
    });

    // Token should be cleared
    expect(localStorage.getItem("authToken")).toBeNull();
  });
});
