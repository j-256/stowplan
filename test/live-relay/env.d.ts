/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { WorkspaceLiveRoom } from "../../worker/live-relay";

declare global {
  namespace Cloudflare {
    interface Env {
      LIVE_RELAY_SECRET: string;
      LIVE_WORKSPACE_RATE_LIMITER: RateLimit;
      WORKSPACES: DurableObjectNamespace<WorkspaceLiveRoom>;
    }
  }
}

export {};
