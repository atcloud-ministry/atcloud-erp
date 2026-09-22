import { createHash } from "crypto";
import type { ClientSession } from "mongoose";
import IdempotencyRecord, {
  type IIdempotencyRecord,
  type IdempotencyResourceReference,
} from "../../models/IdempotencyRecord";
import {
  MongoTransactionService,
  mongoTransactionService,
  type MongoTransactionAttemptContext,
  type MongoTransactionRunOptions,
} from "./MongoTransactionService";
import {
  findIdempotencyReplayResponseViolation,
  IDEMPOTENCY_REPLAY_RESPONSE_LIMITS,
  type IdempotencyReplayResponseDto,
} from "./IdempotencyResponseContract";

export type {
  IdempotencyReplayResponseDto,
  IdempotencyReplayValue,
} from "./IdempotencyResponseContract";

export const IDEMPOTENCY_LIMITS = Object.freeze({
  maxRequestBytes: 32 * 1024,
  maxResponseBytes: IDEMPOTENCY_REPLAY_RESPONSE_LIMITS.maxBytes,
  maxDepth: IDEMPOTENCY_REPLAY_RESPONSE_LIMITS.maxDepth,
  maxNodes: IDEMPOTENCY_REPLAY_RESPONSE_LIMITS.maxNodes,
  minTtlMs: 60_000,
  maxTtlMs: 30 * 24 * 60 * 60 * 1000,
  defaultTtlMs: 24 * 60 * 60 * 1000,
});
export const IDEMPOTENCY_HASH_VERSION = 1;

export interface IdempotentOperationResult<
  TResponse extends IdempotencyReplayResponseDto,
> {
  readonly httpStatus: number;
  readonly response?: TResponse;
  readonly resource?: IdempotencyResourceReference;
}

export interface ExecuteIdempotentlyInput<
  TResponse extends IdempotencyReplayResponseDto,
> {
  readonly scope: string;
  readonly actorKey: string;
  readonly key: string;
  readonly requestPayload: unknown;
  readonly ttlMs?: number;
  readonly transactionOptions?: MongoTransactionRunOptions;
  readonly execute: (
    session: ClientSession,
    context: MongoTransactionAttemptContext,
  ) => Promise<IdempotentOperationResult<TResponse>>;
}

export interface IdempotencyExecutionResult<
  TResponse extends IdempotencyReplayResponseDto,
>
  extends IdempotentOperationResult<TResponse> {
  readonly receiptId: string;
  readonly replayed: boolean;
}

interface PersistenceResult {
  readonly acknowledged?: boolean;
  readonly matchedCount?: number;
  readonly modifiedCount?: number;
  readonly deletedCount?: number;
}

export interface IdempotencyRecordRepository {
  findOne(
    filter: Readonly<Record<string, unknown>>,
    projection?: Readonly<Record<string, unknown>>,
    options?: Readonly<Record<string, unknown>>,
  ): PromiseLike<IIdempotencyRecord | null>;
  create(
    documents: ReadonlyArray<Readonly<Record<string, unknown>>>,
    options: Readonly<Record<string, unknown>>,
  ): Promise<IIdempotencyRecord[]>;
  updateOne(
    filter: Readonly<Record<string, unknown>>,
    update: Readonly<Record<string, unknown>>,
    options?: Readonly<Record<string, unknown>>,
  ): PromiseLike<PersistenceResult>;
  deleteOne(
    filter: Readonly<Record<string, unknown>>,
    options?: Readonly<Record<string, unknown>>,
  ): PromiseLike<PersistenceResult>;
}

type TransactionRunner = Pick<MongoTransactionService, "run">;

abstract class IdempotencyError extends Error {
  abstract readonly code: string;
}

export class IdempotencyValidationError extends IdempotencyError {
  readonly name = "IdempotencyValidationError";
  readonly code = "IDEMPOTENCY_VALIDATION_ERROR";

  constructor(message: string) {
    super(message);
  }
}

export class IdempotencyPayloadTooLargeError extends IdempotencyError {
  readonly name = "IdempotencyPayloadTooLargeError";
  readonly code = "IDEMPOTENCY_PAYLOAD_TOO_LARGE";

