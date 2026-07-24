import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Accept guest access · Stowplan",
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
  return <main className="onboarding account"><section>
    <p className="eyebrow">One-time guest access</p>
    <h1>Open the shared workspace?</h1>
    <p>This link creates a short-lived guest session on this device. It is used only after you confirm, so link previews and security scanners cannot consume it.</p>
    <form action={action} method="post">
      <button className="primary" type="submit">Open shared workspace</button>
    </form>
    <p className="muted">If you did not expect this link, close this page. No access has been granted yet.</p>
    <Link href="/">Use Stowplan locally instead</Link>
  </section></main>;
}
