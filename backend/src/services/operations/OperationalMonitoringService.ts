import mongoose from "mongoose";
import {
  applicationReadinessService,
  type ApplicationReadinessService,
} from "./ApplicationReadinessService";
import {
  publishRecoveryCollectionSuccess,
  publishRecoveryStatus,
} from "./OperationalMetricsBridge";
import {
  recoveryControlService,
  type RecoveryControlService,
  type RecoveryStatusSnapshot,
} from "./RecoveryControlService";
import { awaitWithAbort } from "../../utils/abortablePromise";

interface ReadinessMetricsPort {
  getSnapshot(): ReturnType<ApplicationReadinessService["getSnapshot"]>;
}

interface RecoveryMetricsSnapshotPort {
  getStatusSnapshot(options?: {
    readonly signal?: AbortSignal;
  }): ReturnType<RecoveryControlService["getStatusSnapshot"]>;
}

export interface OperationalMonitoringDependencies {
  readonly readiness?: ReadinessMetricsPort;
  readonly recovery?: RecoveryMetricsSnapshotPort;
  readonly publishRecovery?: (snapshot: RecoveryStatusSnapshot) => void;
  readonly publishRecoveryCollectionSuccess?: (success: boolean) => void;
  readonly databaseReady?: () => boolean;
  readonly now?: () => number;
  readonly refreshIntervalMs?: number;
  readonly collectionTimeoutMs?: number;
}

export const OPERATIONAL_METRICS_REFRESH_INTERVAL_MS = 30_000;
export const OPERATIONAL_METRICS_COLLECTION_TIMEOUT_MS = 2_000;

/** Refreshes bounded, PII-free operational gauges before Prometheus exposition. */
export class OperationalMonitoringService {
  private readonly readiness: ReadinessMetricsPort;
  private readonly recovery: RecoveryMetricsSnapshotPort;
  private readonly publishRecovery: (snapshot: RecoveryStatusSnapshot) => void;
  private readonly publishRecoveryCollectionSuccess: (success: boolean) => void;
  private readonly databaseReady: () => boolean;
  private readonly now: () => number;
  private readonly refreshIntervalMs: number;
  private readonly collectionTimeoutMs: number;
  private lastRefreshStartedAt: number | null = null;
  private refreshPromise: Promise<void> | null = null;

  constructor(dependencies: OperationalMonitoringDependencies = {}) {
    this.readiness = dependencies.readiness ?? applicationReadinessService;
    this.recovery = dependencies.recovery ?? recoveryControlService;
    this.publishRecovery =
      dependencies.publishRecovery ?? publishRecoveryStatus;
    this.publishRecoveryCollectionSuccess =
      dependencies.publishRecoveryCollectionSuccess ??
      publishRecoveryCollectionSuccess;
    this.databaseReady =
      dependencies.databaseReady ?? (() => mongoose.connection.readyState === 1);
    this.now = dependencies.now ?? Date.now;
    this.refreshIntervalMs =
      dependencies.refreshIntervalMs ?? OPERATIONAL_METRICS_REFRESH_INTERVAL_MS;
    this.collectionTimeoutMs =
      dependencies.collectionTimeoutMs ??
      OPERATIONAL_METRICS_COLLECTION_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.refreshIntervalMs) ||
      this.refreshIntervalMs < 1
    ) {
      throw new Error("Operational metrics refresh interval is invalid.");
    }
    if (
      !Number.isSafeInteger(this.collectionTimeoutMs) ||
      this.collectionTimeoutMs < 1
    ) {
      throw new Error("Operational metrics collection timeout is invalid.");
    }
  }

  async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;

    let now: number;
    try {
      now = this.now();
    } catch {
      return;
    }
    if (!Number.isFinite(now)) return;
    if (
      this.lastRefreshStartedAt !== null &&
      now >= this.lastRefreshStartedAt &&
      now - this.lastRefreshStartedAt < this.refreshIntervalMs
    ) {
      return;
    }

    this.lastRefreshStartedAt = now;
    const operation = this.performRefresh();
    this.refreshPromise = operation;
    try {
      await operation;
    } finally {
      if (this.refreshPromise === operation) this.refreshPromise = null;
    }
  }

  private async performRefresh(): Promise<void> {
    const readinessOperation = (async () => {
      try {
        await this.readiness.getSnapshot();
      } catch {
        // Metrics exposition remains available during readiness failures.
      }
    })();

    const recoveryOperation = (async () => {
      try {
        if (!this.databaseReady()) {
          this.publishRecoveryCollectionSuccess(false);
          return;
        }
        const abortController = new AbortController();
        const timeout = setTimeout(
          () =>
            abortController.abort(
              new Error("Operational metrics collection timed out."),
            ),
          this.collectionTimeoutMs,
        );
        timeout.unref?.();
        let snapshot: RecoveryStatusSnapshot;
        try {
          snapshot = await awaitWithAbort(
            this.recovery.getStatusSnapshot({
              signal: abortController.signal,
            }),
            abortController.signal,
          );
        } finally {
          clearTimeout(timeout);
        }
        this.publishRecovery(snapshot);
        this.publishRecoveryCollectionSuccess(true);
      } catch {
        this.publishRecoveryCollectionSuccess(false);
      }
    })();

    await Promise.all([readinessOperation, recoveryOperation]);
  }
}

export const operationalMonitoringService =
  new OperationalMonitoringService();
