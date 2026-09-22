import { useCallback, useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import type { EventRole, OrganizerDetail } from "../../types/event";
import {
  getAvatarUrlWithCacheBust,
  getAvatarAlt,
} from "../../utils/avatarUtils";
import { Icon } from "../common";
import NameCardActionModal from "../common/NameCardActionModal";
import NotificationPromptModal from "../common/NotificationPromptModal";
import { canSeeGuestContactInSlot } from "../../utils/guestPrivacy";
import { ChevronDownIcon } from "@heroicons/react/24/outline";
import {
  eventService,
  userOptionsService,
  type UserPickerDTO,
} from "../../services/api";

// Lightweight inline editor for per-role agenda (admins/organizers only)
function RoleAgendaEditor({
  role,
  eventId,
  organizerDetails,
  editing,
  setEditing,
  canEdit,
}: {
  role: EventRole;
  eventId?: string;
  organizerDetails?: OrganizerDetail[];
  editing: boolean;
  setEditing: (v: boolean) => void;
  canEdit: boolean;
}) {
  const [value, setValue] = useState<string>(role.agenda || "");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Keep local value in sync if role changes from outside
  useEffect(() => {
    setValue(role.agenda || "");
  }, [role.agenda]);

  const save = async () => {
    if (!eventId) return; // cannot save without event ID
    try {
      setSaving(true);
      setError(null);
      // Get latest event to avoid clobbering roles
      const fresh = await eventService.getEvent(eventId);
      const nextRoles = (fresh.roles || []).map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        maxParticipants: r.maxParticipants,
        startTime: r.startTime,
        endTime: r.endTime,
        agenda: r.id === role.id ? value.trim() || undefined : r.agenda,
      }));
      await eventService.updateEvent(eventId, {
        roles: nextRoles as unknown as Record<string, unknown>[],
        organizerDetails: fresh.organizerDetails || organizerDetails || [],
        suppressNotifications: true,
      });
      setSavedAt(Date.now());
      setEditing(false);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to save agenda";
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  // View mode (no edit): show text only for privileged users and non-privileged alike; hide empty placeholder
  if (!editing) {
    const hasText = (value || "").trim() !== "";
    return (
      <div>
        {hasText ? (
          <div className="bg-gray-50 p-2 rounded whitespace-pre-line text-sm text-gray-700">
            {value}
          </div>
        ) : (
          // No explicit placeholder text per request
          <div />
        )}
        <div className="mt-1 flex items-center gap-2 text-xs">
          {saving && <span className="text-gray-500">Saving…</span>}
          {!saving && savedAt && <span className="text-green-600">Saved</span>}
          {error && <span className="text-red-600">{error}</span>}
        </div>
      </div>
    );
  }

  // Edit mode: show textarea with Save/Cancel
  return (
    <div>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Add role timing for this role…"
        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
        rows={3}
        disabled={!eventId || !canEdit}
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={save}
          disabled={saving || !eventId}
          className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-300 disabled:text-gray-600"
        >
          Save
        </button>
        <button
          onClick={() => {
            setValue(role.agenda || "");
            setEditing(false);
          }}
          disabled={saving}
          className="px-3 py-1.5 text-sm rounded-md bg-gray-100 text-gray-800 hover:bg-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
        >
          Cancel
        </button>
        <div className="ml-2 flex items-center gap-2 text-xs">
          {saving && <span className="text-gray-500">Saving…</span>}
          {!saving && savedAt && <span className="text-green-600">Saved</span>}
          {error && <span className="text-red-600">{error}</span>}
        </div>
      </div>
    </div>
  );
}

