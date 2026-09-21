import client from "prom-client";

// Centralized Prometheus metrics registration.
// We keep this lightweight; prom-client default metrics can be enabled if needed later.

const register = new client.Registry();

// Optional: allow disabling if ever needed via env
const ENABLE_PROM: boolean = process.env.ENABLE_PROMETHEUS !== "false";

// Short link counters
export const shortLinkCreatedCounter = new client.Counter({
  name: "short_link_created_total",
  help: "Total number of short links created (idempotent creates not counted)",
  registers: [register],
});

export const shortLinkResolveCounter = new client.Counter({
  name: "short_link_resolve_total",
  help: "Short link status resolutions by outcome",
  labelNames: ["status"],
  registers: [register],
});

export const shortLinkRedirectCounter = new client.Counter({
  name: "short_link_redirect_total",
  help: "Short link redirect outcomes (HTTP path /s/:key)",
  labelNames: ["status"],
  registers: [register],
});

export const shortLinkResolveDuration = new client.Histogram({
  name: "short_link_resolve_duration_seconds",
  help: "Duration of short link resolution handler (controller layer)",
  labelNames: ["status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [register],
});

// Short link cache metrics
export const shortLinkCacheHitCounter = new client.Counter({
  name: "short_link_cache_hits_total",
  help: "Short link cache hits by entry type (positive vs negative)",
  labelNames: ["type"],
  registers: [register],
});

export const shortLinkCacheMissCounter = new client.Counter({
  name: "short_link_cache_misses_total",
  help: "Short link cache misses (lookups not found in cache)",
  registers: [register],
});

export const shortLinkCacheEvictionCounter = new client.Counter({
  name: "short_link_cache_evictions_total",
  help: "Short link cache evictions (positive entries removed due to LRU)",
  registers: [register],
});

// Stale evictions (expired-at-lookup) – separate from LRU pressure evictions above
export const shortLinkCacheStaleEvictionCounter = new client.Counter({
  name: "short_link_cache_stale_evictions_total",
  help: "Short link cache entries evicted at lookup time because they were stale (expired lifecycle)",
  labelNames: ["reason"],
  registers: [register],
});

export const shortLinkCacheEntriesGauge = new client.Gauge({
  name: "short_link_cache_entries",
  help: "Current number of positive short link cache entries",
  registers: [register],
});

// Registration attempt counters (placeholders for negative test metrics to be instrumented later)
export const registrationAttemptCounter = new client.Counter({
  name: "registration_attempts_total",
  help: "Total registration attempts (successful + failed)",
  registers: [register],
});

export const registrationFailureCounter = new client.Counter({
  name: "registration_failures_total",
  help: "Total failed registration attempts categorized by reason",
  labelNames: ["reason"],
  registers: [register],
});

export const auditLogWriteFailureCounter = new client.Counter({
  name: "audit_log_write_failures_total",
  help: "Total best-effort audit log writes that failed",
  labelNames: ["source"],
  registers: [register],
});

export const applicationReadinessGauge = new client.Gauge({
  name: "atcloud_application_readiness",
  help: "Current readiness of fixed application components (1 ready, 0 not ready)",
  labelNames: ["component"],
  registers: [register],
});

export const alumniNetworkModeGauge = new client.Gauge({
  name: "atcloud_alumni_network_mode",
  help: "Effective Alumni Network mode represented by one active fixed label",
  labelNames: ["mode"],
  registers: [register],
});

export const notificationOutboxBacklogGauge = new client.Gauge({
  name: "atcloud_notification_outbox_backlog",
  help: "Current notification outbox records by fixed lifecycle status",
  labelNames: ["status"],
  registers: [register],
});

export const notificationOutboxRecoverableGauge = new client.Gauge({
  name: "atcloud_notification_outbox_recoverable",
  help: "Current notification outbox records eligible for a fixed recovery action",
  labelNames: ["kind"],
  registers: [register],
});

export const notificationOutboxSnapshotCollectionSuccessGauge =
  new client.Gauge({
    name: "atcloud_notification_outbox_snapshot_collection_success",
    help: "Whether the latest bounded notification outbox snapshot collection succeeded",
    registers: [register],
  });

export const recoveryOperationCounter = new client.Counter({
  name: "atcloud_recovery_operations_total",
  help: "Bounded recovery-control operations by fixed operation and outcome",
  labelNames: ["operation", "outcome"],
  registers: [register],
});

// Short link creation attempt/failure counters
export const shortLinkCreateAttemptCounter = new client.Counter({
  name: "shortlink_create_attempts_total",
  help: "Total short link creation attempts (successful + failed)",
  registers: [register],
});

export const shortLinkCreateFailureCounter = new client.Counter({
  name: "shortlink_create_failures_total",
  help: "Total short link creation failures categorized by reason",
  labelNames: ["reason"],
  registers: [register],
});

// Expire events (e.g., unpublish) for observability
export const shortLinkExpireCounter = new client.Counter({
  name: "short_link_expire_events_total",
  help: "Number of bulk short link expiration events triggered (e.g., unpublish)",
  registers: [register],
});

// Provide text exposition
export async function getMetrics(): Promise<string> {
  if (!ENABLE_PROM) return ""; // minimal guard
  return register.metrics();
}

export function isPromEnabled(): boolean {
  return ENABLE_PROM;
}

// Export register for potential external use (tests)
export { register as prometheusRegistry };
