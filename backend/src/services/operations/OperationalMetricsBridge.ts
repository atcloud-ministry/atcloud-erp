import type { AlumniNetworkMode } from "../../config/alumniNetworkFeature";
import {
  alumniNetworkModeGauge,
  applicationReadinessGauge,
  notificationOutboxBacklogGauge,
  notificationOutboxRecoverableGauge,
  notificationOutboxSnapshotCollectionSuccessGauge,
  recoveryOperationCounter,
} from "../PrometheusMetricsService";
import {
  RECOVERY_OPERATION,
  type RecoveryStatusSnapshot,
} from "./RecoveryControlService";

export const READINESS_COMPONENTS = [
  "database",
  "reliability",
  "feature_control",
  "migrations",
] as const;
export type ReadinessComponent = (typeof READINESS_COMPONENTS)[number];

export type RecoveryOperationOutcome =
  | "success"
  | "replay"
  | "invalid"
  | "conflict"
  | "uncertain"
  | "failure";

/** Fixed-cardinality bridge. Metric failures never affect application work. */
export function publishAlumniNetworkMode(mode: AlumniNetworkMode): void {
  try {
    for (const candidate of ["off", "read_only", "on"] as const) {
      alumniNetworkModeGauge.labels(candidate).set(candidate === mode ? 1 : 0);
    }
  } catch {
    // Operational telemetry is secondary to the authoritative feature gate.
  }
}

export function publishReadinessComponents(
  components: Readonly<Record<ReadinessComponent, boolean>>,
): void {
  try {
    for (const component of READINESS_COMPONENTS) {
      applicationReadinessGauge
        .labels(component)
        .set(components[component] ? 1 : 0);
    }
  } catch {
    // A metrics registry failure must not change readiness evaluation.
  }
}

export function publishRecoveryStatus(
  snapshot: RecoveryStatusSnapshot,
): void {
  try {
    notificationOutboxBacklogGauge
      .labels("pending")
      .set(snapshot.backlog.pending);
    notificationOutboxBacklogGauge
      .labels("processing")
      .set(snapshot.backlog.processing);
    notificationOutboxBacklogGauge.labels("dead").set(snapshot.backlog.dead);
    notificationOutboxRecoverableGauge
      .labels("expired_lease")
      .set(snapshot.recoverable.expiredLeases);
    notificationOutboxRecoverableGauge
      .labels("exhausted_attempts")
      .set(snapshot.recoverable.exhaustedAttempts);
  } catch {
    // A metrics registry failure must not change recovery behavior.
  }
}

export function publishRecoveryCollectionSuccess(success: boolean): void {
  try {
    notificationOutboxSnapshotCollectionSuccessGauge.set(success ? 1 : 0);
  } catch {
    // Snapshot availability must not change application work.
  }
}

export function recordRecoveryOperation(
  outcome: RecoveryOperationOutcome,
): void {
  try {
    recoveryOperationCounter.inc({
      operation: RECOVERY_OPERATION,
      outcome,
    });
  } catch {
    // Recovery remains available when telemetry is unavailable.
  }
}
