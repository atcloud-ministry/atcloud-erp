import mongoose from "mongoose";
import type { AlumniNetworkMode } from "../../config/alumniNetworkFeature";
import type { RuntimeConfigSuccessDTO } from "../../contracts/runtimeConfig";
import {
  featureControlService,
  type FeatureControlService,
} from "../runtime/FeatureControlService";
import {
  reliabilityFoundationService,
  type ReliabilityFoundationStatusSnapshot,
} from "../reliability/ReliabilityFoundationService";
import {
  publishAlumniNetworkMode,
  publishReadinessComponents,
  type ReadinessComponent,
} from "./OperationalMetricsBridge";
import { awaitWithAbort } from "../../utils/abortablePromise";

export interface ApplicationReadinessSnapshot {
  readonly ready: boolean;
  readonly components: Readonly<Record<ReadinessComponent, boolean>>;
  readonly alumniNetworkMode: AlumniNetworkMode;
}

interface FeatureControlReadinessPort {
  getOperationalRuntimeConfig(options?: {
    readonly signal?: AbortSignal;
  }): Promise<RuntimeConfigSuccessDTO>;
}

interface ReliabilityReadinessPort {
  getStatusSnapshot(): ReliabilityFoundationStatusSnapshot;
}

export interface ApplicationReadinessDependencies {
  readonly databaseProbe?: (signal: AbortSignal) => Promise<boolean>;
  readonly featureControl?: FeatureControlReadinessPort;
  readonly reliability?: ReliabilityReadinessPort;
  readonly probeTimeoutMs?: number;
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}

export const APPLICATION_READINESS_PROBE_TIMEOUT_MS = 2_000;
export const APPLICATION_READINESS_CACHE_TTL_MS = 2_000;
const DATABASE_PING_TIMEOUT_MS = 1_500;

async function probeMongoDatabase(signal: AbortSignal): Promise<boolean> {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    return false;
  }
  await mongoose.connection.db.command(
    { ping: 1 },
    { timeoutMS: DATABASE_PING_TIMEOUT_MS, signal },
  );
  return true;
}

function isReliabilityReady(
  status: ReliabilityFoundationStatusSnapshot,
): boolean {
  const transactionReady =
    status.transactionCapability.state === "verified" ||
    status.transactionCapability.state === "not_required";
  const workerReady =
    status.notificationOutbox.enabled !== true ||
    status.notificationOutbox.workerStarted;

  return (
    status.initialized &&
    !status.initializationFailed &&
    status.started &&
    !status.stopping &&
    transactionReady &&
    status.indexes.idempotencyRecordReady &&
    status.indexes.notificationOutboxReady &&
    workerReady &&
    status.lastFailureCode === null
  );
}

export class ApplicationReadinessService {
  private readonly databaseProbe: (signal: AbortSignal) => Promise<boolean>;
  private readonly featureControl: FeatureControlReadinessPort;
  private readonly reliability: ReliabilityReadinessPort;
  private readonly probeTimeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private cachedSnapshot: {
    readonly collectedAt: number;
    readonly value: ApplicationReadinessSnapshot;
  } | null = null;
  private snapshotPromise: Promise<ApplicationReadinessSnapshot> | null = null;

  constructor(dependencies: ApplicationReadinessDependencies = {}) {
    this.databaseProbe = dependencies.databaseProbe ?? probeMongoDatabase;
    this.featureControl =
      dependencies.featureControl ??
      (featureControlService as Pick<
        FeatureControlService,
        "getOperationalRuntimeConfig"
      >);
    this.reliability = dependencies.reliability ?? reliabilityFoundationService;
    this.probeTimeoutMs =
      dependencies.probeTimeoutMs ?? APPLICATION_READINESS_PROBE_TIMEOUT_MS;
    this.cacheTtlMs =
      dependencies.cacheTtlMs ?? APPLICATION_READINESS_CACHE_TTL_MS;
    this.now = dependencies.now ?? Date.now;
    if (!Number.isSafeInteger(this.probeTimeoutMs) || this.probeTimeoutMs < 1) {
      throw new Error("Application readiness probe timeout is invalid.");
    }
    if (!Number.isSafeInteger(this.cacheTtlMs) || this.cacheTtlMs < 1) {
      throw new Error("Application readiness cache TTL is invalid.");
    }
  }

  async getSnapshot(): Promise<ApplicationReadinessSnapshot> {
    if (this.snapshotPromise) return this.snapshotPromise;

    const now = this.now();
    if (
      this.cachedSnapshot &&
      Number.isFinite(now) &&
      now >= this.cachedSnapshot.collectedAt &&
      now - this.cachedSnapshot.collectedAt < this.cacheTtlMs
    ) {
      return this.cachedSnapshot.value;
    }

    const operation = this.evaluateSnapshot();
    this.snapshotPromise = operation;
    try {
      const value = await operation;
      let collectedAt = Date.now();
      try {
        const completedAt = this.now();
        if (Number.isFinite(completedAt)) collectedAt = completedAt;
      } catch {
        // The readiness result remains valid when an injected clock fails.
      }
      this.cachedSnapshot = {
        collectedAt,
        value,
      };
      return value;
    } finally {
      if (this.snapshotPromise === operation) this.snapshotPromise = null;
    }
  }

  private async evaluateSnapshot(): Promise<ApplicationReadinessSnapshot> {
    let database = false;
    let reliability = false;
    let featureControl = false;
    let alumniNetworkMode: AlumniNetworkMode = "off";

    try {
      reliability = isReliabilityReady(this.reliability.getStatusSnapshot());
    } catch {
      reliability = false;
    }

    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(new Error("Readiness probe timed out.")),
      this.probeTimeoutMs,
    );
    timeout.unref?.();
    try {
      try {
        database =
          (await awaitWithAbort(
            this.databaseProbe(abortController.signal),
            abortController.signal,
          )) === true;
      } catch {
        database = false;
      }

      if (database) {
        try {
          const runtime = await awaitWithAbort(
            this.featureControl.getOperationalRuntimeConfig({
              signal: abortController.signal,
            }),
            abortController.signal,
          );
          alumniNetworkMode = runtime.data.alumniNetwork.mode;
          featureControl = true;
        } catch {
          featureControl = false;
          alumniNetworkMode = "off";
        }
      }
    } finally {
      clearTimeout(timeout);
    }

    const components = Object.freeze({
      database,
      reliability,
      feature_control: featureControl,
    });
    publishReadinessComponents(components);
    publishAlumniNetworkMode(alumniNetworkMode);

    return Object.freeze({
      // Alumni Network has its own fail-closed gate. Its control-plane health
      // remains observable without taking the existing ERP out of rotation.
      ready: database && reliability,
      components,
      alumniNetworkMode,
    });
  }
}

export const applicationReadinessService = new ApplicationReadinessService();
