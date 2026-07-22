import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { D1DatabaseLike } from "../adapters/d1-snapshot-store";

export interface RuntimeEnv {
  DB?: D1DatabaseLike;
  AUTH_ADMIN_EMAILS?: string;
  AUTH_DEV_ENABLED?: string;
  AUTH_SESSION_DAYS?: string;
  BASE_URL?: string;
  CLOUDFLARE_ACCESS_AUD?: string;
  CLOUDFLARE_ACCESS_TEAM_DOMAIN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}

export async function runtimeEnv(): Promise<RuntimeEnv> {
  try { return getCloudflareContext({ async: true }).then(context => context.env as RuntimeEnv); }
  catch { return process.env as RuntimeEnv; }
}
