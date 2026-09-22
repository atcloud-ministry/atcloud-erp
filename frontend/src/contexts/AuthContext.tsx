import React, { createContext, useContext, useState, useCallback } from "react";
import type { ReactNode } from "react";
import type {
  AuthUser,
  LoginFormData,
  SystemAuthorizationLevel,
} from "../types";
import { authService } from "../services/api";
import { getAvatarUrlWithCacheBust } from "../utils/avatarUtils";
import {
  sendWelcomeMessage,
  hasWelcomeMessageBeenSent,
} from "../utils/welcomeMessageService";
import { unregisterPushBeforeLogout } from "../services/webPushLifecycle";

interface AuthContextType {
  // State
  currentUser: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  initializationError: string | null;

  // Actions
  login: (
    credentials: LoginFormData
  ) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  retryInitialization: () => Promise<void>;
  updateUser: (user: Partial<AuthUser>) => void;

  // Permissions
  canCreateEvents: boolean;
  canManageUsers: boolean;
  hasRole: (roles: string | string[]) => boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [initializationError, setInitializationError] = useState<string | null>(
    null,
  );

  const checkExistingAuth = useCallback(async () => {
    setIsLoading(true);
    setInitializationError(null);
    try {
      const token = localStorage.getItem("authToken");
      if (token) {
        try {
          // Validate token with the server by getting user profile
          const userProfile = await authService.getProfile();

          // Convert backend user format to frontend AuthUser format
          const authUser: AuthUser = {
            id: userProfile.id,
            username: userProfile.username,
            firstName: userProfile.firstName || "",
            lastName: userProfile.lastName || "",
            email: userProfile.email,
            phone: userProfile.phone,
            birthYear: userProfile.birthYear,
            residenceCity: userProfile.residenceCity,
            residenceRegion: userProfile.residenceRegion,
            residenceCountryCode: userProfile.residenceCountryCode,
            employmentStatus: userProfile.employmentStatus,
            role: userProfile.role as SystemAuthorizationLevel,
            isAtCloudLeader: userProfile.isAtCloudLeader ? "Yes" : "No",
            roleInAtCloud: userProfile.roleInAtCloud,
            gender: (userProfile.gender as "male" | "female") || "male",
            avatar: getAvatarUrlWithCacheBust(
              userProfile.avatar || null,
              (userProfile.gender as "male" | "female") || "male"
            ),
            weeklyChurch: userProfile.weeklyChurch,
            churchAddress: userProfile.churchAddress,
            homeAddress: userProfile.homeAddress,
            occupation: userProfile.occupation,
            company: userProfile.company,
          };

          setCurrentUser(authUser);
        } catch (error) {
          const status =
            error && typeof error === "object" && "status" in error
              ? Number((error as { status?: unknown }).status)
              : null;
          if (status === 401 || status === 403) {
            await unregisterPushBeforeLogout();
            localStorage.removeItem("authToken");
            sessionStorage.removeItem("authToken");
            setCurrentUser(null);
          } else {
            // Keep the session token during offline and temporary server failures.
            setInitializationError(
              "We could not verify your session. Check your connection and try again.",
            );
          }
        }
      } else {
        setCurrentUser(null);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Check for existing authentication on app start.
  React.useEffect(() => {
    void checkExistingAuth();
  }, [checkExistingAuth]);

  const login = useCallback(async (credentials: LoginFormData) => {
    setIsLoading(true);

    try {
      // Use real API login
      const authResponse = await authService.login(
        credentials.emailOrUsername,
        credentials.password,
        credentials.rememberMe
      );

      // Convert backend user format to frontend AuthUser format
      const authUser: AuthUser = {
        id: authResponse.user.id,
        username: authResponse.user.username,
        firstName: authResponse.user.firstName || "",
        lastName: authResponse.user.lastName || "",
        email: authResponse.user.email,
        phone: authResponse.user.phone,
        birthYear: authResponse.user.birthYear,
        residenceCity: authResponse.user.residenceCity,
        residenceRegion: authResponse.user.residenceRegion,
        residenceCountryCode: authResponse.user.residenceCountryCode,
        employmentStatus: authResponse.user.employmentStatus,
        role: authResponse.user.role as SystemAuthorizationLevel,
        isAtCloudLeader: authResponse.user.isAtCloudLeader ? "Yes" : "No",
        roleInAtCloud: authResponse.user.roleInAtCloud,
        gender: (authResponse.user.gender as "male" | "female") || "male",
        avatar: getAvatarUrlWithCacheBust(
          authResponse.user.avatar || null,
          (authResponse.user.gender as "male" | "female") || "male"
        ),
        weeklyChurch: authResponse.user.weeklyChurch,
        churchAddress: authResponse.user.churchAddress,
        homeAddress: authResponse.user.homeAddress,
        occupation: authResponse.user.occupation,
        company: authResponse.user.company,
      };

      setCurrentUser(authUser);
      setInitializationError(null);

      // Check if this is a first login and send welcome message
      // Move this to after successful login state is set
      try {
        const hasReceived = await hasWelcomeMessageBeenSent(authUser.id);

        if (!hasReceived) {
          await sendWelcomeMessage(authUser, true);
        }
      } catch (error) {
        console.error("❌ Error handling welcome message:", error);
        // Welcome-message delivery must not fail an otherwise valid login.
      }

      return { success: true };
    } catch (error) {
      console.error("🔐 Login failed:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Login failed",
      };
    } finally {
      setIsLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    // Remove only this installation while the access token is still available.
    // The account-level preferences and the user's other installations remain.
    await unregisterPushBeforeLogout();
    try {
      // Call backend logout endpoint
      await authService.logout();
    } catch (error) {
      console.error("Logout error:", error);
      // Continue with local logout even if backend call fails
    }

    setCurrentUser(null);
    setInitializationError(null);
    localStorage.removeItem("authToken");
    sessionStorage.removeItem("authToken");
  }, []);

  const updateUser = useCallback((updates: Partial<AuthUser>) => {
    setCurrentUser((prev) => (prev ? { ...prev, ...updates } : null));
  }, []);

  // Permission helpers
  const canCreateEvents = useCallback(() => {
    return (
      !!currentUser &&
      ["Super Admin", "Administrator", "Leader"].includes(currentUser.role)
    );
  }, [currentUser]);

  const canManageUsers = useCallback(() => {
    return (
      !!currentUser &&
      ["Super Admin", "Administrator"].includes(currentUser.role)
    );
  }, [currentUser]);

  const hasRole = useCallback(
    (roles: string | string[]) => {
      if (!currentUser) return false;
      const roleArray = Array.isArray(roles) ? roles : [roles];
      return roleArray.includes(currentUser.role);
    },
    [currentUser]
  );

  const value: AuthContextType = {
    // State
    currentUser,
    isAuthenticated: !!currentUser,
    isLoading,
    initializationError,

    // Actions
    login,
    logout,
    retryInitialization: checkExistingAuth,
    updateUser,

    // Permissions
    canCreateEvents: canCreateEvents(),
    canManageUsers: canManageUsers(),
    hasRole,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

// Higher-order component for protected routes
export function withAuth<P extends object>(Component: React.ComponentType<P>) {
  return function AuthenticatedComponent(props: P) {
    const { isAuthenticated } = useAuth();

    if (!isAuthenticated) {
      // In a real app, this would redirect to login
      return <div>Please log in to access this page.</div>;
    }

    return <Component {...props} />;
  };
}

// Hook for role-based access
export function useRequireRole(requiredRoles: string | string[]) {
  const { hasRole, currentUser } = useAuth();

  const hasAccess = hasRole(requiredRoles);

  return {
    hasAccess,
    currentUser,
    requiredRoles: Array.isArray(requiredRoles)
      ? requiredRoles
      : [requiredRoles],
  };
}
