import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type WorkerListener = (event: any) => void;

function loadWorker(version = "__PWA_VERSION__") {
  const source = readFileSync(
    resolve(process.cwd(), "pwa/service-worker.js"),
    "utf8",
  ).replace(
    'const SW_VERSION = "__PWA_VERSION__";',
    `const SW_VERSION = ${JSON.stringify(version)};`,
  );
  const listeners = new Map<string, WorkerListener>();
  const setAppBadge = vi.fn().mockResolvedValue(undefined);
  const clearAppBadge = vi.fn().mockResolvedValue(undefined);
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const windowClient = {
    url: "https://community.example/",
    navigate: vi.fn().mockResolvedValue(undefined),
    focus: vi.fn().mockResolvedValue(undefined),
  };
  const clients = {
    claim: vi.fn().mockResolvedValue(undefined),
    matchAll: vi.fn().mockResolvedValue([windowClient]),
    openWindow: vi.fn().mockResolvedValue(undefined),
  };
  const workerScope = {
    location: { origin: "https://community.example" },
    navigator: { setAppBadge, clearAppBadge },
    registration: { showNotification },
    addEventListener: (type: string, listener: WorkerListener) => {
      listeners.set(type, listener);
    },
    skipWaiting: vi.fn(),
  };
  const caches = {
    match: vi.fn().mockResolvedValue(undefined),
    open: vi.fn().mockResolvedValue({ put: vi.fn() }),
    keys: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(true),
  };

  const fetchMock = vi.fn();
  runInNewContext(source, {
    self: workerScope,
    clients,
    caches,
    fetch: fetchMock,
    Request,
    Response,
    URL,
    Set,
    Promise,
    Error,
  });

  return {
    listeners,
    setAppBadge,
    clearAppBadge,
    showNotification,
    windowClient,
    clients,
    workerScope,
    caches,
    fetchMock,
  };
}

