import { createHash } from "node:crypto";
import type {
  MigrationBatchResult,
  MigrationCheckpoint,
  MigrationCounts,
  MigrationFailureCode,
  MigrationPlan,
  MigrationPlanWarning,
  MigrationVerificationResult,
} from "../../migrations/types";
import {
  cloneAndValidateMigrationCheckpoint,
  isMigrationFailureCode,
} from "../../migrations/types";
import { MigrationUsageError } from "./MigrationErrors";

export const ZERO_MIGRATION_COUNTS: MigrationCounts = Object.freeze({
  examined: 0,
  matched: 0,
  modified: 0,
  skipped: 0,
  errors: 0,
});

const MAX_COUNT = Number.MAX_SAFE_INTEGER;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,79}$/;

function requireCount(value: unknown, name: keyof MigrationCounts): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new MigrationUsageError(
      `Migration count ${name} must be a non-negative safe integer.`,
    );
  }
  return value as number;
}

export function normalizeMigrationCounts(value: unknown): MigrationCounts {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MigrationUsageError("Migration counts must be an object.");
  }

  const candidate = value as Partial<Record<keyof MigrationCounts, unknown>>;
  const counts: MigrationCounts = {
    examined: requireCount(candidate.examined, "examined"),
    matched: requireCount(candidate.matched, "matched"),
    modified: requireCount(candidate.modified, "modified"),
    skipped: requireCount(candidate.skipped, "skipped"),
    errors: requireCount(candidate.errors, "errors"),
  };

  if (counts.matched > counts.examined) {
    throw new MigrationUsageError(
      "Migration matched count cannot exceed examined count.",
    );
  }
  if (counts.modified > counts.matched) {
    throw new MigrationUsageError(
      "Migration modified count cannot exceed matched count.",
    );
  }
  if (counts.skipped > counts.examined) {
    throw new MigrationUsageError(
      "Migration skipped count cannot exceed examined count.",
    );
  }
  if (counts.errors > counts.examined) {
    throw new MigrationUsageError(
      "Migration error count cannot exceed examined count.",
    );
  }
  return counts;
}

function safeAdd(left: number, right: number, name: keyof MigrationCounts): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total > MAX_COUNT) {
    throw new MigrationUsageError(`Migration count ${name} overflowed.`);
  }
  return total;
}

export function addMigrationCounts(
  total: MigrationCounts,
  delta: MigrationCounts,
): MigrationCounts {
  return {
    examined: safeAdd(total.examined, delta.examined, "examined"),
    matched: safeAdd(total.matched, delta.matched, "matched"),
    modified: safeAdd(total.modified, delta.modified, "modified"),
    skipped: safeAdd(total.skipped, delta.skipped, "skipped"),
    errors: safeAdd(total.errors, delta.errors, "errors"),
  };
}

export function cloneMigrationCheckpoint(
  value: unknown,
): MigrationCheckpoint | null {
  const result = cloneAndValidateMigrationCheckpoint(value);
  if ("violation" in result) {
    throw new MigrationUsageError(
      `Migration checkpoint ${result.violation}.`,
    );
  }
  return result.checkpoint;
}

function canonicalJsonValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalJsonValue);

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [
        key,
        canonicalJsonValue((value as Record<string, unknown>)[key]),
      ]),
  );
}

function checkpointKey(value: MigrationCheckpoint | null): string {
  return JSON.stringify(canonicalJsonValue(value));
}

export function normalizeMigrationBatchResult(
  value: unknown,
  previousCheckpoint: MigrationCheckpoint | null,
): MigrationBatchResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MigrationUsageError("Migration batch result must be an object.");
  }

  const candidate = value as {
    done?: unknown;
    checkpoint?: unknown;
    counts?: unknown;
  };
  if (typeof candidate.done !== "boolean") {
    throw new MigrationUsageError("Migration batch result requires done.");
  }

  const checkpoint = cloneMigrationCheckpoint(candidate.checkpoint);
  const counts = normalizeMigrationCounts(candidate.counts);
  if (counts.errors !== 0) {
    throw new MigrationUsageError(
      "A migration batch with row errors cannot be committed.",
    );
  }
  if (!candidate.done && checkpoint === null) {
    throw new MigrationUsageError(
      "An incomplete migration batch requires a checkpoint.",
    );
  }
  if (
    !candidate.done &&
    checkpointKey(checkpoint) === checkpointKey(previousCheckpoint)
  ) {
    throw new MigrationUsageError(
      "An incomplete migration batch must advance its checkpoint.",
    );
  }

  return candidate.done
    ? { done: true, checkpoint, counts }
    : { done: false, checkpoint: checkpoint!, counts };
}

