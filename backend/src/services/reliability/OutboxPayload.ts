import { createHash } from "crypto";

export type OutboxJsonPrimitive = string | number | boolean | null;
export type OutboxJsonValue =
  | OutboxJsonPrimitive
  | OutboxJsonValue[]
  | OutboxJsonObject;
export interface OutboxJsonObject {
  readonly [key: string]: OutboxJsonValue;
}

export const OUTBOX_PAYLOAD_LIMITS = Object.freeze({
  maxBytes: 32 * 1024,
  maxDepth: 8,
  maxNodes: 1_000,
  maxArrayItems: 250,
  maxObjectKeys: 150,
  maxKeyLength: 128,
  maxStringLength: 8_192,
});

export class InvalidOutboxPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOutboxPayloadError";
  }
}

interface TraversalState {
  nodes: number;
  readonly ancestors: WeakSet<object>;
}

function fail(reason: string): never {
  throw new InvalidOutboxPayloadError(`Invalid outbox payload: ${reason}`);
}

function normalizeValue(
  value: unknown,
  state: TraversalState,
  depth: number,
): OutboxJsonValue {
  state.nodes += 1;
  if (state.nodes > OUTBOX_PAYLOAD_LIMITS.maxNodes) {
    fail("node limit exceeded");
  }
  if (depth > OUTBOX_PAYLOAD_LIMITS.maxDepth) {
    fail("depth limit exceeded");
  }

  if (value === null) return null;
  if (typeof value === "string") {
    if (value.length > OUTBOX_PAYLOAD_LIMITS.maxStringLength) {
      fail("string limit exceeded");
    }
    return value;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("numbers must be finite");
    return Object.is(value, -0) ? 0 : value;
  }
  if (
    typeof value === "undefined" ||
    typeof value === "bigint" ||
    typeof value === "symbol" ||
    typeof value === "function"
  ) {
    fail("only JSON values are allowed");
  }
  if (typeof value !== "object") fail("only JSON values are allowed");

  if (state.ancestors.has(value)) fail("cyclic values are not allowed");
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > OUTBOX_PAYLOAD_LIMITS.maxArrayItems) {
        fail("array item limit exceeded");
      }
      return value.map((item) => normalizeValue(item, state, depth + 1));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("only plain objects are allowed");
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort();
    if (keys.length > OUTBOX_PAYLOAD_LIMITS.maxObjectKeys) {
      fail("object key limit exceeded");
    }

    const normalized: Record<string, OutboxJsonValue> = {};
    for (const key of keys) {
      if (
        !key ||
        key.length > OUTBOX_PAYLOAD_LIMITS.maxKeyLength ||
        key.startsWith("$") ||
        key.includes(".") ||
        key === "__proto__" ||
        key === "prototype" ||
        key === "constructor"
      ) {
        fail("unsafe object key");
      }
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) {
        fail("accessor properties are not allowed");
      }
      normalized[key] = normalizeValue(descriptor.value, state, depth + 1);
    }
    return normalized;
  } finally {
    state.ancestors.delete(value);
  }
}

/**
 * Produces a canonical, detached JSON object for durable storage. Sorting object
 * keys makes the corresponding hash stable across request retries.
 */
export function normalizeOutboxPayload(value: unknown): OutboxJsonObject {
  const normalized = normalizeValue(
    value,
    { nodes: 0, ancestors: new WeakSet<object>() },
    0,
  );
  if (normalized === null || Array.isArray(normalized) || typeof normalized !== "object") {
    fail("the root value must be an object");
  }

  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, "utf8") > OUTBOX_PAYLOAD_LIMITS.maxBytes) {
    fail("byte limit exceeded");
  }
  return normalized;
}

export function hashOutboxPayload(
  payloadVersion: number,
  payload: OutboxJsonObject,
): string {
  return createHash("sha256")
    .update(`${payloadVersion}:`)
    .update(JSON.stringify(payload))
    .digest("hex");
}

export function hashOutboxDedupeKey(dedupeKey: string): string {
  return createHash("sha256").update(dedupeKey).digest("hex");
}

export function hashOutboxError(error: unknown): string {
  let description = "unknown";
  if (error instanceof Error) {
    description = `${error.name}:${error.message}`;
  } else if (typeof error === "string") {
    description = error;
  }
  return createHash("sha256").update(description.slice(0, 8_192)).digest("hex");
}
