export const PUSH_INSTALLATION_ID_MAX_LENGTH = 128;
export const PUSH_ENDPOINT_MAX_LENGTH = 2_048;
export const PUSH_KEY_MAX_LENGTH = 512;

export interface PushPublicConfigDTO {
  enabled: boolean;
  publicKey: string | null;
}

export interface PushSubscriptionDTO {
  id: string;
  installationId: string;
  status: "active";
  createdAt: string;
  updatedAt: string;
  lastSuccessfulPushAt: string | null;
}

export interface PushSubscriptionListDTO {
  subscriptions: PushSubscriptionDTO[];
}

export interface NotificationPreferenceDTO {
  pushEnabled: boolean;
  emailEnabled: boolean;
  updatedAt: string | null;
}

export interface PushSubscriptionInput {
  installationId: string;
  subscription: {
    endpoint: string;
    expirationTime: number | null;
    keys: {
      p256dh: string;
      auth: string;
    };
  };
}

export interface NotificationPreferenceChanges {
  pushEnabled?: boolean;
  emailEnabled?: boolean;
}

type JsonObject = Record<string, unknown>;

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;

function contractError(path: string, expectation: string): never {
  throw new Error(
    `Invalid Push Notifications API response at ${path}: expected ${expectation}`,
  );
}

function exactObjectAt(
  value: unknown,
  path: string,
  expectedKeys: readonly string[],
): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return contractError(path, "object");
  }
  const object = value as JsonObject;
  const keys = Object.keys(object);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => !expectedKeys.includes(key))
  ) {
    return contractError(path, `exact keys ${expectedKeys.join(", ")}`);
  }
  return object;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string") return contractError(path, "string");
  return value;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") return contractError(path, "boolean");
  return value;
}

function dateAt(value: unknown, path: string): string {
  const result = stringAt(value, path);
  if (
    Number.isNaN(Date.parse(result)) ||
    new Date(result).toISOString() !== result
  ) {
    return contractError(path, "canonical ISO date string");
  }
  return result;
}

function nullableDateAt(value: unknown, path: string): string | null {
  return value === null ? null : dateAt(value, path);
}

function base64urlAt(value: unknown, path: string, maximum: number): string {
  const result = stringAt(value, path);
  if (
    result.length === 0 ||
    result.length > maximum ||
    !BASE64URL_PATTERN.test(result)
  ) {
    return contractError(path, `base64url string up to ${maximum} characters`);
  }
  return result;
}

export function isValidPushInstallationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= PUSH_INSTALLATION_ID_MAX_LENGTH &&
    INSTALLATION_ID_PATTERN.test(value)
  );
}

export function requirePushInstallationId(value: unknown): string {
  if (!isValidPushInstallationId(value)) {
    throw new Error("installationId must be a valid per-browser identifier");
  }
  return value;
}

export function decodePushPublicConfig(
  value: unknown,
): PushPublicConfigDTO {
  const object = exactObjectAt(value, "data", ["enabled", "publicKey"]);
  const enabled = booleanAt(object.enabled, "data.enabled");
  const publicKey =
    object.publicKey === null
      ? null
      : base64urlAt(object.publicKey, "data.publicKey", PUSH_KEY_MAX_LENGTH);
  if (enabled !== (publicKey !== null)) {
    return contractError(
      "data.publicKey",
      enabled ? "configured public key" : "null while Push is disabled",
    );
  }
  return { enabled, publicKey };
}

