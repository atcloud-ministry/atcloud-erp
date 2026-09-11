import { BaseApiClient } from "./common";
import type { User as AppUser } from "../../types";
import type { RegistrationProfileFields } from "@atcloud/shared-time/registration-profile";
import type { AdminUserListParams } from "./userDirectory.api";
import {
  decodeAdminUserDetail,
  decodeAdminUsersPage,
  type AdminUserDTO,
  type AdminUsersPageDTO,
} from "./userDirectory.contracts";

export type AdminProfileUpdate = Partial<RegistrationProfileFields> & {
  avatar?: string;
  isAtCloudLeader?: boolean;
  roleInAtCloud?: string;
};

/**
 * Users API Service
 * Handles user management, profile operations, and admin user management
 */
class UsersApiClient extends BaseApiClient {
  // ========== User List and Search ==========

  /**
   * Get paginated list of users with filters (Admin only)
   * @param params - Pagination, search, and filter parameters
   * @returns Paginated users list with metadata
   */
  async getUsers(
    params?: AdminUserListParams,
  ): Promise<AdminUsersPageDTO> {
    const queryParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          queryParams.append(key, value.toString());
        }
      });
    }

    const endpoint = `/users${
      queryParams.toString() ? `?${queryParams.toString()}` : ""
    }`;
    const response = await this.request<unknown>(endpoint);

    if (response.data !== undefined) {
      return decodeAdminUsersPage(response.data);
    }

    throw new Error(response.message || "Failed to get users");
  }

  /**
   * Get a single user by ID
   * @param id - User ID
   * @returns User object
   */
  async getUser(id: string): Promise<AdminUserDTO> {
    const response = await this.request<unknown>(`/users/${id}`);

    if (response.data !== undefined) {
      return decodeAdminUserDetail(response.data);
    }

    throw new Error(response.message || "Failed to get user");
  }

  // ========== Profile Management ==========

  /**
   * Update current user's profile
   * @param updates - Profile fields to update
   * @returns Updated user object
   */
  async updateProfile(updates: unknown): Promise<AppUser> {
    // Backend returns { success, message, data: { id, username, ... } }
    // The user object is directly in data, not wrapped in data.user
    const response = await this.request<AppUser>("/users/profile", {
      method: "PUT",
      body: JSON.stringify(updates),
    });

    if (response.data) {
      return response.data;
    }

    throw new Error(response.message || "Failed to update profile");
  }

  /**
   * Admin edit any user's profile (Admin only)
   * @param userId - Target user ID
   * @param updates - Profile fields to update
   * @returns Updated profile fields
   */
  async adminEditProfile(
    userId: string,
    updates: AdminProfileUpdate,
  ): Promise<AdminProfileUpdate> {
    const response = await this.request<AdminProfileUpdate>(
      `/users/${userId}/admin-edit`,
      {
        method: "PUT",
        body: JSON.stringify(updates),
      },
    );

    if (response.data) {
      return response.data;
    }

    throw new Error(response.message || "Failed to update user profile");
  }

  // ========== User Stats and Analytics ==========

  /**
   * Get community-level statistics (all authenticated users)
   * @returns Community statistics object (totals, role distribution)
   */
  async getCommunityStats(): Promise<unknown> {
    const response = await this.request<unknown>("/users/community-stats");

    if (response.data) {
      return response.data;
    }

    throw new Error(response.message || "Failed to get community stats");
  }

  /**
   * Get user statistics (Admin only)
   * @returns User statistics object
   */
  async getUserStats(): Promise<unknown> {
    const response = await this.request<unknown>("/users/stats");

    if (response.data) {
      return response.data;
    }

    throw new Error(response.message || "Failed to get user stats");
  }

  // ========== Role Management ==========

  /**
   * Update a user's role (Admin only)
   * @param userId - Target user ID
   * @param role - New role to assign
   * @returns Updated user object
   */
  async updateUserRole(userId: string, role: string): Promise<AppUser> {
    const response = await this.request<{ user: AppUser }>(
      `/users/${userId}/role`,
      {
        method: "PUT",
        body: JSON.stringify({ role }),
      },
    );

    if (response.data) {
      return response.data.user;
    }

    throw new Error(response.message || "Failed to update user role");
  }

  // ========== User Deletion ==========

  /**
   * Delete a user permanently (Admin only)
   * @param userId - User ID to delete
   */
  async deleteUser(userId: string): Promise<void> {
    await this.request(`/users/${userId}`, {
      method: "DELETE",
    });
  }

  /**
   * Get impact analysis before deleting a user (Admin only)
   * @param userId - User ID to analyze
   * @returns Detailed impact report with affected resources
   */
  async getUserDeletionImpact(userId: string): Promise<{
    user: {
      email: string;
      name: string;
      role: string;
      createdAt: Date;
    };
    impact: {
      registrations: number;
      eventsCreated: number;
      eventOrganizations: number;
      messageStates: number;
      messagesCreated: number;
      promoCodes: number;
      programMentorships: number;
      programClassReps: number;
      programMentees: number;
      shortLinks: number;
      avatarFile: boolean;
      eventFlyerFiles: number;
      affectedEvents: Array<{
        id: string;
        title: string;
        participantCount: number;
      }>;
    };
    risks: string[];
  }> {
    const response = await this.request<{
      user: {
        email: string;
        name: string;
        role: string;
        createdAt: Date;
      };
      impact: {
        registrations: number;
        eventsCreated: number;
        eventOrganizations: number;
        messageStates: number;
        messagesCreated: number;
        promoCodes: number;
        programMentorships: number;
        programClassReps: number;
        programMentees: number;
        shortLinks: number;
        avatarFile: boolean;
        eventFlyerFiles: number;
        affectedEvents: Array<{
          id: string;
          title: string;
          participantCount: number;
        }>;
      };
      risks: string[];
    }>(`/users/${userId}/deletion-impact`, {
      method: "GET",
    });
    if (!response.data) {
      throw new Error("Failed to fetch deletion impact");
    }
    return response.data;
  }

  // ========== Password Management ==========

  /**
   * Request a password change (requires current password)
   * @param currentPassword - Current password for verification
   * @param newPassword - New password to set
   * @returns Success message
   */
  async requestPasswordChange(
    currentPassword: string,
    newPassword: string,
  ): Promise<{ message: string }> {
    return await this.request("/auth/request-password-change", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  }

  /**
   * Complete password change using token from email
   * @param token - Email verification token
   * @returns Success message
   */
  async completePasswordChange(token: string): Promise<{ message: string }> {
    return await this.request(`/auth/complete-password-change/${token}`, {
      method: "POST",
    });
  }

  // ========== User Activation ==========

  /**
   * Deactivate a user account (Admin only)
   * @param userId - User ID to deactivate
   */
  async deactivateUser(userId: string): Promise<void> {
    await this.request(`/users/${userId}/deactivate`, {
      method: "PUT",
    });
  }

  /**
   * Reactivate a deactivated user account (Admin only)
   * @param userId - User ID to reactivate
   */
  async reactivateUser(userId: string): Promise<void> {
    await this.request(`/users/${userId}/reactivate`, {
      method: "PUT",
    });
  }
}

