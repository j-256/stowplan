import { defineConfig, devices } from "@playwright/test";

const TEST_OUTPUT_DIRECTORY = "test-results";
const E2E_DATABASE_PATH =
  `${TEST_OUTPUT_DIRECTORY}/stowplan-e2e.sqlite`;

export default defineConfig({
  outputDir: TEST_OUTPUT_DIRECTORY,
  testDir: "tests/e2e",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure" },
  webServer: {
    command: "npm run build:next && npm run start:node",
    url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: { ...process.env, AUTH_BASE_URL:"http://127.0.0.1:3100", AUTH_DEV_ENABLED:"true", HOST:"127.0.0.1", PORT:"3100", STOWPLAN_SQLITE_PATH:E2E_DATABASE_PATH },
  },
  projects: [
    { name:"mobile-chromium", use:{ ...devices["Pixel 7 Pro"] } },
    { name:"mobile-landscape", use:{ ...devices["Pixel 7 Pro landscape"] } },
    { name:"tablet-portrait", use:{ ...devices["iPad Mini"], browserName:"chromium" } },
    { name:"tablet-landscape", use:{ ...devices["iPad Mini landscape"], browserName:"chromium" } },
    { name:"desktop-compact", use:{ ...devices["Desktop Chrome"], viewport:{ width:1024, height:700 } } },
    { name:"desktop-chromium", use:{ ...devices["Desktop Chrome"], viewport:{ width:1440, height:900 } } },
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
