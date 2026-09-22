import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Real HTTP writes, Mongo persistence, the outbox worker, Socket.IO and two
// independently signed-in React clients. No mocked network or page reloads.
test("both participants receive every Help lifecycle update away from Community", async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const backend = process.env.FULLSTACK_E2E_BACKEND_URL!;
  const frontend = process.env.FULLSTACK_E2E_FRONTEND_URL!;
  expect(new URL(backend).hostname).toBe("127.0.0.1");
  const adminLogin = await request.post(`${backend}/api/auth/login`, {
    data: {
      emailOrUsername: process.env.FULLSTACK_E2E_USERNAME,
      password: process.env.FULLSTACK_E2E_PASSWORD,
    },
  });
  expect(adminLogin.status()).toBe(200);
  const adminToken = (await adminLogin.json()).data.accessToken as string;
  const initial = (await (await request.get(`${backend}/api/runtime-config`)).json()).data;
  const enabled = await request.patch(`${backend}/api/system/feature-controls/alumni-network`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { mode: "on", expectedRevision: initial.revision },
  });
  expect(enabled.status()).toBe(200);
  const enabledRevision = (await enabled.json()).data.revision as number;
  const requesterContext = await browser.newContext();
  const helperContext = await browser.newContext();
  const requester = await requesterContext.newPage();
  const helper = await helperContext.newPage();
  const frames = new Map<Page, string[]>([[requester, []], [helper, []]]);
  for (const page of [requester, helper]) {
    page.setDefaultTimeout(10_000);
    page.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload }) => {
        const text = payload.toString();
        if (text.includes("alumni_help_update")) frames.get(page)!.push(text);
      });
    });
  }

  async function login(page: Page, username: string): Promise<string> {
    await page.goto(`${frontend}/#/login`);
    await page.getByPlaceholder("Enter your username or email").fill(username);
    await page.getByPlaceholder("Enter your password").fill(process.env.FULLSTACK_E2E_PASSWORD!);
    const responsePromise = page.waitForResponse((response) =>
      response.url().endsWith("/api/auth/login") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Login", exact: true }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    await page.getByRole("dialog", { name: "Login Successful" })
      .getByRole("button", { name: "OK", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
    await page.getByRole("link", { name: "Welcome", exact: true }).click();
    return (await response.json()).data.accessToken;
  }

  async function write(client: APIRequestContext, token: string, path: string, data: unknown) {
    const response = await client.post(`${backend}/api/alumni-help-requests${path}`, {
      headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": randomUUID() },
      data,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).data.request;
  }

  async function expectUpdate(page: Page, id: string, revision: number) {
    // A socket frame is required so the periodic recovery check cannot mask a
    // broken notification delivery path.
    await expect.poll(() => frames.get(page)!.some((frame) =>
      frame.includes(id) && frame.includes(`"requestRevision":${revision},`),
    ), { timeout: 8_000 }).toBe(true);
    await expect(page.getByRole("link", {
      name: "Alumni Community, 1 help requests with updates or actions needed",
      exact: true,
    })).toBeVisible({ timeout: 8_000 });
    const systemNotice = page.getByRole("dialog", { name: "System Message", exact: true });
    if (await systemNotice.isVisible()) {
      await systemNotice.getByRole("button", { name: "OK", exact: true }).click();
    }
  }

  async function readInUi(page: Page, expectedStatus: string, returnHome = true) {
    await page.getByRole("link", { name: /^Alumni Community/ }).click();
    await page.getByRole("link", { name: /^Help Requests(?:,|$)/ }).click();
    await expect(page.getByText("New update", { exact: true })).toBeVisible();
    const readPromise = page.waitForResponse((response) =>
      /\/api\/alumni-help-requests\/[a-f\d]{24}\/read$/.test(response.url()) &&
      response.request().method() === "POST",
    );
    await page.getByRole("link", { name: "View Request", exact: true }).click();
    expect((await readPromise).status()).toBe(200);
    await expect(page.getByText(expectedStatus, { exact: true }).first()).toBeVisible();
    if (returnHome) await page.getByRole("link", { name: "Welcome", exact: true }).click();
  }

  try {
    const requesterToken = await login(requester, process.env.FULLSTACK_E2E_USERNAME!);
    const helperToken = await login(helper, "e2e_alumni_helper");
    const terms = await request.get(`${backend}/api/alumni-help-requests/terms`, {
      headers: { Authorization: `Bearer ${requesterToken}` },
    });
    const acceptedTerms = (await terms.json()).data.terms;
    let current = await write(request, requesterToken, "", {
      alumniProfileId: "64b00000000000000000ee01",
      requestedHelpType: "career_advice",
      openingNote: "Controlled realtime workflow test",
      consentVersion: acceptedTerms.consent.version,
      consentAccepted: true,
      disclaimerVersion: acceptedTerms.disclaimer.version,
      disclaimerAccepted: true,
    });
    await expectUpdate(helper, current.id, current.revision);
    await readInUi(helper, "Requested");

    current = await write(request, helperToken, `/${current.id}/request-information`, {
      expectedRevision: current.revision,
      note: "Please describe your goals.",
    });
    await expectUpdate(requester, current.id, current.revision);
    await readInUi(requester, "Needs information");

    current = await write(request, requesterToken, `/${current.id}/provide-information`, {
      expectedRevision: current.revision,
      note: "I would appreciate an introduction.",
    });
    await expectUpdate(helper, current.id, current.revision);
    await readInUi(helper, "Requested");

    current = await write(request, helperToken, `/${current.id}/propose-alternative`, {
      expectedRevision: current.revision,
      proposedHelpType: "warm_introduction",
    });
    await expectUpdate(requester, current.id, current.revision);
    await readInUi(requester, "Alternative proposed");

    current = await write(request, requesterToken, `/${current.id}/confirm-alternative`, {
      expectedRevision: current.revision,
    });
    await expectUpdate(helper, current.id, current.revision);
    for (const page of [requester, helper]) {
      const modal = page.getByRole("dialog", { name: "Chat Room created" });
      await expect(modal).toBeVisible({ timeout: 8_000 });
      await expect(modal.getByRole("button", { name: "Open Chat Room", exact: true })).toBeVisible();
      await modal.getByRole("button", { name: "Later", exact: true }).click();
    }
    await readInUi(helper, "Accepted");

    current = await write(request, helperToken, `/${current.id}/start`, {
      expectedRevision: current.revision,
    });
    await expectUpdate(requester, current.id, current.revision);
    await readInUi(requester, "In progress");

    current = await write(request, helperToken, `/${current.id}/complete`, {
      expectedRevision: current.revision,
    });
    await expectUpdate(requester, current.id, current.revision);
    await readInUi(requester, "Help marked complete");

    current = await write(request, requesterToken, `/${current.id}/outcomes`, {
      expectedRevision: current.revision,
      outcomeCode: "completed",
    });
    await expectUpdate(helper, current.id, current.revision);
    await readInUi(helper, "Help marked complete");

    current = await write(request, helperToken, `/${current.id}/outcomes/${current.latestOutcome.id}/confirm`, {
      expectedRevision: current.latestOutcome.revision,
    });
    expect(current.status).toBe("closed");
    await expectUpdate(requester, current.id, current.revision);
    for (const page of [requester, helper]) {
      const modal = page.getByRole("dialog", { name: "Help request closed" });
      await expect(modal).toBeVisible({ timeout: 8_000 });
      await expect(
        modal.getByRole("button", { name: "Open Chat Room", exact: true }),
      ).toBeVisible();
      await modal.getByRole("button", { name: "Later", exact: true }).click();
    }
    await readInUi(requester, "Closed", false);
    await expect(requester.getByRole("link", { name: "Alumni Community", exact: true })).toBeVisible();
    await expect(
      requester.getByText("Confirmed result and closed the request", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      requester.getByRole("button", { name: "Close request", exact: true }),
    ).toHaveCount(0);
  } finally {
    const restored = await request.patch(`${backend}/api/system/feature-controls/alumni-network`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { mode: initial.alumniNetwork.mode, expectedRevision: enabledRevision },
    });
    expect(restored.status()).toBe(200);
    await Promise.allSettled([requesterContext.close(), helperContext.close()]);
  }
});
