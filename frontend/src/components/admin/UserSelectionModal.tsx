import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  XMarkIcon,
  MagnifyingGlassIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "@heroicons/react/24/outline";
import { useAvatarUpdates } from "../../hooks/useAvatarUpdates";
import {
  getAvatarUrlWithCacheBust,
  getAvatarAlt,
} from "../../utils/avatarUtils";
import {
  adminUsersService,
  type AdminUserDTO,
} from "../../services/api";

export interface SelectedUser {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  roleInAtCloud?: string;
  gender: "male" | "female";
  avatar: string | null;
  phone?: string;
}

interface UserSelectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (user: SelectedUser) => void;
  title?: string;
  description?: string;
  // Optional: filter users by role
  allowedRoles?: string[];
  // Optional: exclude specific user IDs
  excludeUserIds?: string[];
}

const USER_ROLES: AdminUserDTO["role"][] = [
  "Super Admin",
  "Administrator",
  "Leader",
  "Guest Expert",
  "Participant",
];

const asUserRole = (value: string | undefined) =>
  value && USER_ROLES.includes(value as AdminUserDTO["role"])
    ? (value as AdminUserDTO["role"])
    : undefined;

export default function UserSelectionModal({
  isOpen,
  onClose,
  onSelect,
  title = "Select User",
  description = "Search and select a user from the list",
  allowedRoles,
  excludeUserIds = [],
}: UserSelectionModalProps) {
  useAvatarUpdates(); // Listen for avatar updates
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<AdminUserDTO[]>([]);
  const [searchPage, setSearchPage] = useState(1);
  const [searchHasNext, setSearchHasNext] = useState(false);
  const [searchTotalPages, setSearchTotalPages] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Paginated user browsing (when no search query)
  const [browsePage, setBrowsePage] = useState(1);
  const [browseUsers, setBrowseUsers] = useState<AdminUserDTO[]>([]);
  const [browseTotalPages, setBrowseTotalPages] = useState(0);
  const [browseTotalUsers, setBrowseTotalUsers] = useState(0);
  const [loadingBrowse, setLoadingBrowse] = useState(false);

  // Admin selection warning modal
  const [showAdminWarning, setShowAdminWarning] = useState(false);
  const [attemptedAdminUser, setAttemptedAdminUser] =
    useState<AdminUserDTO | null>(null);

  const USERS_PER_PAGE = 20;

  // Convert User to SelectedUser format
  const convertUserToSelectedUser = (user: AdminUserDTO): SelectedUser => ({
    id: user.id,
    firstName: user.firstName ?? "",
    lastName: user.lastName ?? "",
    email: user.email,
    role: user.role,
    roleInAtCloud: user.roleInAtCloud ?? undefined,
    gender: user.gender ?? "male",
    avatar: user.avatar,
    phone: user.phone ?? undefined,
  });

  const handleSelectUser = (user: AdminUserDTO) => {
    // Check if user is Administrator or Super Admin
    if (user.role === "Administrator" || user.role === "Super Admin") {
      setAttemptedAdminUser(user);
      setShowAdminWarning(true);
      return;
    }

    const selectedUser = convertUserToSelectedUser(user);
    onSelect(selectedUser);
    handleClose();
  };

  const handleCloseAdminWarning = () => {
    setShowAdminWarning(false);
    setAttemptedAdminUser(null);
  };

  const handleClose = () => {
    setQuery("");
    setSearchResults([]);
    setSearchPage(1);
    setSearchHasNext(false);
    setSearchTotalPages(0);
    setBrowsePage(1);
    setBrowseUsers([]);
    setBrowseTotalPages(0);
    setBrowseTotalUsers(0);
    setLoadingBrowse(false);
    onClose();
  };

  // Focus the search input when opening
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Fetch paginated users when modal opens or page changes (when no search)
  useEffect(() => {
    if (!isOpen || query.trim()) return;

    let cancelled = false;
    const fetchBrowseUsers = async () => {
      setLoadingBrowse(true);
      try {
        const params = {
          page: browsePage,
          limit: USERS_PER_PAGE,
          isActive: true,
          sortBy: "firstName" as const,
          sortOrder: "asc" as const,
          role:
            allowedRoles?.length === 1
              ? asUserRole(allowedRoles[0])
              : undefined,
        };

        const response = await adminUsersService.list(params);
        const users = response.users.filter((user) => {
            if (!user.id) return false;
            // Exclude specified user IDs
            if (excludeUserIds.includes(user.id)) return false;
            // Filter by allowed roles if specified
            if (allowedRoles && allowedRoles.length > 0) {
              return allowedRoles.includes(user.role);
            }
            return true;
          });

        if (!cancelled) {
          setBrowseUsers(users);
          setBrowseTotalPages(response.pagination.totalPages);
          setBrowseTotalUsers(response.pagination.totalUsers);
        }
      } catch (err) {
        console.error("Failed to fetch browse users:", err);
        if (!cancelled) {
          setBrowseUsers([]);
          setBrowseTotalPages(0);
          setBrowseTotalUsers(0);
        }
      } finally {
        if (!cancelled) {
          setLoadingBrowse(false);
        }
      }
    };

    fetchBrowseUsers();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, browsePage, query]);

  // Debounced search effect
  useEffect(() => {
    let cancelled = false;
    const doSearch = async () => {
      if (!query.trim()) {
        setSearchResults([]);
        setSearchHasNext(false);
        setSearchTotalPages(0);
        return;
      }
      setSearching(true);
      try {
        const result = await adminUsersService.list({
          q: query.trim(),
          page: searchPage,
          limit: USERS_PER_PAGE,
          isActive: true,
          sortBy: "firstName",
          sortOrder: "asc",
          role:
            allowedRoles?.length === 1
              ? asUserRole(allowedRoles[0])
              : undefined,
        });
        const users = result.users.filter((user) => {
            if (!user.id) return false;
            // Exclude specified user IDs
            if (excludeUserIds.includes(user.id)) return false;
            // Filter by allowed roles if specified
            if (allowedRoles && allowedRoles.length > 0) {
              return allowedRoles.includes(user.role);
            }
            return true;
          });

        if (!cancelled) {
          setSearchResults(users);
          setSearchHasNext(result.pagination.hasNext);
          setSearchTotalPages(result.pagination.totalPages);
        }
      } catch (err) {
        console.error("Search users failed:", err);
      } finally {
        if (!cancelled) setSearching(false);
      }
    };

    const t = setTimeout(doSearch, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, searchPage]);

  if (!isOpen) return null;

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black bg-opacity-50 z-40"
        onClick={handleClose}
      />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b border-gray-200">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">{title}</h2>
              <p className="text-sm text-gray-600 mt-1">{description}</p>
            </div>
            <button
              onClick={handleClose}
              className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors"
            >
              <XMarkIcon className="h-6 w-6" />
            </button>
          </div>

          {/* Search */}
          <div className="p-4 border-b border-gray-200">
            <div className="relative">
              <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => {
                  setSearchPage(1);
                  setQuery(e.target.value);
                }}
                placeholder="Search by name or email..."
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
              />
            </div>
          </div>

          {/* User List */}
          <div className="flex-1 overflow-y-auto p-4">
            {query && searchResults.length === 0 && !searching ? (
              <div className="text-center py-12">
                <p className="text-gray-500">
                  No users found matching "{query}"
                </p>
              </div>
            ) : !query ? (
              loadingBrowse ? (
                <div className="text-center py-12">
                  <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-purple-600 border-r-transparent"></div>
                  <p className="text-gray-500 mt-4">Loading users...</p>
                </div>
              ) : browseUsers.length === 0 ? (
                <div className="text-center py-12">
                  <p className="text-gray-500">No users available</p>
                  {allowedRoles && allowedRoles.length > 0 && (
                    <p className="text-sm text-gray-400 mt-2">
                      Only {allowedRoles.join(", ")} roles can be selected
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  {browseUsers.map((user) => (
                    <button
                      key={user.id}
                      type="button"
                      onClick={() => handleSelectUser(user)}
                      className="w-full flex items-center space-x-4 p-4 hover:bg-gray-50 rounded-lg transition-colors border border-transparent hover:border-gray-200"
                    >
                      <img
                        src={getAvatarUrlWithCacheBust(
                          user.avatar || null,
                          user.gender ?? "male"
                        )}
                        alt={getAvatarAlt(
                          user.firstName ?? "",
                          user.lastName ?? "",
                          !!user.avatar
                        )}
                        className="h-12 w-12 rounded-full object-cover"
                      />
                      <div className="flex-1 text-left">
                        <div className="font-medium text-gray-900">
                          {user.firstName} {user.lastName}
                        </div>
                        <div className="text-sm text-gray-600">
                          {user.email}
                        </div>
                        <div className="text-sm text-gray-500 mt-1">
                          {user.role}
                          {user.roleInAtCloud && (
                            <span className="ml-2">• {user.roleInAtCloud}</span>
                          )}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )
            ) : (
              <div className="space-y-2">
                {searchResults.map((user) => (
                  <button
                    key={user.id}
                    type="button"
                    onClick={() => handleSelectUser(user)}
                    className="w-full flex items-center space-x-4 p-4 hover:bg-gray-50 rounded-lg transition-colors border border-transparent hover:border-gray-200"
                  >
                    <img
                      src={getAvatarUrlWithCacheBust(
                        user.avatar || null,
                        user.gender ?? "male"
                      )}
                      alt={getAvatarAlt(
                        user.firstName ?? "",
                        user.lastName ?? "",
                        !!user.avatar
                      )}
                      className="h-12 w-12 rounded-full object-cover"
                    />
                    <div className="flex-1 text-left">
                      <div className="font-medium text-gray-900">
                        {user.firstName} {user.lastName}
                      </div>
                      <div className="text-sm text-gray-600">{user.email}</div>
                      <div className="text-sm text-gray-500 mt-1">
                        {user.role}
                        {user.roleInAtCloud && (
                          <span className="ml-2">• {user.roleInAtCloud}</span>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Footer with Pagination */}
          <div className="p-4 border-t border-gray-200">
            {!query && browseTotalUsers > 0 && (
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm text-gray-600">
                  Showing{" "}
                  {Math.min(
                    (browsePage - 1) * USERS_PER_PAGE + 1,
                    browseTotalUsers
                  )}{" "}
                  - {Math.min(browsePage * USERS_PER_PAGE, browseTotalUsers)} of{" "}
                  {browseTotalUsers} users
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setBrowsePage((p) => Math.max(1, p - 1))}
                    disabled={browsePage === 1}
                    className="p-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Previous page"
                  >
                    <ChevronLeftIcon className="h-5 w-5" />
                  </button>
                  <span className="text-sm text-gray-700 px-2">
                    Page {browsePage} of {browseTotalPages}
                  </span>
                  <button
                    onClick={() =>
                      setBrowsePage((p) => Math.min(browseTotalPages, p + 1))
                    }
                    disabled={browsePage >= browseTotalPages}
                    className="p-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Next page"
                  >
                    <ChevronRightIcon className="h-5 w-5" />
                  </button>
                </div>
              </div>
            )}
            {query && searchResults.length > 0 && (
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm text-gray-600">
                  {searchResults.length} search result
                  {searchResults.length !== 1 ? "s" : ""}
                </div>
                {searchTotalPages > 1 && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setSearchPage((p) => Math.max(1, p - 1))}
                      disabled={searchPage === 1}
                      className="p-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Previous page"
                    >
                      <ChevronLeftIcon className="h-5 w-5" />
                    </button>
                    <span className="text-sm text-gray-700 px-2">
                      Page {searchPage} of {searchTotalPages}
                    </span>
                    <button
                      onClick={() =>
                        setSearchPage((p) => Math.min(searchTotalPages, p + 1))
                      }
                      disabled={
                        searchPage >= searchTotalPages || !searchHasNext
                      }
                      className="p-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Next page"
                    >
                      <ChevronRightIcon className="h-5 w-5" />
                    </button>
                  </div>
                )}
              </div>
            )}
            <div className="flex justify-end">
              <button
                onClick={handleClose}
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Admin Warning Modal */}
      {showAdminWarning && attemptedAdminUser && (
        <>
          {/* Backdrop for warning modal */}
          <div
            className="fixed inset-0 bg-black bg-opacity-50 z-[60]"
            onClick={handleCloseAdminWarning}
          />

          {/* Warning Modal */}
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
            <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
              {/* Icon */}
              <div className="flex items-center justify-center w-12 h-12 mx-auto bg-yellow-100 rounded-full mb-4">
                <svg
                  className="h-6 w-6 text-yellow-600"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  />
                </svg>
              </div>

              {/* Title */}
              <h3 className="text-lg font-semibold text-gray-900 text-center mb-2">
                Admin User Selected
              </h3>

              {/* Message */}
              <div className="text-sm text-gray-600 text-center mb-6">
                <p className="mb-3">
                  <strong>
                    {attemptedAdminUser.firstName} {attemptedAdminUser.lastName}
                  </strong>{" "}
                  is a <strong>{attemptedAdminUser.role}</strong>.
                </p>
                <p>
                  Admin users already have full access to all programs. Promo
                  codes are not needed for Administrator or Super Admin users.
                </p>
              </div>

              {/* Action Button */}
              <div className="flex justify-center">
                <button
                  onClick={handleCloseAdminWarning}
                  className="px-6 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
                >
                  OK, Choose Another User
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>,
    document.body
  );
}
