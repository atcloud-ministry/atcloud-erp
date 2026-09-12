import { ChatBubbleOvalLeftEllipsisIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import ChatRoomRow from "../components/chat/ChatRoomRow";
import Pagination from "../components/common/Pagination";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "../components/ui";
import { useChatRooms } from "../contexts/ChatRoomsContext";
import { isAlumniHelpUpdatePayload } from "../contexts/AlumniHelpContext";
import { useRuntimeConfig } from "../contexts/RuntimeConfigContext";
import {
  CHAT_ROOM_DEFAULT_PAGE_SIZE,
  CONVERSATION_SECTIONS,
  conversationsService,
  type ConversationListDTO,
  type ConversationSection,
} from "../services/api";
import { socketService } from "../services/socketService";

const TABS: readonly { id: ConversationSection; label: string }[] = [
  { id: "current", label: "Current" },
  { id: "past", label: "Past / Read-only" },
];

const EMPTY_PAGINATION: ConversationListDTO["pagination"] = {
  currentPage: 1,
  totalPages: 0,
  totalCount: 0,
  hasNext: false,
  hasPrev: false,
};

function parseView(value: string | null): ConversationSection {
  return value && CONVERSATION_SECTIONS.includes(value as ConversationSection)
    ? (value as ConversationSection)
    : "current";
}

function parsePage(value: string | null): number {
  return value && /^\d+$/.test(value) && Number(value) > 0 ? Number(value) : 1;
}

export default function ChatRooms() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { config, status: runtimeStatus } = useRuntimeConfig();
  const {
    applyCounterSnapshot,
    captureCounterGeneration,
    roomUnreadCounts,
  } = useChatRooms();
  const view = parseView(searchParams.get("view"));
  const page = parsePage(searchParams.get("page"));
  const [loaded, setLoaded] = useState<{
    view: ConversationSection;
    page: number;
    result: ConversationListDTO;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadSequence, setReloadSequence] = useState(0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readable =
    runtimeStatus === "ready" && config.alumniNetwork.readable;

  const setViewAndPage = useCallback(
    (nextView: ConversationSection, nextPage = 1) => {
      const next = new URLSearchParams();
      if (nextView !== "current") next.set("view", nextView);
      if (nextPage > 1) next.set("page", String(nextPage));
      setSearchParams(next);
    },
    [setSearchParams],
  );

  useEffect(() => {
    if (!readable) return;
    const controller = new AbortController();
    const counterGeneration = captureCounterGeneration();
    setLoading(true);
    setError(null);
    void conversationsService
      .list(
        { view, page, limit: CHAT_ROOM_DEFAULT_PAGE_SIZE },
        controller.signal,
      )
      .then((result) => {
        if (controller.signal.aborted) return;
        const lastPage = Math.max(1, result.pagination.totalPages);
        if (page > lastPage) {
          setViewAndPage(view, lastPage);
          return;
        }
        setLoaded({ view, page, result });
        applyCounterSnapshot(
          result.chatUnreadTotal,
          undefined,
          undefined,
          undefined,
          counterGeneration,
        );
        result.conversations.forEach((room) => {
          applyCounterSnapshot(
            result.chatUnreadTotal,
            room.id,
            room.viewer.unreadCount,
            room.viewer.lastReadSequence,
            counterGeneration,
          );
        });
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "Unable to load Chat Rooms.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    applyCounterSnapshot,
    captureCounterGeneration,
    page,
    readable,
    reloadSequence,
    setViewAndPage,
    view,
  ]);

  useEffect(() => {
    if (!readable) return;
    const refreshNow = () => {
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      setReloadSequence((value) => value + 1);
    };
    const scheduleRefresh = () => {
      if (refreshTimerRef.current !== null) return;
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        setReloadSequence((value) => value + 1);
      }, 500);
    };
    // A recipient-scoped unread snapshot accompanies new messages. Listening
    // to that single source coalesces bursts instead of fetching the list once
    // for both message and counter events.
    const stopUnread = socketService.on("chat_unread_update", scheduleRefresh);
    const stopHelp = socketService.on<unknown>(
      "alumni_help_update",
      (payload) => {
        if (isAlumniHelpUpdatePayload(payload)) scheduleRefresh();
      },
    );
    const stopReconnect = socketService.on("connect", refreshNow);
    return () => {
      stopUnread();
      stopHelp();
      stopReconnect();
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [readable]);

  const result =
    loaded?.view === view && loaded.page === page ? loaded.result : null;
  const rooms = result?.conversations ?? [];
  const pagination = result?.pagination ?? EMPTY_PAGINATION;
  const heading = useMemo(
    () => TABS.find((tab) => tab.id === view)?.label ?? "Current",
    [view],
  );

  if (runtimeStatus === "loading") {
    return <LoadingState message="Loading Chat Rooms..." />;
  }
  if (!readable) {
    return (
      <ErrorState
        message="Chat Rooms are temporarily unavailable."
        title="Chat Rooms unavailable"
      />
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        subtitle="Continue private Alumni Help conversations in one place."
        title="Chat Rooms"
      />
      <nav
        aria-label="Chat Room views"
        className="overflow-x-auto rounded-lg bg-white shadow-sm"
      >
        <div className="flex min-w-max border-b border-gray-200 px-3 pt-3">
          {TABS.map((tab) => {
            const active = tab.id === view;
            return (
              <Link
                aria-current={active ? "page" : undefined}
                className={`-mb-px min-h-11 rounded-t-lg border px-4 py-3 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  active
                    ? "border-gray-200 border-b-white bg-white text-blue-700"
                    : "border-transparent bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
                key={tab.id}
                to={
                  tab.id === "current"
                    ? "/dashboard/chat-rooms"
                    : "/dashboard/chat-rooms?view=past"
                }
              >
                {tab.label}
              </Link>
            );
          })}
        </div>
      </nav>

      <section aria-busy={loading} aria-labelledby="chat-room-results-heading">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold text-gray-900" id="chat-room-results-heading">
            {heading}
          </h2>
          {!loading && !error && (
            <p aria-live="polite" className="text-sm text-gray-600">
              {pagination.totalCount} {pagination.totalCount === 1 ? "Room" : "Rooms"}
            </p>
          )}
        </div>

        {loading && !result ? (
          <div className="rounded-lg border border-gray-200 bg-white">
            <LoadingState message="Loading Chat Rooms..." />
          </div>
        ) : error ? (
          <div className="rounded-lg border border-gray-200 bg-white">
            <ErrorState
              action={
                <button
                  className="min-h-11 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  onClick={() => setReloadSequence((value) => value + 1)}
                  type="button"
                >
                  Try Again
                </button>
              }
              message={error}
              title="Unable to load Chat Rooms"
            />
          </div>
        ) : rooms.length === 0 ? (
          <div className="rounded-lg border border-gray-200 bg-white">
            <EmptyState
              action={
                view === "current" ? (
                  <Link
                    className="font-medium text-blue-700 hover:text-blue-800"
                    to="/dashboard/community/help-requests"
                  >
                    View Help Requests
                  </Link>
                ) : undefined
              }
              icon={
                <ChatBubbleOvalLeftEllipsisIcon
                  aria-hidden="true"
                  className="mx-auto h-12 w-12 text-gray-400"
                />
              }
              message={
                view === "current"
                  ? "Accepted Alumni Help requests will appear here."
                  : "You have no past Rooms available for history."
              }
              title={view === "current" ? "No current Rooms" : "No past Rooms"}
            />
          </div>
        ) : (
          <ul className="grid gap-3 sm:gap-4" aria-label={`${heading} Chat Rooms`}>
            {rooms.map((room) => (
              <ChatRoomRow
                key={room.id}
                room={room}
                unreadCount={roomUnreadCounts[room.id] ?? room.viewer.unreadCount}
              />
            ))}
          </ul>
        )}

        {!loading && !error && rooms.length > 0 && (
          <div className="mt-6">
            <Pagination
              currentPage={pagination.currentPage}
              hasNext={pagination.hasNext}
              hasPrev={pagination.hasPrev}
              onPageChange={(nextPage) => setViewAndPage(view, nextPage)}
              showPageNumbers
              totalPages={pagination.totalPages}
            />
          </div>
        )}
      </section>
    </div>
  );
}

export { parsePage, parseView };
