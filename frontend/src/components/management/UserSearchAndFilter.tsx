import { useState, useCallback, useEffect, useMemo } from "react";
import {
  MagnifyingGlassIcon,
  AdjustmentsHorizontalIcon,
} from "@heroicons/react/24/outline";
import type { SystemAuthorizationLevel } from "../../types/management";

export interface UserSearchFilters {
  search: string;
  role?: string;
  gender?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}

interface UserSearchAndFilterProps {
  onFiltersChange: (filters: UserSearchFilters) => void;
  loading: boolean;
  totalResults?: number;
  currentUserRole: SystemAuthorizationLevel;
  mode?: "admin" | "community";
}

const ADMIN_SORT_OPTIONS = [
  { value: "role", label: "System Authorization Level" },
  { value: "createdAt", label: "Join Date" },
  { value: "gender", label: "Gender" },
];

const COMMUNITY_SORT_OPTIONS = [
  { value: "firstName", label: "First Name" },
  { value: "lastName", label: "Last Name" },
  { value: "username", label: "Username" },
];

const ROLE_OPTIONS = [
  { value: "", label: "All Roles" },
  { value: "Super Admin", label: "Super Admin" },
  { value: "Administrator", label: "Administrator" },
  { value: "Leader", label: "Leader" },
  { value: "Guest Expert", label: "Guest Expert" },
  { value: "Participant", label: "Participant" },
];

const GENDER_OPTIONS = [
  { value: "", label: "All Genders" },
  { value: "male", label: "Male" },
  { value: "female", label: "Female" },
];

