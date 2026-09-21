import { useState, useEffect, useCallback } from "react";
import {
  adminUsersService,
  apiClient,
  communityMembersService,
  userService,
  type AdminUserDTO,
  type CommunityMemberListParams,
  type CommunityMemberDTO,
} from "../services/api";
import type { AdminUserListParams } from "../services/api/userDirectory.api";
import { useToastReplacement } from "../contexts/NotificationModalContext";

// Backend response shapes we actually consume in this hook
interface BackendUserBase {
  id: string;
  _id?: string; // MongoDB ID fallback
  username: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  role: string;
  roleInAtCloud?: string | null;
  lastLogin?: string | null;
  createdAt?: string | null;
  joinedAt?: string | null;
  // Optional profile details
  avatar?: string | null;
  gender?: "male" | "female" | null;
  phone?: string | null;
  dateOfBirth?: string | null;
  location?: string | null;
  bio?: string | null;
  emailVerified?: boolean | null;
}

export interface UserProfile {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  systemAuthorizationLevel: string;
  // Backend boolean flag; used by management mapping to display "Yes"/"No"
  isAtCloudLeader?: boolean;
  roleInAtCloud?: string;
  avatar?: string;
  gender?: "male" | "female";
  phone?: string;
  dateOfBirth?: string;
  location?: string;
  bio?: string;
  joinedAt: string;
  lastActive?: string;
  isActive?: boolean;
  emailVerified?: boolean;
  occupation?: string;
  company?: string;
  weeklyChurch?: string;
  churchAddress?: string;
}

export interface UseUserProfileReturn {
  profile: UserProfile | null;
  loading: boolean;
  error: string | null;
  refreshProfile: () => Promise<void>;
  updateProfile: (updates: Partial<UserProfile>) => Promise<boolean>;
}

export function useUserProfile(): UseUserProfileReturn {
  const { success, error: showError } = useToastReplacement();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchProfile = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response =
        (await apiClient.getProfile()) as unknown as BackendUserBase;

      // Convert backend user format to frontend UserProfile format
      const convertedProfile: UserProfile = {
        id: response.id,
        username: response.username,
        email: response.email,
        firstName: response.firstName ?? "",
        lastName: response.lastName ?? "",
        role: response.role,
        systemAuthorizationLevel: response.role, // Use role as system authorization level
        roleInAtCloud: response.roleInAtCloud ?? undefined,
        avatar: response.avatar ?? undefined,
        gender: response.gender ?? undefined,
        phone: response.phone ?? undefined,
        dateOfBirth: response.dateOfBirth ?? undefined,
        location: response.location ?? undefined,
        bio: response.bio ?? undefined,
        joinedAt:
          response.createdAt ?? response.joinedAt ?? new Date().toISOString(),
        lastActive: response.lastLogin ?? undefined,
        isActive: true, // Default to true as the API doesn't provide this field
        emailVerified: response.emailVerified ?? undefined,
      };

      setProfile(convertedProfile);
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to load user profile";
      setError(errorMessage);
      showError(errorMessage);
      console.error("Error fetching user profile:", err);
    } finally {
      setLoading(false);
    }
  }, [showError]);

  const updateProfile = useCallback(
    async (updates: Partial<UserProfile>): Promise<boolean> => {
      setLoading(true);
      setError(null);

      try {
        const response = await userService.updateProfile(updates);

        // Update local state with response
        if (response && profile) {
          const updatedProfile = { ...profile, ...updates };
          setProfile(updatedProfile);
        }

        success("Profile updated successfully");
        return true;
      } catch (err: unknown) {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to update profile";
        setError(errorMessage);
        showError(errorMessage);
        console.error("Error updating profile:", err);
        return false;
      } finally {
        setLoading(false);
      }
    },
    [profile, success, showError],
  );

  const refreshProfile = useCallback(async () => {
    await fetchProfile();
  }, [fetchProfile]);

  // Auto-load profile on mount
  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  return {
    profile,
    loading,
    error,
    refreshProfile,
    updateProfile,
  };
}

