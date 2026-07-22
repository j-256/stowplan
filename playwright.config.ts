import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure" },
  webServer: {
    command: "npm run build:next && npm run start:node",
    url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { ...process.env, AUTH_BASE_URL:"http://127.0.0.1:3100", AUTH_DEV_ENABLED:"true", HOST:"127.0.0.1", PORT:"3100", STOWPLAN_SQLITE_PATH:"/tmp/stowplan-e2e.sqlite" },
  },
  projects: [
    { name:"mobile-chromium", use:{ ...devices["Pixel 7"] } },
    { name:"desktop-chromium", use:{ ...devices["Desktop Chrome"] } },
  ],
});
