import type { MigrationReadDatabase } from "../services/migrations/MigrationReadDatabase";
import type {
  MigrationTransactionDatabase,
  MigrationTransactionReadDatabase,
} from "../services/migrations/MigrationTransactionDatabase";

export const MIGRATION_ID_PATTERN =
  /^(\d{4})(\d{2})(\d{2})_\d{3}_[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MIGRATION_CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;

export const SCHEMA_MIGRATION_STATUSES = [
  "applying",
  "applied",
  "apply_failed",
  "rolling_back",
  "rolled_back",
  "rollback_failed",
] as const;

export const SCHEMA_MIGRATION_DIRECTIONS = ["up", "down"] as const;

export const MIGRATION_ROLLBACK_REASON_CODES = [
  "POSTCONDITION_FAILED",
  "DATA_VALIDATION_FAILED",
  "RELEASE_ROLLBACK",
  "MIGRATION_REPLACED",
  "OPERATOR_REQUEST",
] as const;

export const MIGRATION_FAILURE_CODES = [
  "MIGRATION_APPLY_FAILED",
  "MIGRATION_EXECUTION_FAILED",
  "MIGRATION_LEASE_CONTENDED",
  "MIGRATION_LEASE_LOST",
  "MIGRATION_LEASE_USAGE_ERROR",
  "MIGRATION_ROLLBACK_FAILED",
  "MIGRATION_STATE_CONFLICT",
  "MIGRATION_USAGE_ERROR",
] as const;

export type SchemaMigrationStatus =
  (typeof SCHEMA_MIGRATION_STATUSES)[number];
export type MigrationDirection =
  (typeof SCHEMA_MIGRATION_DIRECTIONS)[number];
export type MigrationRollbackReasonCode =
  (typeof MIGRATION_ROLLBACK_REASON_CODES)[number];
export type MigrationFailureCode = (typeof MIGRATION_FAILURE_CODES)[number];

export function isMigrationFailureCode(
  value: unknown,
): value is MigrationFailureCode {
  return (MIGRATION_FAILURE_CODES as readonly unknown[]).includes(value);
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * Checkpoints contain resumability metadata only (for example, a cursor and a
 * phase number). They must never contain source documents, credentials, or
 * other unbounded application data.
 */
export type MigrationCheckpoint = JsonObject;

export const MAX_MIGRATION_CHECKPOINT_BYTES = 16 * 1024;
export const MAX_MIGRATION_CHECKPOINT_DEPTH = 8;
export const MAX_MIGRATION_CHECKPOINT_NODES = 256;
export const MAX_MIGRATION_CHECKPOINT_KEYS = 64;
export const MAX_MIGRATION_CHECKPOINT_ARRAY_ITEMS = 128;
export const MAX_MIGRATION_CHECKPOINT_STRING_LENGTH = 2_048;

const CHECKPOINT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const FORBIDDEN_CHECKPOINT_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

interface JsonValidationState {
  nodes: number;
  ancestors: Set<object>;
}

type JsonCloneResult =
  | { readonly value: JsonValue; readonly violation?: never }
  | { readonly value?: never; readonly violation: string };

export type MigrationCheckpointCloneResult =
  | {
      readonly checkpoint: MigrationCheckpoint | null;
      readonly violation?: never;
    }
  | { readonly checkpoint?: never; readonly violation: string };

function cloneJsonValue(
  value: unknown,
  depth: number,
  state: JsonValidationState,
): JsonCloneResult {
  if (value === null) return { value: null };

  if (typeof value === "string") {
    return value.length <= MAX_MIGRATION_CHECKPOINT_STRING_LENGTH
      ? { value }
      : { violation: "contains a string that is too long" };
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { value: Object.is(value, -0) ? 0 : value }
      : { violation: "contains a non-finite number" };
  }
  if (typeof value === "boolean") return { value };
  if (typeof value !== "object") {
    return { violation: `contains a non-JSON ${typeof value} value` };
  }
  if (depth > MAX_MIGRATION_CHECKPOINT_DEPTH) {
    return { violation: "exceeds the maximum nesting depth" };
  }

  state.nodes += 1;
  if (state.nodes > MAX_MIGRATION_CHECKPOINT_NODES) {
    return { violation: "contains too many values" };
  }
  if (state.ancestors.has(value)) {
    return { violation: "contains a circular reference" };
  }
  state.ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
        PropertyKey,
        PropertyDescriptor
      >;
      const lengthDescriptor = descriptors.length;
      const length = lengthDescriptor?.value;
      if (
        typeof length !== "number" ||
        !Number.isSafeInteger(length) ||
        length < 0
      ) {
        return { violation: "contains an invalid array length" };
      }
      if (length > MAX_MIGRATION_CHECKPOINT_ARRAY_ITEMS) {
        return { violation: "contains an array with too many items" };
      }

      const keys = Reflect.ownKeys(descriptors);
      for (const key of keys) {
        if (key === "length") continue;
        if (
          typeof key !== "string" ||
          !/^(?:0|[1-9]\d*)$/.test(key) ||
          Number(key) >= length
        ) {
          return { violation: "contains a non-index array property" };
        }
      }

      const clone: JsonValue[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          !descriptor?.enumerable ||
          !("value" in descriptor) ||
          descriptor.get ||
          descriptor.set
        ) {
          return { violation: "contains a sparse or accessor array item" };
        }
        const result = cloneJsonValue(descriptor.value, depth + 1, state);
        if ("violation" in result) return result;
        clone.push(result.value);
      }
      return { value: clone };
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return { violation: "contains a non-plain object" };
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > MAX_MIGRATION_CHECKPOINT_KEYS) {
      return { violation: "contains an object with too many keys" };
    }

    const clone: Record<string, JsonValue> = {};
    for (const key of keys) {
      if (typeof key !== "string") {
        return { violation: "contains a symbol key" };
      }
      if (
        !CHECKPOINT_KEY_PATTERN.test(key) ||
        FORBIDDEN_CHECKPOINT_KEYS.has(key)
      ) {
        return { violation: `contains an invalid key: ${key}` };
      }

      const descriptor = descriptors[key];
      if (
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        descriptor.get ||
        descriptor.set
      ) {
        return { violation: `contains a non-data property: ${key}` };
      }

      const result = cloneJsonValue(
        descriptor.value,
        depth + 1,
        state,
      );
      if ("violation" in result) return result;
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        value: result.value,
        writable: true,
      });
    }
    return { value: clone };
  } finally {
    state.ancestors.delete(value);
  }
}

