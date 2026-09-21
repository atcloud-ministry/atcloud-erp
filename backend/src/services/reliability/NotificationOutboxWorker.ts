import { randomUUID } from "crypto";
import { hostname } from "os";
import { createLogger } from "../LoggerService";
import {
  NotificationOutboxLeaseLostError,
  type ClaimedNotificationOutbox,
  type NotificationOutboxFailure,
  type NotificationOutboxReconciliationResult,
  type NotificationOutboxService,
  type NotificationOutboxUnsupportedReconciliationResult,
  type SupportedOutboxDelivery,
} from "./NotificationOutboxService";
import { NotificationOutboxDeliveryRegistry } from "./NotificationOutboxDeliveryRegistry";

export interface NotificationOutboxWorkerAuthorizer {
  assertCanReconcile(signal?: AbortSignal): Promise<void>;
  assertCanDeliver(event: ClaimedNotificationOutbox): Promise<void>;
}

export interface NotificationOutboxWorkerConfig {
  readonly pollIntervalMs: number;
  readonly maxIdlePollIntervalMs: number;
  readonly batchSize: number;
  readonly reconciliationLimit: number;
  readonly reconciliationIntervalMs: number;
  readonly unsupportedDeliveryGraceMs: number;
  readonly authorizationTimeoutMs: number;
  readonly heartbeatIntervalMs: number;
  readonly deliveryTimeoutMs: number;
  readonly stopTimeoutMs: number;
}

export interface NotificationOutboxWorkerRunResult
  extends NotificationOutboxReconciliationResult,
    NotificationOutboxUnsupportedReconciliationResult {
  readonly reconciliationPerformed: boolean;
  readonly claimed: number;
  readonly delivered: number;
  readonly retried: number;
  readonly deadLettered: number;
  readonly leaseLost: number;
  readonly abandoned: number;
  readonly deferred: number;
}

type MutableNotificationOutboxWorkerRunResult = {
  -readonly [Key in keyof NotificationOutboxWorkerRunResult]: NotificationOutboxWorkerRunResult[Key];
};

export interface NotificationOutboxWorkerTimers {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): NodeJS.Timeout;
  clearTimeout(timer: NodeJS.Timeout): void;
  setInterval(callback: () => void, delayMs: number): NodeJS.Timeout;
  clearInterval(timer: NodeJS.Timeout): void;
}

interface NotificationOutboxWorkerDependencies {
  readonly outbox: Pick<
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
  readonly registry: NotificationOutboxDeliveryRegistry;
  readonly authorizer: NotificationOutboxWorkerAuthorizer;
  readonly workerId?: string;
  readonly config?: Partial<NotificationOutboxWorkerConfig>;
  readonly classifyFailure?: (error: unknown) => NotificationOutboxFailure;
  readonly timers?: NotificationOutboxWorkerTimers;
}

export const NOTIFICATION_OUTBOX_WORKER_DEFAULT_BATCH_SIZE = 100;

const DEFAULT_CONFIG: NotificationOutboxWorkerConfig = Object.freeze({
  pollIntervalMs: 1_000,
  maxIdlePollIntervalMs: 30_000,
  batchSize: NOTIFICATION_OUTBOX_WORKER_DEFAULT_BATCH_SIZE,
  reconciliationLimit: 100,
  reconciliationIntervalMs: 60_000,
  unsupportedDeliveryGraceMs: 24 * 60 * 60_000,
  authorizationTimeoutMs: 10_000,
  heartbeatIntervalMs: 15_000,
  deliveryTimeoutMs: 45_000,
  stopTimeoutMs: 10_000,
});

const SYSTEM_TIMERS: NotificationOutboxWorkerTimers = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback: () => void, delayMs: number) =>
    setTimeout(callback, delayMs),
  clearTimeout: (timer: NodeJS.Timeout) => clearTimeout(timer),
  setInterval: (callback: () => void, delayMs: number) =>
    setInterval(callback, delayMs),
  clearInterval: (timer: NodeJS.Timeout) => clearInterval(timer),
});

export class PermanentNotificationOutboxDeliveryError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "PermanentNotificationOutboxDeliveryError";
  }
}

export class RetryableNotificationOutboxDeliveryError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "RetryableNotificationOutboxDeliveryError";
  }
}

/** A runtime delivery gate changed after claim; release without an attempt. */
export class DeferredNotificationOutboxDeliveryError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "DeferredNotificationOutboxDeliveryError";
  }
}

