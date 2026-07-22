import { authenticate } from "../../../../src/server/auth";
import { runtimeEnv } from "../../../../src/server/runtime";

export async function GET(request: Request) {
  const env = await runtimeEnv();
  const providers = [
    env.AUTH_DEV_ENABLED === "true" ? "development" : null,
    env.AUTH_GOOGLE_CLIENT_ID && env.AUTH_GOOGLE_CLIENT_SECRET ? "google" : null,
    env.AUTH_GITHUB_CLIENT_ID && env.AUTH_GITHUB_CLIENT_SECRET ? "github" : null,
    env.AUTH_CLOUDFLARE_ACCESS_TEAM_DOMAIN && env.AUTH_CLOUDFLARE_ACCESS_AUD ? "cloudflare-access" : null,
  ].filter((provider): provider is string => provider !== null);
  if (!env.DB) return Response.json({ user: null, configured: false, providers: [] });
  const user = await authenticate(env.DB, request);
  return Response.json(
    { user, configured: true, providers },
    { status: user ? 200 : 401, headers: { "cache-control": "no-store" } },
  );
}
