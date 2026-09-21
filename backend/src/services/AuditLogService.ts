import { createHash } from "crypto";
import mongoose from "mongoose";
import {
  AUDIT_ACTOR_TYPES,
  AUDIT_LOG_VERSION,
  AUDIT_OUTCOMES,
  AUDIT_SOURCES,
  type AuditActor,
  type AuditLogWriteInput,
  type AuditSource,
} from "../contracts/auditLog";
import AuditLog from "../models/AuditLog";
import { scrubSensitiveString } from "../utils/sensitiveString";
import { createLogger } from "./LoggerService";
import { auditLogWriteFailureCounter } from "./PrometheusMetricsService";

export const AUDIT_DETAIL_LIMITS = Object.freeze({
  maxDepth: 5,
  maxKeysPerObject: 30,
  maxArrayItems: 30,
  maxNodes: 200,
  maxStringLength: 500,
  maxTotalStringCharacters: 8_000,
  maxSerializedLength: 16_000,
});

const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";
const CIRCULAR = "[CIRCULAR]";
const MAX_DEPTH = "[MAX_DEPTH]";
const UNSUPPORTED = "[UNSUPPORTED]";

type SanitizedAuditValue =
  | null
  | boolean
  | number
  | string
  | SanitizedAuditValue[]
  | { [key: string]: SanitizedAuditValue };

interface SanitizationState {
  readonly seen: WeakSet<object>;
  nodesRemaining: number;
  charactersRemaining: number;
}

const log = createLogger("AuditLogService");

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveDetailKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (!normalized) return true;

  if (
    normalized.includes("password") ||
    normalized.includes("passwd") ||
    normalized.includes("passphrase") ||
    normalized.includes("secret") ||
    normalized.includes("token") ||
    normalized.includes("apikey") ||
    normalized.includes("credential") ||
    normalized.includes("privatekey") ||
    normalized === "authorization" ||
    normalized === "authorizationheader" ||
    normalized === "cookie" ||
    normalized === "setcookie"
  ) {
    return true;
  }

  if (normalized.includes("email")) {
    return !normalized.endsWith("emailhash");
  }

  const containsRawIp =
    normalized === "ip" ||
    normalized === "ipaddress" ||
    normalized === "clientip" ||
    normalized === "remoteip" ||
    normalized === "remoteaddress" ||
    normalized === "ipcidr";
  if (containsRawIp) return true;

  const isContentDescriptor = /(?:id|ids|count|type|kind|status|sequence|code|at)$/.test(
    normalized,
  );
  if (isContentDescriptor) return false;

  return (
    normalized === "message" ||
    normalized === "messages" ||
    normalized.endsWith("message") ||
    normalized === "body" ||
    normalized.startsWith("body") ||
    normalized.endsWith("body") ||
    normalized === "text" ||
    normalized.endsWith("text") ||
    normalized === "content" ||
    normalized.endsWith("content") ||
    normalized === "html" ||
    normalized.endsWith("html") ||
    normalized === "markdown" ||
    normalized.endsWith("markdown") ||
    normalized === "subject" ||
    normalized === "description" ||
    normalized === "note" ||
    normalized === "notes" ||
    normalized === "comment" ||
    normalized === "comments" ||
    normalized === "reason" ||
    normalized === "payload" ||
    normalized === "request" ||
    normalized === "response" ||
    normalized === "input" ||
    normalized === "output" ||
    normalized === "raw" ||
    normalized === "summary"
  );
}