// Hook for getting all users (admin functionality)
export function useUsers(options?: {
  suppressErrors?: boolean;
  autoFetch?: boolean;
}) {
  const { error: showError } = useToastReplacement();
  const [users, setUsers] = useState<AdminUserDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState({
    currentPage: 1,
    totalPages: 0,
    totalUsers: 0,
    hasNext: false,
    hasPrev: false,
  });

  const fetchUsers = useCallback(
    async (params: AdminUserListParams = {}) => {
      setLoading(true);
      setError(null);

      try {
        const response = await adminUsersService.list(params);
        setUsers(response.users);
        setPagination(response.pagination);
      } catch (err: unknown) {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to load users";
        setError(errorMessage);
        if (!options?.suppressErrors) {
          showError(errorMessage);
        }
        console.error("Error fetching users:", err);
      } finally {
        setLoading(false);
      }
    },
    [showError, options?.suppressErrors],
  );

  const searchUsers = useCallback(
    async (searchTerm: string) => {
      await fetchUsers({ q: searchTerm, page: 1 });
    },
    [fetchUsers],
  );

  const filterUsers = useCallback(
    async (filters: {
      role?: string;
      isActive?: boolean;
      isVerified?: boolean;
    }) => {
      await fetchUsers({
        ...filters,
        role: filters.role as AdminUserListParams["role"],
        page: 1,
      });
    },
    [fetchUsers],
  );

  // Enhanced method for advanced filtering and sorting
  const fetchUsersWithFilters = useCallback(
    async (params: {
      q?: string;
      role?: string;
      gender?: string;
      sortBy?: string;
      sortOrder?: "asc" | "desc";
      page?: number;
      limit?: number;
    }) => {
      // Clean up undefined values to avoid sending empty params
      const cleanParams = Object.fromEntries(
        Object.entries(params).filter(
          ([, value]) => value !== undefined && value !== "",
        ),
      );

      await fetchUsers(cleanParams as AdminUserListParams);
    },
    [fetchUsers],
  );

  const loadPage = useCallback(
    async (
      page: number,
      currentFilters?: {
        q?: string;
        role?: string;
        gender?: string;
        sortBy?: string;
        sortOrder?: "asc" | "desc";
      },
    ) => {
      if (currentFilters) {
        await fetchUsersWithFilters({ ...currentFilters, page });
      } else {
        await fetchUsers({ page });
      }
    },
    [fetchUsers, fetchUsersWithFilters],
  );

  const refreshUsers = useCallback(async () => {
    await fetchUsers();
  }, [fetchUsers]);

  // Auto-load users on mount (only if autoFetch is not explicitly disabled)
  useEffect(() => {
    if (options?.autoFetch !== false) {
      fetchUsers();
    }
  }, [fetchUsers, options?.autoFetch]);

  return {
    users,
    loading,
    error,
    pagination,
    searchUsers,
    filterUsers,
    fetchUsersWithFilters,
    loadPage,
    refreshUsers,
  };
}

export function useCommunityMembers(options?: { autoFetch?: boolean }) {
  const { error: showError } = useToastReplacement();
  const [members, setMembers] = useState<CommunityMemberDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState({
    currentPage: 1,
    totalPages: 0,
    totalMembers: 0,
    hasNext: false,
    hasPrev: false,
  });

  const fetchMembers = useCallback(
    async (params: CommunityMemberListParams = {}) => {
      setLoading(true);
      setError(null);
      try {
        const response = await communityMembersService.list(params);
        setMembers(response.members);
        setPagination(response.pagination);
      } catch (err: unknown) {
        const message =
          err instanceof Error
            ? err.message
            : "Failed to load community members";
        setError(message);
        showError(message);
      } finally {
        setLoading(false);
      }
    },
    [showError],
  );

  useEffect(() => {
    if (options?.autoFetch !== false) void fetchMembers();
  }, [fetchMembers, options?.autoFetch]);

  return { members, loading, error, pagination, fetchMembers };
}

// Hook for getting community-level statistics (available to all authenticated users)
export function useCommunityStats(shouldFetch: boolean = true) {
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    if (!shouldFetch) return;
    setLoading(true);
    setError(null);

    try {
      const response =
        (await userService.getCommunityStats()) as unknown as Record<
          string,
          unknown
        >;
      setStats(response);
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error
          ? err.message
          : "Failed to load community statistics";
      setError(errorMessage);
      console.error("Error fetching community stats:", err);
    } finally {
      setLoading(false);
    }
  }, [shouldFetch]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  return {
    stats,
    loading,
    error,
    refreshStats: fetchStats,
  };
}

// Hook for getting user statistics
export function useUserStats(shouldFetch: boolean = true) {
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    if (!shouldFetch) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = (await userService.getUserStats()) as unknown as Record<
        string,
        unknown
      >;
      setStats(response);
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to load user statistics";
      setError(errorMessage);
      console.error("Error fetching user stats:", err);
    } finally {
      setLoading(false);
    }
  }, [shouldFetch]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  return {
    stats,
    loading,
    error,
    refreshStats: fetchStats,
  };
}

// Hook for getting specific user by ID
export function useUser(userId: string) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchUser = useCallback(async () => {
    if (!userId) return;

    setLoading(true);
    setError(null);

    try {
      const response = (await userService.getUser(
        userId,
      )) as unknown as BackendUserBase;

      // Convert backend user format to frontend UserProfile format
      const convertedUser: UserProfile = {
        id: response.id,
        username: response.username,
        email: response.email,
        firstName: response.firstName ?? "",
        lastName: response.lastName ?? "",
        role: response.role,
        systemAuthorizationLevel: response.role,
        roleInAtCloud: response.roleInAtCloud ?? undefined,
        avatar: response.avatar ?? undefined,
        gender: response.gender ?? undefined,
        phone: response.phone ?? undefined,
        dateOfBirth: response.dateOfBirth ?? undefined,
        location: response.location ?? undefined,
        bio: response.bio ?? undefined,
        joinedAt:
          response.createdAt ?? response.joinedAt ?? new Date().toISOString(),
        lastActive: response.lastLogin ?? undefined,
        isActive: true,
        emailVerified: response.emailVerified ?? undefined,
      };

      setUser(convertedUser);
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to load user";
      setError(errorMessage);
      console.error("Error fetching user:", err);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  return {
    user,
    loading,
    error,
    refreshUser: fetchUser,
  };
}
