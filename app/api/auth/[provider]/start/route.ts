import { beginOAuth, provider } from "../../../../../src/server/auth";
import { oauthReturnTo } from "../../../../../src/domain/app-url";
import { runtimeEnv } from "../../../../../src/server/runtime";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const env = await runtimeEnv();
  if (!env.DB) {
    return Response.json(
      { error: "Database is not configured" },
      { status: 503 },
    );
  }
  const id = (await params).provider;
  const configuredProvider = provider(env, id);
  if (!configuredProvider) {
    return Response.json(
      { error: "Authentication provider is not configured" },
      { status: 404 },
    );
  }
  const url = new URL(request.url);
  const base = env.AUTH_BASE_URL ?? url.origin;
  const returnTo = oauthReturnTo(url.searchParams.get("returnTo"));
  return Response.redirect(
    await beginOAuth(env.DB, configuredProvider, base, returnTo),
  );
}
