import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfigSuccessDTO } from "../../../../src/contracts/runtimeConfig";
import type { ReliabilityFoundationStatusSnapshot } from "../../../../src/services/reliability/ReliabilityFoundationService";

const metricMocks = vi.hoisted(() => ({
  publishReadinessComponents: vi.fn(),
  publishAlumniNetworkMode: vi.fn(),
}));

vi.mock(
  "../../../../src/services/operations/OperationalMetricsBridge",
  () => metricMocks,
);

import { ApplicationReadinessService } from "../../../../src/services/operations/ApplicationReadinessService";

function readyReliability(): ReliabilityFoundationStatusSnapshot {
  return {
    initialized: true,
    initializationFailed: false,
    started: true,
    stopping: false,
    transactionCapability: {
      required: true,
      state: "verified",
      topology: "replica_set",
    },
    indexes: {
      idempotencyRecordReady: true,
      notificationOutboxReady: true,
    },
    notificationOutbox: {
      enabled: true,
      workerConstructed: true,
      workerStarted: true,
    },
    lastFailureCode: null,
  };
}

function runtimeConfig(
  mode: "off" | "read_only" | "on" = "on",
): RuntimeConfigSuccessDTO {
  const capabilities = {
    off: { readable: false, writable: false },
    read_only: { readable: true, writable: false },
    on: { readable: true, writable: true },
  } as const;

  return {
    success: true,
    data: {
      version: 1,
      revision: 3,
      alumniNetwork: { mode, ...capabilities[mode] },
    },
  };
}

function readyMigrations() {
  return {
    getSnapshot: vi.fn().mockResolvedValue({
      ready: true,
      appliedCount: 3,
      requiredCount: 3,
      issues: [],
    }),
  };
}

