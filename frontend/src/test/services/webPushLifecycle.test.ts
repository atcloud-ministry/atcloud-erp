import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pushNotificationsService } from "../../services/api";
import {
  PUSH_INSTALLATION_STORAGE_KEY,
  PUSH_LOGOUT_CLEANUP_TIMEOUT_MS,
  decodeVapidPublicKey,
  disablePushGlobally,
  enablePushForCurrentBrowser,
  getCurrentBrowserPushState,
  getOrCreatePushInstallationId,
  removePushForCurrentBrowser,
  resetPushInstallationMemoryForTests,
  unregisterPushBeforeLogout,
} from "../../services/webPushLifecycle";

vi.mock("../../services/api", () => ({
  pushNotificationsService: {
    upsertSubscription: vi.fn(),
    updatePreferences: vi.fn(),
    removeSubscription: vi.fn(),
  },
}));

const installationId = "web-550e8400-e29b-41d4-a716-446655440000";
const originalServiceWorker = Object.getOwnPropertyDescriptor(
  navigator,
  "serviceWorker",
);

function vapidPublicKey(): string {
  const bytes = Uint8Array.from({ length: 65 }, (_, index) =>
    index === 0 ? 4 : index,
  );
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function installBrowserMocks(options: {
  permission?: NotificationPermission;
  existingSubscription?: PushSubscription | null;
} = {}) {
  const requestPermission = vi
    .fn<[], Promise<NotificationPermission>>()
    .mockResolvedValue(options.permission ?? "granted");
  vi.stubGlobal("Notification", {
    permission: options.permission === "denied" ? "denied" : "default",
    requestPermission,
  });
  vi.stubGlobal("PushManager", class PushManager {});

  const createdSubscription = {
    options: { applicationServerKey: decodeVapidPublicKey(vapidPublicKey()).buffer },
    toJSON: () => ({
      endpoint: "https://fcm.googleapis.com/fcm/send/browser-endpoint",
      expirationTime: null,
      keys: { p256dh: "p256dh_key", auth: "auth_key" },
    }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  } as unknown as PushSubscription;
  let currentSubscription = options.existingSubscription ?? null;
  const pushManager = {
    getSubscription: vi.fn(async () => currentSubscription),
    subscribe: vi.fn(async () => {
      currentSubscription = createdSubscription;
      return createdSubscription;
    }),
  };
  const registration = { pushManager } as unknown as ServiceWorkerRegistration;
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      ready: Promise.resolve(registration),
      getRegistration: vi.fn().mockResolvedValue(registration),
    },
  });
  return { requestPermission, pushManager, createdSubscription };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(PUSH_INSTALLATION_STORAGE_KEY, installationId);
  resetPushInstallationMemoryForTests();
  vi.clearAllMocks();
  vi.mocked(pushNotificationsService.upsertSubscription).mockResolvedValue({
    id: "64b000000000000000000001",
    installationId,
    status: "active",
    createdAt: "2026-09-13T12:00:00.000Z",
    updatedAt: "2026-09-13T12:00:00.000Z",
    lastSuccessfulPushAt: null,
  });
  vi.mocked(pushNotificationsService.updatePreferences).mockResolvedValue({
    pushEnabled: true,
    emailEnabled: true,
    updatedAt: "2026-09-13T12:00:00.000Z",
  });
  vi.mocked(pushNotificationsService.removeSubscription).mockResolvedValue();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalServiceWorker) {
    Object.defineProperty(navigator, "serviceWorker", originalServiceWorker);
  } else {
    Reflect.deleteProperty(navigator, "serviceWorker");
  }
  resetPushInstallationMemoryForTests();
});

