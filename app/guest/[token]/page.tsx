import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { authenticate } from "../../../src/server/auth";
import { runtimeEnv } from "../../../src/server/runtime";

export const metadata: Metadata = {
  title: "Accept workspace invitation · Stowplan",
  robots: { index: false, follow: false },
};

export default async function GuestAccess({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ returnTo?: string | string[] }> }) {
  const { token } = await params;
  const requestedReturn = (await searchParams).returnTo;
  const returnTo = Array.isArray(requestedReturn)
    ? requestedReturn[0]
    : requestedReturn;
  const action = returnTo
    ? `/api/auth/guest/${encodeURIComponent(token)}?returnTo=${encodeURIComponent(returnTo)}`
    : `/api/auth/guest/${encodeURIComponent(token)}`;
  const env = await runtimeEnv();
  const user = env.DB
    ? await authenticate(
        env.DB,
        new Request("https://stowplan.invalid/guest", {
          headers: await headers(),
        }),
      )
    : null;
  return <main className="onboarding account"><section>
    <p className="eyebrow">Workspace invitation</p>
    <h1>Open the shared workspace?</h1>
    <p>This link can enroll one signed-in account as a viewer or editor before it expires. The workspace then uses its ordinary URL, and membership remains until you leave, an owner removes you, or the server workspace is deleted.</p>
    <p>You will be asked to sign in first if needed. The invitation is used only after you return and confirm, so previews and security scanners cannot consume it.</p>
    {user
      ? <p>Accepting as <strong>{user.displayName}</strong> ({user.email}).</p>
      : <p>No account is signed in yet.</p>}
    <form action={action} method="post">
      {user &&
        <input
          name="expectedAccountId"
          type="hidden"
          value={user.userId}
        />}
      <button className="primary" type="submit">Accept invitation</button>
    </form>
    <p className="muted">If you did not expect this link, close this page. No access has been granted yet.</p>
    <Link href="/">Use Stowplan locally instead</Link>
  </section></main>;
}
