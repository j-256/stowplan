"use client";

import {
  Copy,
  ExternalLink,
  Link2,
  LogOut,
  Share2,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import styles from "./account.module.css";

interface User {
  displayName: string;
  email: string;
  expiresAt: string;
  globalRole: string;
}

interface MeResponse {
  configured: boolean;
  providers: string[];
  user: User | null;
}

interface GuestResponse {
  error?: string;
  expiresAt?: string;
  url?: string;
}

interface GuestLink {
  expiresAt: string;
  url: string;
}

interface NavigationState {
  ready: boolean;
  returnTo: string;
  workspace: string | null;
}

const ACCESS_LOGOUT_PATH = "/cdn-cgi/access/logout";
const DEFAULT_RETURN_TO = "/";
const INITIAL_NAVIGATION: NavigationState = {
  ready: false,
  returnTo: DEFAULT_RETURN_TO,
  workspace: null,
};
const MAX_RETURN_TO_DECODE_PASSES = 4;
const RETURN_TO_ORIGIN = "https://stowplan.invalid";
const SERVER_NAVIGATION_HREF = "";

function actionError(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message) return fallback;
  if (
    error.message === fallback ||
    error.message.startsWith(`${fallback}:`)
  ) {
    return error.message;
  }
  return `${fallback}: ${error.message}`;
}

async function readResponse<T>(
  response: Response,
  fallback: string,
): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      `${fallback}: the server returned an empty or unreadable response`,
    );
  }
  if (!response.ok) {
    const error =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : fallback;
    throw new Error(error);
  }
  return body as T;
}

async function fetchAccount(): Promise<{
  accessSignedIn: boolean;
  account: MeResponse;
}> {
  const statusError = "Could not check account status";
  let response = await fetch("/api/auth/me", { cache: "no-store" });
  let account = await readResponse<MeResponse>(response, statusError);
  let accessSignedIn = false;
  if (!account.user && account.providers?.includes("cloudflare-access")) {
    const access = await fetch("/api/auth/access", { method: "POST" });
    await readResponse<{ user: User }>(
      access,
      "Cloudflare Access could not create an app session",
    );
    response = await fetch("/api/auth/me", { cache: "no-store" });
    account = await readResponse<MeResponse>(response, statusError);
    if (!account.user) {
      throw new Error(
        "Cloudflare Access signed in, but the app session was not created",
      );
    }
    accessSignedIn = true;
  }
  return { accessSignedIn, account };
}

function navigationHref(): string {
  return typeof location === "undefined"
    ? SERVER_NAVIGATION_HREF
    : location.href;
}

function subscribeNavigation(change: () => void): () => void {
  addEventListener("popstate", change);
  return () => removeEventListener("popstate", change);
}

function safeReturnTo(requested: string | null): string {
  if (!requested) return DEFAULT_RETURN_TO;
  try {
    const resolved = new URL(requested, RETURN_TO_ORIGIN);
    if (resolved.origin !== RETURN_TO_ORIGIN) return DEFAULT_RETURN_TO;
    const localPath = `${resolved.pathname}${resolved.search}${resolved.hash}`;
    let safetyPath = resolved.pathname;
    for (let pass = 0; pass < MAX_RETURN_TO_DECODE_PASSES; pass += 1) {
      const decodedPath = decodeURIComponent(safetyPath);
      if (decodedPath === safetyPath) return localPath;
      const decoded = new URL(decodedPath, RETURN_TO_ORIGIN);
      if (decoded.origin !== RETURN_TO_ORIGIN) return DEFAULT_RETURN_TO;
      if (decoded.pathname === safetyPath) return localPath;
      safetyPath = decoded.pathname;
    }
    return DEFAULT_RETURN_TO;
  } catch {
    return DEFAULT_RETURN_TO;
  }
}

function readNavigation(href: string): NavigationState {
  if (!href) return INITIAL_NAVIGATION;
  const search = new URL(href).searchParams;
  return {
    ready: true,
    returnTo: safeReturnTo(search.get("returnTo")),
    workspace: search.get("workspace"),
  };
}

