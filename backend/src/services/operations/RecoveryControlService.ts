import type { ClientSession } from "mongoose";
import NotificationOutbox from "../../models/NotificationOutbox";
import { AuditLogService } from "../AuditLogService";
import {
  IdempotencyInProgressError,
  IdempotencyKeyConflictError,
  IdempotencyValidationError,
  idempotencyService,
  type IdempotencyReplayResponseDto,
} from "../reliability/IdempotencyService";
import {
  notificationOutboxMetrics,
  type NotificationOutboxMetrics,
} from "../reliability/NotificationOutboxMetrics";
import {
  buildExhaustedOutboxRecoveryFilter,
  buildExpiredLeaseOutboxRecoveryFilter,
  notificationOutboxService,
  type NotificationOutboxReconciliationResult,
} from "../reliability/NotificationOutboxService";
import { MongoTransactionCommitUncertainError } from "../reliability/MongoTransactionService";
import { awaitWithAbort } from "../../utils/abortablePromise";

export const RECOVERY_OPERATION =
  "notification_outbox_reconcile" as const;
export const RECOVERY_RECONCILIATION_LIMITS = Object.freeze({
  default: 25,
  maximum: 25,
});
export const RECOVERY_STATUS_READ_TIMEOUT_MS = 1_500;
export const RECOVERY_EXECUTION_TIMEOUT_MS = 15_000;
export const RECOVERY_QUERY_MAX_TIME_MS = 1_000;

export interface RecoveryActor {
  readonly id: string;
  readonly role: string;
}

export interface ExecuteRecoveryInput {
  readonly actor: RecoveryActor;
  readonly idempotencyKey: string;
  readonly limit?: number;
  readonly correlationId?: string;
}

export interface RecoveryOperationResponse
  extends IdempotencyReplayResponseDto {
  readonly operation: typeof RECOVERY_OPERATION;
  readonly recoveredExpiredLeases: number;
  readonly deadLetteredExhausted: number;
}

export interface RecoveryExecutionResult
  extends RecoveryOperationResponse {
  readonly receiptId: string;
  readonly replayed: boolean;
}

export interface RecoveryStatusSnapshot {
  readonly operation: typeof RECOVERY_OPERATION;
  readonly backlog: {
    readonly pending: number;
    readonly processing: number;
    readonly dead: number;
  };
  readonly recoverable: {
    readonly expiredLeases: number;
    readonly exhaustedAttempts: number;
  };
}

interface RecoveryOutboxPort {
  reconcile(
    limit: number,
    options: {
      readonly session: ClientSession;
      readonly recordMetrics: false;
      readonly maxTimeMS: number;
      readonly signal: AbortSignal;
    },
  ): Promise<NotificationOutboxReconciliationResult>;
}

interface RecoveryIdempotencyPort {
  execute<TResponse extends IdempotencyReplayResponseDto>(input: {
    readonly scope: string;
    readonly actorKey: string;
    readonly key: string;
    readonly requestPayload: unknown;
    readonly execute: (
      session: ClientSession,
    ) => Promise<{
      readonly httpStatus: number;
      readonly response: TResponse;
    }>;
  }): Promise<RecoveryIdempotencyExecutionResult<TResponse>>;
}

interface RecoveryIdempotencyExecutionResult<
  TResponse extends IdempotencyReplayResponseDto,
> {
  readonly receiptId: string;
  readonly replayed: boolean;
  readonly httpStatus: number;
  readonly response?: TResponse;
}

interface RecoveryAuditPort {
  recordRequiredInTransaction(
    input: Parameters<typeof AuditLogService.recordRequiredInTransaction>[0],
    session: ClientSession,
  ): Promise<void>;
}

interface RecoveryMetricsPort {
  increment(
    metric: Parameters<NotificationOutboxMetrics["increment"]>[0],
    amount?: number,
  ): void;
}

interface RecoveryStatusModelPort {
  countDocuments(
    filter: Readonly<Record<string, unknown>>,
    options?: Readonly<Record<string, unknown>>,
  ): PromiseLike<number>;
}

