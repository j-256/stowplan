import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const TEST_RELAY_SECRET =
  "test-live-relay-secret-with-at-least-32-bytes";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: { LIVE_RELAY_SECRET: TEST_RELAY_SECRET },
      },
      wrangler: { configPath: "./wrangler.live.jsonc" },
    }),
  ],
  test: {
    include: ["test/live-relay/**/*.worker-test.ts"],
    reporters: ["default"],
  },
});
