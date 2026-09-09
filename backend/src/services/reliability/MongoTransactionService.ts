import mongoose, { type ClientSession, type Connection } from "mongoose";

export type MongoTransactionDriverOptions = NonNullable<
  Parameters<ClientSession["startTransaction"]>[0]
>;

export interface MongoTransactionAttemptContext {
  readonly attempt: number;
  readonly maxAttempts: number;
}

export interface MongoTransactionRunOptions {
  readonly maxAttempts?: number;
  readonly maxCommitAttempts?: number;
  readonly retryDelayMs?: number;
  /** Only the commit deadline is caller-tunable; durability/isolation stay fixed. */
  readonly maxCommitTimeMS?: number;
}

export interface MongoTransactionTopologyCapability {
  readonly supported: boolean;
  readonly topology: "replica_set" | "sharded" | "standalone" | "unknown";
  readonly maxWireVersion?: number;
  readonly logicalSessionTimeoutMinutes?: number;
  readonly reason?: string;
}

type HelloResponse = Readonly<Record<string, unknown>>;

const DEFAULT_MAX_COMMIT_TIME_MS = 10_000;
const DEFAULT_TRANSACTION_OPTIONS: MongoTransactionDriverOptions = {
  readConcern: { level: "snapshot" },
  writeConcern: { w: "majority" },
  readPreference: "primary",
  maxCommitTimeMS: DEFAULT_MAX_COMMIT_TIME_MS,
};

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_COMMIT_ATTEMPTS = 3;
const MAX_CONFIGURED_ATTEMPTS = 10;
const MAX_COMMIT_TIME_MS = 120_000;

abstract class MongoTransactionError extends Error {
  abstract readonly code: string;
  declare readonly cause: unknown;

  protected constructor(message: string, cause?: unknown) {
    super(message);
    Object.defineProperty(this, "cause", {
      value: cause,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }
}

export class MongoTransactionUnavailableError extends MongoTransactionError {
  readonly name = "MongoTransactionUnavailableError";
  readonly code = "MONGO_TRANSACTIONS_UNAVAILABLE";

  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

export class MongoTransactionRetryExhaustedError extends MongoTransactionError {
  readonly name = "MongoTransactionRetryExhaustedError";
  readonly code = "MONGO_TRANSACTION_RETRY_EXHAUSTED";

  constructor(
    public readonly attempts: number,
    cause: unknown,
  ) {
    super(`MongoDB transaction failed after ${attempts} attempts.`, cause);
  }
}

/**
 * The server could not determine whether commit succeeded. Callers must
 * reconcile through their durable idempotency key instead of rerunning an
 * unkeyed side effect.
 */
export class MongoTransactionCommitUncertainError extends MongoTransactionError {
  readonly name = "MongoTransactionCommitUncertainError";
  readonly code = "MONGO_TRANSACTION_COMMIT_UNCERTAIN";

  constructor(
    public readonly commitAttempts: number,
    cause: unknown,
  ) {
    super(
      `MongoDB transaction commit outcome is unknown after ${commitAttempts} attempts.`,
      cause,
    );
  }
}

export class MongoTransactionUsageError extends MongoTransactionError {
  readonly name = "MongoTransactionUsageError";
  readonly code = "MONGO_TRANSACTION_USAGE_ERROR";

  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function inspectMongoTransactionTopology(
  hello: HelloResponse,
): MongoTransactionTopologyCapability {
  const maxWireVersion = readFiniteNumber(hello.maxWireVersion);
  const logicalSessionTimeoutMinutes = readFiniteNumber(
    hello.logicalSessionTimeoutMinutes,
  );
  const isSharded = hello.msg === "isdbgrid";
  const isReplicaSet =
    typeof hello.setName === "string" && hello.setName.trim().length > 0;
  const topology = isSharded
    ? "sharded"
    : isReplicaSet
      ? "replica_set"
      : "standalone";

  if (!logicalSessionTimeoutMinutes || logicalSessionTimeoutMinutes <= 0) {
    return {
      supported: false,
      topology,
      ...(maxWireVersion === undefined ? {} : { maxWireVersion }),
      reason: "MongoDB deployment does not advertise logical session support.",
    };
  }

  if (!isSharded && !isReplicaSet) {
    return {
      supported: false,
      topology,
      ...(maxWireVersion === undefined ? {} : { maxWireVersion }),
      logicalSessionTimeoutMinutes,
      reason:
        "MongoDB transactions require a replica set or sharded deployment; standalone servers are unsupported.",
    };
  }

  const minimumWireVersion = isSharded ? 8 : 7;
  if (maxWireVersion === undefined || maxWireVersion < minimumWireVersion) {
    return {
      supported: false,
      topology,
      ...(maxWireVersion === undefined ? {} : { maxWireVersion }),
      logicalSessionTimeoutMinutes,
      reason: `MongoDB topology requires maxWireVersion >= ${minimumWireVersion} for transactions.`,
    };
  }

  return {
    supported: true,
    topology,
    maxWireVersion,
    logicalSessionTimeoutMinutes,
  };
}

export function hasMongoErrorLabel(error: unknown, label: string): boolean {
  if (!error || typeof error !== "object") return false;

  const candidate = error as {
    hasErrorLabel?: (value: string) => boolean;
    errorLabels?: unknown;
  };
  try {
    if (candidate.hasErrorLabel?.(label)) return true;
  } catch {
    // Fall through to the immutable label list used by plain test doubles.
  }
  return Array.isArray(candidate.errorLabels) && candidate.errorLabels.includes(label);
}

function requireAttemptCount(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CONFIGURED_ATTEMPTS) {
    throw new MongoTransactionUsageError(
      `${name} must be an integer between 1 and ${MAX_CONFIGURED_ATTEMPTS}.`,
    );
  }
  return value;
}

function requireRetryDelay(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 30_000) {
    throw new MongoTransactionUsageError(
      "retryDelayMs must be an integer between 0 and 30000.",
    );
  }
  return value;
}

function requireMaxCommitTime(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_COMMIT_TIME_MS) {
    throw new MongoTransactionUsageError(
      `maxCommitTimeMS must be an integer between 1 and ${MAX_COMMIT_TIME_MS}.`,
    );
  }
  return value;
}

async function defaultSleep(delayMs: number): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

export class MongoTransactionService {
  private cachedCapability?: MongoTransactionTopologyCapability;

