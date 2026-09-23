import { expect, test, type Page, type Route } from "@playwright/test";

function success(data: unknown) {
  return { success: true, data };
}

async function mockPublicApi(page: Page): Promise<void> {
  await page.route("**/api/**", async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/runtime-config") {
      return route.fulfill({
        json: success({
          version: 1,
          revision: 1,
          alumniNetwork: { mode: "on", readable: true, writable: true },
        }),
      });
    }

    return route.fulfill({ json: success({}) });
  });
}

test.beforeEach(async ({ page }) => {
  await mockPublicApi(page);
});

test("uses the five-button bottom navigation only on phone-sized viewports", async ({
  page,
}, testInfo) => {
  await page.goto("/#/dashboard/welcome");

  const dismissInstall = page.getByRole("button", { name: "Not now" });
  if (await dismissInstall.isVisible().catch(() => false)) {
    await dismissInstall.click();
  }

  const bottomNavigation = page.getByRole("navigation", {
    name: "Mobile primary navigation",
  });
  const isPhone =
    testInfo.project.name.includes("android") ||
    testInfo.project.name.includes("iphone");

  if (!isPhone) {
    await expect(bottomNavigation).toBeHidden();
    const tabletMenuButton = page.getByRole("button", {
      name: "Open navigation menu",
    });
    if (testInfo.project.name.includes("ipad")) {
      await expect(tabletMenuButton).toBeVisible();
    } else {
      await expect(tabletMenuButton).toBeHidden();
    }
    return;
  }

  await expect(bottomNavigation).toBeVisible();
  await expect(
    bottomNavigation.locator(":scope > div > :is(button, a)"),
  ).toHaveCount(5);
  await expect(
    bottomNavigation.getByRole("button", { name: "Open navigation menu" }),
  ).toBeVisible();
  await expect(
    bottomNavigation.getByRole("link", { name: "Event Calendar" }),
  ).toHaveAttribute("href", /\/dashboard\/upcoming$/);
  await expect(
    bottomNavigation.getByRole("link", { name: "Chat Rooms" }),
  ).toHaveAttribute("href", /\/dashboard\/chat-rooms$/);
  await expect(
    bottomNavigation.getByRole("link", { name: "Donate" }),
  ).toHaveAttribute("href", /\/dashboard\/donate$/);
  await expect(
    bottomNavigation.getByRole("link", { name: "Feedback" }),
  ).toHaveAttribute("href", /\/dashboard\/feedback$/);

  const geometry = await bottomNavigation.evaluate((navigation) => {
    const targets = Array.from(
      navigation.querySelectorAll<HTMLElement>(":scope > div > button, :scope > div > a"),
    );
    const rectangle = navigation.getBoundingClientRect();
    return {
      bottom: rectangle.bottom,
      minimumTargetHeight: Math.min(
        ...targets.map((target) => target.getBoundingClientRect().height),
      ),
      pageWidth: document.documentElement.scrollWidth,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  });
  expect(Math.abs(geometry.viewportHeight - geometry.bottom)).toBeLessThan(2);
  expect(geometry.minimumTargetHeight).toBeGreaterThanOrEqual(44);
  expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewportWidth);

  await bottomNavigation
    .getByRole("button", { name: "Open navigation menu" })
    .click();
  const menu = page.getByRole("navigation", {
    exact: true,
    name: "Primary navigation",
  });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("link", { name: "Event Calendar" })).toBeHidden();
  await expect(menu.getByRole("link", { name: "Donate" })).toBeHidden();
  await expect(bottomNavigation).toHaveAttribute("inert", "");

  await menu.getByRole("button", { name: "Close navigation menu" }).click();
  await expect(bottomNavigation).not.toHaveAttribute("inert", "");
  await expect(
    bottomNavigation.getByRole("button", { name: "Open navigation menu" }),
  ).toBeFocused();
});
