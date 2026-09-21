export interface NotificationOutboxMetricsSnapshot {
  readonly enqueued: number;
  readonly deduplicated: number;
  readonly idempotencyConflicts: number;
  readonly claimed: number;
  readonly delivered: number;
  readonly retryScheduled: number;
  readonly deadLettered: number;
  readonly expiredLeasesRecovered: number;
  readonly unsupportedPending: number;
  readonly unsupportedDeadLettered: number;
  readonly leasesRenewed: number;
  readonly leaseLost: number;
}

type NotificationOutboxMetric = keyof NotificationOutboxMetricsSnapshot;

const EMPTY_SNAPSHOT: NotificationOutboxMetricsSnapshot = Object.freeze({
  enqueued: 0,
  deduplicated: 0,
  idempotencyConflicts: 0,
  claimed: 0,
  delivered: 0,
  retryScheduled: 0,
  deadLettered: 0,
  expiredLeasesRecovered: 0,
  unsupportedPending: 0,
  unsupportedDeadLettered: 0,
  leasesRenewed: 0,
  leaseLost: 0,
});

/** Fixed-dimension counters suitable for health output or a Prometheus bridge. */
export class NotificationOutboxMetrics {
  private counters: Record<NotificationOutboxMetric, number> = {
    ...EMPTY_SNAPSHOT,
  };

  increment(metric: NotificationOutboxMetric, amount: number = 1): void {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new Error("Notification outbox metric increment must be non-negative");
    }
    this.counters[metric] += amount;
  }

  setUnsupportedPending(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Unsupported notification backlog must be non-negative");
    }
    this.counters.unsupportedPending = value;
  }

  snapshot(): NotificationOutboxMetricsSnapshot {
    return Object.freeze({ ...this.counters });
  }

  resetForTests(): void {
    if (process.env.NODE_ENV !== "test") {
      throw new Error("Notification outbox metrics can only be reset in tests");
    }
    this.counters = { ...EMPTY_SNAPSHOT };
  }
}

export const notificationOutboxMetrics = new NotificationOutboxMetrics();
