import { defineConfig, devices } from "@playwright/test";

// Browser end-to-end suite (e2e/): one `wrangler dev` with its own local D1, started by
// e2e/global-setup.ts. Tests share that database and reseed it before each test, so they run one
// at a time. CONTRIBUTING.md has how to run and debug it.
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0, // a backstop only: a flaky test gets fixed, not retried
  timeout: 20_000,
  expect: { timeout: 5_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }], ["github"]] : [["list"], ["html", { open: "never" }]],
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // The production build may register a service worker (Web Push); keep it out of the tests.
    serviceWorkers: "block",
    // No timezone/locale drift between laptops and CI in what the page renders.
    locale: "en-US",
    timezoneId: "America/New_York",
  },
  projects: [{ name: "chromium" }],
});