interface EventRoleSignupProps {
  role: EventRole;
  onSignup: (roleId: string, notes?: string) => void;
  onCancel: (roleId: string) => void;
  currentUserId: string;
  currentUserRole:
    | "Super Admin"
    | "Administrator"
    | "Leader"
    | "Guest Expert"
    | "Participant";
  isUserSignedUpForThisRole: boolean;
  hasReachedMaxRoles: boolean;
  maxRolesForUser: number;
  isRoleAllowedForUser: boolean;
  // eventType, viewerGroupLetters, viewerGroupLetter: REMOVED - no longer needed after removing group-based visibility
  eventId?: string;
  // New props for organizer assignment
  isOrganizer?: boolean;
  onAssignUser?: (
    roleId: string,
    userId: string,
    sendNotifications?: boolean,
  ) => void;
  // Guests count for this role (admin-only visibility); used to include in capacity
  guestCount?: number;
  // Optional guest list for this role to render inside slots (admin-only visibility)
  guestList?: Array<{
    id?: string;
    fullName: string;
    email?: string;
    phone?: string;
    notes?: string;
  }>;
  // Organizer contacts snapshot used by updateEvent payload contract
  organizerDetails?: OrganizerDetail[];
  // Phase 6: Paid events - indicates if event requires purchase (for role access control, not UI hiding)
  requiresPurchase?: boolean;
}

