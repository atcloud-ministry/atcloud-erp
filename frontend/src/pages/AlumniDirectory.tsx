import { useCallback, useEffect, useState } from "react";
import AlumniDirectoryCard from "../components/directory/AlumniDirectoryCard";
import AlumniDirectoryFilters, {
  EMPTY_DIRECTORY_FILTERS,
  type DirectoryFiltersValue,
} from "../components/directory/AlumniDirectoryFilters";
import Pagination from "../components/common/Pagination";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "../components/ui";
import { useRuntimeConfig } from "../contexts/RuntimeConfigContext";
import {
  alumniDirectoryService,
  DIRECTORY_DEFAULT_PAGE_SIZE,
  type DirectoryCardDTO,
  type DirectoryListParams,
  type DirectoryPageDTO,
} from "../services/api";

const INITIAL_PAGINATION: DirectoryPageDTO["pagination"] = Object.freeze({
  currentPage: 1,
  totalPages: 0,
  totalProfiles: 0,
  hasNext: false,
  hasPrev: false,
});

function queryFrom(
  filters: DirectoryFiltersValue,
  page: number,
): DirectoryListParams {
  return {
    page,
    limit: DIRECTORY_DEFAULT_PAGE_SIZE,
    q: filters.q || undefined,
    company: filters.company || undefined,
    industry: filters.industry || undefined,
    skill: filters.skill || undefined,
    location: filters.location || undefined,
    cohort: filters.cohort || undefined,
    offering: filters.offering || undefined,
  };
}

export default function AlumniDirectory() {
  const { config, status: runtimeStatus } = useRuntimeConfig();
  const [filters, setFilters] = useState<DirectoryFiltersValue>(
    EMPTY_DIRECTORY_FILTERS,
  );
  const [page, setPage] = useState(1);
  const [profiles, setProfiles] = useState<DirectoryCardDTO[]>([]);
  const [pagination, setPagination] = useState(INITIAL_PAGINATION);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadSequence, setReloadSequence] = useState(0);

  useEffect(() => {
    if (runtimeStatus !== "ready" || !config.alumniNetwork.readable) return;

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void alumniDirectoryService
      .list(queryFrom(filters, page), controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        const lastAvailablePage = Math.max(1, result.pagination.totalPages);
        if (page > lastAvailablePage) {
          setPage(lastAvailablePage);
          return;
        }
        setProfiles(result.profiles);
        setPagination(result.pagination);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "Unable to load the alumni directory.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [config.alumniNetwork.readable, filters, page, reloadSequence, runtimeStatus]);

  const applyFilters = useCallback((nextFilters: DirectoryFiltersValue) => {
    setFilters(nextFilters);
    setPage(1);
  }, []);

  const changePage = useCallback((nextPage: number) => {
    setPage(nextPage);
  }, []);

  if (runtimeStatus === "loading") {
    return <LoadingState message="Loading Alumni Directory..." />;
  }

  if (runtimeStatus !== "ready" || !config.alumniNetwork.readable) {
    return (
      <ErrorState
        message="The Alumni Directory is temporarily unavailable."
        title="Alumni Directory unavailable"
      />
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <PageHeader
        subtitle="Find alumni by experience, location, cohort, and the help they offer."
        title="Alumni Directory"
      />

      <AlumniDirectoryFilters
        loading={loading}
        onApply={applyFilters}
        value={filters}
      />

      <section aria-busy={loading} aria-labelledby="directory-results-title">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold text-gray-900" id="directory-results-title">
            Alumni
          </h2>
          {!loading && !error && (
            <p aria-live="polite" className="text-sm text-gray-600">
              {pagination.totalProfiles} {pagination.totalProfiles === 1 ? "profile" : "profiles"}
            </p>
          )}
        </div>

        {loading ? (
          <div className="rounded-lg border border-gray-200 bg-white">
            <LoadingState message="Loading alumni..." />
          </div>
        ) : error ? (
          <div className="rounded-lg border border-gray-200 bg-white">
            <ErrorState
              action={
                <button
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                  onClick={() => setReloadSequence((value) => value + 1)}
                  type="button"
                >
                  Try Again
                </button>
              }
              message={error}
              title="Unable to load alumni"
            />
          </div>
        ) : profiles.length === 0 ? (
          <div className="rounded-lg border border-gray-200 bg-white">
            <EmptyState
              message="Try changing or resetting your search filters."
              title="No alumni found"
            />
          </div>
        ) : (
          <div
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
            data-testid="alumni-directory-grid"
          >
            {profiles.map((profile) => (
              <AlumniDirectoryCard
                key={profile.id}
                profile={profile}
                writable={config.alumniNetwork.writable}
              />
            ))}
          </div>
        )}

        {!loading && !error && profiles.length > 0 && (
          <div className="mt-6">
            <Pagination
              currentPage={pagination.currentPage}
              hasNext={pagination.hasNext}
              hasPrev={pagination.hasPrev}
              onPageChange={changePage}
              showPageNumbers
              totalPages={pagination.totalPages}
            />
          </div>
        )}
      </section>
    </div>
  );
}

export { queryFrom };
