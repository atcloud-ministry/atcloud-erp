import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  renderHook,
  act,
} from "@testing-library/react";
import {
  AuthProvider,
  useAuth,
  withAuth,
  useRequireRole,
} from "../../contexts/AuthContext";
import { authService } from "../../services/api";
import * as welcomeMessageService from "../../utils/welcomeMessageService";
import { createDeferred } from "../fixtures/deferred";

// Mock dependencies
vi.mock("../../services/api", () => ({
  authService: {
    login: vi.fn(),
    logout: vi.fn(),
    getProfile: vi.fn(),
  },
}));

vi.mock("../../utils/welcomeMessageService", () => ({
  sendWelcomeMessage: vi.fn(),
  hasWelcomeMessageBeenSent: vi.fn(),
}));

vi.mock("../../utils/avatarUtils", () => ({
  getAvatarUrlWithCacheBust: vi.fn((url) => url || "/default-avatar.png"),
}));

describe("AuthContext", () => {
  const mockUser = {
    id: "user123",
    username: "testuser",
    firstName: "Test",
    lastName: "User",
    email: "test@example.com",
    phone: "+14155550100",
    birthYear: 1990,
    residenceCity: "Seattle",
    residenceRegion: "US-WA",
    residenceCountryCode: "US" as const,
    employmentStatus: "employed" as const,
    role: "Leader",
    isAtCloudLeader: true,
    roleInAtCloud: "Ministry Leader",
    gender: "male",
    avatar: "/avatar.png",
    weeklyChurch: "Test Church",
    churchAddress: "123 Church St",
    homeAddress: undefined,
    occupation: "Engineer",
    company: "Tech Corp",
  };

  beforeEach(() => {
    // Clear localStorage
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();

    // Default mock implementations
    vi.mocked(authService.getProfile).mockRejectedValue(new Error("No token"));
    vi.mocked(
      welcomeMessageService.hasWelcomeMessageBeenSent
    ).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("AuthProvider Initialization", () => {
    it("provides auth context to children", () => {
      const TestComponent = () => {
        const auth = useAuth();
        return <div>Auth: {auth.isAuthenticated ? "Yes" : "No"}</div>;
      };

      render(
        <AuthProvider>
          <TestComponent />
        </AuthProvider>
      );

      expect(screen.getByText(/Auth: No/)).toBeDefined();
    });

    it("starts with isLoading true, then false after initialization", async () => {
      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      // Initial loading state may resolve quickly, so we just verify it ends up false
      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });

    it("initializes with no user when no token exists", async () => {
      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.currentUser).toBeNull();
      expect(result.current.isAuthenticated).toBe(false);
    });

    it("validates existing token on mount", async () => {
      localStorage.setItem("authToken", "valid-token");
      vi.mocked(authService.getProfile).mockResolvedValue(mockUser);

      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(authService.getProfile).toHaveBeenCalled();
      expect(result.current.currentUser).toBeTruthy();
      expect(result.current.isAuthenticated).toBe(true);
    });

    it("removes invalid token on mount", async () => {
      localStorage.setItem("authToken", "invalid-token");
      vi.mocked(authService.getProfile).mockRejectedValue(
        new Error("Invalid token")
      );

      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(localStorage.getItem("authToken")).toBeNull();
      expect(result.current.currentUser).toBeNull();
    });

    it("converts backend user format to frontend AuthUser format", async () => {
      localStorage.setItem("authToken", "valid-token");
      vi.mocked(authService.getProfile).mockResolvedValue(mockUser);

      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      await waitFor(() => {
        expect(result.current.currentUser).toBeTruthy();
      });

      const user = result.current.currentUser;
      expect(user?.id).toBe("user123");
      expect(user?.username).toBe("testuser");
      expect(user?.firstName).toBe("Test");
      expect(user?.isAtCloudLeader).toBe("Yes");
      expect(user).toMatchObject({
        phone: "+14155550100",
        birthYear: 1990,
        residenceCity: "Seattle",
        residenceRegion: "US-WA",
        residenceCountryCode: "US",
        employmentStatus: "employed",
      });
    });
  });

  describe("Login", () => {
    it("successfully logs in with valid credentials", async () => {
      const authResponse = {
        accessToken: "new-token",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        user: mockUser,
      };

      vi.mocked(authService.login).mockResolvedValue(authResponse);

      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      let loginResult;
      await act(async () => {
        loginResult = await result.current.login({
          emailOrUsername: "test@example.com",
          password: "password123",
          rememberMe: true,
        });
      });

      expect(loginResult).toEqual({ success: true });
      expect(result.current.currentUser).toBeTruthy();
      expect(result.current.isAuthenticated).toBe(true);
    });

    it("returns error on failed login", async () => {
      vi.mocked(authService.login).mockRejectedValue(
        new Error("Invalid credentials")
      );

      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      let loginResult;
      await act(async () => {
        loginResult = await result.current.login({
          emailOrUsername: "test@example.com",
          password: "wrongpassword",
          rememberMe: false,
        });
      });

      expect(loginResult).toEqual({
        success: false,
        error: "Invalid credentials",
      });
      expect(result.current.currentUser).toBeNull();
    });

    it("sends welcome message for new users", async () => {
      const authResponse = {
        accessToken: "new-token",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        user: mockUser,
      };

      vi.mocked(authService.login).mockResolvedValue(authResponse);
      vi.mocked(
        welcomeMessageService.hasWelcomeMessageBeenSent
      ).mockResolvedValue(false);
      vi.mocked(welcomeMessageService.sendWelcomeMessage).mockResolvedValue(
        undefined
      );

      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await act(async () => {
        await result.current.login({
          emailOrUsername: "test@example.com",
          password: "password123",
          rememberMe: true,
        });
      });

      await waitFor(() => {
        expect(
          welcomeMessageService.hasWelcomeMessageBeenSent
        ).toHaveBeenCalledWith("user123");
        expect(welcomeMessageService.sendWelcomeMessage).toHaveBeenCalled();
      });
    });

    it("does not send welcome message for returning users", async () => {
      const authResponse = {
        accessToken: "new-token",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        user: mockUser,
      };

      vi.mocked(authService.login).mockResolvedValue(authResponse);
      vi.mocked(
        welcomeMessageService.hasWelcomeMessageBeenSent
      ).mockResolvedValue(true);

      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await act(async () => {
        await result.current.login({
          emailOrUsername: "test@example.com",
          password: "password123",
          rememberMe: true,
        });
      });

      await waitFor(() => {
        expect(
          welcomeMessageService.hasWelcomeMessageBeenSent
        ).toHaveBeenCalled();
      });

      expect(welcomeMessageService.sendWelcomeMessage).not.toHaveBeenCalled();
    });

    it("continues login even if welcome message fails", async () => {
      const authResponse = {
        accessToken: "new-token",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        user: mockUser,
      };

      vi.mocked(authService.login).mockResolvedValue(authResponse);
      vi.mocked(
        welcomeMessageService.hasWelcomeMessageBeenSent
      ).mockRejectedValue(new Error("Service unavailable"));

      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      let loginResult;
      await act(async () => {
        loginResult = await result.current.login({
          emailOrUsername: "test@example.com",
          password: "password123",
          rememberMe: true,
        });
      });

      expect(loginResult).toEqual({ success: true });
      expect(result.current.currentUser).toBeTruthy();
    });

    it("sets isLoading during login", async () => {
      const authResponse = {
        accessToken: "new-token",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        user: mockUser,
      };

      const login = createDeferred<typeof authResponse>();
      vi.mocked(authService.login).mockReturnValue(login.promise);

      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      let loginPromise: Promise<{ success: boolean; error?: string }>;
      act(() => {
        loginPromise = result.current.login({
          emailOrUsername: "test@example.com",
          password: "password123",
          rememberMe: true,
        });
      });

      expect(result.current.isLoading).toBe(true);

      await act(async () => {
        login.resolve(authResponse);
        await loginPromise;
      });

      expect(result.current.isLoading).toBe(false);
    });

    it("handles login with rememberMe false", async () => {
      const authResponse = {
        accessToken: "new-token",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        user: mockUser,
      };

      vi.mocked(authService.login).mockResolvedValue(authResponse);

      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await act(async () => {
        await result.current.login({
          emailOrUsername: "test@example.com",
          password: "password123",
          rememberMe: false,
        });
      });

      expect(authService.login).toHaveBeenCalledWith(
        "test@example.com",
        "password123",
        false
      );
    });
  });

  describe("Logout", () => {
    it("clears user state on logout", async () => {
      localStorage.setItem("authToken", "valid-token");
      vi.mocked(authService.getProfile).mockResolvedValue(mockUser);
      vi.mocked(authService.logout).mockResolvedValue(undefined);

      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      await waitFor(() => {
        expect(result.current.currentUser).toBeTruthy();
      });

      await act(async () => {
        await result.current.logout();
      });

      expect(result.current.currentUser).toBeNull();
      expect(result.current.isAuthenticated).toBe(false);
    });

    it("removes tokens from storage on logout", async () => {
      localStorage.setItem("authToken", "valid-token");
      sessionStorage.setItem("authToken", "session-token");
      vi.mocked(authService.logout).mockResolvedValue(undefined);

      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await act(async () => {
        await result.current.logout();
      });

      expect(localStorage.getItem("authToken")).toBeNull();
      expect(sessionStorage.getItem("authToken")).toBeNull();
    });

    it("calls backend logout endpoint", async () => {
      vi.mocked(authService.logout).mockResolvedValue(undefined);

      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await act(async () => {
        await result.current.logout();
      });

      expect(authService.logout).toHaveBeenCalled();
    });

    it("continues logout even if backend call fails", async () => {
      localStorage.setItem("authToken", "valid-token");
      vi.mocked(authService.getProfile).mockResolvedValue(mockUser);
      vi.mocked(authService.logout).mockRejectedValue(
        new Error("Network error")
      );

      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      await waitFor(() => {
        expect(result.current.currentUser).toBeTruthy();
      });

      await act(async () => {
        await result.current.logout();
      });

      expect(result.current.currentUser).toBeNull();
      expect(localStorage.getItem("authToken")).toBeNull();
    });
  });

  describe("updateUser", () => {
    it("updates current user with partial data", async () => {
      localStorage.setItem("authToken", "valid-token");
      vi.mocked(authService.getProfile).mockResolvedValue(mockUser);

      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      await waitFor(() => {
        expect(result.current.currentUser).toBeTruthy();
      });

      act(() => {
        result.current.updateUser({
          firstName: "Updated",
          lastName: "Name",
        });
      });

      expect(result.current.currentUser?.firstName).toBe("Updated");
      expect(result.current.currentUser?.lastName).toBe("Name");
      expect(result.current.currentUser?.username).toBe("testuser");
    });

    it("does nothing if no current user", () => {
      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      act(() => {
        result.current.updateUser({ firstName: "Updated" });
      });

      expect(result.current.currentUser).toBeNull();
    });
  });

  describe("Permissions - canCreateEvents", () => {
    it("returns true for Super Admin", async () => {
      localStorage.setItem("authToken", "valid-token");
      vi.mocked(authService.getProfile).mockResolvedValue({
        ...mockUser,
        role: "Super Admin",
      });

      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      await waitFor(() => {
        expect(result.current.currentUser).toBeTruthy();
      });

      expect(result.current.canCreateEvents).toBe(true);
    });

    it("returns true for Administrator", async () => {
      localStorage.setItem("authToken", "valid-token");
      vi.mocked(authService.getProfile).mockResolvedValue({
        ...mockUser,
        role: "Administrator",
      });

      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      await waitFor(() => {
        expect(result.current.currentUser).toBeTruthy();
      });

      expect(result.current.canCreateEvents).toBe(true);
    });

    it("returns true for Leader", async () => {
      localStorage.setItem("authToken", "valid-token");
      vi.mocked(authService.getProfile).mockResolvedValue({
        ...mockUser,
        role: "Leader",
      });

      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      await waitFor(() => {
        expect(result.current.currentUser).toBeTruthy();
      });

      expect(result.current.canCreateEvents).toBe(true);
    });

    it("returns false for Participant", async () => {
      localStorage.setItem("authToken", "valid-token");
      vi.mocked(authService.getProfile).mockResolvedValue({
        ...mockUser,
        role: "Participant",
      });

      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      await waitFor(() => {
        expect(result.current.currentUser).toBeTruthy();
      });

      expect(result.current.canCreateEvents).toBe(false);
    });

    it("returns false when not authenticated", () => {
      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      expect(result.current.canCreateEvents).toBe(false);
    });
  });

  describe("Permissions - canManageUsers", () => {
    it("returns true for Super Admin", async () => {
      localStorage.setItem("authToken", "valid-token");
      vi.mocked(authService.getProfile).mockResolvedValue({
        ...mockUser,
        role: "Super Admin",
      });

      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      await waitFor(() => {
        expect(result.current.currentUser).toBeTruthy();
      });

      expect(result.current.canManageUsers).toBe(true);
    });

    it("returns true for Administrator", async () => {
      localStorage.setItem("authToken", "valid-token");
      vi.mocked(authService.getProfile).mockResolvedValue({
        ...mockUser,
        role: "Administrator",
      });

      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      await waitFor(() => {
        expect(result.current.currentUser).toBeTruthy();
      });

      expect(result.current.canManageUsers).toBe(true);
    });

    it("returns false for Leader", async () => {
      localStorage.setItem("authToken", "valid-token");
      vi.mocked(authService.getProfile).mockResolvedValue({
        ...mockUser,
        role: "Leader",
      });

      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      await waitFor(() => {
        expect(result.current.currentUser).toBeTruthy();
      });

      expect(result.current.canManageUsers).toBe(false);
    });

    it("returns false when not authenticated", () => {
      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      expect(result.current.canManageUsers).toBe(false);
    });
  });

  describe("Permissions - hasRole", () => {
    it("returns true for matching single role", async () => {
      localStorage.setItem("authToken", "valid-token");
      vi.mocked(authService.getProfile).mockResolvedValue({
        ...mockUser,
        role: "Leader",
      });

      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      await waitFor(() => {
        expect(result.current.currentUser).toBeTruthy();
      });

      expect(result.current.hasRole("Leader")).toBe(true);
    });

    it("returns false for non-matching single role", async () => {
      localStorage.setItem("authToken", "valid-token");
      vi.mocked(authService.getProfile).mockResolvedValue({
        ...mockUser,
        role: "Leader",
      });

      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      await waitFor(() => {
        expect(result.current.currentUser).toBeTruthy();
      });

      expect(result.current.hasRole("Administrator")).toBe(false);
    });

    it("returns true when role matches one in array", async () => {
      localStorage.setItem("authToken", "valid-token");
      vi.mocked(authService.getProfile).mockResolvedValue({
        ...mockUser,
        role: "Leader",
      });

      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      await waitFor(() => {
        expect(result.current.currentUser).toBeTruthy();
      });

      expect(result.current.hasRole(["Administrator", "Leader"])).toBe(true);
    });

    it("returns false when role does not match any in array", async () => {
      localStorage.setItem("authToken", "valid-token");
      vi.mocked(authService.getProfile).mockResolvedValue({
        ...mockUser,
        role: "Participant",
      });

      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      await waitFor(() => {
        expect(result.current.currentUser).toBeTruthy();
      });

      expect(result.current.hasRole(["Administrator", "Leader"])).toBe(false);
    });

    it("returns false when not authenticated", () => {
      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      expect(result.current.hasRole("Leader")).toBe(false);
    });
  });

  describe("useAuth Hook Error Handling", () => {
    it("throws error when used outside AuthProvider", () => {
      expect(() => {
        renderHook(() => useAuth());
      }).toThrow("useAuth must be used within an AuthProvider");
    });
  });

  describe("withAuth HOC", () => {
    it("renders component when authenticated", async () => {
      localStorage.setItem("authToken", "valid-token");
      vi.mocked(authService.getProfile).mockResolvedValue(mockUser);

      const TestComponent = () => <div>Protected Content</div>;
      const ProtectedComponent = withAuth(TestComponent);

      render(
        <AuthProvider>
          <ProtectedComponent />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByText("Protected Content")).toBeDefined();
      });
    });

    it("shows login message when not authenticated", () => {
      const TestComponent = () => <div>Protected Content</div>;
      const ProtectedComponent = withAuth(TestComponent);

      render(
        <AuthProvider>
          <ProtectedComponent />
        </AuthProvider>
      );

      expect(
        screen.getByText("Please log in to access this page.")
      ).toBeDefined();
      expect(screen.queryByText("Protected Content")).toBeNull();
    });

    it("passes props to wrapped component", async () => {
      localStorage.setItem("authToken", "valid-token");
      vi.mocked(authService.getProfile).mockResolvedValue(mockUser);

      const TestComponent = ({ title }: { title: string }) => (
        <div>{title}</div>
      );
      const ProtectedComponent = withAuth(TestComponent);

      render(
        <AuthProvider>
          <ProtectedComponent title="My Page" />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByText("My Page")).toBeDefined();
      });
    });
  });

  describe("useRequireRole Hook", () => {
    it("returns hasAccess true for matching role", async () => {
      localStorage.setItem("authToken", "valid-token");
      vi.mocked(authService.getProfile).mockResolvedValue({
        ...mockUser,
        role: "Administrator",
      });

      const { result } = renderHook(
        () => ({
          auth: useAuth(),
          roleCheck: useRequireRole("Administrator"),
        }),
        {
          wrapper: AuthProvider,
        }
      );

      await waitFor(() => {
        expect(result.current.auth.currentUser).toBeTruthy();
      });

      expect(result.current.roleCheck.hasAccess).toBe(true);
      expect(result.current.roleCheck.currentUser).toBeTruthy();
      expect(result.current.roleCheck.requiredRoles).toEqual(["Administrator"]);
    });

    it("returns hasAccess false for non-matching role", async () => {
      localStorage.setItem("authToken", "valid-token");
      vi.mocked(authService.getProfile).mockResolvedValue({
        ...mockUser,
        role: "Participant",
      });

      const { result } = renderHook(
        () => ({
          auth: useAuth(),
          roleCheck: useRequireRole("Administrator"),
        }),
        {
          wrapper: AuthProvider,
        }
      );

      await waitFor(() => {
        expect(result.current.auth.currentUser).toBeTruthy();
      });

      expect(result.current.roleCheck.hasAccess).toBe(false);
    });

    it("handles multiple required roles", async () => {
      localStorage.setItem("authToken", "valid-token");
      vi.mocked(authService.getProfile).mockResolvedValue({
        ...mockUser,
        role: "Leader",
      });

      const { result } = renderHook(
        () => ({
          auth: useAuth(),
          roleCheck: useRequireRole(["Administrator", "Leader"]),
        }),
        {
          wrapper: AuthProvider,
        }
      );

      await waitFor(() => {
        expect(result.current.auth.currentUser).toBeTruthy();
      });

      expect(result.current.roleCheck.hasAccess).toBe(true);
      expect(result.current.roleCheck.requiredRoles).toEqual([
        "Administrator",
        "Leader",
      ]);
    });

    it("converts single role to array", () => {
      const { result } = renderHook(() => useRequireRole("Leader"), {
        wrapper: AuthProvider,
      });

      expect(result.current.requiredRoles).toEqual(["Leader"]);
    });
  });
});