export function decodePushSubscription(
  value: unknown,
  path = "data",
): PushSubscriptionDTO {
  const object = exactObjectAt(value, path, [
    "id",
    "installationId",
    "status",
    "createdAt",
    "updatedAt",
    "lastSuccessfulPushAt",
  ]);
  const id = stringAt(object.id, `${path}.id`);
  if (!OBJECT_ID_PATTERN.test(id)) {
    return contractError(`${path}.id`, "24-character ObjectId string");
  }
  const installationId = stringAt(
    object.installationId,
    `${path}.installationId`,
  );
  if (!isValidPushInstallationId(installationId)) {
    return contractError(`${path}.installationId`, "valid installation ID");
  }
  if (object.status !== "active") {
    return contractError(`${path}.status`, "active");
  }
  return {
    id,
    installationId,
    status: "active",
    createdAt: dateAt(object.createdAt, `${path}.createdAt`),
    updatedAt: dateAt(object.updatedAt, `${path}.updatedAt`),
    lastSuccessfulPushAt: nullableDateAt(
      object.lastSuccessfulPushAt,
      `${path}.lastSuccessfulPushAt`,
    ),
  };
}

export function decodePushSubscriptionList(
  value: unknown,
): PushSubscriptionListDTO {
  const object = exactObjectAt(value, "data", ["subscriptions"]);
  if (!Array.isArray(object.subscriptions)) {
    return contractError("data.subscriptions", "array");
  }
  const subscriptions = object.subscriptions.map((entry, index) =>
    decodePushSubscription(entry, `data.subscriptions[${index}]`),
  );
  const installationIds = new Set(subscriptions.map((entry) => entry.installationId));
  if (installationIds.size !== subscriptions.length) {
    return contractError("data.subscriptions", "unique installation IDs");
  }
  return { subscriptions };
}

export function decodeNotificationPreference(
  value: unknown,
): NotificationPreferenceDTO {
  const object = exactObjectAt(value, "data", [
    "pushEnabled",
    "emailEnabled",
    "updatedAt",
  ]);
  return {
    pushEnabled: booleanAt(object.pushEnabled, "data.pushEnabled"),
    emailEnabled: booleanAt(object.emailEnabled, "data.emailEnabled"),
    updatedAt: nullableDateAt(object.updatedAt, "data.updatedAt"),
  };
}

function requireSubscriptionEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length > PUSH_ENDPOINT_MAX_LENGTH) {
    throw new Error("Push subscription endpoint is invalid");
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw new Error("Push subscription endpoint is invalid");
  }
  return value;
}

function requireSubscriptionKey(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > PUSH_KEY_MAX_LENGTH ||
    !BASE64URL_PATTERN.test(value)
  ) {
    throw new Error(`Push subscription ${label} key is invalid`);
  }
  return value;
}

export function normalizePushSubscriptionInput(
  value: PushSubscriptionInput,
): PushSubscriptionInput {
  const expirationTime = value.subscription.expirationTime;
  if (
    expirationTime !== null &&
    (!Number.isSafeInteger(expirationTime) || expirationTime <= 0)
  ) {
    throw new Error("Push subscription expiration time is invalid");
  }
  return {
    installationId: requirePushInstallationId(value.installationId),
    subscription: {
      endpoint: requireSubscriptionEndpoint(value.subscription.endpoint),
      expirationTime,
      keys: {
        p256dh: requireSubscriptionKey(
          value.subscription.keys.p256dh,
          "p256dh",
        ),
        auth: requireSubscriptionKey(value.subscription.keys.auth, "auth"),
      },
    },
  };
}

export function normalizeNotificationPreferenceChanges(
  value: NotificationPreferenceChanges,
): NotificationPreferenceChanges {
  const keys = Object.keys(value);
  if (
    keys.length === 0 ||
    keys.some((key) => !["pushEnabled", "emailEnabled"].includes(key)) ||
    (value.pushEnabled !== undefined && typeof value.pushEnabled !== "boolean") ||
    (value.emailEnabled !== undefined && typeof value.emailEnabled !== "boolean")
  ) {
    throw new Error("Notification preference changes are invalid");
  }
  return {
    ...(value.pushEnabled !== undefined
      ? { pushEnabled: value.pushEnabled }
      : {}),
    ...(value.emailEnabled !== undefined
      ? { emailEnabled: value.emailEnabled }
      : {}),
  };
}
