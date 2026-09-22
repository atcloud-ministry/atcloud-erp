import {
  expect,
  test,
  type Page,
  type Request,
  type Route,
} from "@playwright/test";

const ROOM_ID = "507f1f77bcf86cd799439011";
const HELP_REQUEST_ID = "507f1f77bcf86cd799439012";
const APP_CACHE_PREFIX = "atcloud-pwa-";

const authenticatedUser = {
  id: "507f1f77bcf86cd799439010",
  username: "pwa_e2e_user",
  email: "pwa-e2e@example.com",
  firstName: "PWA",
  lastName: "Tester",
  role: "Administrator",
  isAtCloudLeader: true,
  roleInAtCloud: "Administrator",
  gender: "male",
  isActive: true,
  isVerified: true,
};

function success(data: unknown) {
  return { success: true, data };
}

function pathOf(request: Request): string {
  return new URL(request.url()).pathname;
}

async function mockApi(page: Page): Promise<void> {
  await page.route("**/api/**", async (route: Route) => {
    const path = pathOf(route.request());
    if (!path.startsWith("/api/")) return route.continue();

    if (path === "/api/runtime-config") {
      return route.fulfill({
        json: success({
          version: 1,
          revision: 1,
          alumniNetwork: { mode: "on", readable: true, writable: true },
        }),
      });
    }
    if (path === "/api/auth/login") {
      return route.fulfill({
        json: success({ accessToken: "pwa-e2e-token", user: authenticatedUser }),
      });
    }
    if (path === "/api/auth/profile") {
      return route.fulfill({ json: success({ user: authenticatedUser }) });
    }
    if (path === "/api/notifications/welcome-status") {
      return route.fulfill({
        json: success({ hasReceivedWelcomeMessage: true }),
      });
    }
    if (path === "/api/notifications/system") {
      return route.fulfill({
        json: success({ messages: [], pagination: undefined }),
      });
    }
    if (path === "/api/notifications/bell") {
      return route.fulfill({
        json: success({ notifications: [], unreadCount: 0 }),
      });
    }
    if (path === "/api/conversations/unread-count") {
      return route.fulfill({ json: success({ chatUnreadTotal: 0 }) });
    }
    if (path === "/api/alumni-help-requests/action-required-count") {
      return route.fulfill({
        json: success({ helpActionRequiredCount: 0, helpNotificationCount: 0 }),
      });
    }
    if (path === "/api/pwa-private-probe") {
      return route.fulfill({ json: success({ private: true }) });
    }

    return route.fulfill({ json: success({}) });
  });
}

async function waitForActiveServiceWorker(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (registration.active && navigator.serviceWorker.controller) return;

    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new Error("Service Worker did not control the page")),
        10_000,
      );
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        () => {
          window.clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  });
}

test.beforeEach(async ({ page }) => {
  await mockApi(page);
});

test("serves an installable manifest and branded platform metadata", async ({
  page,
  request,
}) => {
  const response = await request.get("/manifest.json");
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toMatch(
    /^application\/(?:manifest\+)?json\b/,
  );

  const manifest = await response.json();
  expect(manifest).toMatchObject({
    id: "/",
    name: "@Cloud Events & Community",
    short_name: "@Cloud",
    start_url: "/?source=pwa",
    scope: "/",
    display: "standalone",
  });
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        src: "/pwa-icon-192.png",
        sizes: "192x192",
        purpose: "any",
      }),
      expect.objectContaining({
        src: "/pwa-icon-512.png",
        sizes: "512x512",
        purpose: "any",
      }),
      expect.objectContaining({
        src: "/pwa-maskable-512.png",
        sizes: "512x512",
        purpose: "maskable",
      }),
    ]),
  );
  expect(manifest.shortcuts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ url: "/#/dashboard/chat-rooms" }),
      expect.objectContaining({ url: "/#/dashboard/community/alumni" }),
    ]),
  );

  await page.goto("/");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.json",
  );
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    "href",
    "/apple-touch-icon.png",
  );
  const appleIconPixels = await page.evaluate(async () => {
    const icon = new Image();
    icon.src = "/apple-touch-icon.png";
    await icon.decode();
    const canvas = document.createElement("canvas");
    canvas.width = icon.naturalWidth;
    canvas.height = icon.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D context is unavailable");
    context.drawImage(icon, 0, 0);
    return {
      size: [icon.naturalWidth, icon.naturalHeight],
      background: Array.from(context.getImageData(0, 0, 1, 1).data),
      mark: Array.from(context.getImageData(90, 134, 1, 1).data),
    };
  });
  expect(appleIconPixels.size).toEqual([180, 180]);
  expect(appleIconPixels.background).toEqual([255, 255, 255, 255]);
  expect(appleIconPixels.mark[2]).toBeGreaterThan(appleIconPixels.mark[0]);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    "#111827",
  );

  const csp =
    (await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute("content")) ?? "";
  const directives = new Map(
    csp
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...sources] = part.split(/\s+/u);
        return [name, sources] as const;
      }),
  );
  expect(directives.get("script-src")).toEqual(["'self'"]);
  expect(directives.get("worker-src")).toEqual(["'self'"]);
  expect(directives.get("manifest-src")).toEqual(["'self'"]);
  expect(directives.get("connect-src")).not.toContain("ws:");
  expect(directives.get("connect-src")).not.toContain("wss:");
});