describe("per-installation Web Push lifecycle", () => {
  it("keeps one installation ID in local storage", () => {
    expect(getOrCreatePushInstallationId()).toBe(installationId);
    expect(getOrCreatePushInstallationId()).toBe(installationId);
  });

  it("checks current state without requesting notification permission", async () => {
    const { requestPermission } = installBrowserMocks();
    const state = await getCurrentBrowserPushState();

    expect(state).toMatchObject({
      supported: true,
      permission: "default",
      subscribed: false,
      installationId,
    });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("requests permission immediately, subscribes, and upserts only this installation", async () => {
    const { requestPermission, pushManager } = installBrowserMocks();
    const enablePromise = enablePushForCurrentBrowser(vapidPublicKey());

    expect(requestPermission).toHaveBeenCalledOnce();
    const state = await enablePromise;

    expect(pushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: expect.any(Uint8Array),
    });
    expect(pushNotificationsService.upsertSubscription).toHaveBeenCalledWith({
      installationId,
      subscription: {
        endpoint: "https://fcm.googleapis.com/fcm/send/browser-endpoint",
        expirationTime: null,
        keys: { p256dh: "p256dh_key", auth: "auth_key" },
      },
    });
    expect(pushNotificationsService.updatePreferences).toHaveBeenCalledWith({
      pushEnabled: true,
    });
    expect(state).toMatchObject({ permission: "granted", subscribed: true });
  });

  it("replaces a subscription whose VAPID application server key has changed", async () => {
    const previousServerKey = decodeVapidPublicKey(vapidPublicKey()).slice();
    previousServerKey[previousServerKey.length - 1] ^= 0xff;
    const previousSubscription = {
      options: { applicationServerKey: previousServerKey.buffer },
      unsubscribe: vi.fn().mockResolvedValue(true),
    } as unknown as PushSubscription;
    const { pushManager } = installBrowserMocks({
      existingSubscription: previousSubscription,
    });

    await expect(
      enablePushForCurrentBrowser(vapidPublicKey()),
    ).resolves.toMatchObject({ permission: "granted", subscribed: true });

    expect(previousSubscription.unsubscribe).toHaveBeenCalledOnce();
    expect(pushManager.subscribe).toHaveBeenCalledOnce();
    expect(
      vi.mocked(previousSubscription.unsubscribe).mock.invocationCallOrder[0],
    ).toBeLessThan(pushManager.subscribe.mock.invocationCallOrder[0]);
    expect(pushNotificationsService.upsertSubscription).toHaveBeenCalledWith({
      installationId,
      subscription: {
        endpoint: "https://fcm.googleapis.com/fcm/send/browser-endpoint",
        expirationTime: null,
        keys: { p256dh: "p256dh_key", auth: "auth_key" },
      },
    });
  });

  it("does not subscribe when permission is denied", async () => {
    const { pushManager } = installBrowserMocks({ permission: "denied" });
    const state = await enablePushForCurrentBrowser(vapidPublicKey());

    expect(state.permission).toBe("denied");
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(pushNotificationsService.upsertSubscription).not.toHaveBeenCalled();
  });

  it("turns a synchronous permission API failure into a safe rejection", async () => {
    const { requestPermission, pushManager } = installBrowserMocks();
    requestPermission.mockImplementation(() => {
      throw new DOMException("Not allowed", "NotAllowedError");
    });

    await expect(
      enablePushForCurrentBrowser(vapidPublicKey()),
    ).rejects.toThrow(/could not request notification permission/);
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(pushNotificationsService.upsertSubscription).not.toHaveBeenCalled();
  });

  it("removes both server and browser state without exposing subscription data", async () => {
    const existingSubscription = {
      unsubscribe: vi.fn().mockResolvedValue(true),
    } as unknown as PushSubscription;
    installBrowserMocks({ existingSubscription });

    await expect(removePushForCurrentBrowser()).resolves.toEqual({
      serverRemoved: true,
      browserUnsubscribed: true,
    });
    expect(pushNotificationsService.removeSubscription).toHaveBeenCalledWith(
      installationId,
    );
    expect(existingSubscription.unsubscribe).toHaveBeenCalledOnce();
  });

  it("saves global opt-out before best-effort installation cleanup", async () => {
    installBrowserMocks();
    const calls: string[] = [];
    vi.mocked(pushNotificationsService.updatePreferences).mockImplementation(
      async () => {
        calls.push("preference");
        return {
          pushEnabled: false,
          emailEnabled: true,
          updatedAt: "2026-09-13T12:00:00.000Z",
        };
      },
    );
    vi.mocked(pushNotificationsService.removeSubscription).mockImplementation(
      async () => {
        calls.push("cleanup");
      },
    );

    await disablePushGlobally();
    expect(calls).toEqual(["preference", "cleanup"]);
  });

  it("does not let a stalled server cleanup block logout or browser unsubscribe", async () => {
    vi.useFakeTimers();
    const existingSubscription = {
      unsubscribe: vi.fn().mockResolvedValue(true),
    } as unknown as PushSubscription;
    installBrowserMocks({ existingSubscription });
    vi.mocked(pushNotificationsService.removeSubscription).mockReturnValue(
      new Promise<void>(() => undefined),
    );

    const cleanup = unregisterPushBeforeLogout();
    await vi.advanceTimersByTimeAsync(PUSH_LOGOUT_CLEANUP_TIMEOUT_MS);
    await expect(cleanup).resolves.toBeUndefined();
    expect(existingSubscription.unsubscribe).toHaveBeenCalledOnce();
  });
});
