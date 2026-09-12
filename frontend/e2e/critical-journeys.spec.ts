import { expect, test, type Page, type Route } from "@playwright/test";

const user = {
  id: "e2e-user",
  username: "e2e_user",
  email: "e2e@example.com",
  firstName: "E2E",
  lastName: "User",
  role: "Administrator",
  isAtCloudLeader: true,
  roleInAtCloud: "Administrator",
  gender: "male",
};

async function mockApi(page: Page) {
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    // Vite source modules can legitimately live under /src/services/api/.
    // Only intercept calls to the backend's public /api namespace.
    if (!path.startsWith("/api/")) {
      return route.continue();
    }

    if (path.endsWith("/auth/register")) {
      return route.fulfill({
        json: { success: true, data: { accessToken: "e2e-token", user } },
      });
    }
    if (path.endsWith("/auth/login")) {
      return route.fulfill({
        json: { success: true, data: { accessToken: "e2e-token", user } },
      });
    }
    if (path.endsWith("/auth/profile")) {
      return route.fulfill({ json: { success: true, data: { user } } });
    }
    if (path.endsWith("/notifications/welcome-status")) {
      return route.fulfill({
        json: {
          success: true,
          data: { hasReceivedWelcomeMessage: true },
        },
      });
    }

    return route.fulfill({ json: { success: true, data: {} } });
  });
}

test.beforeEach(async ({ page }) => {
  page.on("console", (message) => {
    if (message.type() === "error") {
      console.error(`[browser] ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => console.error(`[browser] ${error.message}`));
  await mockApi(page);
});

test("public home exposes login, sign-up, and guest entry", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Welcome to @Cloud" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Login" })).toHaveAttribute(
    "href",
    "#/login",
  );
  await expect(page.getByRole("link", { name: "Sign Up" })).toHaveAttribute(
    "href",
    "#/signup",
  );
  await expect(
    page.getByRole("link", { name: "Enter as a Guest" }),
  ).toHaveAttribute("href", "#/dashboard/welcome");
});

test("a new user can submit registration and reach check-email", async ({
  page,
}) => {
  await page.goto("/#/signup");

  await page.getByPlaceholder("Enter your email address").fill(user.email);
  await page.getByPlaceholder("Choose a username").fill(user.username);
  await page.getByPlaceholder("Enter your password").fill("Str0ngP@ss!");
  await page
    .getByPlaceholder("Enter your confirm password")
    .fill("Str0ngP@ss!");
  await page.getByPlaceholder("Enter your first name").fill(user.firstName);
  await page.getByPlaceholder("Enter your last name").fill(user.lastName);
  await page.getByRole("combobox", { name: /Gender/ }).selectOption("male");
  await page.getByLabel(/Birth Year/).fill("1990");
  await page.getByLabel(/Phone Country/).selectOption("US");
  await page.getByPlaceholder("Enter your phone number").fill("415 555 2671");
  await page.getByLabel(/Country of Residence/).selectOption("US");
  await page.getByLabel(/^State/).selectOption("US-CA");
  await page.getByPlaceholder("Enter city").fill("San Francisco");
  await page.getByLabel(/Employment Status/).selectOption("employed");
  await page
    .getByPlaceholder("Enter company or organization")
    .fill("Example Co");
  await page.getByRole("button", { name: "Sign Up" }).click();

  await expect(page.getByText("We’ll keep your history")).toBeVisible();
  await page.getByRole("button", { name: "OK" }).click();
  await expect(page.getByText("Welcome to @Cloud!")).toBeVisible();
  await page.getByRole("button", { name: "OK" }).click();

  await expect(page).toHaveURL(/\/check-email$/);
  await expect(
    page.getByRole("heading", { name: /Check Your Email/i }),
  ).toBeVisible();
});

test("login returns an authenticated user to the protected destination", async ({
  page,
}) => {
  await page.goto("/#/dashboard/income-history");
  await expect(page).toHaveURL(/\/#\/login$/);

  await page
    .getByPlaceholder("Enter your username or email")
    .fill(user.email);
  await page.getByPlaceholder("Enter your password").fill("Str0ngP@ss!");
  await page.getByRole("button", { name: "Login" }).click();

  await expect(page).toHaveURL(/\/#\/dashboard\/income-history$/);
  await expect.poll(() => page.evaluate(() => localStorage.authToken)).toBe(
    "e2e-token",
  );
});
