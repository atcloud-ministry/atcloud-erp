export const PUSH_INSTALLATION_ID_MAX_LENGTH = 128;
export const PUSH_ENDPOINT_MAX_LENGTH = 2_048;
export const PUSH_KEY_MAX_LENGTH = 512;
export const PUSH_SUBSCRIPTION_INACTIVITY_DAYS = 90;

const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;
const WEB_PUSH_HOST_SUFFIXES = [
  "push.services.mozilla.com",
  "notify.windows.com",
] as const;
const WEB_PUSH_EXACT_HOSTS = new Set([
  "fcm.googleapis.com",
  "web.push.apple.com",
]);
const ALLOWED_BODY_KEYS = new Set(["installationId", "subscription"]);
const ALLOWED_SUBSCRIPTION_KEYS = new Set(["endpoint", "expirationTime", "keys"]);
const ALLOWED_KEYS_KEYS = new Set(["p256dh", "auth"]);
const ALLOWED_PREFERENCE_KEYS = new Set(["pushEnabled", "emailEnabled"]);

export interface PushSubscriptionInput {
  readonly installationId: string;
  readonly endpoint: string;
  readonly expirationTime: number | null;
  readonly keys: {
    readonly p256dh: string;
    readonly auth: string;
  };
}

export interface PushSubscriptionDTO {
  readonly id: string;
  readonly installationId: string;
  readonly status: "active";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSuccessfulPushAt: string | null;
}

export interface PushSubscriptionListDTO {
  readonly subscriptions: readonly PushSubscriptionDTO[];
}

export interface NotificationPreferenceDTO {
  readonly pushEnabled: boolean;
  readonly emailEnabled: boolean;
  readonly updatedAt: string | null;
}

export interface PushPublicConfigDTO {
  readonly enabled: boolean;
  readonly publicKey: string | null;
}

export class PushNotificationValidationError extends Error {
  readonly name = "PushNotificationValidationError";

  constructor(
    public readonly issues: readonly Readonly<{ path: string; msg: string }>[],
  ) {
    super("Invalid push notification request.");
  }
}

function issue(path: string, msg: string): never {
  throw new PushNotificationValidationError([Object.freeze({ path, msg })]);
}

function plainObject(
  value: unknown,
  path: string,
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return issue(path, "Must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return issue(path, "Must be a plain object");
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  source: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  const unexpected = Object.keys(source).find((key) => !allowed.has(key));
  if (unexpected) issue(`${path}.${unexpected}`, "Unexpected field");
}

function boundedString(
  value: unknown,
  path: string,
  maximum: number,
  pattern?: RegExp,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    (pattern && !pattern.test(value))
  ) {
    return issue(path, "Invalid value");
  }
  return value;
}

function subscriptionKey(
  value: unknown,
  path: string,
  expectedBytes: number,
  requireUncompressedPoint = false,
): string {
  const encoded = boundedString(
    value,
    path,
    PUSH_KEY_MAX_LENGTH,
    BASE64URL_PATTERN,
  );
  let decoded: Buffer;
  try {
    decoded = Buffer.from(encoded.replace(/=+$/u, ""), "base64url");
  } catch {
    return issue(path, "Invalid Web Push key");
  }
  if (
    decoded.length !== expectedBytes ||
    (requireUncompressedPoint && decoded[0] !== 4)
  ) {
    return issue(path, "Invalid Web Push key");
  }
  return encoded;
}

export function parsePushSubscriptionBody(
  value: unknown,
): PushSubscriptionInput {
  const body = plainObject(value, "body");
  exactKeys(body, ALLOWED_BODY_KEYS, "body");
  const subscription = plainObject(body.subscription, "subscription");
  exactKeys(subscription, ALLOWED_SUBSCRIPTION_KEYS, "subscription");
  const keys = plainObject(subscription.keys, "subscription.keys");
  exactKeys(keys, ALLOWED_KEYS_KEYS, "subscription.keys");

  const installationId = boundedString(
    body.installationId,
    "installationId",
    PUSH_INSTALLATION_ID_MAX_LENGTH,
    INSTALLATION_ID_PATTERN,
  );
  const endpoint = boundedString(
    subscription.endpoint,
    "subscription.endpoint",
    PUSH_ENDPOINT_MAX_LENGTH,
  );
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return issue("subscription.endpoint", "Must be a valid HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port !== "" && url.port !== "443") ||
    (!WEB_PUSH_EXACT_HOSTS.has(url.hostname.toLowerCase()) &&
      !WEB_PUSH_HOST_SUFFIXES.some(
        (suffix) =>
          url.hostname.toLowerCase() === suffix ||
          url.hostname.toLowerCase().endsWith(`.${suffix}`),
      ))
  ) {
    return issue("subscription.endpoint", "Must be a supported Web Push HTTPS URL");
  }

  const expirationTime = subscription.expirationTime;
  if (
    expirationTime !== null &&
    (!Number.isSafeInteger(expirationTime) || Number(expirationTime) <= 0)
  ) {
    return issue("subscription.expirationTime", "Must be null or a positive integer");
  }

  return Object.freeze({
    installationId,
    endpoint,
    expirationTime: expirationTime === null ? null : Number(expirationTime),
    keys: Object.freeze({
      p256dh: subscriptionKey(
        keys.p256dh,
        "subscription.keys.p256dh",
        65,
        true,
      ),
      auth: subscriptionKey(
        keys.auth,
        "subscription.keys.auth",
        16,
      ),
    }),
  });
}

export function parseInstallationId(value: unknown): string {
  return boundedString(
    value,
    "installationId",
    PUSH_INSTALLATION_ID_MAX_LENGTH,
    INSTALLATION_ID_PATTERN,
  );
}

export function parseNotificationPreferenceBody(value: unknown): {
  readonly pushEnabled?: boolean;
  readonly emailEnabled?: boolean;
} {
  const body = plainObject(value, "body");
  exactKeys(body, ALLOWED_PREFERENCE_KEYS, "body");
  if (Object.keys(body).length === 0) issue("body", "At least one field is required");
  if (body.pushEnabled !== undefined && typeof body.pushEnabled !== "boolean") {
    issue("pushEnabled", "Must be a boolean");
  }
  if (body.emailEnabled !== undefined && typeof body.emailEnabled !== "boolean") {
    issue("emailEnabled", "Must be a boolean");
  }
  return Object.freeze({
    ...(typeof body.pushEnabled === "boolean"
      ? { pushEnabled: body.pushEnabled }
      : {}),
    ...(typeof body.emailEnabled === "boolean"
      ? { emailEnabled: body.emailEnabled }
      : {}),
  });
}
