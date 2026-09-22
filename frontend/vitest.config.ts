import { defineConfig } from "vitest/config";
import { coverageThresholds } from "../config/coverage-thresholds";

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify("0.0.0-test"),
  },
  test: {
    // The current jsdom suite is faster and more deterministic in one isolated
    // worker; backend unit/contract tiers carry the safe file parallelism.
    pool: "threads",
    maxWorkers: 1,
    poolOptions: {
      threads: {
        singleThread: true,
        isolate: true,
      },
    },
    // Avoid stuck watch polling; we primarily use non-watch in root runs
    watch: false,
    // Be explicit about environment; many tests rely on jsdom
    environment: "jsdom",
    // Some tests can be a bit slow with fewer workers; raise timeout slightly
    testTimeout: 20000,
    hookTimeout: 20000,
    // Error-path contracts intentionally exercise production logging. Failed
    // assertions and thrown errors still surface; opt into captured console
    // diagnostics with VITEST_VERBOSE_LOGS=true when debugging.
    silent: process.env.VITEST_VERBOSE_LOGS !== "true",
    setupFiles: ["src/test/setup.ts"],
    exclude: [
      "e2e/**",
      "e2e-pwa/**",
      "e2e-fullstack/**",
      "node_modules/**",
      "dist/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html", "json-summary"],
      reportsDirectory: "coverage/frontend",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/test/**",
        "src/**/*.{test,spec}.{ts,tsx}",
        "src/types/**",
        "src/vite-env.d.ts",
        "src/main.tsx",
      ],
      thresholds: { ...coverageThresholds.frontend },
    },
  },
});
