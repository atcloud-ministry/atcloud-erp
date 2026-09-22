import { describe, expect, it, vi } from "vitest";
import { OperationalMonitoringService } from "../../../../src/services/operations/OperationalMonitoringService";

const recoverySnapshot = Object.freeze({
  operation: "notification_outbox_reconcile" as const,
  backlog: Object.freeze({ pending: 2, processing: 1, dead: 0 }),
  recoverable: Object.freeze({ expiredLeases: 1, exhaustedAttempts: 0 }),
});

describe("OperationalMonitoringService", () => {
  it("refreshes readiness and publishes a bounded recovery snapshot", async () => {
    const readiness = { getSnapshot: vi.fn().mockResolvedValue({ ready: true }) };
    const recovery = {
      getStatusSnapshot: vi.fn().mockResolvedValue(recoverySnapshot),
    };
    const publishRecovery = vi.fn();
    const publishRecoveryCollectionSuccess = vi.fn();
    const service = new OperationalMonitoringService({
      readiness,
      recovery,
      publishRecovery,
      publishRecoveryCollectionSuccess,
      databaseReady: () => true,
    });

    await expect(service.refresh()).resolves.toBeUndefined();

    expect(readiness.getSnapshot).toHaveBeenCalledOnce();
    expect(recovery.getStatusSnapshot).toHaveBeenCalledOnce();
    expect(publishRecovery).toHaveBeenCalledWith(recoverySnapshot);
    expect(publishRecoveryCollectionSuccess).toHaveBeenCalledWith(true);
  });

  it("does not query recovery state while the database is unavailable", async () => {
    const readiness = { getSnapshot: vi.fn().mockResolvedValue({ ready: false }) };
    const recovery = { getStatusSnapshot: vi.fn() };
    const publishRecoveryCollectionSuccess = vi.fn();
    const service = new OperationalMonitoringService({
      readiness,
      recovery,
      publishRecovery: vi.fn(),
      publishRecoveryCollectionSuccess,
      databaseReady: () => false,
    });

    await service.refresh();

    expect(readiness.getSnapshot).toHaveBeenCalledOnce();
    expect(recovery.getStatusSnapshot).not.toHaveBeenCalled();
    expect(publishRecoveryCollectionSuccess).toHaveBeenCalledWith(false);
  });

  it("keeps metrics exposition available when either refresh fails", async () => {
    const publishRecoveryCollectionSuccess = vi.fn();
    const service = new OperationalMonitoringService({
      readiness: {
        getSnapshot: vi.fn().mockRejectedValue(new Error("readiness failed")),
      },
      recovery: {
        getStatusSnapshot: vi.fn().mockRejectedValue(new Error("recovery failed")),
      },
      publishRecovery: vi.fn(() => {
        throw new Error("publish failed");
      }),
      publishRecoveryCollectionSuccess,
      databaseReady: () => true,
    });

    await expect(service.refresh()).resolves.toBeUndefined();
    expect(publishRecoveryCollectionSuccess).toHaveBeenCalledWith(false);
  });

  it("contains synchronous dependency failures", async () => {
    const publishRecoveryCollectionSuccess = vi.fn();
    const service = new OperationalMonitoringService({
      readiness: {
        getSnapshot: vi.fn(() => {
          throw new Error("synchronous readiness failure");
        }),
      },
      recovery: {
        getStatusSnapshot: vi.fn(() => {
          throw new Error("synchronous recovery failure");
        }),
      },
      publishRecovery: vi.fn(),
      publishRecoveryCollectionSuccess,
      databaseReady: () => true,
    });

    await expect(service.refresh()).resolves.toBeUndefined();
    expect(publishRecoveryCollectionSuccess).toHaveBeenCalledWith(false);
  });

  it("caches and coalesces collection to bound database query frequency", async () => {
    let now = 1_000;
    let releaseRecovery: ((value: typeof recoverySnapshot) => void) | undefined;
    const recoveryPromise = new Promise<typeof recoverySnapshot>((resolve) => {
      releaseRecovery = resolve;
    });
    const readiness = { getSnapshot: vi.fn().mockResolvedValue({ ready: true }) };
    const recovery = {
      getStatusSnapshot: vi.fn().mockReturnValue(recoveryPromise),
    };
    const service = new OperationalMonitoringService({
      readiness,
      recovery,
      publishRecovery: vi.fn(),
      publishRecoveryCollectionSuccess: vi.fn(),
      databaseReady: () => true,
      now: () => now,
      refreshIntervalMs: 30_000,
    });

    const first = service.refresh();
    const concurrent = service.refresh();
    expect(recovery.getStatusSnapshot).toHaveBeenCalledOnce();
    releaseRecovery?.(recoverySnapshot);
    await Promise.all([first, concurrent]);

    await service.refresh();
    expect(recovery.getStatusSnapshot).toHaveBeenCalledOnce();

    now += 30_000;
    recovery.getStatusSnapshot.mockResolvedValueOnce(recoverySnapshot);
    await service.refresh();
    expect(recovery.getStatusSnapshot).toHaveBeenCalledTimes(2);
  });

  it("bounds a stalled recovery snapshot and releases the shared refresh", async () => {
    const publishRecovery = vi.fn();
    const publishRecoveryCollectionSuccess = vi.fn();
    const recovery = {
      getStatusSnapshot: vi.fn(() => new Promise(() => undefined)),
    };
    const service = new OperationalMonitoringService({
      readiness: { getSnapshot: vi.fn().mockResolvedValue({ ready: true }) },
      recovery,
      publishRecovery,
      publishRecoveryCollectionSuccess,
      databaseReady: () => true,
      refreshIntervalMs: 1,
      collectionTimeoutMs: 5,
      now: (() => {
        let now = 0;
        return () => ++now;
      })(),
    });

    await expect(service.refresh()).resolves.toBeUndefined();
    await expect(service.refresh()).resolves.toBeUndefined();

    expect(recovery.getStatusSnapshot).toHaveBeenCalledTimes(2);
    expect(publishRecovery).not.toHaveBeenCalled();
    expect(publishRecoveryCollectionSuccess).toHaveBeenNthCalledWith(1, false);
    expect(publishRecoveryCollectionSuccess).toHaveBeenNthCalledWith(2, false);
  });
});
