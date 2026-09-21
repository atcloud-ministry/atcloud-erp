const EVENT_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,79}$/u;
const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u;
const ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;

export interface SafeErrorEventMetadata {
  readonly eventCode: string;
  readonly errorName: string;
  readonly userId?: string;
}

export function safeErrorName(error: unknown): string {
  let candidate: unknown;
  try {
    candidate =
      error instanceof Error
        ? error.name
        : error && typeof error === "object" && "name" in error
          ? error.name
          : undefined;
  } catch {
    return "UnknownError";
  }
  return typeof candidate === "string" && ERROR_NAME_PATTERN.test(candidate)
    ? candidate
    : "UnknownError";
}

function safeEventMetadata(
  eventCode: string,
  error: unknown,
  userId?: string,
): SafeErrorEventMetadata {
  const safeEventCode = EVENT_CODE_PATTERN.test(eventCode)
    ? eventCode
    : "APPLICATION_OPERATION_FAILED";
  const safeUserId =
    typeof userId === "string" && USER_ID_PATTERN.test(userId)
      ? userId
      : undefined;
  return Object.freeze({
    eventCode: safeEventCode,
    errorName: safeErrorName(error),
    ...(safeUserId ? { userId: safeUserId } : {}),
  });
}

/** Emit bounded metadata only; never pass the original Error or request payload. */
export function logSafeErrorEvent(
  eventCode: string,
  error: unknown,
  userId?: string,
): void {
  console.error(
    "Application operation failed",
    safeEventMetadata(eventCode, error, userId),
  );
}

/** Non-fatal counterpart for delivery/notification degradation. */
export function logSafeWarningEvent(
  eventCode: string,
  error: unknown,
  userId?: string,
): void {
  console.warn(
    "Application operation degraded",
    safeEventMetadata(eventCode, error, userId),
  );
}
