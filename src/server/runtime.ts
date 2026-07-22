import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { D1DatabaseLike } from "../adapters/d1-snapshot-store";

export interface RuntimeEnv {
  DB?: D1DatabaseLike;
  AUTH_ADMIN_EMAILS?: string;
  AUTH_ADMIN_REQUIRE_ACCESS?: string;
  AUTH_DEV_ENABLED?: string;
  AUTH_BASE_URL?: string;
  AUTH_CLOUDFLARE_ACCESS_AUD?: string;
  AUTH_CLOUDFLARE_ACCESS_TEAM_DOMAIN?: string;
  AUTH_GITHUB_CLIENT_ID?: string;
  AUTH_GITHUB_CLIENT_SECRET?: string;
  AUTH_GOOGLE_CLIENT_ID?: string;
  AUTH_GOOGLE_CLIENT_SECRET?: string;
  AUTH_SESSION_TTL_SECONDS?: string;
}

export async function runtimeEnv(): Promise<RuntimeEnv> {
  const injected = (globalThis as typeof globalThis & { __STOWPLAN_ENV?: RuntimeEnv }).__STOWPLAN_ENV;
  if (injected) return injected;
  try { return getCloudflareContext({ async: true }).then(context => context.env as RuntimeEnv); }
  catch { return process.env as RuntimeEnv; }
}
