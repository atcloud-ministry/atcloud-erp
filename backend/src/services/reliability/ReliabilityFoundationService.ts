import {
  isMongoTransactionCapabilityRequired,
  isNotificationOutboxEnabled,
} from "../../config/reliability";
import IdempotencyRecord from "../../models/IdempotencyRecord";
import NotificationOutbox from "../../models/NotificationOutbox";
import { alumniInvitationEmailDeliveryHandler } from "../alumni/AlumniInvitationEmailDeliveryHandler";
import { alumniHelpWorkflowDeliveryHandler } from "../alumni/AlumniHelpWorkflowDeliveryHandler";
import { chatMessageDeliveryHandler } from "../chat/ChatMessageDeliveryHandler";
import {
  mongoTransactionService,
  type MongoTransactionService,
  type MongoTransactionTopologyCapability,
} from "./MongoTransactionService";
import { NotificationOutboxDeliveryRegistry } from "./NotificationOutboxDeliveryRegistry";
import {
  notificationOutboxMetrics,
  type NotificationOutboxMetrics,
  type NotificationOutboxMetricsSnapshot,
} from "./NotificationOutboxMetrics";
import {
  notificationOutboxService,
  type NotificationOutboxService,
} from "./NotificationOutboxService";
import {
  NotificationOutboxWorker,
  type NotificationOutboxWorkerAuthorizer,
} from "./NotificationOutboxWorker";
import { NotificationOutboxWorkerAuthorization } from "./NotificationOutboxWorkerAuthorization";

export type ReliabilityFoundationFailureCode =
  | "CONFIGURATION_READ_FAILED"
  | "TRANSACTION_CAPABILITY_CHECK_FAILED"
  | "IDEMPOTENCY_INDEX_INITIALIZATION_FAILED"
  | "OUTBOX_INDEX_INITIALIZATION_FAILED"
  | "OUTBOX_HANDLER_REGISTRY_EMPTY"
  | "OUTBOX_WORKER_CONSTRUCTION_FAILED"
  | "OUTBOX_WORKER_START_FAILED"
  | "OUTBOX_WORKER_STOP_FAILED";

export type ReliabilityTransactionCapabilityState =
  | "not_checked"
  | "not_required"
  | "verified"
  | "failed";

export interface ReliabilityFoundationStatusSnapshot {
  readonly initialized: boolean;
  readonly initializationFailed: boolean;
  readonly started: boolean;
  readonly stopping: boolean;
  readonly transactionCapability: {
    readonly required: boolean | null;
    readonly state: ReliabilityTransactionCapabilityState;
    readonly topology: MongoTransactionTopologyCapability["topology"] | null;
  };
  readonly indexes: {
    readonly idempotencyRecordReady: boolean;
    readonly notificationOutboxReady: boolean;
  };
  readonly notificationOutbox: {
    readonly enabled: boolean | null;
    readonly workerConstructed: boolean;
    readonly workerStarted: boolean;
  };
  readonly lastFailureCode: ReliabilityFoundationFailureCode | null;
}

export interface ReliabilityFoundationSnapshot {
  readonly status: ReliabilityFoundationStatusSnapshot;
  readonly metrics: NotificationOutboxMetricsSnapshot;
}

interface IndexInitializer {
  init(): Promise<unknown>;
}

export interface ReliabilityFoundationWorker {
  start(): void;
  stop(): Promise<void>;
}

type ReliabilityOutboxWorkerPort = Pick<
  NotificationOutboxService,
  | "leaseDurationMs"
  | "claimNext"
  | "renewLease"
  | "deferClaim"
  | "finalizeDelivered"
  | "finalizeFailure"
  | "reconcile"
  | "reconcileUnsupportedDeliveries"
>;

export interface ReliabilityFoundationWorkerFactoryInput {
  readonly outbox: ReliabilityOutboxWorkerPort;
  readonly registry: NotificationOutboxDeliveryRegistry;
  readonly authorizer: NotificationOutboxWorkerAuthorizer;
}

