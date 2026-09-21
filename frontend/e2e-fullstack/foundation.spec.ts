import { expect, test, type APIRequestContext } from "@playwright/test";

type AlumniNetworkMode = "off" | "read_only" | "on";

interface RuntimeConfig {
  readonly version: 1;
  readonly revision: number;
  readonly alumniNetwork: {
    readonly mode: AlumniNetworkMode;
    readonly readable: boolean;
    readonly writable: boolean;
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requiredBackendOrigin(): string {
  const raw = requiredEnvironment("FULLSTACK_E2E_BACKEND_URL");
  const parsed = new URL(raw);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    !parsed.port ||
    parsed.pathname !== "/"
  ) {
    throw new Error(
      "FULLSTACK_E2E_BACKEND_URL must be an explicit loopback HTTP origin.",
    );
  }
  return parsed.origin;
}

function runtimeConfigFrom(payload: unknown): RuntimeConfig {
  expect(payload).toEqual({
    success: true,
    data: {
      version: 1,
      revision: expect.any(Number),
      alumniNetwork: {
        mode: expect.stringMatching(/^(off|read_only|on)$/),
        readable: expect.any(Boolean),
        writable: expect.any(Boolean),
      },
    },
  });
  const config = (payload as { data: RuntimeConfig }).data;
  expect(Number.isSafeInteger(config.revision)).toBe(true);
  expect(config.revision).toBeGreaterThanOrEqual(0);
  const capabilities = {
    off: { readable: false, writable: false },
    read_only: { readable: true, writable: false },
    on: { readable: true, writable: true },
  } as const;
  expect(config.alumniNetwork).toEqual({
    mode: config.alumniNetwork.mode,
    ...capabilities[config.alumniNetwork.mode],
  });
  return config;
}

async function updateAlumniNetworkMode(
  request: APIRequestContext,
  backendOrigin: string,
  token: string,
  mode: AlumniNetworkMode,
  expectedRevision: number,
): Promise<RuntimeConfig> {
  const response = await request.patch(
    `${backendOrigin}/api/system/feature-controls/alumni-network`,
    {
      headers: { Authorization: `Bearer ${token}` },
      data: { mode, expectedRevision },
    },
  );
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  return runtimeConfigFrom(await response.json());
}

test("real login, runtime config, protected API, and feature control work together", async ({
  page,
  request,
}) => {
  const backendOrigin = requiredBackendOrigin();
  const username = requiredEnvironment("FULLSTACK_E2E_USERNAME");
  const email = requiredEnvironment("FULLSTACK_E2E_EMAIL");
  const password = requiredEnvironment("FULLSTACK_E2E_PASSWORD");

  const readinessResponse = await request.get(
    `${backendOrigin}/api/readiness`,
  );
  expect(readinessResponse.status()).toBe(200);
  expect(readinessResponse.headers()["cache-control"]).toBe("no-store");
  expect(await readinessResponse.json()).toEqual({
    success: true,
    status: "ready",
    version: 1,
    timestamp: expect.any(String),
  });

  const initialConfigResponse = await request.get(
    `${backendOrigin}/api/runtime-config`,
  );
  expect(initialConfigResponse.status()).toBe(200);
  expect(initialConfigResponse.headers()["cache-control"]).toBe("no-store");
  const initialConfig = runtimeConfigFrom(await initialConfigResponse.json());
  expect(initialConfig.alumniNetwork).toEqual({
    mode: "off",
    readable: false,
    writable: false,
  });

  const browserRuntimeConfigPromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/runtime-config" &&
      response.request().method() === "GET",
  );
  await page.goto("/#/login");
  const browserRuntimeConfigResponse = await browserRuntimeConfigPromise;
  expect(browserRuntimeConfigResponse.status()).toBe(200);
  expect(
    await browserRuntimeConfigResponse.headerValue("cache-control"),
  ).toBe("no-store");
  expect(
    runtimeConfigFrom(await browserRuntimeConfigResponse.json()),
  ).toEqual(initialConfig);
  await page.getByPlaceholder("Enter your username or email").fill(username);
  await page.getByPlaceholder("Enter your password").fill(password);

  const loginResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/auth/login" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Login" }).click();
  const loginResponse = await loginResponsePromise;
  expect(loginResponse.status()).toBe(200);

  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("authToken")))
    .not.toBeNull();

  const token = await page.evaluate(() => localStorage.getItem("authToken"));
  expect(token).toBeTruthy();
  expect(token).not.toMatch(/^test-/);
  expect(token?.split(".")).toHaveLength(3);
  await expect(page).toHaveURL(/\/#\/dashboard(?:\/|$)/);

  const profileResponse = await request.get(
    `${backendOrigin}/api/auth/profile`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(profileResponse.status()).toBe(200);
  expect(await profileResponse.json()).toMatchObject({
    success: true,
    data: {
      user: {
        username,
        email,
        role: "Super Admin",
        isVerified: true,
        isActive: true,
      },
    },
  });

  const recoveryResponse = await page.evaluate(
    async ({ origin, accessToken }) => {
      const response = await fetch(
        `${origin}/api/system/recovery/notification-outbox/reconcile`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "Idempotency-Key": "11111111-1111-4111-8111-111111111111",
          },
          body: JSON.stringify({ limit: 1 }),
        },
      );
      return {
        status: response.status,
        cacheControl: response.headers.get("cache-control"),
        body: await response.json(),
      };
    },
    { origin: backendOrigin, accessToken: token! },
  );
  expect(recoveryResponse).toEqual({
    status: 200,
    cacheControl: "no-store",
    body: {
      success: true,
      data: {
        operation: "notification_outbox_reconcile",
        recoveredExpiredLeases: 0,
        deadLetteredExhausted: 0,
        receiptId: expect.any(String),
        replayed: false,
      },
    },
  });

  const readOnlyConfig = await updateAlumniNetworkMode(
    request,
    backendOrigin,
    token!,
    "read_only",
    initialConfig.revision,
  );
  expect(readOnlyConfig.revision).toBe(initialConfig.revision + 1);
  expect(readOnlyConfig.alumniNetwork).toEqual({
    mode: "read_only",
    readable: true,
    writable: false,
  });

  const observedConfigResponse = await request.get(
    `${backendOrigin}/api/runtime-config`,
  );
  expect(observedConfigResponse.status()).toBe(200);
  expect(runtimeConfigFrom(await observedConfigResponse.json())).toEqual(
    readOnlyConfig,
  );

  const enabledConfig = await updateAlumniNetworkMode(
    request,
    backendOrigin,
    token!,
    "on",
    readOnlyConfig.revision,
  );
  expect(enabledConfig.revision).toBe(readOnlyConfig.revision + 1);
  expect(enabledConfig.alumniNetwork).toEqual({
    mode: "on",
    readable: true,
    writable: true,
  });

  const disabledConfig = await updateAlumniNetworkMode(
    request,
    backendOrigin,
    token!,
    "off",
    enabledConfig.revision,
  );
  expect(disabledConfig.revision).toBe(enabledConfig.revision + 1);
  expect(disabledConfig.alumniNetwork).toEqual({
    mode: "off",
    readable: false,
    writable: false,
  });
});