  constructor(
    public readonly payloadKind: "request" | "response",
    public readonly maxBytes: number,
  ) {
    super(`Idempotency ${payloadKind} payload exceeds ${maxBytes} bytes.`);
  }
}

export class IdempotencyKeyConflictError extends IdempotencyError {
  readonly name = "IdempotencyKeyConflictError";
  readonly code = "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST";

  constructor(public readonly scope: string) {
    super(
      `The idempotency key was already used with a different request in scope "${scope}".`,
    );
  }
}

export class IdempotencyInProgressError extends IdempotencyError {
  readonly name = "IdempotencyInProgressError";
  readonly code = "IDEMPOTENCY_OPERATION_IN_PROGRESS";

  constructor(public readonly scope: string) {
    super(`The idempotent operation is still in progress in scope "${scope}".`);
  }
}

export class IdempotencyPersistenceError extends IdempotencyError {
  readonly name = "IdempotencyPersistenceError";
  readonly code = "IDEMPOTENCY_PERSISTENCE_ERROR";

  constructor(message: string) {
    super(message);
  }
}

interface CanonicalizationState {
  readonly seen: WeakSet<object>;
  nodes: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeReplayResponse(value: unknown): IdempotencyReplayResponseDto {
  const canonical = canonicalizeIdempotencyPayload(value, "response");
  const normalized = JSON.parse(canonical) as unknown;
  const violation = findIdempotencyReplayResponseViolation(normalized);
  if (violation) throw new IdempotencyValidationError(violation);
  return normalized as IdempotencyReplayResponseDto;
}

function serializeCanonicalJson(
  value: unknown,
  state: CanonicalizationState,
  depth: number,
): string {
  state.nodes += 1;
  if (state.nodes > IDEMPOTENCY_LIMITS.maxNodes) {
    throw new IdempotencyValidationError(
      `Idempotency payload exceeds ${IDEMPOTENCY_LIMITS.maxNodes} JSON nodes.`,
    );
  }
  if (depth > IDEMPOTENCY_LIMITS.maxDepth) {
    throw new IdempotencyValidationError(
      `Idempotency payload exceeds maximum depth ${IDEMPOTENCY_LIMITS.maxDepth}.`,
    );
  }

  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new IdempotencyValidationError(
        "Idempotency payload numbers must be finite.",
      );
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new IdempotencyValidationError(
      `Idempotency payload contains unsupported ${typeof value} value.`,
    );
  }

  if (state.seen.has(value)) {
    throw new IdempotencyValidationError(
      "Idempotency payload cannot contain circular references.",
    );
  }
  state.seen.add(value);

  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new IdempotencyValidationError(
            "Idempotency payload cannot contain sparse arrays.",
          );
        }
        items.push(serializeCanonicalJson(value[index], state, depth + 1));
      }
      return `[${items.join(",")}]`;
    }

    if (!isPlainRecord(value)) {
      throw new IdempotencyValidationError(
        "Idempotency payload objects must use a plain object prototype.",
      );
    }

    const properties: string[] = [];
    for (const key of Object.keys(value).sort()) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new IdempotencyValidationError(
          `Idempotency payload contains forbidden key "${key}".`,
        );
      }
      properties.push(
        `${JSON.stringify(key)}:${serializeCanonicalJson(value[key], state, depth + 1)}`,
      );
    }
    return `{${properties.join(",")}}`;
  } finally {
    state.seen.delete(value);
  }
}

export function canonicalizeIdempotencyPayload(
  value: unknown,
  payloadKind: "request" | "response" = "request",
): string {
  const canonical = serializeCanonicalJson(
    value,
    { seen: new WeakSet<object>(), nodes: 0 },
    0,
  );
  const maxBytes =
    payloadKind === "request"
      ? IDEMPOTENCY_LIMITS.maxRequestBytes
      : IDEMPOTENCY_LIMITS.maxResponseBytes;
  if (Buffer.byteLength(canonical, "utf8") > maxBytes) {
    throw new IdempotencyPayloadTooLargeError(payloadKind, maxBytes);
  }
  return canonical;
}

type IdempotencyHashDomain = "actor" | "key" | "request";