class NotificationOutboxWorkerStoppingError extends Error {
  constructor() {
    super("Notification outbox worker is stopping");
    this.name = "NotificationOutboxWorkerStoppingError";
  }
}

function defaultClassifyFailure(error: unknown): NotificationOutboxFailure {
  if (error instanceof PermanentNotificationOutboxDeliveryError) {
    return { code: error.code, retryable: false, cause: error };
  }
  if (error instanceof RetryableNotificationOutboxDeliveryError) {
    return { code: error.code, retryable: true, cause: error };
  }
  return { code: "DELIVERY_FAILED", retryable: true, cause: error };
}

function requirePositiveInteger(
  value: number,
  name: keyof NotificationOutboxWorkerConfig,
  max: number,
): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new Error(`Notification outbox worker ${name} is invalid`);
  }
  return value;
}

function defaultWorkerId(): string {
  const raw = `${hostname()}:${process.pid}:${randomUUID()}`;
  return raw.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 128);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Notification outbox delivery aborted");
}

function safeRunFailureMetadata(
  error: unknown,
): Readonly<{ outcome: "authorization_timeout" | "run_failed" }> {
  return Object.freeze({
    outcome:
      error instanceof RetryableNotificationOutboxDeliveryError &&
      error.code === "WORKER_AUTHORIZATION_TIMEOUT"
        ? "authorization_timeout"
        : "run_failed",
  });
}

/** Observes a promise while allowing shutdown, timeout, or lease loss to win. */
function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * In-process durable outbox worker. Mongo lease-token fencing, rather than
 * process-local state, provides safety while Render instances overlap. Delivery
 * is intentionally at-least-once; handlers and clients must use eventId or the
 * referenced aggregate identifier to suppress duplicate presentation.
 */
export class NotificationOutboxWorker {
  private readonly outbox: NotificationOutboxWorkerDependencies["outbox"];
  private readonly registry: NotificationOutboxDeliveryRegistry;
  private readonly authorizer: NotificationOutboxWorkerAuthorizer;
  private readonly workerId: string;
  private readonly config: NotificationOutboxWorkerConfig;
  private readonly classifyFailure: (
    error: unknown,
  ) => NotificationOutboxFailure;
  private readonly timers: NotificationOutboxWorkerTimers;
  private readonly log = createLogger("NotificationOutboxWorker");
  private timer: NodeJS.Timeout | null = null;
  private currentRun: Promise<NotificationOutboxWorkerRunResult> | null = null;
  private stopPromise: Promise<void> | null = null;
  private activeRunAuthorizationAbortController: AbortController | null = null;
  private activeDeliveryAbortController: AbortController | null = null;
  private nextReconciliationAtMs = 0;
  private idlePollIntervalMs: number;
  // A producer can commit an outbox record while the worker is sleeping on an
  // exponential idle delay. Keep the request until the active pass completes
  // so that a wake cannot be lost between a claim and its next schedule.
  private wakeRequested = false;
  private started = false;
  private stopping = false;

