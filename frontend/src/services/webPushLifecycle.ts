import {
  pushNotificationsService,
  type PushSubscriptionInput,
} from "./api";

export const PUSH_INSTALLATION_STORAGE_KEY =
  "atcloud.push.installation-id.v1";
export const PUSH_LOGOUT_CLEANUP_TIMEOUT_MS = 1_500;

export type BrowserPushPermission = NotificationPermission | "unsupported";

export interface CurrentBrowserPushState {
  supported: boolean;
  permission: BrowserPushPermission;
  subscribed: boolean;
  installationId: string | null;
}

export interface PushCleanupResult {
  serverRemoved: boolean;
  browserUnsubscribed: boolean;
}

let memoryInstallationId: string | null = null;

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function browserCrypto(): Crypto | null {
  return typeof globalThis.crypto === "undefined" ? null : globalThis.crypto;
}

function createInstallationId(cryptoSource: Crypto | null): string {
  if (cryptoSource && typeof cryptoSource.randomUUID === "function") {
    return `web-${cryptoSource.randomUUID()}`;
  }
  if (cryptoSource && typeof cryptoSource.getRandomValues === "function") {
    const bytes = cryptoSource.getRandomValues(new Uint8Array(16));
    return `web-${Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")}`;
  }
  throw new Error("This browser cannot create a secure installation ID");
}

export function getExistingPushInstallationId(
  storage: Storage | null = browserStorage(),
): string | null {
  try {
    const value = storage?.getItem(PUSH_INSTALLATION_STORAGE_KEY) ?? null;
    if (/^web-[A-Za-z0-9._:-]+$/.test(value ?? "") && value!.length <= 128) {
      memoryInstallationId = value;
      return value;
    }
  } catch {
    // Storage access can be denied in private or hardened browsing modes.
  }
  return memoryInstallationId;
}

export function getOrCreatePushInstallationId(
  storage: Storage | null = browserStorage(),
  cryptoSource: Crypto | null = browserCrypto(),
): string {
  const existing = getExistingPushInstallationId(storage);
  if (existing) return existing;

  const installationId = createInstallationId(cryptoSource);
  memoryInstallationId = installationId;
  try {
    storage?.setItem(PUSH_INSTALLATION_STORAGE_KEY, installationId);
  } catch {
    // The in-memory ID keeps this page session usable when storage is blocked.
  }
  return installationId;
}

export function isWebPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

async function currentRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!isWebPushSupported()) return null;
  return (await navigator.serviceWorker.getRegistration("/")) ?? null;
}

export async function getCurrentBrowserPushState(): Promise<CurrentBrowserPushState> {
  if (!isWebPushSupported()) {
    return {
      supported: false,
      permission: "unsupported",
      subscribed: false,
      installationId: null,
    };
  }
  const registration = await currentRegistration();
  const subscription = registration
    ? await registration.pushManager.getSubscription()
    : null;
  return {
    supported: true,
    permission: Notification.permission,
    subscribed: subscription !== null,
    installationId: getExistingPushInstallationId(),
  };
}

function base64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
    throw new Error("Push configuration is invalid");
  }
  const unpadded = value.replace(/=+$/u, "");
  const remainder = unpadded.length % 4;
  if (remainder === 1) throw new Error("Push configuration is invalid");
  const padded = `${unpadded.replace(/-/gu, "+").replace(/_/gu, "/")}${
    remainder === 0 ? "" : "=".repeat(4 - remainder)
  }`;
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("Push configuration is invalid");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== 65 || bytes[0] !== 4) {
    throw new Error("Push configuration is invalid");
  }
  return bytes;
}

export function decodeVapidPublicKey(value: string): Uint8Array<ArrayBuffer> {
  return base64urlToBytes(value);
}

function sameBytes(
  first: ArrayBuffer | ArrayBufferView | null,
  second: Uint8Array,
): boolean {
  if (!first) return false;
  const bytes = ArrayBuffer.isView(first)
    ? new Uint8Array(first.buffer, first.byteOffset, first.byteLength)
    : new Uint8Array(first);
  return (
    bytes.byteLength === second.byteLength &&
    bytes.every((value, index) => value === second[index])
  );
}

function serializeSubscription(
  installationId: string,
  subscription: PushSubscription,
): PushSubscriptionInput {
  const json = subscription.toJSON();
  const endpoint = json.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    throw new Error("The browser returned an incomplete Push subscription");
  }
  return {
    installationId,
    subscription: {
      endpoint,
      expirationTime: json.expirationTime ?? null,
      keys: { p256dh, auth },
    },
  };
}

export function enablePushForCurrentBrowser(
  vapidPublicKey: string,
): Promise<CurrentBrowserPushState> {
  if (!isWebPushSupported()) {
    return Promise.reject(new Error("Web Push is not supported on this browser"));
  }

  // Keep this call before the first await: browsers require a live user gesture.
  let permissionRequest: Promise<NotificationPermission>;
  try {
    permissionRequest = Notification.requestPermission();
  } catch {
    return Promise.reject(
      new Error("This browser could not request notification permission"),
    );
  }
  return permissionRequest.then(async (permission) => {
    if (permission !== "granted") {
      return {
        supported: true,
        permission,
        subscribed: false,
        installationId: getExistingPushInstallationId(),
      };
    }

    const applicationServerKey = decodeVapidPublicKey(vapidPublicKey);
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    const existingKey = subscription?.options.applicationServerKey ?? null;
    if (subscription && existingKey && !sameBytes(existingKey, applicationServerKey)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });

    const installationId = getOrCreatePushInstallationId();
    await pushNotificationsService.upsertSubscription(
      serializeSubscription(installationId, subscription),
    );
    await pushNotificationsService.updatePreferences({ pushEnabled: true });
    return {
      supported: true,
      permission: "granted",
      subscribed: true,
      installationId,
    };
  });
}

export async function removePushForCurrentBrowser(): Promise<PushCleanupResult> {
  const installationId = getExistingPushInstallationId();
  const serverRemoval = (async (): Promise<boolean> => {
    if (!installationId) return true;
    try {
      await pushNotificationsService.removeSubscription(installationId);
      return true;
    } catch {
      return false;
    }
  })();

  const browserRemoval = (async (): Promise<boolean> => {
    if (!isWebPushSupported()) return true;
    try {
      const registration = await currentRegistration();
      const subscription = registration
        ? await registration.pushManager.getSubscription()
        : null;
      return subscription ? await subscription.unsubscribe() : true;
    } catch {
      return false;
    }
  })();

  const [serverRemoved, browserUnsubscribed] = await Promise.all([
    serverRemoval,
    browserRemoval,
  ]);
  return { serverRemoved, browserUnsubscribed };
}

export async function disablePushGlobally(): Promise<{
  cleanup: PushCleanupResult;
}> {
  await pushNotificationsService.updatePreferences({ pushEnabled: false });
  return { cleanup: await removePushForCurrentBrowser() };
}

export async function unregisterPushBeforeLogout(): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      removePushForCurrentBrowser(),
      new Promise<void>((resolve) => {
        timeoutId = setTimeout(resolve, PUSH_LOGOUT_CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // Logout must continue even if local Push cleanup is unavailable.
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/** Test-only reset for module fallback state. */
export function resetPushInstallationMemoryForTests(): void {
  memoryInstallationId = null;
}