export default function Account() {
  const [configured, setConfigured] = useState(false);
  const [creatingGuest, setCreatingGuest] = useState(false);
  const [guestLink, setGuestLink] = useState<GuestLink | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [providers, setProviders] = useState<string[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const href = useSyncExternalStore(
    subscribeNavigation,
    navigationHref,
    () => SERVER_NAVIGATION_HREF,
  );
  const navigation = readNavigation(href);
  const { ready: navigationReady, returnTo, workspace } = navigation;

  useEffect(() => {
    if (!navigationReady) return;
    let active = true;
    void fetchAccount().then(({ accessSignedIn, account }) => {
      if (!active) return;
      setUser(account.user);
      setConfigured(account.configured);
      setProviders(account.providers ?? []);
      if (accessSignedIn) {
        setMessage("Signed in. Returning to your workspace so its backup can start.");
        location.replace(returnTo);
        return;
      }
      setLoaded(true);
    }).catch((error) => {
      if (!active) return;
      setMessage(actionError(error, "Could not check account status"));
      setLoaded(true);
    });
    return () => {
      active = false;
    };
  }, [navigationReady, returnTo]);

  const createGuestLink = async () => {
    setGuestLink(null);
    setMessage("");
    if (!workspace) {
      setMessage("Open Account from a workspace before creating a guest link.");
      return;
    }
    setCreatingGuest(true);
    try {
      const response = await fetch("/api/admin/guest-links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hours: 24,
          returnTo,
          role: "editor",
          workspaceId: workspace,
        }),
      });
      const body = await readResponse<GuestResponse>(
        response,
        "Could not create a guest link",
      );
      if (!body.url || !body.expiresAt) {
        throw new Error(
          "Could not create a guest link: the server did not return the link",
        );
      }
      setGuestLink({ expiresAt: body.expiresAt, url: body.url });
      setMessage("Guest link created. It can be used once during the next 24 hours.");
    } catch (error) {
      setMessage(actionError(error, "Could not create a guest link"));
    } finally {
      setCreatingGuest(false);
    }
  };

  const copyGuestLink = async () => {
    if (!guestLink) {
      setMessage("Create a guest link before copying it.");
      return;
    }
    try {
      await navigator.clipboard.writeText(guestLink.url);
      setMessage("Guest link copied.");
    } catch {
      setMessage("Could not copy automatically. Select the link below and copy it.");
    }
  };

  const shareGuestLink = async () => {
    if (!guestLink) {
      setMessage("Create a guest link before sharing it.");
      return;
    }
    setMessage("");
    try {
      await navigator.share({
        text: "Open this shared Stowplan workspace",
        title: "Stowplan guest access",
        url: guestLink.url,
      });
      setMessage("Guest link shared.");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      setMessage("Could not open the share sheet. Copy the guest link instead.");
    }
  };

  const signOut = async () => {
    setMessage("");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        setMessage(body?.error ?? "Could not sign out");
        return;
      }
      if (providers.includes("cloudflare-access")) {
        location.assign(ACCESS_LOGOUT_PATH);
        return;
      }
      location.reload();
    } catch (error) {
      setMessage(actionError(error, "Could not sign out"));
    }
  };

  const developmentSignIn = async (data: FormData) => {
    setMessage("");
    try {
      const response = await fetch("/api/auth/dev", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: String(data.get("email")),
          name: String(data.get("name")),
        }),
      });
      await readResponse<{ user: User }>(
        response,
        "Development sign-in failed",
      );
      location.href = returnTo;
    } catch (error) {
      setMessage(actionError(error, "Development sign-in failed"));
    }
  };
  const oauthReturn = encodeURIComponent(returnTo);

  return <main className="onboarding account">
    <section>
      <p className="eyebrow">Identity & backup</p>
      <h1>{user ? `Signed in as ${user.displayName}` : "Connect Stowplan"}</h1>
      {!loaded
        ? <p>Checking server configuration...</p>
        : user
          ? <>
              <p className={styles.identity}>
                <ShieldCheck />
                <span>
                  <strong>{user.email}</strong>
                  <small>{user.globalRole} account, session expires {new Date(user.expiresAt).toLocaleString()}</small>
                </span>
              </p>
              <section className={styles.guestPanel}>
                <h2>Invite a collaborator</h2>
                <p>Create a one-time editor link that opens this exact workspace view. The link expires after 24 hours.</p>
                <button
                  className="primary"
                  disabled={!workspace || creatingGuest}
                  onClick={() => void createGuestLink()}
                >
                  <Link2 />
                  {creatingGuest ? "Creating guest link..." : "Create guest link"}
                </button>
                {!workspace && <small>Return to a workspace and open Account from Settings to create an invite.</small>}
                {guestLink && <div className={styles.guestResult}>
                  <label>
                    One-time guest link
                    <input readOnly value={guestLink.url} onFocus={(event) => event.currentTarget.select()} />
                  </label>
                  <small>Expires {new Date(guestLink.expiresAt).toLocaleString()}</small>
                  <div className={styles.guestActions}>
                    <button onClick={() => void copyGuestLink()}><Copy /> Copy</button>
                    {typeof navigator !== "undefined" && typeof navigator.share === "function" &&
                      <button onClick={() => void shareGuestLink()}><Share2 /> Share</button>}
                    <a href={guestLink.url} target="_blank" rel="noreferrer"><ExternalLink /> Open</a>
                  </div>
                </div>}
              </section>
              <div className={styles.accountActions}>
                <button onClick={() => void signOut()}><LogOut /> Sign out</button>
                {user.globalRole === "admin" && <Link href="/admin">Open admin control panel</Link>}
              </div>
            </>
          : <>
              <p>{configured
                ? "Sign in to back up this device, administer the server, and share authorized workspaces."
                : "This deployment has no server database. Local organizing remains fully available; use the Node + SQLite or Cloudflare + D1 runbook to test server features."}</p>
              {providers.includes("development") && <form action={developmentSignIn} className="dev-signin">
                <h2>Local development sign-in</h2>
                <label>Name<input name="name" defaultValue="Local Owner" required /></label>
                <label>Email<input name="email" type="email" defaultValue="owner@example.test" required /></label>
                <button className="primary">Sign in locally</button>
                <small>Use <code>owner@example.test</code> for deterministic local admin access, or add another address to <code>AUTH_ADMIN_EMAILS</code> before starting the server. Sign-in is immediate and does not send a code. Never enable this provider on a public deployment.</small>
              </form>}
              {providers.includes("google") &&
                <a className="auth-button" href={`/api/auth/google/start?returnTo=${oauthReturn}`}>Continue with Google</a>}
              {providers.includes("github") &&
                <a className="auth-button" href={`/api/auth/github/start?returnTo=${oauthReturn}`}>Continue with GitHub</a>}
              {configured && !providers.length &&
                <p className="muted">The database is ready, but no sign-in provider is enabled. Local development sign-in requires <code>AUTH_DEV_ENABLED=true</code>; it creates a session immediately and never sends an email code.</p>}
              <p className="muted">Cloudflare Access can sign you in automatically when enabled by the operator. Guest links are one-time and short-lived.</p>
            </>}
      {message && <output aria-live="polite">{message}</output>}
      <Link href={returnTo}>Back to Stowplan</Link>
    </section>
  </main>;
}