export interface RecoveryControlDependencies {
  readonly outbox?: RecoveryOutboxPort;
  readonly idempotency?: RecoveryIdempotencyPort;
  readonly audit?: RecoveryAuditPort;
  readonly metrics?: RecoveryMetricsPort;
  readonly statusModel?: RecoveryStatusModelPort;
  readonly now?: () => Date;
  readonly statusReadTimeoutMs?: number;
  readonly executionTimeoutMs?: number;
}

export class RecoveryControlInputError extends Error {
  readonly code = "RECOVERY_CONTROL_INPUT_INVALID";
  readonly name = "RecoveryControlInputError";
}

export class RecoveryControlOutcomeUncertainError extends Error {
  readonly code = "RECOVERY_CONTROL_OUTCOME_UNCERTAIN";
  readonly name = "RecoveryControlOutcomeUncertainError";

  constructor() {
    super("The recovery operation exceeded its response deadline.");
  }
}

export class RecoveryControlBusyError extends Error {
  readonly code = "RECOVERY_CONTROL_BUSY";
  readonly name = "RecoveryControlBusyError";

  constructor() {
    super("A recovery operation is already in progress.");
  }
}

function requireLimit(value: unknown): number {
  const resolved =
    value === undefined
      ? RECOVERY_RECONCILIATION_LIMITS.default
      : value;
  if (
    !Number.isSafeInteger(resolved) ||
    Number(resolved) < 1 ||
    Number(resolved) > RECOVERY_RECONCILIATION_LIMITS.maximum
  ) {
    throw new RecoveryControlInputError(
      `limit must be an integer between 1 and ${RECOVERY_RECONCILIATION_LIMITS.maximum}.`,
    );
  }
  return Number(resolved);
}

function requireActor(actor: RecoveryActor): RecoveryActor {
  if (
    !actor ||
    typeof actor.id !== "string" ||
    !/^[a-fA-F0-9]{24}$/.test(actor.id) ||
    typeof actor.role !== "string" ||
    actor.role.length < 1 ||
    actor.role.length > 80
  ) {
    throw new RecoveryControlInputError("Recovery actor is invalid.");
  }
  return { id: actor.id.toLowerCase(), role: actor.role };
}

export class RecoveryControlService {
  private readonly outbox: RecoveryOutboxPort;
  private readonly idempotency: RecoveryIdempotencyPort;
  private readonly audit: RecoveryAuditPort;
  private readonly metrics: RecoveryMetricsPort;
  private readonly statusModel: RecoveryStatusModelPort;
  private readonly now: () => Date;
  private readonly statusReadTimeoutMs: number;
  private readonly executionTimeoutMs: number;
  private activeExecution: Promise<
    RecoveryIdempotencyExecutionResult<RecoveryOperationResponse>
  > | null = null;

