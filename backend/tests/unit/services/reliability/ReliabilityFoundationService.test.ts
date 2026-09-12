import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationOutboxWorkerAuthorization } from "../../../../src/services/reliability/NotificationOutboxWorkerAuthorization";
import { NotificationOutboxDeliveryRegistry } from "../../../../src/services/reliability/NotificationOutboxDeliveryRegistry";
import {
  createProductionNotificationOutboxDeliveryRegistry,
  ReliabilityFoundationOperationError,
  ReliabilityFoundationService,
  type ReliabilityFoundationDependencies,
  type ReliabilityFoundationWorker,
} from "../../../../src/services/reliability/ReliabilityFoundationService";
import type { NotificationOutboxMetricsSnapshot } from "../../../../src/services/reliability/NotificationOutboxMetrics";

const CAPABILITY = Object.freeze({
  supported: true,
  topology: "replica_set" as const,
  maxWireVersion: 21,
  logicalSessionTimeoutMinutes: 30,
});

const METRICS: NotificationOutboxMetricsSnapshot = Object.freeze({
  enqueued: 3,
  deduplicated: 2,
  idempotencyConflicts: 1,
  claimed: 4,
  delivered: 3,
  retryScheduled: 1,
  deadLettered: 0,
  expiredLeasesRecovered: 2,
  unsupportedPending: 7,
  unsupportedDeadLettered: 1,
  leasesRenewed: 5,
  leaseLost: 1,
});

const originalEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  MONGO_TRANSACTIONS_REQUIRED: process.env.MONGO_TRANSACTIONS_REQUIRED,
  NOTIFICATION_OUTBOX_ENABLED: process.env.NOTIFICATION_OUTBOX_ENABLED,
};

function restoreEnvironmentValue(
  name: keyof typeof originalEnvironment,
  value: string | undefined,
): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restoreEnvironmentValue("NODE_ENV", originalEnvironment.NODE_ENV);
  restoreEnvironmentValue(
    "MONGO_TRANSACTIONS_REQUIRED",
    originalEnvironment.MONGO_TRANSACTIONS_REQUIRED,
  );
  restoreEnvironmentValue(
    "NOTIFICATION_OUTBOX_ENABLED",
    originalEnvironment.NOTIFICATION_OUTBOX_ENABLED,
  );
});

function dependencies(
  overrides: ReliabilityFoundationDependencies = {},
): ReliabilityFoundationDependencies {
  return {
    transactionService: {
      assertTopologyCapability: vi.fn().mockResolvedValue(CAPABILITY),
    },
    idempotencyRecord: { init: vi.fn().mockResolvedValue(undefined) },
    notificationOutbox: { init: vi.fn().mockResolvedValue(undefined) },
    metrics: { snapshot: () => METRICS },
    isTransactionCapabilityRequired: () => false,
    isOutboxEnabled: () => false,
    ...overrides,
  };
}

