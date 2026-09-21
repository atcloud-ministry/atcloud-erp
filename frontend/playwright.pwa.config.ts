import { defineConfig, devices } from "@playwright/test";

const previewOrigin = "http://127.0.0.1:4174";

export default defineConfig({
  testDir: "./e2e-pwa",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: previewOrigin,
    serviceWorkers: "allow",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "android-chromium",
      use: { ...devices["Pixel 7"], browserName: "chromium" },
    },
    {
      name: "iphone-viewport-chromium",
      use: { ...devices["iPhone 13"], browserName: "chromium" },
    },
    {
      name: "ipad-viewport-chromium",
      use: { ...devices["iPad Pro 11"], browserName: "chromium" },
    },
  ],
  webServer: {
    command:
      "npm run build && npm run preview -- --host 127.0.0.1 --port 4174",
    url: previewOrigin,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
