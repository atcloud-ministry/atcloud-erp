/* global clients */

const SW_VERSION = "__PWA_VERSION__";
const PRECACHE_URLS = /* __PWA_PRECACHE_MANIFEST__ */ [];
const CACHE_PREFIX = "atcloud-pwa-";
const PRECACHE_NAME = `${CACHE_PREFIX}precache-${SW_VERSION}`;
const RUNTIME_NAME = `${CACHE_PREFIX}runtime-${SW_VERSION}`;
const OFFLINE_URL = "/offline.html";
const APP_SHELL_URL = "/index.html";
const PRIVATE_PATH_PREFIXES = ["/api/", "/uploads/", "/s/"];
const OBJECT_ID_PATTERN = "[a-fA-F0-9]{24}";
const ALLOWED_DEEP_LINK = new RegExp(
  `^/#/dashboard/(?:chat-rooms/${OBJECT_ID_PATTERN}|community/help-requests/${OBJECT_ID_PATTERN})$`,
);

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isPrivateNetworkOnlyPath(pathname) {
  return PRIVATE_PATH_PREFIXES.some(
    (prefix) => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix),
  );
}

function isCacheableResponse(response) {
  return response.ok && response.type !== "opaque";
}

function obsoleteCacheNames(cacheNames) {
  return cacheNames.filter(
    (cacheName) =>
      cacheName.startsWith(CACHE_PREFIX) &&
      cacheName !== PRECACHE_NAME &&
      cacheName !== RUNTIME_NAME,
  );
}

async function activateCurrentVersion() {
  const cacheNames = await caches.keys();
  const obsoleteCaches = obsoleteCacheNames(cacheNames);
  let windowClients = null;

  if (obsoleteCaches.length > 0) {
    try {
      windowClients = await clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
    } catch {
      // Claim the clients, but preserve old caches when they cannot be audited.
      windowClients = null;
    }
  }

  await clients.claim();

  // Never reload another tab without its user's consent: it may contain an
  // unsaved form. Every prior cache stays available while any window is open,
  // so an older bundle can still resolve its versioned lazy chunks. Cleanup is
  // safe only when no window client can depend on those resources.
  if (windowClients === null || windowClients.length > 0) return;

  await Promise.all(obsoleteCaches.map((cacheName) => caches.delete(cacheName)));
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (isCacheableResponse(response)) {
    try {
      const cache = await caches.open(RUNTIME_NAME);
      await cache.put(request, response.clone());
    } catch {
      // A cache quota/storage failure must not hide a valid network response.
    }
  }
  return response;
}

async function networkFirstNavigation(request) {
  try {
    // Never mutate the versioned precache with a live navigation response.
    // During a rolling deployment that could mix a new index with old assets.
    return await fetch(request);
  } catch {
    return (
      // The app uses lazy route chunks that are intentionally not all
      // precached, so a cold offline launch needs the deterministic fallback.
      (await caches.match(OFFLINE_URL)) ??
      (await caches.match(APP_SHELL_URL)) ??
      Response.error()
    );
  }
}

function parsePushPayload(data) {
  if (!data) return null;

  let value;
  try {
    value = data.json();
  } catch {
    return null;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const allowedKeys = new Set([
    "title",
    "body",
    "tag",
    "deepLink",
    "badgeCount",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return null;

  if (
    typeof value.title !== "string" ||
    value.title.length < 1 ||
    value.title.length > 120 ||
    typeof value.body !== "string" ||
    value.body.length < 1 ||
    value.body.length > 500 ||
    typeof value.tag !== "string" ||
    value.tag.length < 1 ||
    value.tag.length > 160 ||
    typeof value.deepLink !== "string" ||
    !ALLOWED_DEEP_LINK.test(value.deepLink) ||
    !Number.isSafeInteger(value.badgeCount) ||
    value.badgeCount < 0 ||
    value.badgeCount > 99
  ) {
    return null;
  }

  return value;
}

function parseLauncherBadgeMessage(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (
    Object.keys(data).length !== 2 ||
    data.type !== "SET_APP_BADGE" ||
    !Number.isSafeInteger(data.launcherBadgeTotal) ||
    data.launcherBadgeTotal < 0 ||
    data.launcherBadgeTotal > 99
  ) {
    return null;
  }
  return data.launcherBadgeTotal;
}

async function setLauncherBadge(count) {
  try {
    if (count === 0 && typeof self.navigator.clearAppBadge === "function") {
      await self.navigator.clearAppBadge();
      return;
    }
    if (count > 0 && typeof self.navigator.setAppBadge === "function") {
      await self.navigator.setAppBadge(count);
    }
  } catch {
    // Badging support is best-effort and must never block notification delivery.
  }
}

function canonicalNotificationUrl(deepLink) {
  if (typeof deepLink !== "string" || !ALLOWED_DEEP_LINK.test(deepLink)) {
    return null;
  }
  const url = new URL(deepLink, self.location.origin);
  return isSameOrigin(url) ? url : null;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(PRECACHE_NAME).then(async (cache) => {
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          const response = await fetch(
            new Request(url, {
              cache: "reload",
              credentials: "same-origin",
            }),
          );
          if (!isCacheableResponse(response)) {
            throw new Error(`Unable to precache ${url}`);
          }
          await cache.put(url, response);
        }),
      );
    }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(activateCurrentVersion());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (!isSameOrigin(url) || isPrivateNetworkOnlyPath(url.pathname)) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (
    url.pathname.startsWith("/assets/") ||
    PRECACHE_URLS.includes(url.pathname)
  ) {
    event.respondWith(cacheFirst(request));
  }
});

self.addEventListener("push", (event) => {
  const payload = parsePushPayload(event.data);
  if (!payload) return;

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(payload.title, {
        body: payload.body,
        tag: payload.tag,
        icon: "/pwa-icon-192.png",
        badge: "/pwa-icon-192.png",
        data: {
          deepLink: payload.deepLink,
          badgeCount: payload.badgeCount,
        },
      }),
      setLauncherBadge(payload.badgeCount),
    ]),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = canonicalNotificationUrl(event.notification.data?.deepLink);
  if (!targetUrl) return;

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (windowClients) => {
        const sameOriginClients = windowClients.filter(
          (client) => new URL(client.url).origin === self.location.origin,
        );
        const target =
          sameOriginClients.find((client) => client.url === targetUrl.href) ??
          sameOriginClients[0];

        if (target) {
          try {
            if (typeof target.navigate === "function") {
              await target.navigate(targetUrl.href);
            }
            await target.focus();
            return;
          } catch {
            // Fall through to a canonical new window if the client disappeared.
          }
        }

        await clients.openWindow(targetUrl.href);
      }),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }

  const launcherBadgeTotal = parseLauncherBadgeMessage(event.data);
  if (launcherBadgeTotal !== null) {
    event.waitUntil(setLauncherBadge(launcherBadgeTotal));
  }
});