export default function UserSearchAndFilter({
  onFiltersChange,
  loading,
  totalResults,
  currentUserRole,
  mode = "admin",
}: UserSearchAndFilterProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedRole, setSelectedRole] = useState("");
  const [selectedGender, setSelectedGender] = useState("");
  // Default sort: Join Date (newest first)
  const [sortBy, setSortBy] = useState(
    mode === "admin" ? "createdAt" : "firstName",
  );
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">(
    mode === "admin" ? "desc" : "asc",
  );
  const [showFilters, setShowFilters] = useState(false);

  // Filter sort options based on user role - only Super Admin and Administrator can see System Authorization Level
  const SORT_OPTIONS = useMemo(() => {
    const canViewRoleSort =
      currentUserRole === "Super Admin" || currentUserRole === "Administrator";
    if (mode === "community") return COMMUNITY_SORT_OPTIONS;
    return canViewRoleSort
      ? ADMIN_SORT_OPTIONS
      : ADMIN_SORT_OPTIONS.filter((option) => option.value !== "role");
  }, [currentUserRole, mode]);

  // If user can't see role sorting but it's currently selected, switch to default
  useEffect(() => {
    const canViewRoleSort =
      currentUserRole === "Super Admin" || currentUserRole === "Administrator";
    if (mode === "community") {
      if (!COMMUNITY_SORT_OPTIONS.some((option) => option.value === sortBy)) {
        setSortBy("firstName");
        setSortOrder("asc");
      }
    } else if (!canViewRoleSort && sortBy === "role") {
      setSortBy("createdAt"); // Default to Join Date
    }
  }, [currentUserRole, mode, sortBy]);

  // Debounced search
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState(searchTerm);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchTerm(searchTerm);
    }, 300);

    return () => clearTimeout(timer);
  }, [searchTerm]);

  // Update filters when any value changes
  const updateFilters = useCallback(() => {
    onFiltersChange({
      search: debouncedSearchTerm,
      role: selectedRole || undefined,
      gender: selectedGender || undefined,
      sortBy,
      sortOrder,
    });
  }, [
    debouncedSearchTerm,
    selectedRole,
    selectedGender,
    sortBy,
    sortOrder,
    onFiltersChange,
  ]);

  useEffect(() => {
    updateFilters();
  }, [updateFilters]);

  const resetFilters = () => {
    setSearchTerm("");
    setSelectedRole("");
    setSelectedGender("");
    setSortBy(mode === "admin" ? "createdAt" : "firstName");
    setSortOrder(mode === "admin" ? "desc" : "asc");
  };

  const hasActiveFilters =
    (mode === "admin" && (selectedRole || selectedGender)) ||
    debouncedSearchTerm;

  const hasActiveSorting =
    sortBy !== (mode === "admin" ? "createdAt" : "firstName") ||
    sortOrder !== (mode === "admin" ? "desc" : "asc");
  const hasActiveSearchOrFilters =
    (mode === "admin" && (selectedRole || selectedGender)) ||
    debouncedSearchTerm;

  return (
    <div className="bg-white border-b border-gray-200 p-4 space-y-4">
      {/* Search Bar */}
      <div className="flex items-center space-x-4">
        <div className="flex-1 relative">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <MagnifyingGlassIcon className="h-5 w-5 text-gray-400" />
          </div>
          <input
            type="text"
            placeholder={
              mode === "admin"
                ? "Search users by name, email, or username..."
                : "Search members by name or username..."
            }
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md leading-5 bg-white placeholder-gray-500 focus:outline-none focus:placeholder-gray-400 focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
            disabled={loading}
          />
          {loading && (
            <div className="absolute inset-y-0 right-0 pr-3 flex items-center">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
            </div>
          )}
        </div>

        {/* Filter Toggle Button */}
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`inline-flex items-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 ${
            hasActiveFilters || showFilters
              ? "ring-2 ring-blue-500 border-blue-500"
              : ""
          }`}
        >
          <AdjustmentsHorizontalIcon className="h-4 w-4 mr-2" />
          {mode === "admin" ? "Sort & Filter" : "Sort"}
          {hasActiveFilters && (
            <span className="ml-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
              Active
            </span>
          )}
        </button>
      </div>

      {/* Expandable Filters Section */}
      {showFilters && (
        <div className="border-t border-gray-200 pt-4 space-y-6">
          {/* Sort Section */}
          <div className="bg-gray-50 rounded-lg p-4">
            <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center">
              <svg
                className="w-4 h-4 mr-2 text-gray-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12"
                />
              </svg>
              Sort Options
              {hasActiveSorting && (
                <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
                  Active
                </span>
              )}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Sort By */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Sort By
                </label>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                  className="block w-full border border-gray-300 rounded-md py-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                  disabled={loading}
                >
                  {SORT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Sort Order */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Sort Order
                </label>
                <select
                  value={sortOrder}
                  onChange={(e) =>
                    setSortOrder(e.target.value as "asc" | "desc")
                  }
                  className="block w-full border border-gray-300 rounded-md py-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                  disabled={loading}
                >
                  <option value="asc">Ascending</option>
                  <option value="desc">Descending</option>
                </select>
              </div>
            </div>
          </div>

          {/* Filter Section */}
          {mode === "admin" && (
            <div className="bg-blue-50 rounded-lg p-4">
            <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center">
              <svg
                className="w-4 h-4 mr-2 text-gray-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
                />
              </svg>
              Filter Options
              {hasActiveSearchOrFilters && (
                <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
                  Active
                </span>
              )}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Role Filter */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  System Authorization Level
                </label>
                <select
                  value={selectedRole}
                  onChange={(e) => setSelectedRole(e.target.value)}
                  className="block w-full border border-gray-300 rounded-md py-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                  disabled={loading}
                >
                  {ROLE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Gender Filter */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Gender
                </label>
                <select
                  value={selectedGender}
                  onChange={(e) => setSelectedGender(e.target.value)}
                  className="block w-full border border-gray-300 rounded-md py-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                  disabled={loading}
                >
                  {GENDER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            </div>
          )}

          {/* Results Summary and Reset */}
          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div className="text-sm text-gray-600">
                {totalResults !== undefined && (
                  <>
                    <span className="font-medium text-gray-900">
                      {totalResults}
                    </span>{" "}
                    {mode === "admin"
                      ? `user${totalResults !== 1 ? "s" : ""}`
                      : `member${totalResults !== 1 ? "s" : ""}`} found
                    {hasActiveSearchOrFilters && (
                      <span className="ml-1">
                        (filtered by{" "}
                        {[
                          debouncedSearchTerm && "search",
                          selectedRole && "role",
                          selectedGender && "gender",
                        ]
                          .filter(Boolean)
                          .join(", ")}
                        )
                      </span>
                    )}
                    {hasActiveSorting && (
                      <span className="ml-1">
                        • Sorted by{" "}
                        {SORT_OPTIONS.find(
                          (opt) => opt.value === sortBy
                        )?.label?.toLowerCase()}{" "}
                        ({sortOrder === "asc" ? "ascending" : "descending"})
                      </span>
                    )}
                  </>
                )}
              </div>

              {hasActiveFilters && (
                <button
                  onClick={resetFilters}
                  className="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded-md text-blue-700 bg-blue-100 hover:bg-blue-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                  disabled={loading}
                >
                  Reset All
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
