import { useEffect, useMemo, useState, useCallback } from "react";
import {
  useParams,
  useNavigate,
  useSearchParams,
  useLocation,
} from "react-router-dom";
import {
  annualMembershipService,
  programService,
  purchaseService,
} from "../services/api";
import type { EventData } from "../types/event";
import { useAvatarUpdates } from "../hooks/useAvatarUpdates";
import { useAuth } from "../contexts/AuthContext";
import { useToastReplacement } from "../contexts/NotificationModalContext";
import { ProgramParticipants } from "../components/program/ProgramParticipants";
import ProgramHeader from "../components/ProgramDetail/ProgramHeader";
import DeleteProgramModal from "../components/ProgramDetail/DeleteProgramModal";
import ProgramIntroSection from "../components/ProgramDetail/ProgramIntroSection";
import ProgramMentors from "../components/ProgramDetail/ProgramMentors";
import ProgramEventsList from "../components/ProgramDetail/ProgramEventsList";
import ProgramPricing from "../components/ProgramDetail/ProgramPricing";
import ProgramChatRoomLink from "../components/ProgramDetail/ProgramChatRoomLink";
import LoadingSpinner from "../components/common/LoadingSpinner";
import { EmailParticipantsModal } from "../components/common";
import { useProgramEmailModal } from "../hooks/useProgramEmailModal";
import type { ProgramType } from "../constants/programTypes";
import type { ProgramRoles } from "../types/program";
import { normalizeProgramRoles } from "../utils/programRoles";
import type { AnnualMembership } from "../types/annualMembership";
import { formatCurrency } from "../utils/currency";
import {
  buildLoginRedirectUrl,
  getPathWithSearch,
} from "../utils/loginRedirect";

type Program = {
  id: string;
  title: string;
  programType: ProgramType;
  hostedBy?: string;
  period?: {
    startYear?: string;
    startMonth?: string;
    endYear?: string;
    endMonth?: string;
  };
  introduction?: string;
  flyerUrl?: string;
  zoomLink?: string;
  meetingId?: string;
  passcode?: string;
  programRoles?: ProgramRoles;
  earlyBirdDeadline?: string;
  mentors?: Array<{
    userId: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    gender?: "male" | "female";
    avatar?: string;
    roleInAtCloud?: string;
  }>;
  // Free program indicator
  isFree?: boolean;
  // Pricing fields are returned top-level from backend model
  fullPriceTicket?: number;
  classRepDiscount?: number;
  earlyBirdDiscount?: number;
  classRepLimit?: number; // Maximum number of Class Rep slots (0 = unlimited)
  classRepCount?: number; // Current number of Class Rep purchases
  // Optional legacy/nested shape for compatibility with older tests/data
  pricing?: {
    fullPriceTicket?: number;
    classRepDiscount?: number;
    earlyBirdDiscount?: number;
  };
};

