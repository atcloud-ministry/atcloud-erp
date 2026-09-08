import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useAvatarUpdates } from "../../hooks/useAvatarUpdates";
import {
  getAvatarUrlWithCacheBust,
  getAvatarAlt,
} from "../../utils/avatarUtils";
import {
  userOptionsService,
  type UserOptionContext,
  type UserPickerDTO,
} from "../../services/api";

export interface Organizer {
  id: string; // UUID to match User interface
  firstName: string;
  lastName: string;
  systemAuthorizationLevel: string;
  roleInAtCloud?: string;
  gender: "male" | "female";
  avatar: string | null;
}

interface OrganizerSelectionProps {
  // The primary organizer of the event (creator/owner)
  mainOrganizer: Organizer;
  // Co-organizers (ordered list)
  selectedOrganizers: Organizer[];
  // For showing (You) tag when appropriate
  currentUserId?: string;
  onOrganizersChange: (organizers: Organizer[]) => void;
  // Optional: hide the main organizer display (useful for mentor selection)
  hideMainOrganizer?: boolean;
  // Optional: custom label for the organizers section
  organizersLabel?: string;
  // Optional: custom button text
  buttonText?: string;
  // Optional: whether to exclude the main organizer from selectable list (default true)
  excludeMainOrganizer?: boolean;
  context?: Extract<UserOptionContext, "event-organizer" | "program-mentor">;
  resourceId?: string;
}