  constructor(
    private readonly connection: Connection = mongoose.connection,
    private readonly sleep: (delayMs: number) => Promise<void> = defaultSleep,
  ) {}

  resetTopologyCapabilityCache(): void {
    this.cachedCapability = undefined;
  }

  async assertTopologyCapability(
    forceRefresh = false,
  ): Promise<MongoTransactionTopologyCapability> {
    if (!forceRefresh && this.cachedCapability?.supported) {
      return this.cachedCapability;
    }

    const db = this.connection.db;
    if (!db) {
      throw new MongoTransactionUnavailableError(
        "MongoDB connection is not ready; transaction capability cannot be verified.",
      );
    }

    let hello: HelloResponse;
    try {
      hello = (await db.admin().command({ hello: 1 })) as HelloResponse;
    } catch (error) {
      throw new MongoTransactionUnavailableError(
        "Unable to inspect MongoDB transaction capability.",
        error,
      );
    }

    const capability = inspectMongoTransactionTopology(hello);
    if (!capability.supported) {
      throw new MongoTransactionUnavailableError(
        capability.reason || "MongoDB transactions are unavailable.",
      );
    }

    this.cachedCapability = capability;
    return capability;
  }

  /**
   * Run MongoDB writes with an explicit session and bounded retries.
   * A transient failure can rerun operation, so it must contain only
   * transaction-scoped database work; enqueue external effects in the outbox.
   */
  async run<T>(
    operation: (
      session: ClientSession,
      context: MongoTransactionAttemptContext,
    ) => Promise<T>,
    options: MongoTransactionRunOptions = {},
  ): Promise<T> {
    if (typeof operation !== "function") {
      throw new MongoTransactionUsageError(
        "MongoDB transaction operation must be a function.",
      );
    }

    const maxAttempts = requireAttemptCount(
      options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      "maxAttempts",
    );
    const maxCommitAttempts = requireAttemptCount(
      options.maxCommitAttempts ?? DEFAULT_MAX_COMMIT_ATTEMPTS,
      "maxCommitAttempts",
    );
    const retryDelayMs = requireRetryDelay(options.retryDelayMs ?? 25);
    const maxCommitTimeMS = requireMaxCommitTime(
      options.maxCommitTimeMS ?? DEFAULT_MAX_COMMIT_TIME_MS,
    );
    const transactionOptions: MongoTransactionDriverOptions = {
      ...DEFAULT_TRANSACTION_OPTIONS,
      maxCommitTimeMS,
    };

    // Never degrade to a sequence of non-transactional writes. A standalone
    // development MongoDB must be upgraded/configured before this API can run.
    await this.assertTopologyCapability();

    let lastTransientError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let session: ClientSession;
      try {
        session = await this.connection.startSession();
      } catch (error) {
        throw new MongoTransactionUnavailableError(
          "Unable to start MongoDB transaction session.",
          error,
        );
      }

      try {
        session.startTransaction(transactionOptions);
        const result = await operation(session, { attempt, maxAttempts });

        if (!session.inTransaction()) {
          throw new MongoTransactionUsageError(
            "Transaction callback ended or committed its session directly; session ownership belongs to MongoTransactionService.",
          );
        }

        for (
          let commitAttempt = 1;
          commitAttempt <= maxCommitAttempts;
          commitAttempt += 1
        ) {
          try {
            await session.commitTransaction();
            return result;
          } catch (error) {
            if (!hasMongoErrorLabel(error, "UnknownTransactionCommitResult")) {
              throw error;
            }
            if (commitAttempt === maxCommitAttempts) {
              throw new MongoTransactionCommitUncertainError(
                commitAttempt,
                error,
              );
            }
            await this.sleep(retryDelayMs * commitAttempt);
          }
        }

        throw new MongoTransactionUsageError(
          "MongoDB transaction commit loop ended unexpectedly.",
        );
      } catch (error) {
        if (!(error instanceof MongoTransactionCommitUncertainError)) {
          try {
            if (session.inTransaction()) await session.abortTransaction();
          } catch {
            // Preserve the operation/commit error. The session is discarded
            // below and an idempotent caller can safely retry or reconcile.
          }
        }

        const retryWholeTransaction = hasMongoErrorLabel(
          error,
          "TransientTransactionError",
        );
        if (retryWholeTransaction) {
          lastTransientError = error;
          if (attempt < maxAttempts) {
            await this.sleep(retryDelayMs * attempt);
            continue;
          }
          throw new MongoTransactionRetryExhaustedError(attempt, error);
        }

        throw error;
      } finally {
        try {
          await session.endSession();
        } catch {
          // Ending a local driver session must not turn a known committed
          // transaction into an ambiguous failure for the caller.
        }
      }
    }

    throw new MongoTransactionRetryExhaustedError(
      maxAttempts,
      lastTransientError,
    );
  }
}

export const mongoTransactionService = new MongoTransactionService();