describe("ApplicationReadinessService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports ready only when every dependency is healthy", async () => {
    const getOperationalRuntimeConfig = vi
      .fn()
      .mockResolvedValue(runtimeConfig("read_only"));
    const service = new ApplicationReadinessService({
      databaseProbe: async () => true,
      featureControl: { getOperationalRuntimeConfig },
      reliability: { getStatusSnapshot: () => readyReliability() },
      migrations: readyMigrations(),
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot).toEqual({
      ready: true,
      components: {
        database: true,
        reliability: true,
        feature_control: true,
        migrations: true,
      },
      alumniNetworkMode: "read_only",
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.components)).toBe(true);
    expect(metricMocks.publishReadinessComponents).toHaveBeenCalledWith(
      snapshot.components,
    );
    expect(metricMocks.publishAlumniNetworkMode).toHaveBeenCalledWith(
      "read_only",
    );
  });

  it("fails closed when the database is unavailable", async () => {
    const getOperationalRuntimeConfig = vi.fn();
    const service = new ApplicationReadinessService({
      databaseProbe: async () => false,
      featureControl: { getOperationalRuntimeConfig },
      reliability: { getStatusSnapshot: () => readyReliability() },
      migrations: readyMigrations(),
    });

    await expect(service.getSnapshot()).resolves.toEqual({
      ready: false,
      components: {
        database: false,
        reliability: true,
        feature_control: false,
        migrations: false,
      },
      alumniNetworkMode: "off",
    });
    expect(getOperationalRuntimeConfig).not.toHaveBeenCalled();
  });

  it("reports not ready when the reliability foundation is incomplete", async () => {
    const readyStatus = readyReliability();
    const reliability: ReliabilityFoundationStatusSnapshot = {
      ...readyStatus,
      notificationOutbox: {
        ...readyStatus.notificationOutbox,
        workerStarted: false,
      },
    };
    const service = new ApplicationReadinessService({
      databaseProbe: async () => true,
      featureControl: {
        getOperationalRuntimeConfig: vi
          .fn()
          .mockResolvedValue(runtimeConfig("on")),
      },
      reliability: { getStatusSnapshot: () => reliability },
      migrations: readyMigrations(),
    });

    await expect(service.getSnapshot()).resolves.toEqual({
      ready: false,
      components: {
        database: true,
        reliability: false,
        feature_control: true,
        migrations: true,
      },
      alumniNetworkMode: "on",
    });
  });

  it("keeps the core ERP ready while feature-control fails closed", async () => {
    const service = new ApplicationReadinessService({
      databaseProbe: async () => true,
      featureControl: {
        getOperationalRuntimeConfig: vi
          .fn()
          .mockRejectedValue(new Error("private feature-control failure")),
      },
      reliability: { getStatusSnapshot: () => readyReliability() },
      migrations: readyMigrations(),
    });

    await expect(service.getSnapshot()).resolves.toEqual({
      ready: true,
      components: {
        database: true,
        reliability: true,
        feature_control: false,
        migrations: true,
      },
      alumniNetworkMode: "off",
    });
    expect(metricMocks.publishAlumniNetworkMode).toHaveBeenCalledWith("off");
  });

  it("converts synchronous dependency exceptions into a not-ready snapshot", async () => {
    const getOperationalRuntimeConfig = vi.fn();
    const service = new ApplicationReadinessService({
      databaseProbe: () => {
        throw new Error("private database failure");
      },
      featureControl: { getOperationalRuntimeConfig },
      reliability: {
        getStatusSnapshot: () => {
          throw new Error("private reliability failure");
        },
      },
      migrations: readyMigrations(),
    });

    await expect(service.getSnapshot()).resolves.toEqual({
      ready: false,
      components: {
        database: false,
        reliability: false,
        feature_control: false,
        migrations: false,
      },
      alumniNetworkMode: "off",
    });
    expect(getOperationalRuntimeConfig).not.toHaveBeenCalled();
  });

  it("bounds a stalled database probe and reports the core unavailable", async () => {
    const databaseProbe = vi.fn(() => new Promise<boolean>(() => undefined));
    const getOperationalRuntimeConfig = vi.fn();
    const service = new ApplicationReadinessService({
      databaseProbe,
      featureControl: { getOperationalRuntimeConfig },
      reliability: { getStatusSnapshot: () => readyReliability() },
      migrations: readyMigrations(),
      probeTimeoutMs: 5,
    });

    await expect(service.getSnapshot()).resolves.toMatchObject({
      ready: false,
      components: { database: false, feature_control: false },
    });
    expect(databaseProbe.mock.calls[0][0].aborted).toBe(true);
    expect(getOperationalRuntimeConfig).not.toHaveBeenCalled();
  });

  it("bounds a stalled optional feature read without taking down the core ERP", async () => {
    const getOperationalRuntimeConfig = vi.fn(
      () => new Promise<RuntimeConfigSuccessDTO>(() => undefined),
    );
    const service = new ApplicationReadinessService({
      databaseProbe: async () => true,
      featureControl: { getOperationalRuntimeConfig },
      reliability: { getStatusSnapshot: () => readyReliability() },
      migrations: readyMigrations(),
      probeTimeoutMs: 5,
    });

    await expect(service.getSnapshot()).resolves.toEqual({
      ready: true,
      components: {
        database: true,
        reliability: true,
        feature_control: false,
        migrations: true,
      },
      alumniNetworkMode: "off",
    });
    expect(getOperationalRuntimeConfig.mock.calls[0][0]?.signal?.aborted).toBe(
      true,
    );
  });

  it("coalesces concurrent probes and caches the bounded result", async () => {
    let now = 1_000;
    let releaseDatabase: ((ready: boolean) => void) | undefined;
    const databaseProbe = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          releaseDatabase = resolve;
        }),
    );
    const featureControl = {
      getOperationalRuntimeConfig: vi
        .fn()
        .mockResolvedValue(runtimeConfig("on")),
    };
    const service = new ApplicationReadinessService({
      databaseProbe,
      featureControl,
      reliability: { getStatusSnapshot: () => readyReliability() },
      migrations: readyMigrations(),
      now: () => now,
      cacheTtlMs: 2_000,
    });

    const first = service.getSnapshot();
    const concurrent = service.getSnapshot();
    expect(databaseProbe).toHaveBeenCalledOnce();
    releaseDatabase?.(true);
    await expect(Promise.all([first, concurrent])).resolves.toHaveLength(2);

    await service.getSnapshot();
    expect(databaseProbe).toHaveBeenCalledOnce();

    now += 2_000;
    databaseProbe.mockResolvedValueOnce(true);
    await service.getSnapshot();
    expect(databaseProbe).toHaveBeenCalledTimes(2);
  });
});