test("runs the generated Service Worker, keeps private APIs network-only, and provides an offline fallback", async ({
  context,
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome to @Cloud" }),
  ).toBeVisible();
  await waitForActiveServiceWorker(page);

  const workerState = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const cacheNames = await caches.keys();
    const cacheEntries = Object.fromEntries(
      await Promise.all(
        cacheNames.map(async (name) => {
          const cache = await caches.open(name);
          return [name, (await cache.keys()).map((request) => request.url)];
        }),
      ),
    );
    return {
      controller: navigator.serviceWorker.controller?.scriptURL ?? null,
      active: registration.active?.scriptURL ?? null,
      cacheNames,
      cacheEntries,
    };
  });
  expect(workerState.controller).toMatch(/\/sw\.js\?v=/);
  expect(workerState.active).toMatch(/\/sw\.js\?v=/);
  expect(
    workerState.cacheNames.some((name) => name.startsWith(APP_CACHE_PREFIX)),
  ).toBe(true);
  expect(Object.values(workerState.cacheEntries).flat()).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/\/index\.html$/),
      expect.stringMatching(/\/assets\/index-[^/]+\.js$/),
    ]),
  );

  await page.evaluate(async () => {
    const response = await fetch("/api/pwa-private-probe");
    if (!response.ok) throw new Error("Private API probe failed");
  });
  expect(
    await page.evaluate(async () =>
      Boolean(await caches.match("/api/pwa-private-probe")),
    ),
  ).toBe(false);

  await context.setOffline(true);
  try {
    await expect(
      page.getByRole("region", { name: "You are offline" }),
    ).toBeVisible();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "You are offline" }),
    ).toBeVisible();
    await expect(page.getByText(/Reconnect to see current events/)).toBeVisible();
    const retainedDeepLink = `/#/dashboard/chat-rooms/${ROOM_ID}`;
    await page.evaluate((target) => {
      window.history.replaceState(null, "", target);
    }, retainedDeepLink);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(
      page.getByRole("heading", { name: "You are offline" }),
    ).toBeVisible();
    await expect(page).toHaveURL(
      new RegExp(`/#/dashboard/chat-rooms/${ROOM_ID}$`),
    );
  } finally {
    await context.setOffline(false);
  }
});

test("shows the appropriate install experience for the emulated platform", async ({
  page,
}, testInfo) => {
  await page.goto("/");

  if (testInfo.project.name.includes("iphone") || testInfo.project.name.includes("ipad")) {
    await expect(
      page.getByRole("region", { name: "Install @Cloud on this device" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Show steps" }).click();
    await expect(page.getByText("Open the browser Share menu.")).toBeVisible();
    await expect(page.getByText(/Add to Home Screen/)).toBeVisible();
    return;
  }

  await page.evaluate(() => {
    const installPrompt = new Event("beforeinstallprompt", {
      cancelable: true,
    });
    Object.defineProperties(installPrompt, {
      prompt: { value: async () => undefined },
      userChoice: {
        value: Promise.resolve({ outcome: "accepted", platform: "web" }),
      },
    });
    window.dispatchEvent(installPrompt);
  });

  await expect(
    page.getByRole("region", { name: "Install @Cloud" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Install app" }).click();
  await expect(
    page.getByRole("region", { name: "Install @Cloud" }),
  ).toBeHidden();
});

test("recovers a protected room deep link after login and accepts the Help deep link", async ({
  page,
}) => {
  await page.goto(`/#/dashboard/chat-rooms/${ROOM_ID}`);
  await expect(page).toHaveURL(/\/#\/login$/);

  const dismissInstall = page.getByRole("button", { name: "Not now" });
  if (await dismissInstall.isVisible().catch(() => false)) {
    await dismissInstall.click();
  }

  await page
    .getByPlaceholder("Enter your username or email")
    .fill(authenticatedUser.email);
  await page.getByPlaceholder("Enter your password").fill("Str0ngP@ss!");
  const loginResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/auth/login") &&
    response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Login" }).click();
  expect((await loginResponse).status()).toBe(200);

  await expect(page).toHaveURL(
    new RegExp(`/#/dashboard/chat-rooms/${ROOM_ID}$`),
  );

  await page.goto(`/#/dashboard/community/help-requests/${HELP_REQUEST_ID}`);
  await expect(page).toHaveURL(
    new RegExp(`/#/dashboard/community/help-requests/${HELP_REQUEST_ID}$`),
  );
});
