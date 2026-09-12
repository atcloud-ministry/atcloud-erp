import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import HelpRequestCard from "../components/alumniHelp/HelpRequestCard";
import Pagination from "../components/common/Pagination";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "../components/ui";
import { useAlumniHelp } from "../contexts/AlumniHelpContext";
import { useRuntimeConfig } from "../contexts/RuntimeConfigContext";
import {
  ALUMNI_HELP_DEFAULT_PAGE_SIZE,
  ALUMNI_HELP_LIST_VIEWS,
  alumniHelpService,
  type AlumniHelpListView,
  type AlumniHelpRequestPageDTO,
} from "../services/api";
import { socketService } from "../services/socketService";
import type { AlumniHelpUpdate } from "../types/realtime";

const TABS: readonly { id: AlumniHelpListView; label: string }[] = [
  { id: "action_required", label: "Action Needed" },
  { id: "received", label: "Received" },
  { id: "sent", label: "Sent" },
  { id: "completed", label: "Completed" },
];

const EMPTY_PAGINATION: AlumniHelpRequestPageDTO["pagination"] = {
  currentPage: 1,
  totalPages: 0,
  totalCount: 0,
  hasNext: false,
  hasPrev: false,
};

function parseView(value: string | null): AlumniHelpListView {
  return value && ALUMNI_HELP_LIST_VIEWS.includes(value as AlumniHelpListView)
    ? (value as AlumniHelpListView)
    : "action_required";
}

function parsePage(value: string | null): number {
  return value && /^\d+$/.test(value) && Number(value) > 0 ? Number(value) : 1;
}

export default function HelpRequests() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { config, status: runtimeStatus } = useRuntimeConfig();
  const { setHelpActionRequiredCount } = useAlumniHelp();
  const view = parseView(searchParams.get("view"));
  const page = parsePage(searchParams.get("page"));
  const [loadedResult, setLoadedResult] = useState<{
    view: AlumniHelpListView;
    page: number;
    value: AlumniHelpRequestPageDTO;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadSequence, setReloadSequence] = useState(0);

  const setViewAndPage = useCallback(
    (nextView: AlumniHelpListView, nextPage = 1) => {
      const next = new URLSearchParams();
      if (nextView !== "action_required") next.set("view", nextView);
      if (nextPage > 1) next.set("page", String(nextPage));
      setSearchParams(next);
    },
    [setSearchParams],
  );

  useEffect(() => {
    if (runtimeStatus !== "ready" || !config.alumniNetwork.readable) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void alumniHelpService
      .list(
        { view, page, limit: ALUMNI_HELP_DEFAULT_PAGE_SIZE },
        controller.signal,
      )
      .then((next) => {
        if (controller.signal.aborted) return;
        const lastPage = Math.max(1, next.pagination.totalPages);
        if (page > lastPage) {
          setViewAndPage(view, lastPage);
          return;
        }
        setLoadedResult({ view, page, value: next });
        setHelpActionRequiredCount(next.helpActionRequiredCount);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "Unable to load help requests.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    config.alumniNetwork.readable,
    page,
    reloadSequence,
    runtimeStatus,
    setHelpActionRequiredCount,
    setViewAndPage,
    view,
  ]);

  useEffect(
    () =>
      socketService.on<AlumniHelpUpdate>("alumni_help_update", () => {
        setReloadSequence((value) => value + 1);
      }),
    [],
  );

  const result =
    loadedResult?.view === view && loadedResult.page === page
      ? loadedResult.value
      : null;
  const requests = result?.requests ?? [];
  const pagination = result?.pagination ?? EMPTY_PAGINATION;
  const activeTabLabel = useMemo(
    () => TABS.find((tab) => tab.id === view)?.label ?? "Action Needed",
    [view],
  );

  if (runtimeStatus === "loading") {
    return <LoadingState message="Loading Help Requests..." />;
  }

  if (runtimeStatus !== "ready" || !config.alumniNetwork.readable) {
    return (
      <ErrorState
        message="Alumni Help is temporarily unavailable."
        title="Help Requests unavailable"
      />
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        subtitle="Review requests, respond to actions, and record help results."
        title="Help Requests"
      />

      <nav
        aria-label="Help Request views"
        className="overflow-x-auto rounded-lg bg-white shadow-sm"
      >
        <div className="flex min-w-max border-b border-gray-200 px-3 pt-3">
          {TABS.map((tab) => {
            const active = tab.id === view;
            return (
              <Link
                aria-current={active ? "page" : undefined}
                className={`-mb-px rounded-t-lg border px-4 py-3 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  active
                    ? "border-gray-200 border-b-white bg-white text-blue-700"
                    : "border-transparent bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
                key={tab.id}
                to={
                  tab.id === "action_required"
                    ? "/dashboard/community/help-requests"
                    : `/dashboard/community/help-requests?view=${tab.id}`
                }
              >
                {tab.label}
              </Link>
            );
          })}
        </div>
      </nav>

      <section aria-busy={loading} aria-labelledby="help-request-results-heading">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold text-gray-900" id="help-request-results-heading">
            {activeTabLabel}
          </h2>
          {!loading && !error && (
            <p aria-live="polite" className="text-sm text-gray-600">
              {pagination.totalCount}{" "}
              {pagination.totalCount === 1 ? "request" : "requests"}
            </p>
          )}
        </div>

        {loading && !result ? (
          <div className="rounded-lg border border-gray-200 bg-white">
            <LoadingState message="Loading help requests..." />
          </div>
        ) : error ? (
          <div className="rounded-lg border border-gray-200 bg-white">
            <ErrorState
              action={
                <button
                  className="min-h-11 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  onClick={() => setReloadSequence((value) => value + 1)}
                  type="button"
                >
                  Try Again
                </button>
              }
              message={error}
              title="Unable to load help requests"
            />
          </div>
        ) : requests.length === 0 ? (
          <div className="rounded-lg border border-gray-200 bg-white">
            <EmptyState
              action={
                <Link className="font-medium text-blue-700 hover:text-blue-800" to="/dashboard/community/alumni">
                  Browse Alumni Directory
                </Link>
              }
              message={
                view === "action_required"
                  ? "You have no help requests requiring action."
                  : `There are no requests in ${activeTabLabel}.`
              }
              title="No help requests"
            />
          </div>
        ) : (
          <div className="space-y-4">
            {requests.map((request) => (
              <HelpRequestCard
                key={request.id}
                request={request}
              />
            ))}
          </div>
        )}

        {!loading && !error && requests.length > 0 && (
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