describe("PWA Service Worker security contracts", () => {
  it("claims clients without reloading tabs during the first installation", async () => {
    const { listeners, clients, caches, windowClient } = loadWorker();
    caches.keys.mockResolvedValueOnce([
      "atcloud-pwa-precache-__PWA_VERSION__",
    ]);
    let pending: Promise<unknown> | undefined;

    listeners.get("activate")?.({
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    });
    await pending;

    expect(clients.claim).toHaveBeenCalledOnce();
    expect(clients.matchAll).not.toHaveBeenCalled();
    expect(windowClient.navigate).not.toHaveBeenCalled();
    expect(caches.delete).not.toHaveBeenCalled();
  });

  it("keeps prior caches without navigating any open tab", async () => {
    const { listeners, clients, caches, windowClient } = loadWorker();
    const secondClient = {
      url: "https://community.example/#/dashboard/chat-rooms",
      navigate: vi.fn(),
      focus: vi.fn(),
    };
    clients.matchAll.mockResolvedValueOnce([windowClient, secondClient]);
    caches.keys.mockResolvedValueOnce([
      "atcloud-pwa-precache-v1",
      "atcloud-pwa-runtime-v1",
      "atcloud-pwa-precache-__PWA_VERSION__",
      "atcloud-pwa-runtime-__PWA_VERSION__",
      "unrelated-application-cache",
    ]);
    let pending: Promise<unknown> | undefined;

    listeners.get("activate")?.({
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    });
    await pending;

    expect(clients.matchAll).toHaveBeenCalledWith({
      type: "window",
      includeUncontrolled: true,
    });
    expect(clients.claim).toHaveBeenCalledOnce();
    expect(windowClient.navigate).not.toHaveBeenCalled();
    expect(secondClient.navigate).not.toHaveBeenCalled();
    expect(caches.delete).not.toHaveBeenCalled();
  });

  it("deletes prior caches only when no window client can depend on them", async () => {
    const { listeners, clients, caches, windowClient } = loadWorker();
    clients.matchAll.mockResolvedValueOnce([]);
    caches.keys.mockResolvedValueOnce([
      "atcloud-pwa-precache-v1",
      "atcloud-pwa-runtime-v1",
      "atcloud-pwa-precache-__PWA_VERSION__",
      "atcloud-pwa-runtime-__PWA_VERSION__",
      "unrelated-application-cache",
    ]);
    let pending: Promise<unknown> | undefined;

    listeners.get("activate")?.({
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    });
    await pending;

    expect(clients.claim).toHaveBeenCalledOnce();
    expect(windowClient.navigate).not.toHaveBeenCalled();
    expect(caches.delete).toHaveBeenCalledTimes(2);
    expect(caches.delete).toHaveBeenCalledWith("atcloud-pwa-precache-v1");
    expect(caches.delete).toHaveBeenCalledWith("atcloud-pwa-runtime-v1");
  });

  it("continues serving an older tab's cached lazy chunk after activation", async () => {
    const { listeners, clients, caches, fetchMock, windowClient } = loadWorker();
    clients.matchAll.mockResolvedValueOnce([windowClient]);
    caches.keys.mockResolvedValueOnce([
      "atcloud-pwa-precache-v1",
      "atcloud-pwa-precache-__PWA_VERSION__",
    ]);
    let activation: Promise<unknown> | undefined;
    listeners.get("activate")?.({
      waitUntil: (promise: Promise<unknown>) => {
        activation = promise;
      },
    });
    await activation;

    const cachedChunk = new Response("old lazy chunk", {
      headers: { "Content-Type": "text/javascript" },
    });
    caches.match.mockResolvedValueOnce(cachedChunk);
    let response: Promise<Response> | undefined;
    listeners.get("fetch")?.({
      request: new Request(
        "https://community.example/assets/old-lazy-route.js",
      ),
      respondWith: (promise: Promise<Response>) => {
        response = promise;
      },
    });

    expect(await response).toBe(cachedChunk);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(caches.delete).not.toHaveBeenCalled();
  });

  it("requires explicit update confirmation and preserves private/offline deep-link recovery across versioned activation", async () => {
    const {
      listeners,
      workerScope,
      clients,
      caches,
      fetchMock,
    } = loadWorker("release-v2");
    let installation: Promise<unknown> | undefined;

    listeners.get("install")?.({
      waitUntil: (promise: Promise<unknown>) => {
        installation = promise;
      },
    });
    await installation;

    // Installing an update only precaches its version. It may activate only
    // after PwaExperience sends the explicit user-confirmed message.
    expect(workerScope.skipWaiting).not.toHaveBeenCalled();
    listeners.get("message")?.({ data: { type: "UPDATE_READY" } });
    expect(workerScope.skipWaiting).not.toHaveBeenCalled();
    listeners.get("message")?.({ data: { type: "SKIP_WAITING" } });
    expect(workerScope.skipWaiting).toHaveBeenCalledOnce();

    const deepLinkClient = {
      url: "https://community.example/#/dashboard/chat-rooms/0123456789abcdef01234567",
      navigate: vi.fn(),
      focus: vi.fn(),
    };
    clients.matchAll.mockResolvedValueOnce([deepLinkClient]);
    caches.keys.mockResolvedValueOnce([
      "atcloud-pwa-precache-release-v1",
      "atcloud-pwa-runtime-release-v1",
      "atcloud-pwa-precache-release-v2",
      "atcloud-pwa-runtime-release-v2",
    ]);
    let activation: Promise<unknown> | undefined;

    listeners.get("activate")?.({
      waitUntil: (promise: Promise<unknown>) => {
        activation = promise;
      },
    });
    await activation;

    // An active deep-linked tab may still require its previous lazy chunks.
    expect(caches.delete).not.toHaveBeenCalled();
    expect(deepLinkClient.navigate).not.toHaveBeenCalled();

    const cacheOpenCallsAfterInstall = caches.open.mock.calls.length;
    const cacheMatchCallsAfterActivation = caches.match.mock.calls.length;
    for (const path of ["/api/private", "/uploads/avatar.jpg", "/s/abc123"]) {
      const respondWith = vi.fn();
      listeners.get("fetch")?.({
        request: new Request(`https://community.example${path}`),
        respondWith,
      });
      expect(respondWith).not.toHaveBeenCalled();
    }
    expect(caches.open).toHaveBeenCalledTimes(cacheOpenCallsAfterInstall);
    expect(caches.match).toHaveBeenCalledTimes(cacheMatchCallsAfterActivation);

    const offlineResponse = new Response("You are offline", { status: 200 });
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    caches.match.mockImplementation(async (key: string) =>
      key === "/offline.html" ? offlineResponse : undefined,
    );
    let fallback: Promise<Response> | undefined;
    listeners.get("fetch")?.({
      request: {
        method: "GET",
        mode: "navigate",
        url: deepLinkClient.url,
      },
      respondWith: (promise: Promise<Response>) => {
        fallback = promise;
      },
    });

    await expect(fallback).resolves.toBe(offlineResponse);
    expect(caches.match).toHaveBeenCalledWith("/offline.html");
    expect(caches.open).toHaveBeenCalledTimes(cacheOpenCallsAfterInstall);
    expect(deepLinkClient.navigate).not.toHaveBeenCalled();
  });

  it("accepts only the bounded room/help push payload contract", async () => {
    const { listeners, showNotification, setAppBadge } = loadWorker();
    let pending: Promise<unknown> | undefined;
    const roomId = "0123456789abcdef01234567";

    listeners.get("push")?.({
      data: {
        json: () => ({
          title: "New message",
          body: "Amy sent a message.",
          tag: `chat:${roomId}`,
          deepLink: `/#/dashboard/chat-rooms/${roomId}`,
          badgeCount: 4,
        }),
      },
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    });
    await pending;

    expect(showNotification).toHaveBeenCalledWith(
      "New message",
      expect.objectContaining({
        body: "Amy sent a message.",
        tag: `chat:${roomId}`,
        data: {
          deepLink: `/#/dashboard/chat-rooms/${roomId}`,
          badgeCount: 4,
        },
      }),
    );
    expect(setAppBadge).toHaveBeenCalledWith(4);

    listeners.get("push")?.({
      data: {
        json: () => ({
          title: "Unsafe",
          body: "Open this",
          tag: "unsafe",
          deepLink: "https://attacker.example/phish",
          badgeCount: 1,
        }),
      },
      waitUntil: vi.fn(),
    });
    expect(showNotification).toHaveBeenCalledOnce();
  });

  it("focuses and navigates an existing same-origin client", async () => {
    const { listeners, windowClient, clients } = loadWorker();
    const requestId = "abcdefabcdefabcdefabcdef";
    let pending: Promise<unknown> | undefined;
    const close = vi.fn();

    listeners.get("notificationclick")?.({
      notification: {
        close,
        data: {
          deepLink: `/#/dashboard/community/help-requests/${requestId}`,
        },
      },
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    });
    await pending;

    expect(close).toHaveBeenCalledOnce();
    expect(windowClient.navigate).toHaveBeenCalledWith(
      `https://community.example/#/dashboard/community/help-requests/${requestId}`,
    );
    expect(windowClient.focus).toHaveBeenCalledOnce();
    expect(clients.openWindow).not.toHaveBeenCalled();
  });

  it("opens the canonical deep link when no app client is available", async () => {
    const { listeners, clients } = loadWorker();
    clients.matchAll.mockResolvedValueOnce([]);
    const roomId = "0123456789abcdef01234567";
    let pending: Promise<unknown> | undefined;

    listeners.get("notificationclick")?.({
      notification: {
        close: vi.fn(),
        data: { deepLink: `/#/dashboard/chat-rooms/${roomId}` },
      },
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    });
    await pending;

    expect(clients.openWindow).toHaveBeenCalledWith(
      `https://community.example/#/dashboard/chat-rooms/${roomId}`,
    );
  });

  it("rejects notification redirects that are not canonical deep links", () => {
    const { listeners, windowClient, clients } = loadWorker();
    const waitUntil = vi.fn();

    listeners.get("notificationclick")?.({
      notification: {
        close: vi.fn(),
        data: { deepLink: "https://attacker.example/" },
      },
      waitUntil,
    });

    expect(waitUntil).not.toHaveBeenCalled();
    expect(windowClient.navigate).not.toHaveBeenCalled();
    expect(clients.openWindow).not.toHaveBeenCalled();
  });

  it("accepts only an absolute, bounded launcher badge count", async () => {
    const { listeners, setAppBadge, clearAppBadge } = loadWorker();
    let pending: Promise<unknown> | undefined;

    listeners.get("message")?.({
      data: { type: "SET_APP_BADGE", launcherBadgeTotal: 8 },
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    });
    await pending;
    expect(setAppBadge).toHaveBeenCalledWith(8);

    listeners.get("message")?.({
      data: { type: "SET_APP_BADGE", launcherBadgeTotal: 0 },
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    });
    await pending;
    expect(clearAppBadge).toHaveBeenCalledOnce();

    listeners.get("message")?.({
      data: { type: "SET_APP_BADGE", launcherBadgeTotal: -1 },
      waitUntil: vi.fn(),
    });
    listeners.get("message")?.({
      data: { type: "SET_APP_BADGE", launcherBadgeTotal: 100 },
      waitUntil: vi.fn(),
    });
    expect(setAppBadge).toHaveBeenCalledOnce();
  });

  it("rejects push badge counts above the approved 99+ boundary", () => {
    const { listeners, showNotification, setAppBadge } = loadWorker();
    const waitUntil = vi.fn();

    listeners.get("push")?.({
      data: {
        json: () => ({
          title: "New message",
          body: "You have a new chat message.",
          tag: "chat:0123456789abcdef01234567",
          deepLink:
            "/#/dashboard/chat-rooms/0123456789abcdef01234567",
          badgeCount: 100,
        }),
      },
      waitUntil,
    });

    expect(waitUntil).not.toHaveBeenCalled();
    expect(showNotification).not.toHaveBeenCalled();
    expect(setAppBadge).not.toHaveBeenCalled();
  });

  it("never intercepts private API or uploaded-content requests", () => {
    const { listeners } = loadWorker();
    for (const path of ["/api/private", "/uploads/avatar.jpg", "/s/abc123"]) {
      const respondWith = vi.fn();
      listeners.get("fetch")?.({
        request: new Request(`https://community.example${path}`),
        respondWith,
      });
      expect(respondWith).not.toHaveBeenCalled();
    }
  });

  it("returns successful navigations without mutating the versioned precache", async () => {
    const { listeners, caches, fetchMock } = loadWorker();
    const liveResponse = new Response("<!doctype html><title>Live</title>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
    fetchMock.mockResolvedValue(liveResponse);
    let pending: Promise<Response> | undefined;

    listeners.get("fetch")?.({
      request: {
        method: "GET",
        mode: "navigate",
        url: "https://community.example/",
      },
      respondWith: (promise: Promise<Response>) => {
        pending = promise;
      },
    });

    await expect(pending).resolves.toBe(liveResponse);
    expect(caches.open).not.toHaveBeenCalled();
  });

  it("prefers the explicit offline page before the app shell", async () => {
    const { listeners, caches, fetchMock } = loadWorker();
    const offlineResponse = new Response("You are offline", { status: 200 });
    fetchMock.mockRejectedValue(new TypeError("offline"));
    caches.match.mockImplementation(async (key: string) =>
      key === "/offline.html" ? offlineResponse : undefined,
    );
    let pending: Promise<Response> | undefined;

    listeners.get("fetch")?.({
      request: {
        method: "GET",
        mode: "navigate",
        url: "https://community.example/dashboard/chat-rooms",
      },
      respondWith: (promise: Promise<Response>) => {
        pending = promise;
      },
    });

    await expect(pending).resolves.toBe(offlineResponse);
    expect(caches.match).toHaveBeenCalledWith("/offline.html");
    expect(caches.match).not.toHaveBeenCalledWith("/index.html");
  });
});
