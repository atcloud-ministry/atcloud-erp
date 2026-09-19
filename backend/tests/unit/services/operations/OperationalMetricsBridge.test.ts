import { describe, expect, it } from "vitest";
import { getMetrics } from "../../../../src/services/PrometheusMetricsService";
import {
  publishAlumniNetworkMode,
  publishReadinessComponents,
  publishRecoveryCollectionSuccess,
  publishRecoveryStatus,
  recordRecoveryOperation,
} from "../../../../src/services/operations/OperationalMetricsBridge";

describe("OperationalMetricsBridge", () => {
  it("publishes only fixed, low-cardinality operational labels", async () => {
    publishAlumniNetworkMode("read_only");
    publishReadinessComponents({
      database: true,
      reliability: true,
      feature_control: false,
      migrations: true,
    });
    publishRecoveryStatus({
      operation: "notification_outbox_reconcile",
      backlog: { pending: 3, processing: 2, dead: 1 },
      recoverable: { expiredLeases: 2, exhaustedAttempts: 1 },
    });
    publishRecoveryCollectionSuccess(true);
    recordRecoveryOperation("success");

    const metrics = await getMetrics();

    expect(metrics).toContain(
      'atcloud_alumni_network_mode{mode="read_only"} 1',
    );
    expect(metrics).toContain(
      'atcloud_application_readiness{component="database"} 1',
    );
    expect(metrics).toContain(
      'atcloud_application_readiness{component="feature_control"} 0',
    );
    expect(metrics).toContain(
      'atcloud_application_readiness{component="migrations"} 1',
    );
    expect(metrics).toContain(
      'atcloud_notification_outbox_backlog{status="pending"} 3',
    );
    expect(metrics).toContain(
      'atcloud_notification_outbox_recoverable{kind="expired_lease"} 2',
    );
    expect(metrics).toContain(
      "atcloud_notification_outbox_snapshot_collection_success 1",
    );
    expect(metrics).toMatch(
      /atcloud_recovery_operations_total\{operation="notification_outbox_reconcile",outcome="success"\} [1-9]\d*/,
    );
    expect(metrics).not.toContain("userId");
    expect(metrics).not.toContain("email");
  });
});
