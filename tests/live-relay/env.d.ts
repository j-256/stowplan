/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { WorkspaceLiveRoom } from "../../worker/live-relay";

declare global {
  namespace Cloudflare {
    interface Env {
      LIVE_RELAY_SECRET: string;
      WORKSPACES: DurableObjectNamespace<WorkspaceLiveRoom>;
    }
  }
}

export {};