export function hashIdempotencyValue(
  scope: string,
  domain: IdempotencyHashDomain,
  value: string,
): string {
  return createHash("sha256")
    .update(`atcloud:idempotency:v${IDEMPOTENCY_HASH_VERSION}`, "utf8")
    .update("\0", "utf8")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(scope, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

export function hashIdempotencyPayload(scope: string, value: unknown): string {
  return hashIdempotencyValue(
    scope,
    "request",
    canonicalizeIdempotencyPayload(value, "request"),
  );
}

function requireBoundedIdentifier(
  value: unknown,
  field: string,
  maxLength: number,
  pattern: RegExp,
): string {
  if (typeof value !== "string") {
    throw new IdempotencyValidationError(`${field} must be a string.`);
  }
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    !pattern.test(normalized)
  ) {
    throw new IdempotencyValidationError(`${field} is invalid.`);
  }
  return normalized;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONGO_OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

function requireOpaqueActorKey(value: unknown): string {
  if (typeof value !== "string") {
    throw new IdempotencyValidationError("actorKey must be a string.");
  }
  const normalized = value.trim();
  if (
    !MONGO_OBJECT_ID_PATTERN.test(normalized) &&
    !UUID_PATTERN.test(normalized)
  ) {
    throw new IdempotencyValidationError(
      "actorKey must be an opaque MongoDB ObjectId or UUID.",
    );
  }
  return normalized.toLowerCase();
}

function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== "string") {
    throw new IdempotencyValidationError("key must be a string.");
  }
  const normalized = value.trim();
  if (!UUID_PATTERN.test(normalized)) {
    throw new IdempotencyValidationError("key must be a UUID.");
  }
  return normalized.toLowerCase();
}

function requireTtlMs(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < IDEMPOTENCY_LIMITS.minTtlMs ||
    value > IDEMPOTENCY_LIMITS.maxTtlMs
  ) {
    throw new IdempotencyValidationError(
      `ttlMs must be an integer between ${IDEMPOTENCY_LIMITS.minTtlMs} and ${IDEMPOTENCY_LIMITS.maxTtlMs}.`,
    );
  }
  return value;
}

function normalizeResource(
  resource: IdempotencyResourceReference | undefined,
): IdempotencyResourceReference | undefined {
  if (!resource) return undefined;
  return {
    type: requireBoundedIdentifier(
      resource.type,
      "resource.type",
      80,
      /^[A-Za-z][A-Za-z0-9_-]*$/,
    ),
    id: requireBoundedIdentifier(
      resource.id,
      "resource.id",
      200,
      /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    ),
  };
}

function requireHttpStatus(value: number): number {
  if (!Number.isInteger(value) || value < 100 || value > 599) {
    throw new IdempotencyValidationError(
      "Idempotent result httpStatus must be an integer between 100 and 599.",
    );
  }
  return value;
}

function hasDuplicateKeyCode(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === 11000
  );
}

function isLogicallyExpired(record: IIdempotencyRecord, now: Date): boolean {
  return new Date(record.expiresAt).getTime() <= now.getTime();
}

function validateExistingRequest(
  record: IIdempotencyRecord,
  requestHash: string,
  scope: string,
): void {
  if (record.requestHash !== requestHash) {
    throw new IdempotencyKeyConflictError(scope);
  }
}

function replayResult<TResponse extends IdempotencyReplayResponseDto>(
  record: IIdempotencyRecord,
  scope: string,
): IdempotencyExecutionResult<TResponse> {
  if (record.state !== "completed") {
    throw new IdempotencyInProgressError(scope);
  }
  if (!record.httpStatus || (record.response === undefined && !record.resource)) {
    throw new IdempotencyPersistenceError(
      `Completed idempotency receipt ${String(record._id)} is incomplete.`,
    );
  }

  const response =
    record.response === undefined
      ? undefined
      : (normalizeReplayResponse(record.response) as TResponse);

  return {
    receiptId: String(record._id),
    replayed: true,
    httpStatus: record.httpStatus,
    ...(response === undefined ? {} : { response }),
    ...(record.resource
      ? {
          resource: {
            type: String(record.resource.type),
            id: String(record.resource.id),
          },
        }
      : {}),
  };
}