export function cloneAndValidateMigrationCheckpoint(
  value: unknown,
): MigrationCheckpointCloneResult {
  if (value === null || value === undefined) return { checkpoint: null };

  try {
    if (typeof value !== "object" || Array.isArray(value)) {
      return { violation: "must be a JSON object or null" };
    }
    const result = cloneJsonValue(value, 0, {
      nodes: 0,
      ancestors: new Set<object>(),
    });
    if (typeof result.violation === "string") {
      return { violation: result.violation };
    }

    const checkpoint = result.value as MigrationCheckpoint;
    const serialized = JSON.stringify(checkpoint);
    if (
      Buffer.byteLength(serialized, "utf8") > MAX_MIGRATION_CHECKPOINT_BYTES
    ) {
      return { violation: "exceeds the maximum serialized size" };
    }
    return { checkpoint };
  } catch {
    return { violation: "cannot be inspected safely" };
  }
}

export function findMigrationCheckpointViolation(
  value: unknown,
): string | undefined {
  return cloneAndValidateMigrationCheckpoint(value).violation;
}

export function isMigrationCheckpoint(
  value: unknown,
): value is MigrationCheckpoint | null | undefined {
  return findMigrationCheckpointViolation(value) === undefined;
}

export interface MigrationCounts {
  readonly examined: number;
  readonly matched: number;
  readonly modified: number;
  readonly skipped: number;
  readonly errors: number;
}