export interface ReliabilityFoundationDependencies {
  readonly transactionService?: Pick<
    MongoTransactionService,
    "assertTopologyCapability"
  >;
  readonly idempotencyRecord?: IndexInitializer;
  readonly notificationOutbox?: IndexInitializer;
  readonly outboxService?: ReliabilityOutboxWorkerPort;
  readonly metrics?: Pick<NotificationOutboxMetrics, "snapshot">;
  readonly isTransactionCapabilityRequired?: () => boolean;
  readonly isOutboxEnabled?: () => boolean;
  readonly registryFactory?: () => NotificationOutboxDeliveryRegistry;
  readonly authorizerFactory?: () => NotificationOutboxWorkerAuthorizer;
  readonly workerFactory?: (
    input: ReliabilityFoundationWorkerFactoryInput,
  ) => ReliabilityFoundationWorker;
}

interface ResolvedReliabilityFoundationDependencies {
  readonly transactionService: Pick<
    MongoTransactionService,
    "assertTopologyCapability"
  >;
  readonly idempotencyRecord: IndexInitializer;
  readonly notificationOutbox: IndexInitializer;
  readonly outboxService: ReliabilityOutboxWorkerPort;
  readonly metrics: Pick<NotificationOutboxMetrics, "snapshot">;
  readonly isTransactionCapabilityRequired: () => boolean;
  readonly isOutboxEnabled: () => boolean;
  readonly registryFactory: () => NotificationOutboxDeliveryRegistry;
  readonly authorizerFactory: () => NotificationOutboxWorkerAuthorizer;
  readonly workerFactory: (
    input: ReliabilityFoundationWorkerFactoryInput,
  ) => ReliabilityFoundationWorker;
}

export class ReliabilityFoundationOperationError extends Error {
  readonly name = "ReliabilityFoundationOperationError";
  readonly cause: unknown;

  constructor(
    public readonly code: ReliabilityFoundationFailureCode,
    cause: unknown,
  ) {
    super(`Reliability foundation operation failed (${code})`);
    Object.defineProperty(this, "cause", {
      value: cause,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  transactionService: mongoTransactionService,
  idempotencyRecord: IdempotencyRecord,
  notificationOutbox: NotificationOutbox,
  outboxService: notificationOutboxService,
  metrics: notificationOutboxMetrics,
  // These callbacks deliberately read process.env only when initialize runs.
  isTransactionCapabilityRequired: () =>
    isMongoTransactionCapabilityRequired(),
  isOutboxEnabled: () => isNotificationOutboxEnabled(),
  registryFactory: createProductionNotificationOutboxDeliveryRegistry,
  authorizerFactory: () => new NotificationOutboxWorkerAuthorization(),
  workerFactory: (input: ReliabilityFoundationWorkerFactoryInput) =>
    new NotificationOutboxWorker(input),
});

export function createProductionNotificationOutboxDeliveryRegistry(): NotificationOutboxDeliveryRegistry {
  return new NotificationOutboxDeliveryRegistry([
    alumniInvitationEmailDeliveryHandler,
    alumniHelpWorkflowDeliveryHandler,
    chatMessageDeliveryHandler,
  ]);
}

/**
 * Coordinates the fail-closed startup contract for transaction capability,
 * reliability indexes, and the durable notification worker. No work starts at
 * module import time, so dotenv may safely load before initialize is called.
 */
export class ReliabilityFoundationService {
  private readonly dependencies: ResolvedReliabilityFoundationDependencies;
  private initializePromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private worker: ReliabilityFoundationWorker | null = null;
  private initialized = false;
  private initializationFailed = false;
  private started = false;
  private stopping = false;
  private transactionRequired: boolean | null = null;
  private transactionState: ReliabilityTransactionCapabilityState =
    "not_checked";
  private transactionTopology:
    | MongoTransactionTopologyCapability["topology"]
    | null = null;
  private idempotencyRecordReady = false;
  private notificationOutboxReady = false;
  private outboxEnabled: boolean | null = null;
  private workerStarted = false;
  private lastFailureCode: ReliabilityFoundationFailureCode | null = null;

  constructor(dependencies: ReliabilityFoundationDependencies = {}) {
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  }

  initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = this.performInitialize();
    }
    return this.initializePromise;
  }

