import { defineConfig, devices } from "@playwright/test";

function requiredLoopbackUrl(name: string): string {
  const raw = process.env[name]?.trim();
  if (!raw) throw new Error(`${name} is required.`);

  const parsed = new URL(raw);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    !parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/"
  ) {
    throw new Error(`${name} must be an explicit loopback HTTP origin.`);
  }
  return parsed.origin;
}

const frontendUrl = requiredLoopbackUrl("FULLSTACK_E2E_FRONTEND_URL");

export default defineConfig({
  testDir: "./e2e-fullstack",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: frontendUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium-fullstack",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