  constructor(dependencies: NotificationOutboxWorkerDependencies) {
    this.outbox = dependencies.outbox;
    this.registry = dependencies.registry;
    this.authorizer = dependencies.authorizer;
    this.classifyFailure =
      dependencies.classifyFailure ?? defaultClassifyFailure;
    this.workerId = dependencies.workerId ?? defaultWorkerId();
    this.timers = dependencies.timers ?? SYSTEM_TIMERS;
    const candidate = { ...DEFAULT_CONFIG, ...dependencies.config };
    this.config = Object.freeze({
      pollIntervalMs: requirePositiveInteger(
        candidate.pollIntervalMs,
        "pollIntervalMs",
        60_000,
      ),
      maxIdlePollIntervalMs: requirePositiveInteger(
        candidate.maxIdlePollIntervalMs,
        "maxIdlePollIntervalMs",
        5 * 60_000,
      ),
      batchSize: requirePositiveInteger(candidate.batchSize, "batchSize", 1_000),
      reconciliationLimit: requirePositiveInteger(
        candidate.reconciliationLimit,
        "reconciliationLimit",
        1_000,
      ),
      reconciliationIntervalMs: requirePositiveInteger(
        candidate.reconciliationIntervalMs,
        "reconciliationIntervalMs",
        24 * 60 * 60_000,
      ),
      unsupportedDeliveryGraceMs: requirePositiveInteger(
        candidate.unsupportedDeliveryGraceMs,
        "unsupportedDeliveryGraceMs",
        90 * 24 * 60 * 60_000,
      ),
      authorizationTimeoutMs: requirePositiveInteger(
        candidate.authorizationTimeoutMs,
        "authorizationTimeoutMs",
        60_000,
      ),
      heartbeatIntervalMs: requirePositiveInteger(
        candidate.heartbeatIntervalMs,
        "heartbeatIntervalMs",
        60_000,
      ),
      deliveryTimeoutMs: requirePositiveInteger(
        candidate.deliveryTimeoutMs,
        "deliveryTimeoutMs",
        15 * 60_000,
      ),
      stopTimeoutMs: requirePositiveInteger(
        candidate.stopTimeoutMs,
        "stopTimeoutMs",
        60_000,
      ),
    });
    if (this.config.maxIdlePollIntervalMs < this.config.pollIntervalMs) {
      throw new Error(
        "Notification outbox maximum idle poll interval must not be shorter than polling",
      );
    }
    if (this.config.heartbeatIntervalMs * 3 > this.outbox.leaseDurationMs) {
      throw new Error(
        "Notification outbox heartbeat must be at most one third of the lease duration",
      );
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(this.workerId)) {
      throw new Error("Notification outbox workerId is invalid");
    }
    this.idlePollIntervalMs = this.config.pollIntervalMs;
  }

  start(): void {
    if (this.started) return;
    if (this.currentRun) {
      throw new Error(
        "Notification outbox worker cannot restart while a previous run is active",
      );
    }
    this.started = true;
    this.stopping = false;
    this.stopPromise = null;
    this.idlePollIntervalMs = this.config.pollIntervalMs;
    this.wakeRequested = false;
    this.nextReconciliationAtMs = 0;
    this.schedule(0);
  }

  /**
   * Request an immediate post-commit outbox pass without bypassing durable
   * claim, authorization, or lease fencing. This is intentionally a wake-up,
   * not an in-process delivery shortcut: records remain recoverable if the
   * process stops before the requested pass can run.
   */
  wake(): void {
    if (!this.started || this.stopping) return;

    this.wakeRequested = true;
    this.idlePollIntervalMs = this.config.pollIntervalMs;

    // A scheduled idle poll has not started yet, so replace it with a
    // zero-delay pass. If a pass is already running, its completion handler
    // consumes wakeRequested and schedules the immediate follow-up instead.
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.currentRun) {
      // The newly scheduled pass consumes this request. Keep the flag only
      // when an active pass must schedule its own immediate follow-up.
      this.wakeRequested = false;
      this.schedule(0);
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const operation = this.performStop();
    this.stopPromise = operation;
    return operation;
  }

  runOnce(): Promise<NotificationOutboxWorkerRunResult> {
    if (this.stopping) {
      return Promise.reject(new NotificationOutboxWorkerStoppingError());
    }
    if (this.currentRun) return this.currentRun;
    const run = this.executeRun().finally(() => {
      if (this.currentRun === run) this.currentRun = null;
    });
    this.currentRun = run;
    return run;
  }