function registeredDeliveryRegistry(): NotificationOutboxDeliveryRegistry {
  return new NotificationOutboxDeliveryRegistry([
    {
      topic: "system_message.created",
      payloadVersion: 1,
      assertCanDeliver: vi.fn().mockResolvedValue(undefined),
      deliver: vi.fn().mockResolvedValue(undefined),
    },
  ]);
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

describe("ReliabilityFoundationService", () => {
  it("wires the alumni invitation email handler into the production registry", () => {
    expect(
      createProductionNotificationOutboxDeliveryRegistry().supportedDeliveries,
    ).toEqual([
      { topic: "alumni.invitation.email", payloadVersion: 1 },
    ]);
  });

  it("reads production environment at initialize time and builds a registered worker", async () => {
    process.env.NODE_ENV = "test";
    delete process.env.NOTIFICATION_OUTBOX_ENABLED;
    const transactionService = {
      assertTopologyCapability: vi.fn().mockResolvedValue(CAPABILITY),
    };
    const idempotencyRecord = {
      init: vi.fn().mockResolvedValue(undefined),
    };
    const notificationOutbox = {
      init: vi.fn().mockResolvedValue(undefined),
    };
    const worker: ReliabilityFoundationWorker = {
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const workerFactory = vi.fn(() => worker);
    const service = new ReliabilityFoundationService({
      transactionService,
      idempotencyRecord,
      notificationOutbox,
      registryFactory: registeredDeliveryRegistry,
      workerFactory,
    });

    process.env.NODE_ENV = "production";
    process.env.NOTIFICATION_OUTBOX_ENABLED = "true";
    await service.initialize();

    expect(transactionService.assertTopologyCapability).toHaveBeenCalledWith(
      true,
    );
    expect(idempotencyRecord.init).toHaveBeenCalledOnce();
    expect(notificationOutbox.init).toHaveBeenCalledOnce();
    expect(workerFactory).toHaveBeenCalledOnce();
    const workerInput = workerFactory.mock.calls[0][0];
    expect(workerInput.registry.supportedDeliveries).toEqual([
      { topic: "system_message.created", payloadVersion: 1 },
    ]);
    expect(workerInput.authorizer).toBeInstanceOf(
      NotificationOutboxWorkerAuthorization,
    );
    expect(service.getStatusSnapshot()).toMatchObject({
      initialized: true,
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
        workerStarted: false,
      },
    });
  });

  it("fails closed when outbox is enabled without a delivery handler", async () => {
    const workerFactory = vi.fn();
    const service = new ReliabilityFoundationService(
      dependencies({
        isOutboxEnabled: () => true,
        registryFactory: () => new NotificationOutboxDeliveryRegistry([]),
        workerFactory,
      }),
    );

    await expect(service.initialize()).rejects.toMatchObject({
      code: "OUTBOX_HANDLER_REGISTRY_EMPTY",
    });
    expect(workerFactory).not.toHaveBeenCalled();
    expect(service.getStatusSnapshot()).toMatchObject({
      initialized: false,
      initializationFailed: true,
      notificationOutbox: {
        enabled: true,
        workerConstructed: false,
        workerStarted: false,
      },
      lastFailureCode: "OUTBOX_HANDLER_REGISTRY_EMPTY",
    });
  });

  it("shares concurrent initialization and initializes each required index once", async () => {
    const gate = deferred();
    const idempotencyRecord = { init: vi.fn(() => gate.promise) };
    const notificationOutbox = {
      init: vi.fn().mockResolvedValue(undefined),
    };
    const transactionRequired = vi.fn(() => false);
    const outboxEnabled = vi.fn(() => false);
    const service = new ReliabilityFoundationService(
      dependencies({
        idempotencyRecord,
        notificationOutbox,
        isTransactionCapabilityRequired: transactionRequired,
        isOutboxEnabled: outboxEnabled,
      }),
    );

    const first = service.initialize();
    const second = service.initialize();
    expect(first).toBe(second);
    expect(idempotencyRecord.init).toHaveBeenCalledOnce();

    gate.resolve();
    await Promise.all([first, second, service.initialize()]);

    expect(idempotencyRecord.init).toHaveBeenCalledOnce();
    expect(notificationOutbox.init).toHaveBeenCalledOnce();
    expect(transactionRequired).toHaveBeenCalledOnce();
    expect(outboxEnabled).toHaveBeenCalledOnce();
  });

  it("fails closed before index or worker setup when transaction capability cannot be proven", async () => {
    const sensitiveCause = new Error(
      "mongodb+srv://private-user:private-password@example.invalid",
    );
    const transactionService = {
      assertTopologyCapability: vi.fn().mockRejectedValue(sensitiveCause),
    };
    const idempotencyRecord = { init: vi.fn() };
    const notificationOutbox = { init: vi.fn() };
    const workerFactory = vi.fn();
    const service = new ReliabilityFoundationService(
      dependencies({
        transactionService,
        idempotencyRecord,
        notificationOutbox,
        workerFactory,
        isTransactionCapabilityRequired: () => true,
        isOutboxEnabled: () => true,
      }),
    );

    const firstFailure = await service.initialize().catch((error) => error);
    const secondFailure = await service.initialize().catch((error) => error);

    expect(firstFailure).toBe(secondFailure);
    expect(firstFailure).toBeInstanceOf(ReliabilityFoundationOperationError);
    expect(firstFailure).toMatchObject({
      code: "TRANSACTION_CAPABILITY_CHECK_FAILED",
      cause: sensitiveCause,
    });
    expect(Object.keys(firstFailure as object)).not.toContain("cause");
    expect(JSON.stringify(firstFailure)).not.toContain("private-password");
    expect(idempotencyRecord.init).not.toHaveBeenCalled();
    expect(notificationOutbox.init).not.toHaveBeenCalled();
    expect(workerFactory).not.toHaveBeenCalled();
    expect(transactionService.assertTopologyCapability).toHaveBeenCalledOnce();
    const serializedStatus = JSON.stringify(service.getSnapshot());
    expect(serializedStatus).not.toContain("private-user");
    expect(serializedStatus).not.toContain("private-password");
    expect(service.getStatusSnapshot()).toMatchObject({
      initialized: false,
      initializationFailed: true,
      transactionCapability: { required: true, state: "failed" },
      lastFailureCode: "TRANSACTION_CAPABILITY_CHECK_FAILED",
    });
  });

  it("reports partial index readiness and does not construct a worker after an index failure", async () => {
    const idempotencyRecord = {
      init: vi.fn().mockResolvedValue(undefined),
    };
    const notificationOutbox = {
      init: vi.fn().mockRejectedValue(new Error("index build failed")),
    };
    const workerFactory = vi.fn();
    const service = new ReliabilityFoundationService(
      dependencies({
        idempotencyRecord,
        notificationOutbox,
        workerFactory,
        isOutboxEnabled: () => true,
      }),
    );

    await expect(service.initialize()).rejects.toMatchObject({
      code: "OUTBOX_INDEX_INITIALIZATION_FAILED",
    });
    expect(workerFactory).not.toHaveBeenCalled();
    expect(service.getStatusSnapshot()).toMatchObject({
      initialized: false,
      initializationFailed: true,
      indexes: {
        idempotencyRecordReady: true,
        notificationOutboxReady: false,
      },
      lastFailureCode: "OUTBOX_INDEX_INITIALIZATION_FAILED",
    });
  });

  it("requires initialization, starts once, and waits for the worker drain on stop", async () => {
    const drain = deferred();
    const worker: ReliabilityFoundationWorker = {
      start: vi.fn(),
      stop: vi
        .fn()
        .mockImplementationOnce(() => drain.promise)
        .mockResolvedValue(undefined),
    };
    const service = new ReliabilityFoundationService(
      dependencies({
        isOutboxEnabled: () => true,
        registryFactory: registeredDeliveryRegistry,
        workerFactory: () => worker,
      }),
    );

    expect(() => service.start()).toThrow("must be initialized");
    await service.initialize();
    service.start();
    service.start();
    expect(worker.start).toHaveBeenCalledOnce();

    let stopped = false;
    const firstStop = service.stop().then(() => {
      stopped = true;
    });
    const secondStop = service.stop();
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(worker.stop).toHaveBeenCalledOnce();
    expect(service.getStatusSnapshot().stopping).toBe(true);
    expect(() => service.start()).toThrow("while stopping");

    drain.resolve();
    await Promise.all([firstStop, secondStop]);
    expect(service.getStatusSnapshot()).toMatchObject({
      initialized: true,
      started: false,
      stopping: false,
      notificationOutbox: { workerStarted: false },
    });

    service.start();
    expect(worker.start).toHaveBeenCalledTimes(2);
    await service.stop();
    await service.stop();
    expect(worker.stop).toHaveBeenCalledTimes(2);
  });

  it("starts and stops idempotently when the worker is disabled", async () => {
    const workerFactory = vi.fn();
    const service = new ReliabilityFoundationService(
      dependencies({ workerFactory, isOutboxEnabled: () => false }),
    );

    await service.initialize();
    service.start();
    service.start();
    expect(workerFactory).not.toHaveBeenCalled();
    expect(service.getStatusSnapshot()).toMatchObject({
      started: true,
      notificationOutbox: {
        enabled: false,
        workerConstructed: false,
        workerStarted: false,
      },
    });

    await service.stop();
    await service.stop();
    expect(service.getStatusSnapshot().started).toBe(false);
  });

  it("returns frozen fixed-dimension status and metrics snapshots", async () => {
    const service = new ReliabilityFoundationService(dependencies());
    await service.initialize();

    const snapshot = service.getSnapshot();
    expect(snapshot.metrics).toEqual(METRICS);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.status)).toBe(true);
    expect(Object.isFrozen(snapshot.status.indexes)).toBe(true);
    expect(Object.isFrozen(snapshot.metrics)).toBe(true);
    expect(Object.keys(snapshot.metrics).sort()).toEqual(
      Object.keys(METRICS).sort(),
    );
  });
});