export default function EventRoleSignup({
  role,
  onSignup,
  onCancel,
  currentUserId,
  currentUserRole,
  isUserSignedUpForThisRole,
  hasReachedMaxRoles,
  maxRolesForUser,
  isRoleAllowedForUser,
  eventId,
  isOrganizer = false,
  onAssignUser,
  guestCount = 0,
  guestList = [],
  organizerDetails: _organizerDetails,
  requiresPurchase: _requiresPurchase = false,
}: EventRoleSignupProps) {
  const navigate = useNavigate();
  const [showSignupForm, setShowSignupForm] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [notes, setNotes] = useState("");
  // Agenda editor state
  const [editingAgenda, setEditingAgenda] = useState(false);
  // Assign modal state
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [userQuery, setUserQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<UserPickerDTO[]>([]);
  const [assignError, setAssignError] = useState<string | null>(null);
  const assignRequestIdRef = useRef(0);
  const [pagination, setPagination] = useState({
    currentPage: 1,
    totalPages: 0,
    totalUsers: 0,
    hasNext: false,
    hasPrev: false,
  });

  // Name card action modal state
  const [nameCardModal, setNameCardModal] = useState<{
    isOpen: boolean;
    userId: string;
    userName: string;
    userRole?: string;
  }>({
    isOpen: false,
    userId: "",
    userName: "",
    userRole: "",
  });

  // Dropdown state for consolidated Sign Up button
  const [showSignUpDropdown, setShowSignUpDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Notification prompt modal state
  const [notificationPrompt, setNotificationPrompt] = useState<{
    isOpen: boolean;
    userId: string;
    userName: string;
  }>({
    isOpen: false,
    userId: "",
    userName: "",
  });

  const totalSignups = role.currentSignups.length + (guestCount || 0);
  const availableSpots = role.maxParticipants - totalSignups;
  const isFull = availableSpots <= 0;
  const isAdminViewer =
    currentUserRole === "Super Admin" || currentUserRole === "Administrator";
  // Organizer-like viewers (Organizer, Co-organizers) are passed via isOrganizer
  const isOrganizerViewer = !!isOrganizer;
  const canEditAgenda = isAdminViewer || isOrganizerViewer;

  // Simplified contact visibility: show to all logged-in users
  const canSeeGuestContactInThisSlot = canSeeGuestContactInSlot({
    isAdminViewer,
    isOrganizerViewer,
  });

  // Check if current user can navigate to other user profiles
  const canNavigateToProfiles =
    currentUserRole === "Super Admin" ||
    currentUserRole === "Administrator" ||
    currentUserRole === "Leader";

  // Get the correct profile link (matching Management page logic)
  const getProfileLink = (userId: string) => {
    return userId === currentUserId
      ? "/dashboard/profile" // Own profile page (editable)
      : `/dashboard/profile/${userId}`; // View-only profile page
  };

  // Handle name card click for authorized users
  const handleNameCardClick = (
    userId: string,
    userName?: string,
    userRole?: string,
  ) => {
    // If clicking on self, always allow navigation to own profile
    if (userId === currentUserId) {
      navigate(getProfileLink(userId));
      return;
    }

    // Open action modal for other users
    setNameCardModal({
      isOpen: true,
      userId,
      userName: userName || "Unknown User",
      userRole: userRole || "",
    });
  };

  const handleSignup = () => {
    onSignup(role.id, notes);
    setShowSignupForm(false);
    setNotes("");
  };

  const handleCancel = () => {
    onCancel(role.id);
    setShowCancelConfirm(false);
  };

  const handleCancelClick = () => {
    setShowCancelConfirm(true);
  };

  // Function to fetch users with pagination and search
  const fetchUsers = useCallback(async (
    page: number = 1,
    searchQuery: string = "",
  ) => {
    const requestId = ++assignRequestIdRef.current;
    try {
      setAssignError(null);
      setIsSearching(true);
      if (!eventId) {
        throw new Error("This event is unavailable for user assignment.");
      }

      const result = await userOptionsService.list({
        context: "event-role-assignee",
        resourceId: eventId,
        q: searchQuery.trim() || undefined,
        page,
        limit: 20,
      });
      if (requestId !== assignRequestIdRef.current) return;
      setSearchResults(result.options);
      setPagination({
        currentPage: result.pagination.currentPage,
        totalPages: result.pagination.totalPages,
        totalUsers: result.pagination.totalOptions,
        hasNext: result.pagination.hasNext,
        hasPrev: result.pagination.hasPrev,
      });
    } catch (e: unknown) {
      if (requestId !== assignRequestIdRef.current) return;
      const message = e instanceof Error ? e.message : "Search failed";
      setAssignError(message);
      setSearchResults([]);
      setPagination({
        currentPage: 1,
        totalPages: 0,
        totalUsers: 0,
        hasNext: false,
        hasPrev: false,
      });
    } finally {
      if (requestId === assignRequestIdRef.current) {
        setIsSearching(false);
      }
    }
  }, [eventId]);

  // Load users when modal opens or search query changes
  useEffect(() => {
    if (!showAssignModal) return;

    let active = true;
    const handler = setTimeout(async () => {
      if (active) {
        await fetchUsers(1, userQuery);
      }
    }, 300);
    return () => {
      active = false;
      clearTimeout(handler);
      assignRequestIdRef.current += 1;
      setIsSearching(false);
    };
  }, [fetchUsers, userQuery, showAssignModal]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setShowSignUpDropdown(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  return (
    <div className="border rounded-lg p-4 bg-white">
      {/* Role Name Header */}
      <div className="mb-4">
        <h3 className="text-xl font-semibold text-gray-900 text-center">
          {role.name}
        </h3>
      </div>

      {/* 3-Column Layout */}
      <div className="grid grid-cols-1 md:grid-cols-[0.9fr_1.8fr_1.3fr] gap-3 mb-4">
        {/* Column 1: Agenda (Times) - ~22% width (0.9fr) */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium text-gray-700">Agenda</h4>
            {canEditAgenda && !editingAgenda && (
              <button
                onClick={() => setEditingAgenda(true)}
                className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-100"
              >
                Edit
              </button>
            )}
          </div>
          <div className="text-sm text-gray-600 space-y-2">
            {/* Agenda editor just below the heading */}
            <RoleAgendaEditor
              role={role}
              eventId={eventId}
              organizerDetails={_organizerDetails}
              editing={canEditAgenda && editingAgenda}
              setEditing={setEditingAgenda}
              canEdit={canEditAgenda}
            />

            {/* Time window view (no fallback text when empty) */}
            {(role.startTime || role.endTime) && (
              <div className="bg-gray-50 p-2 rounded">
                {role.startTime && role.endTime ? (
                  <>
                    <div className="font-medium">Time Slot:</div>
                    <div>
                      {role.startTime} - {role.endTime}
                    </div>
                  </>
                ) : role.startTime ? (
                  <>
                    <div className="font-medium">Start Time:</div>
                    <div>{role.startTime}</div>
                  </>
                ) : (
                  <>
                    <div className="font-medium">End Time:</div>
                    <div>{role.endTime}</div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Column 2: Description - ~45% width (1.8fr) */}
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-gray-700">Description</h4>
          <div className="text-sm text-gray-600 bg-gray-50 p-2 rounded whitespace-pre-line">
            {role.description}
          </div>
        </div>

        {/* Column 3: Actions & Capacity - ~33% width (1.3fr) */}
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-gray-700">Actions</h4>
          <div className="space-y-3">
            {/* Capacity Display */}
            <div className="bg-gray-50 p-2 rounded text-center">
              <div className="text-sm font-medium text-gray-700">
                {totalSignups} / {role.maxParticipants}
              </div>
              {isAdminViewer && (guestCount || 0) > 0 && (
                <div className="text-[11px] text-gray-500">includes guests</div>
              )}
              {!isFull && (
                <div className="text-xs text-green-600">
                  {availableSpots} spot{availableSpots !== 1 ? "s" : ""}{" "}
                  available
                </div>
              )}
            </div>

            {/* Sign-up Action Button */}
            <div>
              {isFull ? (
                <div className="bg-red-50 border border-red-200 rounded-md p-2 text-center">
                  <p className="text-xs text-red-700">Full</p>
                </div>
              ) : (
                <>
                  {/* Informative notices only for users not yet signed up */}
                  {!isUserSignedUpForThisRole && hasReachedMaxRoles && (
                    <div className="bg-amber-50 border border-amber-200 rounded-md p-2 text-center">
                      <p className="text-xs text-amber-700">
                        You have reached your limit of {maxRolesForUser}{" "}
                        {maxRolesForUser === 1 ? "role" : "roles"}.
                      </p>
                    </div>
                  )}
                  {!isUserSignedUpForThisRole &&
                    !hasReachedMaxRoles &&
                    !isRoleAllowedForUser && (
                      <div className="bg-gray-50 border border-gray-200 rounded-md p-2 text-center">
                        <p className="text-xs text-gray-700">Co-Workers only</p>
                      </div>
                    )}

                  {(isUserSignedUpForThisRole ||
                    (isRoleAllowedForUser && !hasReachedMaxRoles) ||
                    isOrganizer) && (
                    <div className="relative" ref={dropdownRef}>
                      <button
                        onClick={() =>
                          setShowSignUpDropdown(!showSignUpDropdown)
                        }
                        className="w-full max-w-full bg-blue-600 text-white py-2 px-2 rounded-md hover:bg-blue-700 transition-colors flex items-center justify-center gap-1 text-sm overflow-hidden"
                      >
                        Sign Up
                        <ChevronDownIcon className="w-4 h-4" />
                      </button>

                      {/* Dropdown Menu */}
                      {showSignUpDropdown && (
                        <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-md shadow-lg border border-gray-200 z-50">
                          <div className="py-1">
                            {/* Only show 'Sign Up Myself' when not already signed up, allowed, and below max roles */}
                            {!isUserSignedUpForThisRole &&
                              isRoleAllowedForUser &&
                              !hasReachedMaxRoles && (
                                <button
                                  onClick={() => {
                                    setShowSignupForm(true);
                                    setShowSignUpDropdown(false);
                                  }}
                                  className="w-full text-left px-2 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                                >
                                  Sign Up Myself
                                </button>
                              )}
                            {/* Assign User - available for organizers */}
                            {isOrganizer && onAssignUser && (
                              <button
                                onClick={() => {
                                  setShowAssignModal(true);
                                  setShowSignUpDropdown(false);
                                }}
                                className="w-full text-left px-2 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                              >
                                Assign User
                              </button>
                            )}
                            {/* Invite Guest - available for users who can sign up for the role */}
                            {isRoleAllowedForUser && (
                              <button
                                onClick={() => {
                                  if (isFull) return;
                                  if (eventId) {
                                    navigate(
                                      `/guest-register/${eventId}?roleId=${role.id}`,
                                    );
                                  } else {
                                    // Guest dashboard deprecated; redirect to public events list
                                    navigate(`/events`);
                                  }
                                  setShowSignUpDropdown(false);
                                }}
                                disabled={isFull}
                                className={`w-full text-left px-2 py-2 text-sm transition-colors ${
                                  isFull
                                    ? "text-gray-400 cursor-not-allowed"
                                    : "text-gray-700 hover:bg-gray-50"
                                }`}
                                title={
                                  isFull
                                    ? "Role is full (includes guests)"
                                    : undefined
                                }
                              >
                                Invite Guest
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* User Already Signed Up Status */}
      {isUserSignedUpForThisRole && (
        <div className="mb-4 bg-green-50 border border-green-200 rounded-lg p-3">
          {!showCancelConfirm ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm text-green-700">
                  ✓ You are already signed up for this role.
                </p>
                <button
                  onClick={handleCancelClick}
                  className="text-sm text-red-600 hover:text-red-800 hover:underline transition-colors"
                >
                  Cancel Signup
                </button>
              </div>
              {(() => {
                const currentUserSignup = role.currentSignups.find(
                  (signup) => signup.userId === currentUserId,
                );
                return (
                  currentUserSignup?.notes && (
                    <div className="text-xs text-green-600 bg-green-100 px-2 py-1 rounded">
                      <span className="font-medium">Your note:</span>{" "}
                      {currentUserSignup.notes}
                    </div>
                  )
                );
              })()}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-amber-700">
                Are you sure you want to cancel your signup for this role?
              </p>
              <div className="flex space-x-3">
                <button
                  onClick={handleCancel}
                  className="flex-1 bg-red-600 text-white py-2 px-3 rounded-md hover:bg-red-700 transition-colors text-sm"
                >
                  Yes, Cancel
                </button>
                <button
                  onClick={() => setShowCancelConfirm(false)}
                  className="flex-1 bg-gray-300 text-gray-700 py-2 px-3 rounded-md hover:bg-gray-400 transition-colors text-sm"
                >
                  Keep Signup
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Signup Form for Users */}
      {!isUserSignedUpForThisRole && showSignupForm && (
        <div className="mb-4 bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="space-y-3">
            <div>
              <label
                htmlFor="signup-notes"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Notes (optional)
              </label>
              <textarea
                id="signup-notes"
                name="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                rows={3}
                placeholder="Any additional notes or comments..."
              />
            </div>
            <div className="flex space-x-3">
              <button
                onClick={handleSignup}
                className="flex-1 bg-green-600 text-white py-2 px-4 rounded-md hover:bg-green-700 transition-colors"
              >
                Confirm Signup
              </button>
              <button
                onClick={() => setShowSignupForm(false)}
                className="flex-1 bg-gray-300 text-gray-700 py-2 px-4 rounded-md hover:bg-gray-400 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Current Signups */}
      {role.currentSignups.length > 0 && (
        <div className="mb-3">
          <h4 className="text-sm font-medium text-gray-700 mb-2">
            Current Signups:
          </h4>
          <div className="space-y-2">
            {role.currentSignups.map((participant) => {
              const isClickable =
                canNavigateToProfiles && participant.userId !== currentUserId;

              // Simplified: show contact to all logged-in users
              const showContact = canSeeGuestContactInSlot({
                isAdminViewer,
                isOrganizerViewer,
              });

              // Ensure the current viewer sees their correct System Authorization Level
              // even if the backend payload omits it or defaults to "Participant".
              const displaySystemLevel =
                participant.userId === currentUserId &&
                currentUserRole !== "Participant" &&
                (!participant.systemAuthorizationLevel ||
                  participant.systemAuthorizationLevel === "Participant")
                  ? currentUserRole
                  : participant.systemAuthorizationLevel;

              return (
                <div
                  key={participant.userId}
                  className={`flex items-start space-x-3 ${
                    isClickable
                      ? "cursor-pointer hover:bg-gray-50 rounded-md p-2 -m-2 transition-colors"
                      : ""
                  }`}
                  onClick={() =>
                    handleNameCardClick(
                      participant.userId,
                      `${participant.firstName} ${participant.lastName}`,
                      participant.roleInAtCloud,
                    )
                  }
                  title={
                    isClickable
                      ? `View ${participant.firstName} ${participant.lastName}'s profile`
                      : undefined
                  }
                >
                  <img
                    src={getAvatarUrlWithCacheBust(
                      participant.avatar || null,
                      participant.gender || "male",
                    )}
                    alt={getAvatarAlt(
                      participant.firstName || "",
                      participant.lastName || "",
                      !!participant.avatar,
                    )}
                    className="w-8 h-8 rounded-full object-cover flex-shrink-0 mt-1"
                  />
                  <div className="flex-grow">
                    <div className="text-sm font-medium text-gray-900">
                      {participant.firstName} {participant.lastName}
                      {participant.userId === currentUserId && (
                        <span className="ml-2 text-xs text-blue-600 font-normal">
                          (You)
                        </span>
                      )}
                    </div>
                    {/* Display both system authorization level and role in @Cloud */}
                    <div className="text-xs text-gray-500 space-y-0.5">
                      {displaySystemLevel && (
                        <div>
                          System Authorization Level: {displaySystemLevel}
                        </div>
                      )}
                      {participant.roleInAtCloud && (
                        <div>Role in @Cloud: {participant.roleInAtCloud}</div>
                      )}
                    </div>
                    {participant.notes && (
                      <div className="text-xs text-gray-600 bg-gray-50 px-2 py-1 rounded mt-1">
                        <span className="font-medium">Note:</span>{" "}
                        {participant.notes}
                      </div>
                    )}
                    {showContact && (
                      <div className="mt-2 text-xs text-gray-600 space-y-1">
                        {participant.email && (
                          <div className="flex items-center gap-2">
                            <Icon
                              name="envelope"
                              className="w-3 h-3 text-gray-500"
                            />
                            <a
                              className="text-blue-600 hover:underline"
                              href={`mailto:${participant.email}`}
                            >
                              {participant.email}
                            </a>
                          </div>
                        )}
                        {participant.phone &&
                          participant.phone.trim() !== "" && (
                            <div className="flex items-center gap-2">
                              <Icon
                                name="phone"
                                className="w-3 h-3 text-gray-500"
                              />
                              <a
                                className="text-blue-600 hover:underline"
                                href={`tel:${participant.phone}`}
                              >
                                {participant.phone}
                              </a>
                            </div>
                          )}
                      </div>
                    )}
                  </div>
                  {/* Contact info moved under avatar/info block above */}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Guests inside slots (visible to all; contact details admin-only) */}
      {(guestList?.length || 0) > 0 && (
        <div
          className="mb-3 space-y-2"
          data-testid={`in-slot-guests-${role.id}`}
        >
          {guestList.map((g, idx) => (
            <div
              key={g.id || idx}
              className="flex items-start space-x-3 hover:bg-gray-50 rounded-md p-2 -m-2 transition-colors"
              title="Guest registration"
              data-testid={`in-slot-guest-${g.id || idx}`}
            >
              <div className="w-8 h-8 rounded-full bg-amber-200 text-amber-800 flex items-center justify-center text-xs mt-1 flex-shrink-0">
                G
              </div>
              <div className="flex-grow">
                <div className="text-sm font-medium text-gray-900">
                  Guest: {g.fullName}
                </div>
                <div className="text-xs text-gray-500 space-y-0.5">
                  {canSeeGuestContactInThisSlot && g.email && (
                    <div className="flex items-center gap-2">
                      <Icon name="envelope" className="w-3 h-3 text-gray-500" />
                      <a
                        className="text-blue-600 hover:underline"
                        href={`mailto:${g.email}`}
                      >
                        {g.email}
                      </a>
                    </div>
                  )}
                  {canSeeGuestContactInThisSlot &&
                    g.phone &&
                    g.phone.trim() !== "" && (
                      <div className="flex items-center gap-2">
                        <Icon name="phone" className="w-3 h-3 text-gray-500" />
                        <a
                          className="text-blue-600 hover:underline"
                          href={`tel:${g.phone}`}
                        >
                          {g.phone}
                        </a>
                      </div>
                    )}
                </div>
                {g.notes && g.notes.trim() !== "" && (
                  <div className="text-xs text-gray-600 bg-gray-50 px-2 py-1 rounded mt-1">
                    <span className="font-medium">Note:</span> {g.notes}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Name Card Action Modal */}
      <NameCardActionModal
        isOpen={nameCardModal.isOpen}
        onClose={() => setNameCardModal({ ...nameCardModal, isOpen: false })}
        userId={nameCardModal.userId}
        userName={nameCardModal.userName}
        userRole={nameCardModal.userRole}
      />

      {/* Assign User Modal */}
      {showAssignModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-md shadow-lg w-[90vw] max-w-lg p-6">
            <div className="flex items-center justify-between mb-3">
              <h4 className="font-semibold text-gray-900">
                Assign User to {role.name}
              </h4>
              <button
                className="text-gray-500 hover:text-gray-700"
                onClick={() => setShowAssignModal(false)}
              >
                ✕
              </button>
            </div>
            <input
              value={userQuery}
              onChange={(e) => setUserQuery(e.target.value)}
              placeholder="Search by first name, last name, or username"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
              autoFocus
            />
            {/* Results area */}
            <div className="mt-3 max-h-64 overflow-auto border border-gray-200 rounded">
              {assignError && (
                <div className="p-3 text-sm text-red-700 bg-red-50 border-b border-red-200">
                  {assignError}
                </div>
              )}
              {isSearching ? (
                <div className="p-3 text-sm text-gray-500">Searching…</div>
              ) : searchResults.length === 0 ? (
                <div className="p-3 text-sm text-gray-500">No results</div>
              ) : (
                <ul>
                  {searchResults.map((u) => (
                    <li key={u.id}>
                      <button
                        className="w-full text-left px-3 py-2 hover:bg-gray-50"
                        onClick={() => {
                          // Show notification prompt instead of directly assigning
                          const userName =
                            `${u.firstName || ""} ${u.lastName || ""}`.trim() ||
                            u.username;
                          setNotificationPrompt({
                            isOpen: true,
                            userId: u.id,
                            userName,
                          });
                          setShowAssignModal(false);
                          setUserQuery("");
                          // Reset pagination when closing
                          setPagination({
                            currentPage: 1,
                            totalPages: 0,
                            totalUsers: 0,
                            hasNext: false,
                            hasPrev: false,
                          });
                        }}
                      >
                        {(u.firstName || "") +
                          (u.lastName ? ` ${u.lastName}` : "")}{" "}
                        <span className="text-gray-500">(@{u.username})</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Pagination controls */}
            {pagination.totalUsers > 0 && !isSearching && (
              <div className="mt-3 space-y-2">
                {/* User count info row */}
                <div className="text-center text-sm text-gray-600">
                  Showing{" "}
                  {Math.min(
                    (pagination.currentPage - 1) * 20 + 1,
                    pagination.totalUsers,
                  )}{" "}
                  -{" "}
                  {Math.min(pagination.currentPage * 20, pagination.totalUsers)}{" "}
                  of {pagination.totalUsers} users
                </div>
                {/* Pagination controls row */}
                <div className="flex items-center justify-center space-x-2">
                  <button
                    onClick={() =>
                      fetchUsers(pagination.currentPage - 1, userQuery)
                    }
                    disabled={!pagination.hasPrev || isSearching}
                    className="px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:bg-gray-300 disabled:text-gray-500 disabled:cursor-not-allowed text-sm"
                  >
                    Previous
                  </button>
                  <span className="px-2 py-1 text-sm font-medium text-gray-700 bg-gray-100 rounded">
                    Page {pagination.currentPage} of {pagination.totalPages}
                  </span>
                  <button
                    onClick={() =>
                      fetchUsers(pagination.currentPage + 1, userQuery)
                    }
                    disabled={!pagination.hasNext || isSearching}
                    className="px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:bg-gray-300 disabled:text-gray-500 disabled:cursor-not-allowed text-sm"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}

            <div className="mt-3 text-right">
              <button
                className="px-3 py-2 text-sm bg-gray-100 rounded hover:bg-gray-200"
                onClick={() => {
                  setShowAssignModal(false);
                  setUserQuery("");
                  // Reset pagination when closing
                  setPagination({
                    currentPage: 1,
                    totalPages: 0,
                    totalUsers: 0,
                    hasNext: false,
                    hasPrev: false,
                  });
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Notification Prompt Modal */}
      <NotificationPromptModal
        isOpen={notificationPrompt.isOpen}
        userName={notificationPrompt.userName}
        roleName={role.name}
        onConfirm={(sendNotifications) => {
          onAssignUser?.(role.id, notificationPrompt.userId, sendNotifications);
          setNotificationPrompt({
            isOpen: false,
            userId: "",
            userName: "",
          });
        }}
        onCancel={() => {
          setNotificationPrompt({
            isOpen: false,
            userId: "",
            userName: "",
          });
        }}
      />
    </div>
  );
}
