import {
  BaseApiClient,
  type ApiResponse,
  type AuthResponse,
  type AuthTokens,
} from "./common";
import { socketService } from "../socketService";
import type { RegistrationProfileFields } from "@atcloud/shared-time/registration-profile";

export type RegisterUserPayload = {
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
  firstName?: string;
  lastName?: string;
  gender?: "male" | "female";
  isAtCloudLeader: boolean;
  roleInAtCloud?: string;
  weeklyChurch?: string;
  churchAddress?: string;
  acceptTerms: boolean;
} & RegistrationProfileFields;

/**
 * Authentication API Service
 * Handles login, registration, password reset, email verification, and profile management
 */
class AuthApiClient extends BaseApiClient {
  /**
   * Login with email/username and password
   */
  async login(
    emailOrUsername: string,
    password: string,
    rememberMe?: boolean
  ): Promise<AuthResponse> {
    // For login, we need to handle 401 errors specially to avoid triggering session expiry
    // Use direct fetch instead of this.request() to avoid automatic session handling
    const url = `${this.baseURL}/auth/login`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          emailOrUsername,
          password,
          rememberMe,
        }),
      });

      let data: ApiResponse<AuthResponse>;
      try {
        data = (await response.json()) as ApiResponse<AuthResponse>;
      } catch {
        data = {
          success: response.ok,
          message: response.statusText,
        } as ApiResponse<AuthResponse>;
      }

      if (response.ok && data.data) {
        // Store token in localStorage
        localStorage.setItem("authToken", data.data.accessToken);
        socketService.updateAuthenticationToken(data.data.accessToken);
        return data.data;
      }

      // For login failures, throw the actual error message without triggering session expiry
      throw new Error(data.message || "Invalid credentials");
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error("Network error during login");
    }
  }

  /**
   * Register a new user
   */
  async register(userData: RegisterUserPayload): Promise<AuthResponse> {
    const response = await this.request<AuthResponse>("/auth/register", {
      method: "POST",
      body: JSON.stringify(userData),
    });

    if (response.data) {
      return response.data;
    }

    throw new Error(response.message || "Registration failed");
  }

  /**
   * Logout the current user
   */
  async logout(): Promise<void> {
    try {
      await this.request("/auth/logout", {
        method: "POST",
      });
    } finally {
      localStorage.removeItem("authToken");
      socketService.updateAuthenticationToken(null);
    }
  }

  /**
   * Get the current user's profile
   */
  async getProfile(): Promise<AuthResponse["user"]> {
    const response = await this.request<{ user: AuthResponse["user"] }>(
      "/auth/profile"
    );

    if (response.data) {
      return response.data.user;
    }

    throw new Error(response.message || "Failed to get profile");
  }

  /**
   * Refresh the authentication token
   * Note: This is now exposed publicly (was private in base class) for explicit refresh calls
   */
  async refreshToken(): Promise<AuthTokens> {
    const url = `${this.baseURL}/auth/refresh-token`;
    const resp = await fetch(url, {
      method: "POST",
      credentials: "include",
    });
    const raw: unknown = await resp.json();
    const data = raw as Partial<ApiResponse<AuthTokens>> &
      Partial<AuthTokens> & {
        data?: Partial<AuthTokens>;
        message?: string;
      };
    if (!resp.ok) {
      throw new Error(data?.message || `HTTP ${resp.status}`);
    }
    const token = data.accessToken || data?.data?.accessToken;
    if (token) {
      localStorage.setItem("authToken", token);
      socketService.updateAuthenticationToken(token);
      const expiresAt =
        data.expiresAt ||
        data?.data?.expiresAt ||
        new Date(Date.now() + 55 * 60 * 1000).toISOString();
      return { accessToken: token, expiresAt };
    }
    throw new Error(data?.message || "Token refresh failed");
  }

  /**
   * Verify email with token
   */
  async verifyEmail(token: string): Promise<void> {
    await this.request(`/auth/verify-email/${token}`);
  }

  /**
   * Resend verification email
   */
  async resendVerification(email: string): Promise<void> {
    await this.request("/auth/resend-verification", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
  }

  /**
   * Request password reset email
   */
  async forgotPassword(email: string): Promise<void> {
    await this.request("/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
  }

  /**
   * Reset password with token
   */
  async resetPassword(
    token: string,
    newPassword: string,
    confirmPassword: string
  ): Promise<void> {
    await this.request("/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, newPassword, confirmPassword }),
    });
  }
}

// Export singleton instance
const authApiClient = new AuthApiClient();

// Export service methods
export const authService = {
  login: (emailOrUsername: string, password: string, rememberMe?: boolean) =>
    authApiClient.login(emailOrUsername, password, rememberMe),
  register: (userData: Parameters<typeof authApiClient.register>[0]) =>
    authApiClient.register(userData),
  logout: () => authApiClient.logout(),
  getProfile: () => authApiClient.getProfile(),
  refreshToken: () => authApiClient.refreshToken(),
  verifyEmail: (token: string) => authApiClient.verifyEmail(token),
  resendVerification: (email: string) =>
    authApiClient.resendVerification(email),
  forgotPassword: (email: string) => authApiClient.forgotPassword(email),
  resetPassword: (
    token: string,
    newPassword: string,
    confirmPassword: string
  ) => authApiClient.resetPassword(token, newPassword, confirmPassword),
};
