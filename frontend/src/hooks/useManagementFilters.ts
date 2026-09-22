import { useCallback, useEffect, useRef, useState } from "react";
import type { UserSearchFilters } from "../components/management/UserSearchAndFilter";
import type { CommunityMemberListParams } from "../services/api";
import { socketService } from "../services/socketService";
import { useCommunityMembers, useUsers } from "./useUsersApi";
import { useSocket } from "./useSocket";

export type ManagementDirectoryScope = "admin" | "community";

const initialFilters = (
  scope: ManagementDirectoryScope,
): UserSearchFilters => ({
  search: "",
  role: undefined,
  gender: undefined,
  sortBy: scope === "admin" ? "createdAt" : "firstName",
  sortOrder: scope === "admin" ? "desc" : "asc",
});

const communitySortBy = (
  value: string | undefined,
): CommunityMemberListParams["sortBy"] => {
  if (value === "lastName" || value === "username") return value;
  return "firstName";
};

function sameFilters(a: UserSearchFilters, b: UserSearchFilters): boolean {
  return (
    a.search === b.search &&
    a.role === b.role &&
    a.gender === b.gender &&
    a.sortBy === b.sortBy &&
    a.sortOrder === b.sortOrder
  );
}

export function useManagementFilters(scope: ManagementDirectoryScope) {
  const [currentFilters, setCurrentFilters] = useState<UserSearchFilters>(() =>
    initialFilters(scope),
  );
  const currentFiltersRef = useRef(currentFilters);
  const initializedScopeRef = useRef<ManagementDirectoryScope | null>(null);
  currentFiltersRef.current = currentFilters;

  const {
    users: adminUsers,
    loading: adminLoading,
    error: adminError,
    pagination: adminPagination,
    fetchUsersWithFilters,
  } = useUsers({ autoFetch: false });
  const {
    members: communityMembers,
    loading: communityLoading,
    error: communityError,
    pagination: communityPagination,
    fetchMembers,
  } = useCommunityMembers({ autoFetch: false });

  useSocket();

  const fetchPage = useCallback(
    async (filters: UserSearchFilters, page: number) => {
      if (scope === "admin") {
        await fetchUsersWithFilters({
          q: filters.search || undefined,
          role: filters.role || undefined,
          gender: filters.gender || undefined,
          sortBy: filters.sortBy || "createdAt",
          sortOrder: filters.sortOrder || "desc",
          page,
        });
        return;
      }

      await fetchMembers({
        q: filters.search || undefined,
        sortBy: communitySortBy(filters.sortBy),
        sortOrder: filters.sortOrder || "asc",
        page,
      });
    },
    [fetchMembers, fetchUsersWithFilters, scope],
  );

  const handleFiltersChange = useCallback(
    (filters: UserSearchFilters) => {
      // The filter control reports its default values on mount. The hook has
      // already loaded that page, so do not issue the same request twice.
      if (sameFilters(currentFiltersRef.current, filters)) return;
      currentFiltersRef.current = filters;
      setCurrentFilters(filters);
      void fetchPage(filters, 1);
    },
    [fetchPage],
  );

  const handlePageChange = useCallback(
    (page: number) => {
      void fetchPage(currentFiltersRef.current, page);
    },
    [fetchPage],
  );

  const handleRefresh = useCallback(() => {
    const page =
      scope === "admin"
        ? adminPagination.currentPage
        : communityPagination.currentPage;
    void fetchPage(currentFiltersRef.current, page);
  }, [
    adminPagination.currentPage,
    communityPagination.currentPage,
    fetchPage,
    scope,
  ]);

  useEffect(
    () => socketService.on("user_update", handleRefresh),
    [handleRefresh],
  );

  useEffect(() => {
    if (initializedScopeRef.current === scope) return;
    initializedScopeRef.current = scope;
    const filters = initialFilters(scope);
    currentFiltersRef.current = filters;
    setCurrentFilters(filters);
    void fetchPage(filters, 1);
  }, [fetchPage, scope]);

  const pagination =
    scope === "admin"
      ? adminPagination
      : {
          currentPage: communityPagination.currentPage,
          totalPages: communityPagination.totalPages,
          totalUsers: communityPagination.totalMembers,
          hasNext: communityPagination.hasNext,
          hasPrev: communityPagination.hasPrev,
        };

  return {
    scope,
    adminUsers: scope === "admin" ? adminUsers : [],
    communityMembers: scope === "community" ? communityMembers : [],
    loading: scope === "admin" ? adminLoading : communityLoading,
    error: scope === "admin" ? adminError : communityError,
    pagination,
    currentFilters,
    handleFiltersChange,
    handlePageChange,
    handleRefresh,
  };
}
