import { useMemo } from "react";
import type { SystemAuthorizationLevel, User } from "../types/management";
import type { CommunityMemberDTO } from "../services/api";
import { useRoleStats } from "./useRoleStats";
import { useCommunityStats } from "./useUsersApi";
import { useAuth } from "./useAuth";
import { useManagementFilters } from "./useManagementFilters";
import type { ManagementDirectoryScope } from "./useManagementFilters";

/**
 * Enhanced management hook that combines search/filter functionality
 * with the existing management capabilities.
 */
export function useEnhancedManagement(scope?: ManagementDirectoryScope) {
  // Get current user
  const { currentUser } = useAuth();

  // Get actual current user role from auth context
  const currentUserRole: SystemAuthorizationLevel =
    currentUser?.role || "Participant";
  const resolvedScope: ManagementDirectoryScope =
    scope ??
    (currentUserRole === "Super Admin" || currentUserRole === "Administrator"
      ? "admin"
      : "community");
  const isAdminView = resolvedScope === "admin";

  // Use the enhanced filtering hook for user data
  const {
    adminUsers,
    communityMembers,
    loading: filterLoading,
    error: filterError,
    pagination: filterPagination,
    currentFilters,
    handleFiltersChange,
    handlePageChange,
    handleRefresh,
  } = useManagementFilters(resolvedScope);

  // Convert filtered users to management User type
  const users: User[] = useMemo(() => {
    return adminUsers.map((user) => ({
      id: user.id,
      username: user.username,
      email: user.email,
      firstName: user.firstName ?? "",
      lastName: user.lastName ?? "",
      role: user.role,
      avatar: user.avatar,
      gender: user.gender ?? "male",
      joinDate: user.createdAt
        ? new Date(user.createdAt).toLocaleDateString()
        : "Unknown",
      roleInAtCloud: user.roleInAtCloud ?? undefined,
      isAtCloudLeader: user.isAtCloudLeader ? "Yes" : "No",
      isActive: user.isActive,
    }));
  }, [adminUsers]);

  // Page-derived stats (fallback)
  const pageRoleStats = useRoleStats(users);

  // Backend-wide stats for the whole collection (all authenticated users can fetch)
  const { stats: backendStats, loading: backendStatsLoading } =
    useCommunityStats();

  // Map backend stats shape to RoleStats for UI cards; fallback to page stats while loading
  const roleStats = useMemo(() => {
    type BackendRoleDistribution = Record<
      | "Super Admin"
      | "Administrator"
      | "Leader"
      | "Guest Expert"
      | "Participant",
      number
    > &
      Record<string, number>;
    interface BackendUserStats {
      totalUsers: number;
      atCloudLeaders: number;
      roleDistribution: BackendRoleDistribution;
    }
    const fromPossibles = (obj: unknown): BackendUserStats | null => {
      const stats =
        (obj as { stats?: unknown })?.stats ||
        (obj as { data?: { stats?: unknown } })?.data?.stats ||
        null;
      if (!stats || typeof stats !== "object") return null;
      const s = stats as Partial<BackendUserStats>;
      if (!s.roleDistribution) return null;
      return {
        totalUsers: Number(s.totalUsers ?? 0),
        atCloudLeaders: Number(s.atCloudLeaders ?? 0),
        roleDistribution: s.roleDistribution as BackendRoleDistribution,
      };
    };

    const normalized = fromPossibles(backendStats);
    if (!normalized) return pageRoleStats;

    const roleDist = normalized.roleDistribution;
    return {
      total: normalized.totalUsers,
      superAdmin: roleDist["Super Admin"] || 0,
      administrators: roleDist["Administrator"] || 0,
      leaders: roleDist["Leader"] || 0,
      guestExperts: roleDist["Guest Expert"] || 0,
      participants: roleDist["Participant"] || 0,
      atCloudLeaders: normalized.atCloudLeaders,
    };
  }, [backendStats, pageRoleStats]);

  return {
    // User data
    users,
    communityMembers: communityMembers as CommunityMemberDTO[],
    isAdminView,
    scope: resolvedScope,
    currentUserRole,
    roleStats,
    roleStatsLoading: backendStatsLoading,
    pagination: filterPagination,
    loading: filterLoading,
    error: filterError,

    // Search and filtering
    currentFilters,
    onFiltersChange: handleFiltersChange,
    onPageChange: handlePageChange,
    onRefresh: handleRefresh,
  };
}
