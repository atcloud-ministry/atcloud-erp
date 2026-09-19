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
  registrationNoticeVersion: string;
} & RegistrationProfileFields;

export interface RegistrationNoticeDTO {
  version: string;
  text: string;
  effectiveAt: string;
}

function decodeRegistrationNotice(value: unknown): RegistrationNoticeDTO {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid registration notice response");
  }
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== 1 || !("notice" in data)) {
    throw new Error("Invalid registration notice response");
  }
  const notice = data.notice;
  if (!notice || typeof notice !== "object" || Array.isArray(notice)) {
    throw new Error("Invalid registration notice response");
  }
  const record = notice as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    typeof record.version !== "string" ||
    !record.version.trim() ||
    typeof record.text !== "string" ||
    !record.text.trim() ||
    typeof record.effectiveAt !== "string" ||
    Number.isNaN(Date.parse(record.effectiveAt))
  ) {
    throw new Error("Invalid registration notice response");
  }
  return {
    version: record.version,
    text: record.text,
    effectiveAt: record.effectiveAt,
  };
}

/**
 * Authentication API Service
 * Handles login, registration, password reset, email verification, and profile management
 */
class AuthApiClient extends BaseApiClient {
  async getRegistrationNotice(
    signal?: AbortSignal,
  ): Promise<RegistrationNoticeDTO> {
    const response = await this.request<unknown>("/auth/registration-notice", {
      signal,
    });
    if (response.data === undefined) {
      throw new Error(response.message || "Failed to load registration notice");
    }
    return decodeRegistrationNotice(response.data);
  }

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
    return super.refreshToken();
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
  getRegistrationNotice: (signal?: AbortSignal) =>
    authApiClient.getRegistrationNotice(signal),
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
