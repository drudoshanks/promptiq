import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests (SRS §13.1). Runs against a local dev server with the mock
 * optimiser and a disposable database. Set E2E_BASE_URL to target a deployed
 * staging environment instead.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
    // Use an already-installed Chromium when the bundled revision is unavailable.
    ...(process.env.PW_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } } : {}),
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:3000",
        reuseExistingServer: !process.env.CI,
        env: { OPTIMISER_PROVIDER: "mock" },
      },
});