export default function ProgramDetail({
  forceServerPagination,
}: { forceServerPagination?: boolean } = {}) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { hasRole, currentUser } = useAuth();
  const notification = useToastReplacement();
  const [showLoginModal, setShowLoginModal] = useState(false);

  // Listen for real-time avatar updates to refresh mentor avatars
  const avatarUpdateCounter = useAvatarUpdates();

  // Email modal hook for sending emails to program participants
  const {
    emailModal,
    setEmailModal,
    emailEditorRef,
    applyEditorCommand,
    openModal: openEmailModal,
    closeModal: closeEmailModal,
  } = useProgramEmailModal();

  const [program, setProgram] = useState<Program | null>(null);
  const [events, setEvents] = useState<EventData[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchParams, setSearchParams] = useSearchParams();
  const initialPage = Math.max(1, Number(searchParams.get("page")) || 1);
  const initialSortDir: "asc" | "desc" =
    (searchParams.get("sort") as "asc" | "desc") === "desc" ? "desc" : "asc";
  const [page, setPage] = useState(initialPage);
  const [limit] = useState(20);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(initialSortDir);
  const [pageInput, setPageInput] = useState<string>(String(initialPage));
  const [announceText, setAnnounceText] = useState<string>("");
  const loginRedirectUrl = buildLoginRedirectUrl(getPathWithSearch(location));
  const [pageHelper, setPageHelper] = useState<string>("");
  const [pageDebounceId, setPageDebounceId] = useState<number | null>(null);
  // Prefer explicit prop (tests) then env flag
  const serverPaginationEnabled =
    forceServerPagination !== undefined
      ? !!forceServerPagination
      : import.meta.env?.VITE_PROGRAM_EVENTS_PAGINATION === "server";
  const [isListLoading, setIsListLoading] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showFinalConfirm, setShowFinalConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteCascade, setDeleteCascade] = useState<false | true>(false);

  // Purchase/Access state
  const [hasAccess, setHasAccess] = useState<boolean | null>(null);
  const [accessReason, setAccessReason] = useState<
    | "admin"
    | "mentor"
    | "creator"
    | "free"
    | "membership"
    | "purchased"
    | "class_rep"
    | "not_purchased"
    | null
  >(null);
  const [isCurrentUserClassRep, setIsCurrentUserClassRep] = useState(false);
  const [enrollmentRefreshKey, setEnrollmentRefreshKey] = useState(0);
  const [membershipOptions, setMembershipOptions] = useState<
    AnnualMembership[]
  >([]);
  const [showMembershipPrompt, setShowMembershipPrompt] = useState(false);

  const handleEnrollClick = useCallback(() => {
    if (!currentUser) {
      setShowLoginModal(true);
      return;
    }

    const options = membershipOptions.filter(
      (membership) => !membership.purchased && !membership.adminAccess,
    );
    if (options.length > 0) {
      setShowMembershipPrompt(true);
      return;
    }

    navigate(`/dashboard/programs/${id}/enroll`);
  }, [currentUser, id, membershipOptions, navigate]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const p = await programService.getById(id);
        let evts: unknown[] = [];
        if (!serverPaginationEnabled) {
          // Client-side mode: fetch all events once here
          evts = (await programService.listProgramEvents(id)) as unknown[];
        }
        if (cancelled) return;
        setProgram(p as Program);
        type RawEvent2 = Partial<EventData> & { id?: string; _id?: string };
        if (!serverPaginationEnabled) {
          setEvents(
            (evts as RawEvent2[]).map((e) => ({
              id: e.id || e._id,
              title: e.title,
              type: e.type,
              date: e.date,
              endDate: e.endDate,
              time: e.time,
              endTime: e.endTime,
              location: e.location,
              organizer: e.organizer,
              roles: e.roles || [],
              signedUp: e.signedUp || 0,
              totalSlots: e.totalSlots || 0,
              format: e.format,
              createdBy: e.createdBy,
              createdAt: e.createdAt,
            })) as EventData[],
          );
        }
      } catch (e) {
        console.error("Failed to load program", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    id,
    serverPaginationEnabled,
    limit,
    sortDir,
    avatarUpdateCounter,
    enrollmentRefreshKey,
  ]);

  // Check program access (skip for guests — no token means no purchase)
  useEffect(() => {
    if (!id || !currentUser) {
      if (!currentUser) {
        setHasAccess(false);
        setAccessReason("not_purchased");
      }
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await purchaseService.checkProgramAccess(id);
        if (cancelled) return;
        setHasAccess(result.hasAccess);
        setAccessReason(result.reason);
        setIsCurrentUserClassRep(result.reason === "class_rep");
      } catch (error) {
        console.error("Failed to check program access:", error);
        if (!cancelled) {
          setHasAccess(false);
          setAccessReason("not_purchased");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, currentUser, enrollmentRefreshKey]);

  useEffect(() => {
    if (!id || !currentUser) {
      setMembershipOptions([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const options = await annualMembershipService.list({ programId: id });
        if (!cancelled) setMembershipOptions(options);
      } catch (error) {
        console.error("Failed to load annual membership options:", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, currentUser]);

  // Check if current user is a class rep of this program (for email permission)
  useEffect(() => {
    if (!id || !currentUser) return;
    let cancelled = false;
    (async () => {
      try {
        const participants = await programService.getParticipants(id);
        if (cancelled) return;
        // Check if current user is in the classReps list
        const isClassRep =
          participants.classReps?.some((cr) => {
            const userId = cr.user?.id || cr.user?._id;
            return userId === currentUser.id;
          }) ?? false;
        setIsCurrentUserClassRep(isClassRep);
      } catch (error) {
        console.error("Failed to check class rep status:", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, currentUser, enrollmentRefreshKey]);

  // Keep URL query in sync with state (page, sort)
  useEffect(() => {
    setSearchParams({ page: String(page), sort: sortDir }, { replace: true });
    // keep input in sync with actual page
    setPageInput(String(page));
  }, [page, sortDir, setSearchParams]);

  // Derived sorted + paged events (client fallback)
  const sortedEvents = useMemo(() => {
    const copy = [...events];
    const valueOf = (e: EventData) => {
      // Attempt to construct comparable timestamp
      const dateStr = e.date || "";
      const timeStr = e.time || "00:00";
      const ts = Date.parse(`${dateStr} ${timeStr}`);
      return isNaN(ts) ? 0 : ts;
    };
    copy.sort((a, b) => {
      const diff = valueOf(a) - valueOf(b);
      return sortDir === "asc" ? diff : -diff;
    });
    return copy;
  }, [events, sortDir]);

  const [serverTotalPages, setServerTotalPages] = useState<number | null>(null);
  const [serverTotalCount, setServerTotalCount] = useState<number | null>(null);
  const totalPages = useMemo(() => {
    if (serverPaginationEnabled && serverTotalPages != null)
      return serverTotalPages;
    return Math.max(1, Math.ceil(sortedEvents.length / limit));
  }, [serverPaginationEnabled, serverTotalPages, sortedEvents.length, limit]);

  const [serverPageEvents, setServerPageEvents] = useState<EventData[] | null>(
    null,
  );
  const pageEvents = useMemo(() => {
    if (serverPaginationEnabled && serverPageEvents) return serverPageEvents;
    const start = (page - 1) * limit;
    return sortedEvents.slice(start, start + limit);
  }, [serverPaginationEnabled, serverPageEvents, sortedEvents, page, limit]);

  // Helper for numeric page jumps (keeps URL in sync via useEffect above)
  const setPageSafe = (n: number) => {
    const clamped = Math.max(1, Math.min(totalPages, n));
    if (serverPaginationEnabled) {
      // Proactively show spinner on page transitions in server mode
      setIsListLoading(true);
    }
    setPage(clamped);
  };

  // React to page/sort changes when server pagination is enabled
  useEffect(() => {
    if (!id || !serverPaginationEnabled) return;
    let cancelled = false;
    (async () => {
      try {
        setIsListLoading(true);
        const res = await programService.listProgramEventsPaged(id, {
          page,
          limit,
          sort: sortDir === "asc" ? "date:asc" : "date:desc",
        });
        if (cancelled) return;
        const items =
          (res.items as (Partial<EventData> & {
            id?: string;
            _id?: string;
          })[]) || [];
        const mapped: EventData[] = items.map((e) => ({
          id: e.id || e._id,
          title: e.title,
          type: e.type,
          date: e.date,
          endDate: e.endDate,
          time: e.time,
          endTime: e.endTime,
          location: e.location,
          organizer: e.organizer,
          roles: e.roles || [],
          signedUp: e.signedUp || 0,
          totalSlots: e.totalSlots || 0,
          format: e.format,
          createdBy: e.createdBy,
          createdAt: e.createdAt,
        })) as EventData[];
        setServerPageEvents(mapped);
        setServerTotalPages(res.totalPages ?? 1);
        setServerTotalCount((res as { total?: number }).total ?? null);
      } catch (e) {
        console.error("Failed to fetch paged program events", e);
      } finally {
        if (!cancelled) setIsListLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, serverPaginationEnabled, page, limit, sortDir]);

  // Determine status label (upcoming/past/ongoing) using event dates/times.
  const getEventStatus = (e: EventData): "upcoming" | "past" | "ongoing" => {
    // Prefer backend-provided status if available and valid
    if (
      e.status === "upcoming" ||
      e.status === "ongoing" ||
      e.status === "completed"
    ) {
      // Map completed -> past for user-facing label consistency here
      return e.status === "completed"
        ? "past"
        : (e.status as "upcoming" | "ongoing");
    }
    const startTs = Date.parse(`${e.date || ""} ${e.time || "00:00"}`);
    const endTs = Date.parse(
      `${e.endDate || e.date || ""} ${e.endTime || e.time || "23:59"}`,
    );
    const now = Date.now();
    if (!isNaN(startTs) && !isNaN(endTs)) {
      if (now < startTs) return "upcoming";
      if (now > endTs) return "past";
      return "ongoing";
    }
    if (!isNaN(startTs)) return now < startTs ? "upcoming" : "past";
    // If no parseable date, default to upcoming (neutral)
    return "upcoming";
  };

  // Linked events count for delete dialog
  const linkedEventsCount = useMemo(() => {
    if (!id) return 0;
    if (serverPaginationEnabled) {
      return serverTotalCount ?? serverPageEvents?.length ?? 0;
    }
    return events.length;
  }, [
    id,
    serverPaginationEnabled,
    serverTotalCount,
    serverPageEvents,
    events.length,
  ]);

  const openDelete = () => {
    setDeleteCascade(false);
    setShowDeleteModal(true);
  };

  const onProceedToFinalConfirm = () => {
    setShowDeleteModal(false);
    setShowFinalConfirm(true);
  };

  const onConfirmDelete = async () => {
    if (!id) return;
    try {
      setIsDeleting(true);
      const result = await programService.deleteProgram(id, {
        deleteLinkedEvents: !!deleteCascade,
      });

      // Show success notification with details
      const message = deleteCascade
        ? `Program and all linked events deleted successfully. ${
            result.deletedEvents || 0
          } events removed.`
        : `Program deleted successfully. ${
            result.unlinkedEvents || 0
          } events were unlinked and preserved.`;

      notification.success(message, {
        title: "Program Deleted",
        autoCloseDelay: 4000,
      });
      navigate("/dashboard/programs", { replace: true });
    } catch (e: unknown) {
      console.error("Failed to delete program", e);

      // Show error notification with retry guidance
      const error = e as { message?: string; status?: number };
      const errorMsg = error.message || "An unexpected error occurred";
      const isNetworkError =
        !navigator.onLine ||
        errorMsg.includes("NetworkError") ||
        errorMsg.includes("fetch");

      if (isNetworkError) {
        notification.error(
          "Unable to delete program due to network issues. Please check your connection and try again.",
          {
            title: "Connection Error",
          },
        );
      } else if (error.status === 403) {
        notification.error(
          "You don't have permission to delete this program. Contact an administrator if needed.",
          {
            title: "Permission Denied",
          },
        );
      } else if (error.status === 404) {
        notification.error(
          "This program may have already been deleted. Refreshing the page...",
          {
            title: "Program Not Found",
          },
        );
        setTimeout(() => window.location.reload(), 2000);
      } else {
        notification.error(
          `Failed to delete program: ${errorMsg}. Please try again or contact support if the issue persists.`,
          {
            title: "Deletion Failed",
          },
        );
      }

      // Keep modal open on error so user can retry
      setIsDeleting(false);
      return;
    }

    // Only close modals on success
    setIsDeleting(false);
    setShowFinalConfirm(false);
  };

  const cancelDelete = () => {
    setShowDeleteModal(false);
    setShowFinalConfirm(false);
    setDeleteCascade(false);
  };

  if (loading) {
    // Standardized dashboard loading: centered, fullscreen, larger spinner
    return <LoadingSpinner size="lg" />;
  }

  if (!program) return <div className="text-center">Program not found.</div>;

  const programRoles = normalizeProgramRoles(program);
  const hasZoomInfo = !!(
    program.zoomLink?.trim() ||
    program.meetingId?.trim() ||
    program.passcode?.trim()
  );

  return (
    <>
      <div className="max-w-5xl mx-auto space-y-6 min-h-full">
        <DeleteProgramModal
          isOpen={showDeleteModal}
          showFinalConfirm={showFinalConfirm}
          isDeleting={isDeleting}
          linkedEventsCount={linkedEventsCount}
          deleteCascade={deleteCascade}
          onCascadeChange={setDeleteCascade}
          onProceedToFinalConfirm={onProceedToFinalConfirm}
          onConfirmDelete={onConfirmDelete}
          onCancel={cancelDelete}
        />

        <ProgramHeader
          programId={id!}
          title={program.title}
          programType={program.programType}
          period={program.period}
          canEdit={
            hasRole(["Administrator", "Super Admin"]) ||
            // Program creator (Leader who created this program)
            accessReason === "creator" ||
            // Mentors assigned to this program
            (program.mentors?.some(
              (mentor: { userId: string }) => mentor.userId === currentUser?.id,
            ) ??
              false) ||
            isCurrentUserClassRep
          }
          canDelete={
            hasRole(["Administrator", "Super Admin"]) ||
            // Program creator can delete their own program
            accessReason === "creator"
          }
          canCreateEvent={
            // Admin and Super Admin can always create events
            hasRole(["Administrator", "Super Admin"]) ||
            // Program creator can create events
            accessReason === "creator" ||
            // Mentors and class reps can create events in their program
            (program.mentors?.some(
              (mentor: { userId: string }) => mentor.userId === currentUser?.id,
            ) ??
              false) ||
            isCurrentUserClassRep ||
            // Leaders can create events in programs they have access to
            (hasRole(["Leader"]) && hasAccess === true)
          }
          canEmail={
            // Super Admin and Administrator can always email participants
            hasRole(["Administrator", "Super Admin"]) ||
            // Program creator can email participants
            accessReason === "creator" ||
            // Mentors and class reps can email participants for their program
            (program.mentors?.some(
              (mentor: { userId: string }) => mentor.userId === currentUser?.id,
            ) ??
              false) ||
            isCurrentUserClassRep
          }
          onDelete={openDelete}
          onEmailParticipants={openEmailModal}
        />

        <ProgramChatRoomLink
          programId={id!}
          refreshKey={enrollmentRefreshKey}
        />

        <ProgramIntroSection
          programId={id!}
          introduction={program.introduction}
          flyerUrl={program.flyerUrl}
          hasAccess={hasAccess}
          accessReason={accessReason}
          onEnrollClick={handleEnrollClick}
        />

        {hasZoomInfo && (
          <div className="bg-white rounded-lg shadow-sm p-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">
              Zoom Information
            </h2>
            <div className="space-y-3 text-sm">
              {program.zoomLink && (
                <div>
                  <div className="font-medium text-gray-700">Link</div>
                  <a
                    href={program.zoomLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:text-blue-800 break-all"
                  >
                    {program.zoomLink}
                  </a>
                </div>
              )}
              {program.meetingId && (
                <div>
                  <div className="font-medium text-gray-700">Meeting ID</div>
                  <div className="font-mono text-gray-900">
                    {program.meetingId}
                  </div>
                </div>
              )}
              {program.passcode && (
                <div>
                  <div className="font-medium text-gray-700">Passcode</div>
                  <div className="font-mono text-gray-900">
                    {program.passcode}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Mentors section */}
        <ProgramMentors
          mentors={program.mentors || []}
          teacherRoleName={programRoles.teacherRoleName}
          currentUserId={currentUser?.id || null}
          currentUserRole={currentUser?.role || null}
          accessReason={accessReason}
        />

        {/* Program Participants */}
        {program && (
          <ProgramParticipants
            programId={program.id}
            program={{ ...program, programRoles }}
            onEnrollmentChanged={() =>
              setEnrollmentRefreshKey((key) => key + 1)
            }
          />
        )}

        {/* Pricing panel (UI label changed to Tuition; internal naming unchanged) */}
        {membershipOptions.length > 0 && (
          <div className="bg-white rounded-lg shadow-sm p-6 border border-cyan-100">
            <h2 className="text-xl font-semibold text-gray-900">
              Annual Membership Option
            </h2>
            <p className="mt-2 text-sm leading-6 text-gray-700">
              This program is included in{" "}
              <strong>{membershipOptions[0].title}</strong>. You can enroll in
              this program together with{" "}
              {membershipOptions[0].programs
                .map((membershipProgram) => membershipProgram.title)
                .join(", ")}{" "}
              for {formatCurrency(membershipOptions[0].price)}.
            </p>
            <button
              onClick={() =>
                navigate(
                  `/dashboard/annual-memberships/${membershipOptions[0].id}`,
                )
              }
              className="mt-4 rounded-md bg-cyan-700 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-800"
            >
              View Annual Membership
            </button>
          </div>
        )}

        <ProgramPricing
          isFree={program.isFree}
          fullPriceTicket={program.fullPriceTicket}
          classRepDiscount={program.classRepDiscount}
          earlyBirdDiscount={program.earlyBirdDiscount}
          classRepLimit={program.classRepLimit}
          classRepCount={program.classRepCount}
          programRoles={programRoles}
          earlyBirdDeadline={program.earlyBirdDeadline}
          hasAccess={hasAccess}
          accessReason={accessReason}
          onEnrollClick={handleEnrollClick}
          period={program.period}
          pricing={program.pricing}
        />

        {/* Events in program */}
        <ProgramEventsList
          events={events}
          pageEvents={pageEvents}
          page={page}
          totalPages={totalPages}
          pageInput={pageInput}
          pageHelper={pageHelper}
          announceText={announceText}
          sortDir={sortDir}
          isListLoading={isListLoading}
          serverPaginationEnabled={serverPaginationEnabled}
          serverPageEvents={serverPageEvents}
          onSortChange={setSortDir}
          onPageChange={setPageSafe}
          onPageInputChange={(value) => {
            setPageInput(value);
            // show helper for invalid or out-of-range
            const n = Number(value);
            if (Number.isNaN(n)) {
              setPageHelper("Enter a number between 1 and " + totalPages);
            } else if (n < 1 || n > totalPages) {
              setPageHelper(`Page must be between 1 and ${totalPages}`);
            } else {
              setPageHelper("");
            }
          }}
          onPageInputBlur={() => {
            const n = Number(pageInput);
            if (!Number.isNaN(n)) {
              const clamped = Math.max(1, Math.min(totalPages, n));
              setPageSafe(clamped);
              // If input was previously marked out-of-range or is out-of-range now,
              // announce clamping even if the browser/JSDOM auto-clamped the value.
              const wasOutOfRange =
                n < 1 || n > totalPages || (pageHelper ?? "").length > 0;
              setAnnounceText(
                wasOutOfRange || clamped !== n
                  ? `Clamped to page ${clamped} of ${totalPages}`
                  : `Moved to page ${clamped} of ${totalPages}`,
              );
              setPageHelper("");
            } else {
              setPageInput(String(page));
              setAnnounceText(
                `Invalid page. Staying on page ${page} of ${totalPages}`,
              );
              setPageHelper("Enter a number between 1 and " + totalPages);
            }
          }}
          onPageInputKeyDown={(e) => {
            if (e.key === "Enter") {
              const n = Number(pageInput);
              if (!Number.isNaN(n)) {
                const clamped = Math.max(1, Math.min(totalPages, n));
                // debounce commit by 300ms
                if (pageDebounceId) window.clearTimeout(pageDebounceId);
                const id = window.setTimeout(() => {
                  setPageSafe(clamped);
                  const wasOutOfRange =
                    n < 1 || n > totalPages || (pageHelper ?? "").length > 0;
                  setAnnounceText(
                    wasOutOfRange || clamped !== n
                      ? `Clamped to page ${clamped} of ${totalPages}`
                      : `Moved to page ${clamped} of ${totalPages}`,
                  );
                  setPageHelper("");
                }, 300);
                setPageDebounceId(id);
              } else {
                setPageInput(String(page));
                setAnnounceText(
                  `Invalid page. Staying on page ${page} of ${totalPages}`,
                );
                setPageHelper("Enter a number between 1 and " + totalPages);
              }
            }
          }}
          onEventClick={(eventId) => navigate(`/dashboard/event/${eventId}`)}
          getEventStatus={getEventStatus}
        />

        {/* Email Participants Modal */}
        <EmailParticipantsModal
          isOpen={emailModal.open}
          title={program.title}
          emailModal={emailModal}
          setEmailModal={setEmailModal}
          emailEditorRef={emailEditorRef}
          applyEditorCommand={applyEditorCommand}
          onSend={async () => {
            const subject = emailModal.subject.trim();
            const bodyHtml = emailModal.bodyHtml.trim();

            if (!subject || !bodyHtml) {
              notification.error("Subject and message are required.", {
                title: "Missing Fields",
              });
              return;
            }

            try {
              setEmailModal((m) => ({ ...m, sending: true }));
              const res = await programService.sendProgramEmails(id!, {
                subject,
                bodyHtml,
                includeMentors: emailModal.recipients.includeMentors,
                includeClassReps: emailModal.recipients.includeClassReps,
                includeMentees: emailModal.recipients.includeMentees,
              });

              const count: number =
                typeof res.recipientCount === "number"
                  ? res.recipientCount
                  : typeof res.sent === "number"
                    ? res.sent
                    : 0;

              notification.success(
                count > 0
                  ? `Email sent to ${count} recipient${count === 1 ? "" : "s"}.`
                  : "No recipients found for this program.",
                { title: "Email Sent" },
              );

              closeEmailModal();
            } catch (e: unknown) {
              const message =
                e instanceof Error ? e.message : "Failed to send emails.";
              notification.error(message, { title: "Send Failed" });
              setEmailModal((m) => ({ ...m, sending: false }));
            }
          }}
          onClose={closeEmailModal}
          renderRecipientOptions={() => (
            <>
              <label className="inline-flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  checked={emailModal.recipients.includeMentors}
                  onChange={(e) =>
                    setEmailModal((m) => ({
                      ...m,
                      recipients: {
                        ...m.recipients,
                        includeMentors: e.target.checked,
                      },
                    }))
                  }
                />
                Include Mentors
              </label>
              <label className="inline-flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  checked={emailModal.recipients.includeClassReps}
                  onChange={(e) =>
                    setEmailModal((m) => ({
                      ...m,
                      recipients: {
                        ...m.recipients,
                        includeClassReps: e.target.checked,
                      },
                    }))
                  }
                />
                Include Class Representatives
              </label>
              <label className="inline-flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  checked={emailModal.recipients.includeMentees}
                  onChange={(e) =>
                    setEmailModal((m) => ({
                      ...m,
                      recipients: {
                        ...m.recipients,
                        includeMentees: e.target.checked,
                      },
                    }))
                  }
                />
                Include Mentees
              </label>
            </>
          )}
        />
      </div>

      {/* Guest Login Modal */}
      {showLoginModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-lg shadow-xl p-6 max-w-sm mx-4 w-full">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              Login Required
            </h3>
            <p className="text-gray-600 mb-6">
              Please log in or create an account to complete your enrollment.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowLoginModal(false)}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => navigate(loginRedirectUrl)}
                className="px-4 py-2 text-sm font-medium text-white bg-purple-600 hover:bg-purple-700 rounded-md transition-colors"
              >
                Login
              </button>
            </div>
          </div>
        </div>
      )}

      {showMembershipPrompt && membershipOptions.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900">
              Annual Membership Option
            </h3>
            <p className="mt-2 text-sm leading-6 text-gray-700">
              This program is included in{" "}
              <strong>{membershipOptions[0].title}</strong>. You can unlock it
              together with{" "}
              {membershipOptions[0].programs
                .map((membershipProgram) => membershipProgram.title)
                .join(", ")}{" "}
              for {formatCurrency(membershipOptions[0].price)}.
            </p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
              <button
                onClick={() => {
                  setShowMembershipPrompt(false);
                  navigate(`/dashboard/programs/${id}/enroll`);
                }}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Continue Enrollment
              </button>
              <button
                onClick={() =>
                  navigate(
                    `/dashboard/annual-memberships/${membershipOptions[0].id}`,
                  )
                }
                className="rounded-md bg-cyan-700 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-800"
              >
                View Membership
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