// Export singleton instance
const usersApiClient = new UsersApiClient();

// Export service methods
export const usersService = {
  // User list and search
  getUsers: (params?: Parameters<typeof usersApiClient.getUsers>[0]) =>
    usersApiClient.getUsers(params),
  getUser: (id: string) => usersApiClient.getUser(id),

  // Profile management
  updateProfile: (updates: unknown) => usersApiClient.updateProfile(updates),
  adminEditProfile: (
    userId: string,
    updates: Parameters<typeof usersApiClient.adminEditProfile>[1],
  ) => usersApiClient.adminEditProfile(userId, updates),

  // Stats and analytics
  getUserStats: () => usersApiClient.getUserStats(),
  getCommunityStats: () => usersApiClient.getCommunityStats(),

  // Role management
  updateUserRole: (userId: string, role: string) =>
    usersApiClient.updateUserRole(userId, role),

  // User deletion
  deleteUser: (userId: string) => usersApiClient.deleteUser(userId),
  getUserDeletionImpact: (userId: string) =>
    usersApiClient.getUserDeletionImpact(userId),

  // Password management
  requestPasswordChange: (currentPassword: string, newPassword: string) =>
    usersApiClient.requestPasswordChange(currentPassword, newPassword),
  completePasswordChange: (token: string) =>
    usersApiClient.completePasswordChange(token),

  // User activation
  deactivateUser: (userId: string) => usersApiClient.deactivateUser(userId),
  reactivateUser: (userId: string) => usersApiClient.reactivateUser(userId),
};

// Legacy export (singular name for backward compatibility)
export const userService = usersService;
