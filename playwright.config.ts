import { defineConfig, devices } from "@playwright/test";

const TEST_OUTPUT_DIRECTORY = "test-results";
const E2E_DATABASE_PATH =
  `${TEST_OUTPUT_DIRECTORY}/stowplan-e2e.sqlite`;
const E2E_IDENTITY_DIGEST_KEY =
  "playwright-identity-digest-key-at-least-32-bytes";
// Chromium needs this flag so service workers trust the ephemeral E2E certificate
const CHROMIUM_HTTPS_USE = {
  launchOptions: { args: ["--ignore-certificate-errors"] },
};

export default defineConfig({
  outputDir: TEST_OUTPUT_DIRECTORY,
  testDir: "tests/e2e",
  fullyParallel: false,
  // Every worker drives the same Node server and SQLite file, so a second
  // worker only adds contention for shared state. Intermittent failures traced
  // to that contention cost more than the wall clock a single worker spends
  workers: process.env.CI ? 1 : undefined,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "https://localhost:3100",
    ignoreHTTPSErrors: true,
    // A retried run that eventually passes is reported as flaky but discarded by
    // "retain-on-failure", which leaves intermittent failures with no evidence
    // to diagnose. Keep the attempt that failed as well
    trace: "retain-on-failure-and-retries",
  },
  webServer: {
    command:
      "npm run build:next && node scripts/playwright-node-server.mjs",
    ignoreHTTPSErrors: true,
    url: "https://localhost:3100/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: { ...process.env, AUTH_BASE_URL:"https://localhost:3100", AUTH_DEV_ENABLED:"true", AUTH_IDENTITY_DIGEST_KEY:E2E_IDENTITY_DIGEST_KEY, HOST:"127.0.0.1", PORT:"3100", STOWPLAN_SQLITE_PATH:E2E_DATABASE_PATH },
  },
  projects: [
    { name:"mobile-chromium", use:{ ...devices["Pixel 7 Pro"], ...CHROMIUM_HTTPS_USE } },
    { name:"mobile-landscape", use:{ ...devices["Pixel 7 Pro landscape"], ...CHROMIUM_HTTPS_USE } },
    { name:"tablet-portrait", use:{ ...devices["iPad Mini"], ...CHROMIUM_HTTPS_USE, browserName:"chromium" } },
    { name:"tablet-landscape", use:{ ...devices["iPad Mini landscape"], ...CHROMIUM_HTTPS_USE, browserName:"chromium" } },
    { name:"desktop-compact", use:{ ...devices["Desktop Chrome"], ...CHROMIUM_HTTPS_USE, viewport:{ width:1024, height:700 } } },
    { name:"desktop-chromium", use:{ ...devices["Desktop Chrome"], ...CHROMIUM_HTTPS_USE, viewport:{ width:1440, height:900 } } },
    {
      name: "webkit-phone",
      testMatch: /safe-beta\.spec\.ts/,
      use: { ...devices["iPhone 15"] },
    },
    {
      name: "webkit-tablet-landscape",
      testMatch: /safe-beta\.spec\.ts/,
      use: { ...devices["iPad Mini landscape"] },
    },
  ],
});
