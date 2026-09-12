export type PushNotificationErrorCode =
  | "PUSH_NOT_AVAILABLE"
  | "PUSH_SUBSCRIPTION_CONFLICT"
  | "PUSH_SUBSCRIPTION_NOT_FOUND";

export class PushNotificationError extends Error {
  readonly name = "PushNotificationError";

  constructor(
    public readonly code: PushNotificationErrorCode,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}

export function pushNotAvailable(): PushNotificationError {
  return new PushNotificationError(
    "PUSH_NOT_AVAILABLE",
    503,
    "Push notifications are not currently available.",
  );
}

export function pushSubscriptionConflict(): PushNotificationError {
  return new PushNotificationError(
    "PUSH_SUBSCRIPTION_CONFLICT",
    409,
    "This browser subscription is already registered.",
  );
}

export function pushSubscriptionNotFound(): PushNotificationError {
  return new PushNotificationError(
    "PUSH_SUBSCRIPTION_NOT_FOUND",
    404,
    "Push subscription not found.",
  );
}