  start(): void {
    if (!this.initialized) {
      throw new Error(
        "Reliability foundation must be initialized before it can start",
      );
    }
    if (this.stopping) {
      throw new Error("Reliability foundation cannot start while stopping");
    }
    if (this.started) return;

    try {
      this.worker?.start();
      this.workerStarted = this.worker !== null;
      this.started = true;
      this.stopPromise = null;
    } catch (cause) {
      this.lastFailureCode = "OUTBOX_WORKER_START_FAILED";
      throw new ReliabilityFoundationOperationError(
        "OUTBOX_WORKER_START_FAILED",
        cause,
      );
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.started) return Promise.resolve();

    const operation = this.performStop();
    this.stopPromise = operation;
    void operation
      .finally(() => {
        if (this.stopPromise === operation) this.stopPromise = null;
      })
      .catch(() => undefined);
    return operation;
  }

  getStatusSnapshot(): ReliabilityFoundationStatusSnapshot {
    return Object.freeze({
      initialized: this.initialized,
      initializationFailed: this.initializationFailed,
      started: this.started,
      stopping: this.stopping,
      transactionCapability: Object.freeze({
        required: this.transactionRequired,
        state: this.transactionState,
        topology: this.transactionTopology,
      }),
      indexes: Object.freeze({
        idempotencyRecordReady: this.idempotencyRecordReady,
        notificationOutboxReady: this.notificationOutboxReady,
      }),
      notificationOutbox: Object.freeze({
        enabled: this.outboxEnabled,
        workerConstructed: this.worker !== null,
        workerStarted: this.workerStarted,
      }),
      lastFailureCode: this.lastFailureCode,
    });
  }

  getMetricsSnapshot(): NotificationOutboxMetricsSnapshot {
    return Object.freeze({ ...this.dependencies.metrics.snapshot() });
  }

  getSnapshot(): ReliabilityFoundationSnapshot {
    return Object.freeze({
      status: this.getStatusSnapshot(),
      metrics: this.getMetricsSnapshot(),
    });
  }

  private async performInitialize(): Promise<void> {
    let failureCode: ReliabilityFoundationFailureCode =
      "CONFIGURATION_READ_FAILED";
    try {
      this.transactionRequired =
        this.dependencies.isTransactionCapabilityRequired();
      this.outboxEnabled = this.dependencies.isOutboxEnabled();

      if (this.transactionRequired) {
        failureCode = "TRANSACTION_CAPABILITY_CHECK_FAILED";
        const capability =
          await this.dependencies.transactionService.assertTopologyCapability(
            true,
          );
        if (!capability.supported) {
          throw new Error("MongoDB transaction capability is unsupported");
        }
        this.transactionState = "verified";
        this.transactionTopology = capability.topology;
      } else {
        this.transactionState = "not_required";
      }

      failureCode = "IDEMPOTENCY_INDEX_INITIALIZATION_FAILED";
      await this.dependencies.idempotencyRecord.init();
      this.idempotencyRecordReady = true;

      failureCode = "OUTBOX_INDEX_INITIALIZATION_FAILED";
      await this.dependencies.notificationOutbox.init();
      this.notificationOutboxReady = true;

      if (this.outboxEnabled) {
        failureCode = "OUTBOX_WORKER_CONSTRUCTION_FAILED";
        const registry = this.dependencies.registryFactory();
        if (registry.supportedDeliveries.length === 0) {
          failureCode = "OUTBOX_HANDLER_REGISTRY_EMPTY";
          throw new Error(
            "Notification outbox cannot start without a registered delivery handler",
          );
        }
        const authorizer = this.dependencies.authorizerFactory();
        this.worker = this.dependencies.workerFactory({
          outbox: this.dependencies.outboxService,
          registry,
          authorizer,
        });
      }

      this.initialized = true;
      this.lastFailureCode = null;
    } catch (cause) {
      if (failureCode === "TRANSACTION_CAPABILITY_CHECK_FAILED") {
        this.transactionState = "failed";
      }
      this.initializationFailed = true;
      this.lastFailureCode = failureCode;
      throw new ReliabilityFoundationOperationError(failureCode, cause);
    }
  }

  private async performStop(): Promise<void> {
    this.stopping = true;
    try {
      if (this.workerStarted && this.worker) await this.worker.stop();
      this.workerStarted = false;
      this.started = false;
    } catch (cause) {
      this.lastFailureCode = "OUTBOX_WORKER_STOP_FAILED";
      throw new ReliabilityFoundationOperationError(
        "OUTBOX_WORKER_STOP_FAILED",
        cause,
      );
    } finally {
      this.stopping = false;
    }
  }
}

export const reliabilityFoundationService = new ReliabilityFoundationService();
