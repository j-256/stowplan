import { workspaceReturnTo } from "../../../../../src/domain/app-url";
import {
  consumeGuestLink,
  isTrustedMutation,
  sessionCookie,
} from "../../../../../src/server/auth";
import { runtimeEnv } from "../../../../../src/server/runtime";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const env = await runtimeEnv();
  const token = (await params).token;
  const requestUrl = new URL(request.url);
  const base = env.AUTH_BASE_URL ?? request.url;
  const guestUrl = new URL(`/guest/${encodeURIComponent(token)}`, base);
  const returnTo = requestUrl.searchParams.get("returnTo");
  if (returnTo) guestUrl.searchParams.set("returnTo", returnTo);
  return Response.redirect(guestUrl);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const env = await runtimeEnv();
    if (!isTrustedMutation(request, env.AUTH_BASE_URL)) {
      return Response.json({ error: "Cross-origin mutation denied" }, { status: 403 });
    }
    if (!env.DB) {
      return Response.json({ error: "Database is not configured" }, { status: 503 });
    }
    const result = await consumeGuestLink(
      env.DB,
      env,
      (await params).token,
      request,
    );
    const base = env.AUTH_BASE_URL ?? request.url;
    const requested = new URL(request.url).searchParams.get("returnTo");
    const returnTo = workspaceReturnTo(requested, result.workspaceId);
    return new Response(null, {
      status: 302,
      headers: {
        location: new URL(returnTo, base).toString(),
        "set-cookie": sessionCookie(result.session.raw, result.session.maxAge),
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Guest sign-in failed" },
      { status: 401 },
    );
  }
}
