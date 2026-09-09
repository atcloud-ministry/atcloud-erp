export type IdempotencyReplayValue =
  | null
  | boolean
  | number
  | string
  | readonly IdempotencyReplayValue[]
  | IdempotencyReplayResponseDto;

/**
 * Minimal JSON object retained solely to replay an HTTP result. Human-authored
 * content and secrets belong in the referenced domain resource, not here.
 */
export interface IdempotencyReplayResponseDto {
  readonly [key: string]: IdempotencyReplayValue;
}

export const IDEMPOTENCY_REPLAY_RESPONSE_LIMITS = Object.freeze({
  maxBytes: 64 * 1024,
  maxDepth: 20,
  maxNodes: 10_000,
});

const FORBIDDEN_KEY_SUFFIXES = Object.freeze([
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "apikey",
  "credential",
  "credentials",
  "authorization",
  "authorizationheader",
  "cookie",
  "cookievalue",
  "message",
  "messages",
  "content",
  "body",
  "text",
  "html",
  "markdown",
  "subject",
  "description",
  "note",
  "notes",
  "comment",
  "comments",
  "payload",
  "request",
  "response",
  "input",
  "output",
  "raw",
  "summary",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function forbiddenKey(key: string): boolean {
  if (key === "__proto__" || key === "prototype" || key === "constructor") {
    return true;
  }
  const normalized = normalizeKey(key);
  return (
    normalized.length === 0 ||
    FORBIDDEN_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

/** Returns a value-free validation message, or undefined for a safe DTO. */
export function findIdempotencyReplayResponseViolation(
  value: unknown,
): string | undefined {
  if (!isPlainRecord(value)) {
    return "Idempotency response must be a minimal JSON object DTO.";
  }

  const seen = new WeakSet<object>();
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value, depth: 0 },
  ];
  let nodes = 0;
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) continue;
    const { value: current, depth } = entry;
    nodes += 1;
    if (nodes > IDEMPOTENCY_REPLAY_RESPONSE_LIMITS.maxNodes) {
      return "Idempotency response exceeds its JSON node limit.";
    }
    if (depth > IDEMPOTENCY_REPLAY_RESPONSE_LIMITS.maxDepth) {
      return "Idempotency response exceeds its maximum JSON depth.";
    }
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      continue;
    }
    if (typeof current === "number") {
      if (Number.isFinite(current)) continue;
      return "Idempotency response numbers must be finite.";
    }
    if (!current || typeof current !== "object") {
      return "Idempotency response must contain only JSON values.";
    }
    if (seen.has(current)) {
      return "Idempotency response cannot contain circular references.";
    }
    seen.add(current);

    if (Array.isArray(current)) {
      if (current.length > IDEMPOTENCY_REPLAY_RESPONSE_LIMITS.maxNodes) {
        return "Idempotency response exceeds its JSON node limit.";
      }
      for (let index = 0; index < current.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(current, index)) {
          return "Idempotency response cannot contain sparse arrays.";
        }
        stack.push({ value: current[index], depth: depth + 1 });
      }
      continue;
    }
    if (!isPlainRecord(current)) {
      return "Idempotency response must contain only plain JSON objects.";
    }
    const entries = Object.entries(current);
    if (entries.length > IDEMPOTENCY_REPLAY_RESPONSE_LIMITS.maxNodes) {
      return "Idempotency response exceeds its JSON node limit.";
    }
    for (const [key, child] of entries) {
      if (forbiddenKey(key)) {
        return "Idempotency response contains a field that cannot be persisted. Return a resource/status reference instead.";
      }
      stack.push({ value: child, depth: depth + 1 });
    }
  }

  try {
    const serialized = JSON.stringify(value);
    if (
      Buffer.byteLength(serialized, "utf8") >
      IDEMPOTENCY_REPLAY_RESPONSE_LIMITS.maxBytes
    ) {
      return "Idempotency response exceeds its persistence byte limit.";
    }
  } catch {
    return "Idempotency response must contain only JSON values.";
  }

  return undefined;
}