  constructor(dependencies: RecoveryControlDependencies = {}) {
    this.outbox = dependencies.outbox ?? notificationOutboxService;
    this.idempotency = dependencies.idempotency ?? idempotencyService;
    this.audit = dependencies.audit ?? AuditLogService;
    this.metrics = dependencies.metrics ?? notificationOutboxMetrics;
    this.statusModel = dependencies.statusModel ?? NotificationOutbox;
    this.now = dependencies.now ?? (() => new Date());
    this.statusReadTimeoutMs =
      dependencies.statusReadTimeoutMs ?? RECOVERY_STATUS_READ_TIMEOUT_MS;
    this.executionTimeoutMs =
      dependencies.executionTimeoutMs ?? RECOVERY_EXECUTION_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.statusReadTimeoutMs) ||
      this.statusReadTimeoutMs < 1
    ) {
      throw new Error("Recovery status read timeout is invalid.");
    }
    if (
      !Number.isSafeInteger(this.executionTimeoutMs) ||
      this.executionTimeoutMs < 1
    ) {
      throw new Error("Recovery execution timeout is invalid.");
    }
  }

  async getStatusSnapshot(options: {
    readonly signal?: AbortSignal;
  } = {}): Promise<RecoveryStatusSnapshot> {
    const now = this.now();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new Error("Recovery control clock is invalid.");
    }

    const timeoutSignal = AbortSignal.timeout(this.statusReadTimeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const queryOptions = Object.freeze({
      maxTimeMS: this.statusReadTimeoutMs,
      signal,
    });

    const [pending, processing, dead, expiredLeases, exhaustedAttempts] =
      await awaitWithAbort(
        Promise.all([
          this.statusModel.countDocuments(
            { status: "pending" },
            queryOptions,
          ),
          this.statusModel.countDocuments(
            { status: "processing" },
            queryOptions,
          ),
          this.statusModel.countDocuments({ status: "dead" }, queryOptions),
          this.statusModel.countDocuments(
            buildExpiredLeaseOutboxRecoveryFilter(now),
            queryOptions,
          ),
          this.statusModel.countDocuments(
            buildExhaustedOutboxRecoveryFilter(now),
            queryOptions,
          ),
        ]),
        signal,
      );

    return Object.freeze({
      operation: RECOVERY_OPERATION,
      backlog: Object.freeze({ pending, processing, dead }),
      recoverable: Object.freeze({ expiredLeases, exhaustedAttempts }),
    });
  }

  async executeNotificationOutboxReconciliation(
    input: ExecuteRecoveryInput,
  ): Promise<RecoveryExecutionResult> {
    const actor = requireActor(input.actor);
    const limit = requireLimit(input.limit);
    if (this.activeExecution) throw new RecoveryControlBusyError();

    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(new RecoveryControlOutcomeUncertainError()),
      this.executionTimeoutMs,
    );
    timeout.unref?.();
    let execution: RecoveryIdempotencyExecutionResult<RecoveryOperationResponse>;
    try {
      const executionOperation =
        this.idempotency.execute<RecoveryOperationResponse>({
          scope: "operations.recovery.notification_outbox",
          actorKey: actor.id,
          key: input.idempotencyKey,
          requestPayload: { operation: RECOVERY_OPERATION, limit },
          execute: async (session) => {
            const result = await this.outbox.reconcile(limit, {
              session,
              recordMetrics: false,
              maxTimeMS: RECOVERY_QUERY_MAX_TIME_MS,
              signal: abortController.signal,
            });
            const response: RecoveryOperationResponse = Object.freeze({
              operation: RECOVERY_OPERATION,
              recoveredExpiredLeases: result.recoveredExpiredLeases,
              deadLetteredExhausted: result.deadLetteredExhausted,
            });

            await this.audit.recordRequiredInTransaction(
              {
                action: "operations.recovery.notification_outbox",
                actor: { type: "user", id: actor.id, role: actor.role },
                source: "http",
                outcome: "success",
                target: {
                  model: "NotificationOutbox",
                  id: RECOVERY_OPERATION,
                },
                correlationId: input.correlationId,
                details: {
                  limit,
                  recoveredExpiredLeases: result.recoveredExpiredLeases,
                  deadLetteredExhausted: result.deadLetteredExhausted,
                },
              },
              session,
            );

            return { httpStatus: 200, response };
          },
        });
      this.activeExecution = executionOperation;
      const clearActiveExecution = () => {
        if (this.activeExecution === executionOperation) {
          this.activeExecution = null;
        }
      };
      void executionOperation.then(
        clearActiveExecution,
        clearActiveExecution,
      );
      execution = await awaitWithAbort(
        executionOperation,
        abortController.signal,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!execution.response) {
      throw new Error("Recovery operation receipt is incomplete.");
    }
    if (!execution.replayed) {
      this.metrics.increment(
        "expiredLeasesRecovered",
        execution.response.recoveredExpiredLeases,
      );
      this.metrics.increment(
        "deadLettered",
        execution.response.deadLetteredExhausted,
      );
    }

    return Object.freeze({
      ...execution.response,
      receiptId: execution.receiptId,
      replayed: execution.replayed,
    });
  }
}

export function isRecoveryControlClientError(error: unknown): boolean {
  return (
    error instanceof RecoveryControlInputError ||
    error instanceof IdempotencyValidationError
  );
}

export function isRecoveryControlConflict(error: unknown): boolean {
  return (
    error instanceof IdempotencyKeyConflictError ||
    error instanceof IdempotencyInProgressError ||
    error instanceof RecoveryControlBusyError
  );
}

export function isRecoveryControlCommitUncertain(error: unknown): boolean {
  return (
    error instanceof MongoTransactionCommitUncertainError ||
    error instanceof RecoveryControlOutcomeUncertainError
  );
}

export const recoveryControlService = new RecoveryControlService();