export function normalizeMigrationPlan(value: unknown): MigrationPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MigrationUsageError("Migration plan must be an object.");
  }
  const candidate = value as Partial<MigrationPlan>;
  if (
    typeof candidate.summary !== "string" ||
    candidate.summary.trim().length < 1 ||
    candidate.summary.length > 500 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(candidate.summary)
  ) {
    throw new MigrationUsageError("Migration plan summary is invalid.");
  }
  if (
    !Number.isSafeInteger(candidate.estimatedBatches) ||
    (candidate.estimatedBatches as number) < 0
  ) {
    throw new MigrationUsageError(
      "Migration estimatedBatches must be a non-negative safe integer.",
    );
  }
  if (!Array.isArray(candidate.warnings) || candidate.warnings.length > 20) {
    throw new MigrationUsageError("Migration plan warnings are invalid.");
  }
  const warnings = candidate.warnings.map((warning): MigrationPlanWarning => {
    if (
      !warning ||
      typeof warning !== "object" ||
      Array.isArray(warning) ||
      Object.keys(warning).sort().join(",") !== "code,count"
    ) {
      throw new MigrationUsageError("Migration plan warnings are invalid.");
    }
    const candidateWarning = warning as Partial<MigrationPlanWarning>;
    if (
      typeof candidateWarning.code !== "string" ||
      !ERROR_CODE_PATTERN.test(candidateWarning.code) ||
      !Number.isSafeInteger(candidateWarning.count) ||
      (candidateWarning.count as number) < 0
    ) {
      throw new MigrationUsageError("Migration plan warnings are invalid.");
    }
    return {
      code: candidateWarning.code,
      count: candidateWarning.count as number,
    };
  });
  return {
    summary: candidate.summary,
    counts: normalizeMigrationCounts(candidate.counts),
    estimatedBatches: candidate.estimatedBatches as number,
    warnings,
  };
}

export function normalizeMigrationVerification(
  value: unknown,
): MigrationVerificationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MigrationUsageError(
      "Migration verification result must be an object.",
    );
  }
  const candidate = value as Partial<MigrationVerificationResult>;
  if (typeof candidate.ok !== "boolean") {
    throw new MigrationUsageError("Migration verification requires ok.");
  }
  if (
    typeof candidate.summary !== "string" ||
    candidate.summary.trim().length < 1 ||
    candidate.summary.length > 500 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(candidate.summary)
  ) {
    throw new MigrationUsageError("Migration verification summary is invalid.");
  }
  return {
    ok: candidate.ok,
    summary: candidate.summary,
    counts: normalizeMigrationCounts(candidate.counts),
  };
}

export interface SanitizedMigrationFailure {
  readonly code: MigrationFailureCode;
  readonly digest: string;
}

export function sanitizeMigrationFailure(
  error: unknown,
  fallbackCode: string,
): SanitizedMigrationFailure {
  let candidateCode: unknown;
  try {
    candidateCode =
      error !== null &&
      (typeof error === "object" || typeof error === "function")
        ? (error as { readonly code?: unknown }).code
        : undefined;
  } catch {
    candidateCode = undefined;
  }

  const safeFallback: MigrationFailureCode = isMigrationFailureCode(fallbackCode)
    ? fallbackCode
    : "MIGRATION_EXECUTION_FAILED";
  const code =
    isMigrationFailureCode(candidateCode)
      ? candidateCode
      : safeFallback;

  let description = "unknown";
  try {
    if (error instanceof Error) {
      const name = typeof error.name === "string" ? error.name : "Error";
      const message = typeof error.message === "string" ? error.message : "";
      description = `${name}:${message}`;
    } else if (typeof error === "string") {
      description = error;
    }
  } catch {
    description = "unknown";
  }
  return {
    code,
    digest: createHash("sha256")
      .update(description.slice(0, 8_192))
      .digest("hex"),
  };
}
