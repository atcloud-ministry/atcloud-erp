import { useCallback, useEffect, useRef, useState } from "react";
import {
  analyticsService,
  type AnalyticsOverview,
  type AttendanceAnalytics,
  type DonationAnalytics,
  type FinancialSummary,
  type ProgramAnalytics,
  type UserAnalytics,
} from "../services/api/analytics.api";

export type AnalyticsResourceState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

function useLazyAnalyticsResource<T>(
  enabled: boolean,
  fetcher: () => Promise<T>,
): AnalyticsResourceState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);
  const loadingRef = useRef(false);

  const load = useCallback(
    async (force = false) => {
      if (!enabled && !force) return;
      if (loadingRef.current) return;
      if (hasLoadedRef.current && !force) return;

      loadingRef.current = true;
      setLoading(true);
      setError(null);

      try {
        const result = await fetcher();
        setData(result);
        hasLoadedRef.current = true;
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Failed to load analytics";
        setError(message);
      } finally {
        loadingRef.current = false;
        setLoading(false);
      }
    },
    [enabled, fetcher],
  );

  useEffect(() => {
    if (enabled) {
      void load();
    }
  }, [enabled, load]);

  const refresh = useCallback(async () => {
    await load(true);
  }, [load]);

  return { data, loading, error, refresh };
}

export function useAnalyticsOverviewResource(enabled: boolean) {
  const fetcher = useCallback(() => analyticsService.getAnalytics(), []);
  return useLazyAnalyticsResource<AnalyticsOverview>(enabled, fetcher);
}

export function useEventAnalyticsResource(enabled: boolean) {
  const fetcher = useCallback(() => analyticsService.getEventAnalytics(), []);
  return useLazyAnalyticsResource<unknown>(enabled, fetcher);
}

export function useUserAnalyticsResource(enabled: boolean) {
  const fetcher = useCallback(() => analyticsService.getUserAnalytics(), []);
  return useLazyAnalyticsResource<UserAnalytics>(enabled, fetcher);
}

export function useAttendanceAnalyticsResource(enabled: boolean) {
  const fetcher = useCallback(
    () => analyticsService.getAttendanceAnalytics(),
    [],
  );
  return useLazyAnalyticsResource<AttendanceAnalytics>(enabled, fetcher);
}

export function useProgramAnalyticsResource(enabled: boolean) {
  const fetcher = useCallback(() => analyticsService.getProgramAnalytics(), []);
  return useLazyAnalyticsResource<ProgramAnalytics>(enabled, fetcher);
}

export function useDonationAnalyticsResource(enabled: boolean) {
  const fetcher = useCallback(() => analyticsService.getDonationAnalytics(), []);
  return useLazyAnalyticsResource<DonationAnalytics>(enabled, fetcher);
}

export function useFinancialSummaryResource(enabled: boolean) {
  const fetcher = useCallback(
    () => analyticsService.getFinancialSummary(),
    [],
  );
  return useLazyAnalyticsResource<FinancialSummary>(enabled, fetcher);
}