  private async performStop(): Promise<void> {
    this.started = false;
    this.stopping = true;
    this.wakeRequested = false;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.activeDeliveryAbortController?.abort(
      new NotificationOutboxWorkerStoppingError(),
    );
    this.activeRunAuthorizationAbortController?.abort(
      new NotificationOutboxWorkerStoppingError(),
    );

    const active = this.currentRun;
    if (!active) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      let timeout: NodeJS.Timeout | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timeout) this.timers.clearTimeout(timeout);
        resolve();
      };
      timeout = this.timers.setTimeout(finish, this.config.stopTimeoutMs);
      timeout.unref?.();
      if (settled) this.timers.clearTimeout(timeout);
      void active.then(finish, finish);
    });
  }

  private schedule(delayMs: number): void {
    if (!this.started || this.stopping) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.runOnce().then(
        (result) => {
          const wakeRequested = this.wakeRequested;
          this.wakeRequested = false;
          this.idlePollIntervalMs =
            result.claimed > 0
              ? this.config.pollIntervalMs
              : Math.min(
                  this.config.maxIdlePollIntervalMs,
                  this.idlePollIntervalMs * 2,
                );
          this.schedule(wakeRequested ? 0 : this.nextScheduledDelay());
        },
        (error: unknown) => {
          const wakeRequested = this.wakeRequested;
          this.wakeRequested = false;
          if (!(error instanceof NotificationOutboxWorkerStoppingError)) {
            this.log.error(
              "Notification outbox worker run failed",
              undefined,
              undefined,
              safeRunFailureMetadata(error),
            );
          }
          this.idlePollIntervalMs = Math.min(
            this.config.maxIdlePollIntervalMs,
            this.idlePollIntervalMs * 2,
          );
          this.schedule(wakeRequested ? 0 : this.nextScheduledDelay());
        },
      );
    }, delayMs);
    this.timer.unref?.();
  }

  private nextScheduledDelay(): number {
    if (this.nextReconciliationAtMs <= 0) return this.idlePollIntervalMs;
    const untilReconciliation = Math.max(
      this.config.pollIntervalMs,
      this.nextReconciliationAtMs - this.timers.now(),
    );
    return Math.min(this.idlePollIntervalMs, untilReconciliation);
  }

  private async executeRun(): Promise<NotificationOutboxWorkerRunResult> {
    const authorizationAbortController = new AbortController();
    this.activeRunAuthorizationAbortController = authorizationAbortController;
    const authorizationTimeout = this.timers.setTimeout(() => {
      authorizationAbortController.abort(
        new RetryableNotificationOutboxDeliveryError(
          "WORKER_AUTHORIZATION_TIMEOUT",
        ),
      );
    }, this.config.authorizationTimeoutMs);
    authorizationTimeout.unref?.();
    try {
      await raceWithAbort(
        this.authorizer.assertCanReconcile(
          authorizationAbortController.signal,
        ),
        authorizationAbortController.signal,
      );
    } finally {
      this.timers.clearTimeout(authorizationTimeout);
      if (
        this.activeRunAuthorizationAbortController ===
        authorizationAbortController
      ) {
        this.activeRunAuthorizationAbortController = null;
      }
    }
    if (this.stopping) throw new NotificationOutboxWorkerStoppingError();
    const shouldReconcile =
      this.nextReconciliationAtMs === 0 ||
      this.timers.now() >= this.nextReconciliationAtMs;
    let reconciliation: NotificationOutboxReconciliationResult = {
      recoveredExpiredLeases: 0,
      deadLetteredExhausted: 0,
    };
    let unsupported: NotificationOutboxUnsupportedReconciliationResult = {
      unsupportedPending: 0,
      unsupportedDeadLettered: 0,
    };
    if (shouldReconcile) {
      this.nextReconciliationAtMs =
        this.timers.now() + this.config.reconciliationIntervalMs;
      reconciliation = await this.outbox.reconcile(
        this.config.reconciliationLimit,
      );
      if (this.stopping) throw new NotificationOutboxWorkerStoppingError();
      unsupported = await this.outbox.reconcileUnsupportedDeliveries(
        this.registry.supportedDeliveries,
        this.config.unsupportedDeliveryGraceMs,
        this.config.reconciliationLimit,
      );
      if (this.stopping) throw new NotificationOutboxWorkerStoppingError();
    }
    const result: MutableNotificationOutboxWorkerRunResult = {
      ...reconciliation,
      ...unsupported,
      reconciliationPerformed: shouldReconcile,
      claimed: 0,
      delivered: 0,
      retried: 0,
      deadLettered: 0,
      leaseLost: 0,
      abandoned: 0,
      deferred: 0,
    };

    while (result.claimed < this.config.batchSize && !this.stopping) {
      const claimableDeliveries = await this.resolveClaimableDeliveries();
      if (this.stopping) throw new NotificationOutboxWorkerStoppingError();
      const claim = await this.outbox.claimNext(
        this.workerId,
        claimableDeliveries,
      );
      if (!claim) break;
      result.claimed += 1;
      if (this.stopping) {
        result.abandoned += 1;
        break;
      }
      const outcome = await this.deliverClaim(claim);
      result[outcome] += 1;
    }

    return Object.freeze(result);
  }

  private async deliverClaim(
    initialClaim: ClaimedNotificationOutbox,
  ): Promise<
    | "delivered"
    | "retried"
    | "deadLettered"
    | "leaseLost"
    | "abandoned"
    | "deferred"
  > {
    let claim = initialClaim;
    let leaseLost = false;
    let renewInFlight: Promise<void> | null = null;
    const abortController = new AbortController();
    this.activeDeliveryAbortController = abortController;
    const renew = async (): Promise<ClaimedNotificationOutbox> => {
      if (abortController.signal.aborted || this.stopping) {
        throw abortReason(abortController.signal);
      }
      claim = await this.outbox.renewLease(claim);
      return claim;
    };
    const heartbeat = this.timers.setInterval(() => {
      if (renewInFlight || leaseLost || abortController.signal.aborted) return;
      renewInFlight = renew()
        .then(() => undefined)
        .catch((error: unknown) => {
          leaseLost = true;
          abortController.abort(error);
        })
        .finally(() => {
          renewInFlight = null;
        });
    }, this.config.heartbeatIntervalMs);
    heartbeat.unref?.();
    let deliveryTimeout: NodeJS.Timeout | null = this.timers.setTimeout(() => {
      abortController.abort(
        new RetryableNotificationOutboxDeliveryError("DELIVERY_TIMEOUT"),
      );
    }, this.config.deliveryTimeoutMs);
    deliveryTimeout.unref?.();

    try {
      if (this.stopping) throw new NotificationOutboxWorkerStoppingError();
      await raceWithAbort(
        this.authorizer.assertCanDeliver(claim),
        abortController.signal,
      );
      const handler = this.registry.get(claim.topic, claim.payloadVersion);
      if (!handler) {
        throw new PermanentNotificationOutboxDeliveryError(
          "HANDLER_NOT_REGISTERED",
        );
      }
      const context = Object.freeze({
        signal: abortController.signal,
        renewLease: renew,
      });
      await raceWithAbort(
        handler.assertCanDeliver(claim, context),
        abortController.signal,
      );
      if (this.stopping) throw new NotificationOutboxWorkerStoppingError();
      await raceWithAbort(
        handler.deliver(claim, context),
        abortController.signal,
      );
      if (renewInFlight) {
        await raceWithAbort(renewInFlight, abortController.signal);
      }
      if (leaseLost) throw new NotificationOutboxLeaseLostError(claim.eventId);
      if (this.stopping) throw new NotificationOutboxWorkerStoppingError();
      if (deliveryTimeout) this.timers.clearTimeout(deliveryTimeout);
      deliveryTimeout = null;
      await this.outbox.finalizeDelivered(claim);
      return "delivered";
    } catch (error) {
      if (
        error instanceof NotificationOutboxWorkerStoppingError ||
        (this.stopping && abortController.signal.aborted)
      ) {
        return "abandoned";
      }
      if (leaseLost || error instanceof NotificationOutboxLeaseLostError) {
        return "leaseLost";
      }
      if (this.stopping) return "abandoned";
      if (error instanceof DeferredNotificationOutboxDeliveryError) {
        try {
          await this.outbox.deferClaim(claim);
          return "deferred";
        } catch (deferError) {
          if (deferError instanceof NotificationOutboxLeaseLostError) {
            return "leaseLost";
          }
          throw deferError;
        }
      }
      try {
        const finalized = await this.outbox.finalizeFailure(
          claim,
          this.classifyFailure(error),
        );
        return finalized.status === "dead" ? "deadLettered" : "retried";
      } catch (finalizeError) {
        if (finalizeError instanceof NotificationOutboxLeaseLostError) {
          return "leaseLost";
        }
        throw finalizeError;
      }
    } finally {
      if (deliveryTimeout) this.timers.clearTimeout(deliveryTimeout);
      this.timers.clearInterval(heartbeat);
      if (this.activeDeliveryAbortController === abortController) {
        this.activeDeliveryAbortController = null;
      }
    }
  }

  private async resolveClaimableDeliveries(): Promise<
    readonly SupportedOutboxDelivery[]
  > {
    const abortController = new AbortController();
    this.activeRunAuthorizationAbortController = abortController;
    const timeout = this.timers.setTimeout(() => {
      abortController.abort(
        new RetryableNotificationOutboxDeliveryError(
          "WORKER_AVAILABILITY_TIMEOUT",
        ),
      );
    }, this.config.authorizationTimeoutMs);
    timeout.unref?.();
    try {
      return await raceWithAbort(
        this.registry.getClaimableDeliveries(abortController.signal),
        abortController.signal,
      );
    } finally {
      this.timers.clearTimeout(timeout);
      if (this.activeRunAuthorizationAbortController === abortController) {
        this.activeRunAuthorizationAbortController = null;
      }
    }
  }
}