export default function OrganizerSelection({
  mainOrganizer,
  selectedOrganizers,
  currentUserId,
  onOrganizersChange,
  hideMainOrganizer = false,
  organizersLabel = "Co-organizers",
  buttonText = "Add Co-organizer",
  excludeMainOrganizer = true,
  context = "event-organizer",
  resourceId,
}: OrganizerSelectionProps) {
  useAvatarUpdates(); // Listen for avatar updates
  const [showUserList, setShowUserList] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<UserPickerDTO[]>([]);
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [allAuthorized, setAllAuthorized] = useState<UserPickerDTO[]>([]);
  const [loadingAll, setLoadingAll] = useState(false);

  // Convert User to Organizer format
  const convertUserToOrganizer = (user: UserPickerDTO): Organizer => ({
    id: user.id,
    firstName: user.firstName ?? "",
    lastName: user.lastName ?? "",
    systemAuthorizationLevel: user.role,
    roleInAtCloud: user.roleInAtCloud ?? undefined,
    gender: user.gender ?? "male",
    avatar: user.avatar,
  });

  // Available users for co-organizer selection
  // Excludes: main organizer, already selected organizers, and participants
  // Only Super Admin, Administrator, and Leader roles can be co-organizers
  const allowedRolesList = useMemo(
    () => ["Super Admin", "Administrator", "Leader"] as const,
    []
  );

  const baseFilter = useCallback(
    (user: UserPickerDTO) => {
      const userId = user.id.trim();
      return (
        Boolean(userId) &&
        (excludeMainOrganizer ? userId !== mainOrganizer.id : true) &&
        !selectedOrganizers.some((org) => org.id === userId) &&
        // Only allow specific roles
        (allowedRolesList as readonly string[]).includes(user.role)
      );
    },
    [
      excludeMainOrganizer,
      mainOrganizer.id,
      selectedOrganizers,
      allowedRolesList,
    ]
  );

  const handleAddOrganizer = (user: UserPickerDTO) => {
    const newOrganizer = convertUserToOrganizer(user);
    if (!newOrganizer.id.trim()) return;
    onOrganizersChange([...selectedOrganizers, newOrganizer]);
    setShowUserList(false);
  };

  const handleRemoveOrganizer = (organizerId: string) => {
    onOrganizersChange(
      selectedOrganizers.filter((org) => org.id !== organizerId)
    );
  };

  // Focus the search input when opening
  useEffect(() => {
    if (showUserList) {
      setTimeout(() => inputRef.current?.focus(), 0);
    } else {
      // Reset search state when closing
      setQuery("");
      setSearchResults([]);
      setPage(1);
      setHasNext(false);
      setSearching(false);
      setAllAuthorized([]);
      setLoadingAll(false);
    }
  }, [showUserList]);

  // When opening the list with empty query, load all authorized users across pages
  useEffect(() => {
    let cancelled = false;
    const fetchAllAuthorized = async () => {
      if (!showUserList || query.trim()) return;
      setLoadingAll(true);
      try {
        const acc: Record<string, UserPickerDTO> = {};
        let nextPage = 1;
        for (;;) {
          const response = await userOptionsService.list({
            context,
            resourceId,
            page: nextPage,
            limit: 100,
          });
          for (const option of response.options.filter(baseFilter)) {
            acc[option.id] = option;
          }
          if (!response.pagination.hasNext) break;
          nextPage += 1;
        }
        if (!cancelled) {
          const combined = Object.values(acc).sort((a, b) =>
            `${a.firstName} ${a.lastName}`.localeCompare(
              `${b.firstName} ${b.lastName}`
            )
          );
          setAllAuthorized(combined);
        }
      } catch (e) {
        console.error("Failed to load all authorized users:", e);
        if (!cancelled) {
          setAllAuthorized([]);
        }
      } finally {
        if (!cancelled) setLoadingAll(false);
      }
    };
    fetchAllAuthorized();
    return () => {
      cancelled = true;
    };
  }, [baseFilter, context, query, resourceId, showUserList]);

  // Debounced search effect
  useEffect(() => {
    let cancelled = false;
    const doSearch = async () => {
      if (!query.trim()) {
        setSearchResults([]);
        setHasNext(false);
        setSearching(false);
        return;
      }
      setSearching(true);
      try {
        const result = await userOptionsService.list({
          context,
          resourceId,
          q: query.trim(),
          page,
          limit: 100,
        });
        const converted = result.options.filter(baseFilter);

        // If first page, replace; otherwise, append unique by id
        if (!cancelled) {
          setSearchResults((prev) => {
            if (page === 1) return converted;
            const seen = new Set(prev.map((u) => u.id));
            const merged = [...prev];
            for (const u of converted) if (!seen.has(u.id)) merged.push(u);
            return merged;
          });

          setHasNext(result.pagination.hasNext);
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
  }, [baseFilter, context, page, query, resourceId]);

  const OrganizerCard = ({
    organizer,
    isMain = false,
    onRemove,
  }: {
    organizer: Organizer;
    isMain?: boolean;
    onRemove?: () => void;
  }) => (
    <div className="flex items-center space-x-3 p-4 bg-gray-50 rounded-lg border">
      {/* Avatar */}
      <img
        src={getAvatarUrlWithCacheBust(organizer.avatar, organizer.gender)}
        alt={getAvatarAlt(
          organizer.firstName,
          organizer.lastName,
          !!organizer.avatar
        )}
        className="h-12 w-12 rounded-full object-cover"
      />

      {/* User Info */}
      <div className="flex-1">
        <div className="font-medium text-gray-900">
          {organizer.firstName} {organizer.lastName}
          {currentUserId && organizer.id === currentUserId && (
            <span className="ml-2 text-sm text-blue-600 font-normal">
              (You)
            </span>
          )}
        </div>
        <div className="text-sm text-gray-600">
          {organizer.systemAuthorizationLevel}
          {organizer.roleInAtCloud && (
            <span className="ml-2 text-gray-500">
              • {organizer.roleInAtCloud}
            </span>
          )}
        </div>
      </div>

      {/* Remove Button */}
      {!isMain && onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="p-1 text-gray-400 hover:text-red-500 transition-colors"
          title="Remove"
        >
          <XMarkIcon className="h-5 w-5" />
        </button>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Only show "Organizer" label if main organizer is visible */}
      {!hideMainOrganizer && (
        <div className="block text-sm font-medium text-gray-700">Organizer</div>
      )}

      {/* Main Organizer (immutable) - conditionally hidden */}
      {!hideMainOrganizer && <OrganizerCard organizer={mainOrganizer} isMain />}

      {/* Co-organizers */}
      <div className="block text-sm font-medium text-gray-700">
        {organizersLabel}
      </div>
      {selectedOrganizers.map((organizer) => (
        <OrganizerCard
          key={organizer.id}
          organizer={organizer}
          onRemove={() => handleRemoveOrganizer(organizer.id)}
        />
      ))}

      {/* Add Organizer Button */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setShowUserList(!showUserList)}
          className="flex items-center space-x-2 px-4 py-2 border border-dashed border-gray-300 rounded-lg text-gray-600 hover:text-gray-800 hover:border-gray-400 transition-colors w-full justify-center"
        >
          <PlusIcon className="h-5 w-5" />
          <span>{buttonText}</span>
        </button>

        {/* User Selection Dropdown */}
        {showUserList && (
          <div className="absolute top-full left-0 right-0 mt-2 bg-white border border-gray-200 rounded-lg shadow-lg z-10 max-h-60 overflow-y-auto">
            {/* Search input */}
            <div className="sticky top-0 bg-white p-2 border-b border-gray-100">
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => {
                  setPage(1);
                  setQuery(e.target.value);
                }}
                placeholder="Search by name or username"
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                aria-label="Search users"
              />
            </div>
            {query && searchResults.length === 0 && !searching ? (
              <div className="p-4 text-center text-gray-500">
                No matches found
              </div>
            ) : null}
            {!query ? (
              loadingAll ? (
                <div className="p-4 text-center text-gray-500">
                  Loading authorized users…
                </div>
              ) : allAuthorized.length === 0 ? (
                <div className="p-4 text-center text-gray-500">
                  No additional organizers available
                  <div className="text-xs mt-1">
                    Only Super Admin, Administrator, and Leader roles can be
                    co-organizers
                  </div>
                </div>
              ) : (
                <div className="p-2">
                  {allAuthorized.map((user) => (
                    <button
                      key={user.id}
                      type="button"
                      onClick={() => handleAddOrganizer(user)}
                      className="w-full flex items-center space-x-3 p-3 hover:bg-gray-50 rounded-md transition-colors"
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
                        className="h-8 w-8 rounded-full object-cover"
                      />
                      <div className="flex-1 text-left">
                        <div className="font-medium text-gray-900">
                          {user.firstName} {user.lastName}
                        </div>
                        <div className="text-sm text-gray-600">
                          {user.role}
                          {user.roleInAtCloud && (
                            <span className="ml-2 text-gray-500">
                              • {user.roleInAtCloud}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )
            ) : (
              <div className="p-2">
                {searchResults.map((user) => (
                  <button
                    key={user.id}
                    type="button"
                    onClick={() => handleAddOrganizer(user)}
                    className="w-full flex items-center space-x-3 p-3 hover:bg-gray-50 rounded-md transition-colors"
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
                      className="h-8 w-8 rounded-full object-cover"
                    />
                    <div className="flex-1 text-left">
                      <div className="font-medium text-gray-900">
                        {user.firstName} {user.lastName}
                      </div>
                      <div className="text-sm text-gray-600">
                        {user.role}
                        {user.roleInAtCloud && (
                          <span className="ml-2 text-gray-500">
                            • {user.roleInAtCloud}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
                {hasNext && (
                  <div className="p-2">
                    <button
                      type="button"
                      className="w-full px-3 py-2 text-sm border rounded-md hover:bg-gray-50"
                      onClick={() => setPage((p) => p + 1)}
                      disabled={searching}
                    >
                      {searching ? "Loading..." : "Load more"}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Close dropdown when clicking outside */}
      {showUserList && (
        <div
          className="fixed inset-0 z-0"
          onClick={() => setShowUserList(false)}
        />
      )}
    </div>
  );
}