export class IdempotencyService {
  constructor(
    private readonly transactions: TransactionRunner = mongoTransactionService,
    private readonly repository: IdempotencyRecordRepository =
      IdempotencyRecord as unknown as IdempotencyRecordRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute<TResponse extends IdempotencyReplayResponseDto>(
    input: ExecuteIdempotentlyInput<TResponse>,
  ): Promise<IdempotencyExecutionResult<TResponse>> {
    const scope = requireBoundedIdentifier(
      input.scope,
      "scope",
      160,
      /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/,
    );
    const actorKey = requireOpaqueActorKey(input.actorKey);
    const key = requireIdempotencyKey(input.key);
    if (typeof input.execute !== "function") {
      throw new IdempotencyValidationError("execute must be a function.");
    }

    const actorKeyHash = hashIdempotencyValue(scope, "actor", actorKey);
    const keyHash = hashIdempotencyValue(scope, "key", key);
    const requestHash = hashIdempotencyPayload(scope, input.requestPayload);
    const ttlMs = requireTtlMs(
      input.ttlMs ?? IDEMPOTENCY_LIMITS.defaultTtlMs,
    );
    const identityFilter = {
      hashVersion: IDEMPOTENCY_HASH_VERSION,
      scope,
      actorKeyHash,
      keyHash,
    } as const;

    try {
      return await this.transactions.run(
        async (session, attemptContext) => {
          const transactionNow = this.now();
          const existing = await this.repository.findOne(
            identityFilter,
            undefined,
            { session },
          );
          if (existing && !isLogicallyExpired(existing, transactionNow)) {
            validateExistingRequest(existing, requestHash, scope);
            return replayResult<TResponse>(existing, scope);
          }

          if (existing) {
            await this.repository.deleteOne(
              {
                _id: existing._id,
                expiresAt: { $lte: transactionNow },
              },
              { session },
            );
          }

          const expiresAt = new Date(transactionNow.getTime() + ttlMs);
          const [receipt] = await this.repository.create(
            [
              {
                ...identityFilter,
                requestHash,
                state: "in_progress",
                expiresAt,
              },
            ],
            { session },
          );
          if (!receipt) {
            throw new IdempotencyPersistenceError(
              "Failed to create idempotency receipt.",
            );
          }

          const operationResult = await input.execute(session, attemptContext);
          const httpStatus = requireHttpStatus(operationResult.httpStatus);
          const resource = normalizeResource(operationResult.resource);
          const hasResponse = Object.prototype.hasOwnProperty.call(
            operationResult,
            "response",
          );
          if (!hasResponse && !resource) {
            throw new IdempotencyValidationError(
              "Idempotent operation must return a response or resource reference.",
            );
          }

          let response: TResponse | undefined;
          if (hasResponse) {
            response = normalizeReplayResponse(operationResult.response) as TResponse;
          }
          const completedAt = this.now();
          const expiresAtFromCompletion = new Date(
            completedAt.getTime() + ttlMs,
          );
          const completion = await this.repository.updateOne(
            { _id: receipt._id, state: "in_progress" },
            {
              $set: {
                state: "completed",
                httpStatus,
                ...(hasResponse ? { response } : {}),
                ...(resource ? { resource } : {}),
                completedAt,
                expiresAt: expiresAtFromCompletion,
              },
            },
            { session, runValidators: true },
          );
          if (completion.matchedCount !== 1) {
            throw new IdempotencyPersistenceError(
              `Failed to complete idempotency receipt ${String(receipt._id)}.`,
            );
          }

          return {
            receiptId: String(receipt._id),
            replayed: false,
            httpStatus,
            ...(hasResponse ? { response } : {}),
            ...(resource ? { resource } : {}),
          };
        },
        input.transactionOptions,
      );
    } catch (error) {
      if (!hasDuplicateKeyCode(error)) throw error;

      // A competing transaction inserted the same receipt first. MongoDB's
      // unique-index conflict is resolved only after that transaction commits
      // or aborts, so a committed receipt can now be safely replayed.
      const existing = await this.repository.findOne(identityFilter);
      if (!existing || isLogicallyExpired(existing, this.now())) throw error;
      validateExistingRequest(existing, requestHash, scope);
      return replayResult<TResponse>(existing, scope);
    }
  }
}

export const idempotencyService = new IdempotencyService();