export interface MigrationPlan {
  readonly summary: string;
  readonly counts: MigrationCounts;
  readonly estimatedBatches: number;
  readonly warnings: readonly MigrationPlanWarning[];
}

export interface MigrationPlanWarning {
  readonly code: string;
  readonly count: number;
}

interface MigrationProgressContextBase<
  TCheckpoint extends MigrationCheckpoint,
  TAppliedCheckpoint extends MigrationCheckpoint,
> {
  readonly direction: MigrationDirection;
  /** Progress for the currently executing direction. */
  readonly checkpoint: TCheckpoint | null;
  /** Preserved high-watermark/backup locator from the forward migration. */
  readonly appliedCheckpoint: TAppliedCheckpoint | null;
  readonly batchSize: number;
  readonly signal?: AbortSignal;
}

export interface MigrationPlanContext {
  readonly database: MigrationReadDatabase;
  readonly batchSize: number;
  readonly signal?: AbortSignal;
}

export interface MigrationBatchContext<
  TCheckpoint extends MigrationCheckpoint = MigrationCheckpoint,
  TAppliedCheckpoint extends MigrationCheckpoint = TCheckpoint,
> extends MigrationProgressContextBase<TCheckpoint, TAppliedCheckpoint> {
  readonly database: MigrationTransactionDatabase;
  readonly runId: string;
}

export interface MigrationVerificationContext<
  TCheckpoint extends MigrationCheckpoint = MigrationCheckpoint,
  TAppliedCheckpoint extends MigrationCheckpoint = TCheckpoint,
> extends MigrationProgressContextBase<TCheckpoint, TAppliedCheckpoint> {
  readonly database: MigrationTransactionReadDatabase;
}

export type MigrationBatchResult<
  TCheckpoint extends MigrationCheckpoint = MigrationCheckpoint,
> =
  | {
      readonly done: false;
      readonly checkpoint: TCheckpoint;
      readonly counts: MigrationCounts;
    }
  | {
      readonly done: true;
      readonly checkpoint: TCheckpoint | null;
      readonly counts: MigrationCounts;
    };

export interface MigrationVerificationResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly counts: MigrationCounts;
}

export interface MigrationDefinition<
  TApplyCheckpoint extends MigrationCheckpoint = MigrationCheckpoint,
  TRollbackCheckpoint extends MigrationCheckpoint = TApplyCheckpoint,
> {
  readonly id: string;
  readonly description: string;
  readonly checksum: string;
  readonly plan: (
    context: MigrationPlanContext,
  ) => Promise<MigrationPlan>;
  readonly up: (
    context: MigrationBatchContext<TApplyCheckpoint, TApplyCheckpoint>,
  ) => Promise<MigrationBatchResult<TApplyCheckpoint>>;
  readonly down: (
    context: MigrationBatchContext<TRollbackCheckpoint, TApplyCheckpoint>,
  ) => Promise<MigrationBatchResult<TRollbackCheckpoint>>;
  readonly verify: (
    context: MigrationVerificationContext<
      TApplyCheckpoint | TRollbackCheckpoint,
      TApplyCheckpoint
    >,
  ) => Promise<MigrationVerificationResult>;
}

/**
 * A migration's authored source definition. Its checksum is derived from the
 * LF-normalized source file and injected by the registry.
 */
export type MigrationSourceDefinition<
  TApplyCheckpoint extends MigrationCheckpoint = MigrationCheckpoint,
  TRollbackCheckpoint extends MigrationCheckpoint = TApplyCheckpoint,
> = Omit<
  MigrationDefinition<TApplyCheckpoint, TRollbackCheckpoint>,
  "checksum"
> & {
  readonly checksum?: never;
};
