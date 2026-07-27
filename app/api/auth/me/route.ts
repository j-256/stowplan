import {
  authenticate,
  developmentAuthenticationAllowed,
  hasLinkedGoogleIdentity,
  identityEnforcementConfigured,
  provider,
} from "../../../../src/server/auth";
import { runtimeEnv } from "../../../../src/server/runtime";

export async function GET(request: Request) {
  const env = await runtimeEnv();
  const googleConfigured =
    provider(env, "google", request.url) !== null;
  const providers = [
    developmentAuthenticationAllowed(env, request.url)
      && identityEnforcementConfigured(env)
      ? "development"
      : null,
    googleConfigured ? "google" : null,
  ].filter((provider): provider is string => provider !== null);
  if (!env.DB) {
    return Response.json(
      {
        accessMigrationAvailable: false,
        adminAccessRequired:
          env.AUTH_ADMIN_REQUIRE_ACCESS === "true",
        configured: false,
        hasLinkedGoogleIdentity: false,
        providers: [],
        turnstileSiteKey: null,
        user: null,
      },
      { headers: { "cache-control": "no-store" } },
    );
  }
  const user = await authenticate(env.DB, request);
  const googleIdentityLinked = user
    ? await hasLinkedGoogleIdentity(env.DB, user.userId)
    : false;
  return Response.json(
    {
      accessMigrationAvailable:
        env.AUTH_ACCESS_MIGRATION_ENABLED === "true",
      adminAccessRequired:
        env.AUTH_ADMIN_REQUIRE_ACCESS === "true",
      configured: true,
      hasLinkedGoogleIdentity: googleIdentityLinked,
      providers,
      turnstileSiteKey: googleConfigured
        ? env.AUTH_TURNSTILE_SITE_KEY
        : null,
      user,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