function redactedDetailKey(key: string): string {
  return `_redacted_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

function sanitizeString(value: string, state: SanitizationState): string {
  const allowedLength = Math.max(
    0,
    Math.min(
      AUDIT_DETAIL_LIMITS.maxStringLength,
      state.charactersRemaining,
    ),
  );

  if (allowedLength === 0) return TRUNCATED;

  // Bound privacy scanning work while leaving enough lookahead for every
  // supported sensitive token to cross the stored-string boundary safely.
  const scrubbed = scrubSensitiveString(value.slice(0, allowedLength + 512));
  const wasTruncated = value.length > allowedLength || scrubbed.length > allowedLength;
  const bounded = scrubbed.slice(0, allowedLength);
  state.charactersRemaining -= bounded.length;
  return wasTruncated ? `${bounded}${TRUNCATED}` : bounded;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function sanitizeValue(
  value: unknown,
  state: SanitizationState,
  depth: number,
): SanitizedAuditValue | undefined {
  if (state.nodesRemaining <= 0) return TRUNCATED;
  state.nodesRemaining -= 1;

  if (value === null) return null;
  if (typeof value === "string") return sanitizeString(value, state);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : UNSUPPORTED;
  }
  if (typeof value === "bigint") return sanitizeString(value.toString(), state);
  if (
    typeof value === "undefined" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return undefined;
  }

  try {
    if (value instanceof Date) {
      const timestamp = Date.prototype.getTime.call(value);
      return Number.isNaN(timestamp)
        ? UNSUPPORTED
        : sanitizeString(Date.prototype.toISOString.call(value), state);
    }
    if (Buffer.isBuffer(value)) return `[BINARY:${value.length}]`;

    const bsonCandidate = value as {
      _bsontype?: unknown;
      toHexString?: unknown;
    };
    if (
      bsonCandidate._bsontype === "ObjectId" &&
      typeof bsonCandidate.toHexString === "function"
    ) {
      return sanitizeString(
        (bsonCandidate.toHexString as () => string).call(value),
        state,
      );
    }
  } catch {
    return UNSUPPORTED;
  }

  if (depth >= AUDIT_DETAIL_LIMITS.maxDepth) return MAX_DEPTH;
  if (state.seen.has(value)) return CIRCULAR;
  state.seen.add(value);

  if (Array.isArray(value)) {
    const result: SanitizedAuditValue[] = [];
    const length = Math.min(value.length, AUDIT_DETAIL_LIMITS.maxArrayItems);
    for (let index = 0; index < length; index += 1) {
      const sanitized = sanitizeValue(value[index], state, depth + 1);
      if (sanitized !== undefined) result.push(sanitized);
    }
    if (value.length > length) result.push(TRUNCATED);
    return result;
  }

  if (!isPlainObject(value)) return UNSUPPORTED;

  const result: { [key: string]: SanitizedAuditValue } = {};
  let descriptors: Array<[string, PropertyDescriptor]>;
  try {
    descriptors = Object.entries(Object.getOwnPropertyDescriptors(value));
  } catch {
    return { _value: UNSUPPORTED };
  }
  let acceptedKeys = 0;
  for (const [key, descriptor] of descriptors) {
    if (acceptedKeys >= AUDIT_DETAIL_LIMITS.maxKeysPerObject) {
      result._truncated = TRUNCATED;
      break;
    }
    if (
      key.length === 0 ||
      key.length > 64 ||
      key === "__proto__" ||
      key === "prototype" ||
      key === "constructor"
    ) {
      continue;
    }

    const keyContainsSensitiveText = scrubSensitiveString(key) !== key;
    if (keyContainsSensitiveText || isSensitiveDetailKey(key)) {
      acceptedKeys += 1;
      result[redactedDetailKey(key)] = REDACTED;
      continue;
    }
    if (key.startsWith("$") || key.includes(".")) {
      continue;
    }

    acceptedKeys += 1;
    if (!("value" in descriptor)) {
      result[key] = REDACTED;
      continue;
    }

    const sanitized = sanitizeValue(descriptor.value, state, depth + 1);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

export function sanitizeAuditDetails(
  details: Readonly<Record<string, unknown>>,
): Record<string, SanitizedAuditValue> {
  const state: SanitizationState = {
    seen: new WeakSet<object>(),
    nodesRemaining: AUDIT_DETAIL_LIMITS.maxNodes,
    charactersRemaining: AUDIT_DETAIL_LIMITS.maxTotalStringCharacters,
  };
  const sanitized = sanitizeValue(details, state, 0);
  const result =
    sanitized && !Array.isArray(sanitized) && typeof sanitized === "object"
      ? sanitized
      : { _value: sanitized ?? null };

  if (JSON.stringify(result).length > AUDIT_DETAIL_LIMITS.maxSerializedLength) {
    return { _truncated: TRUNCATED };
  }
  return result;
}

function requireBoundedValue(
  value: string,
  name: string,
  maxLength: number,
  pattern: RegExp,
): string {
  const bounded = value.trim();
  if (
    !bounded ||
    bounded.length > maxLength ||
    !pattern.test(bounded) ||
    scrubSensitiveString(bounded) !== bounded
  ) {
    throw new Error(`Invalid audit ${name}.`);
  }
  return bounded;
}

function actorFields(actor: AuditActor): Record<string, unknown> {
  if (actor.type === "user") {
    const id = requireBoundedValue(
      actor.id,
      "actor id",
      64,
      /^[a-fA-F0-9]{24}$/,
    );
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error("Invalid audit actor id.");
    }
    const role = requireBoundedValue(
      actor.role,
      "actor role",
      80,
      /^[A-Za-z][A-Za-z0-9 _-]*$/,
    );
    return {
      actorType: actor.type,
      actorKey: id,
      actorId: id,
      actor: { id, role },
    };
  }

  const key = requireBoundedValue(
    actor.key,
    "actor key",
    200,
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
  );
  return { actorType: actor.type, actorKey: key };
}

function safeMetricSource(source: unknown): AuditSource | "unknown" {
  return typeof source === "string" &&
    (AUDIT_SOURCES as readonly string[]).includes(source)
    ? (source as AuditSource)
    : "unknown";
}

function tryBoundedValue(
  value: unknown,
  name: string,
  maxLength: number,
  pattern: RegExp,
): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return requireBoundedValue(value, name, maxLength, pattern);
  } catch {
    return undefined;
  }
}

function optionalIdentifier(
  value: unknown,
  name: string,
  maxLength: number,
): string | undefined {
  return tryBoundedValue(
    value,
    name,
    maxLength,
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
  );
}

function optionalSha256(value: unknown, name: string): string | undefined {
  return tryBoundedValue(value, name, 64, /^[a-fA-F0-9]{64}$/)?.toLowerCase();
}

function sha256Identifier(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function requireKnownValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`Invalid audit ${name}.`);
  }
  return value as T;
}

function safeLogAction(action: unknown): string {
  if (typeof action !== "string") return "unknown";
  const candidate = scrubSensitiveString(action).slice(0, 120);
  return /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(candidate)
    ? candidate
    : "invalid";
}

function buildAuditLogPayload(
  input: AuditLogWriteInput,
): Record<string, unknown> {
  const action = requireBoundedValue(
    input.action,
    "action",
    120,
    /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/,
  );
  const source = requireKnownValue(input.source, AUDIT_SOURCES, "source");
  const outcome = requireKnownValue(
    input.outcome,
    AUDIT_OUTCOMES,
    "outcome",
  );
  requireKnownValue(input.actor?.type, AUDIT_ACTOR_TYPES, "actor type");
  const correlationId = optionalIdentifier(
    input.correlationId,
    "correlation id",
    128,
  );
  const reasonCode = optionalIdentifier(
    input.reasonCode,
    "reason code",
    120,
  );
  const emailHash = optionalSha256(input.hashes?.email, "email hash");
  const ipHash = optionalSha256(input.hashes?.ip, "IP hash");

  const payload: Record<string, unknown> = {
    version: AUDIT_LOG_VERSION,
    action,
    source,
    outcome,
    ...actorFields(input.actor),
  };

  if (input.target && typeof input.target === "object") {
    const targetModel = tryBoundedValue(
      input.target.model,
      "target model",
      80,
      /^[A-Za-z][A-Za-z0-9_-]*$/,
    );
    const targetId = optionalIdentifier(input.target.id, "target id", 200);

    if (targetModel && typeof input.target.id === "string") {
      payload.targetModel = targetModel;
      payload.targetId = targetId ?? sha256Identifier(input.target.id);
    }
  }
  if (correlationId) payload.correlationId = correlationId;
  if (reasonCode) payload.reasonCode = reasonCode;
  if (input.details) payload.details = sanitizeAuditDetails(input.details);
  if (emailHash) payload.emailHash = emailHash;
  if (ipHash) payload.ipHash = ipHash;
  if (typeof input.userAgent === "string" && input.userAgent) {
    const state: SanitizationState = {
      seen: new WeakSet<object>(),
      nodesRemaining: 1,
      charactersRemaining: 500,
    };
    payload.userAgent = sanitizeString(input.userAgent, state);
  }

  return payload;
}

export class AuditLogService {
  /**
   * Persist an audit record inside the caller-owned MongoDB transaction.
   * The explicit, non-null session prevents a correctness-critical caller
   * from accidentally committing its audit record outside the domain write.
   */
  static async recordRequiredInTransaction(
    input: AuditLogWriteInput,
    session: mongoose.ClientSession,
  ): Promise<void> {
    if (!session || !session.inTransaction()) {
      throw new Error(
        "An active MongoDB transaction is required for transactional audit writes.",
      );
    }
    const payload = buildAuditLogPayload(input);
    await AuditLog.create([payload], { session });
  }

  /** Persist a mandatory audit record without joining a transaction. */
  static async recordRequiredStandalone(
    input: AuditLogWriteInput,
  ): Promise<void> {
    const payload = buildAuditLogPayload(input);
    await AuditLog.create(payload);
  }

  static async record(input: AuditLogWriteInput): Promise<boolean> {
    try {
      await this.recordRequiredStandalone(input);
      return true;
    } catch (error) {
      const source = safeMetricSource(input?.source);
      try {
        auditLogWriteFailureCounter.inc({ source });
      } catch {
        // Metrics must never turn a best-effort audit failure into a caller error.
      }
      log.error(
        "Best-effort audit log write failed",
        error instanceof Error ? error : new Error("Unknown audit write error"),
        "AuditLogService",
        {
          action: safeLogAction(input?.action),
          source,
        },
      );
      return false;
    }
  }
}

export default AuditLogService;
