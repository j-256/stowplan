"use client";

import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  GUEST_INVITATION_PATH,
  INVITATION_CONTINUATION_STORAGE_KEY,
  INVITATION_OAUTH_RESUME_PATH,
  workspacePath,
} from "../../src/domain/app-url";
import {
  clearActiveServerWorkspaceCatalogAccount,
} from "../../src/client/local-replica";
import {
  broadcastAccountChange,
} from "../../src/client/account-channel";
import { AccountDeletion } from "../../src/client/account-deletion";
import { AccountSessions } from "../../src/client/account-sessions";
import { GoogleSignIn } from "../../src/client/google-sign-in";
import styles from "./account.module.css";

interface User {
  displayName: string;
  email: string;
  expiresAt: string;
  globalRole: string;
  userId: string;
}

interface MeResponse {
  accessMigrationAvailable: boolean;
  configured: boolean;
  hasLinkedGoogleIdentity: boolean;
  providers: string[];
  turnstileSiteKey: string | null;
  user: User | null;
}

interface NavigationState {
  ready: boolean;
  resumeInvitation: boolean;
  returnTo: string;
  workspace: string | null;
}

const DEFAULT_RETURN_TO = "/";
const INITIAL_NAVIGATION: NavigationState = {
  ready: false,
  resumeInvitation: false,
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

async function fetchAccount(): Promise<MeResponse> {
  const statusError = "Could not check account status";
  const response = await fetch("/api/auth/me", { cache: "no-store" });
  return readResponse<MeResponse>(response, statusError);
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
    resumeInvitation: search.get("resume") === "invitation",
    returnTo: safeReturnTo(search.get("returnTo")),
    workspace: search.get("workspace"),
  };
}

function isInvitationReturnTo(value: string): boolean {
  try {
    const path = new URL(value, RETURN_TO_ORIGIN).pathname;
    return path === GUEST_INVITATION_PATH ||
      path.startsWith(`${GUEST_INVITATION_PATH}/`);
  } catch {
    return false;
  }
}

function rememberInvitationReturnTo(value: string): boolean {
  if (!isInvitationReturnTo(value)) return false;
  try {
    sessionStorage.setItem(
      INVITATION_CONTINUATION_STORAGE_KEY,
      value,
    );
    return true;
  } catch {
    return false;
  }
}

function takeInvitationReturnTo(): string | null {
  try {
    const saved = sessionStorage.getItem(
      INVITATION_CONTINUATION_STORAGE_KEY,
    );
    if (!saved || !isInvitationReturnTo(saved)) return null;
    sessionStorage.removeItem(
      INVITATION_CONTINUATION_STORAGE_KEY,
    );
    return saved;
  } catch {
    return null;
  }
}

export default function Account() {
  const [
    accessMigrationAvailable,
    setAccessMigrationAvailable,
  ] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [
    hasLinkedGoogleIdentity,
    setHasLinkedGoogleIdentity,
  ] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [providers, setProviders] = useState<string[]>([]);
  const [turnstileSiteKey, setTurnstileSiteKey] =
    useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const href = useSyncExternalStore(
    subscribeNavigation,
    navigationHref,
    () => SERVER_NAVIGATION_HREF,
  );
  const navigation = readNavigation(href);
  const {
    ready: navigationReady,
    resumeInvitation,
    returnTo,
    workspace,
  } = navigation;
  const invitationReturn = isInvitationReturnTo(returnTo);

  useEffect(() => {
    if (!navigationReady) return;
    let active = true;
    if (invitationReturn && !rememberInvitationReturnTo(returnTo)) {
      queueMicrotask(() => {
        if (active) {
          setMessage(
            "This browser could not retain the invitation across sign-in. Sign in in another tab, then return to the invitation page.",
          );
        }
      });
    }
    void fetchAccount().then((account) => {
      if (!active) return;
      setUser(account.user);
      setAccessMigrationAvailable(
        account.accessMigrationAvailable ?? false,
      );
      setConfigured(account.configured);
      setHasLinkedGoogleIdentity(
        account.hasLinkedGoogleIdentity === true,
      );
      setProviders(account.providers ?? []);
      setTurnstileSiteKey(account.turnstileSiteKey ?? null);
      if (account.user) broadcastAccountChange();
      const invitationDestination = account.user
        ? resumeInvitation
          ? takeInvitationReturnTo()
          : invitationReturn
            ? returnTo
            : null
        : null;
      if (account.user && invitationDestination) {
        setMessage("Signed in. Returning to the invitation.");
        location.replace(invitationDestination);
        return;
      }
      if (account.user && resumeInvitation) {
        setMessage(
          "The invitation could not be recovered in this tab. Open the original invitation URL again.",
        );
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
  }, [
    invitationReturn,
    navigationReady,
    resumeInvitation,
    returnTo,
  ]);

  const signOut = async (): Promise<string | null> => {
    setMessage("");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        const failure = body?.error ?? "Could not sign out";
        setMessage(failure);
        return failure;
      }
      await clearActiveServerWorkspaceCatalogAccount().catch(() => undefined);
      broadcastAccountChange();
      location.reload();
      return null;
    } catch (error) {
      const failure = actionError(error, "Could not sign out");
      setMessage(failure);
      return failure;
    }
  };

  const accountDeleted = async (): Promise<void> => {
    await clearActiveServerWorkspaceCatalogAccount()
      .catch(() => undefined);
    broadcastAccountChange();
    location.replace("/account");
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
      broadcastAccountChange();
      location.replace(resumeInvitation
        ? takeInvitationReturnTo() ?? DEFAULT_RETURN_TO
        : returnTo);
    } catch (error) {
      setMessage(actionError(error, "Development sign-in failed"));
    }
  };
  const accessMigrationSignIn = async () => {
    setMessage("");
    try {
      const response = await fetch("/api/auth/access", {
        method: "POST",
      });
      await readResponse<{ user: User }>(
        response,
        "Existing account migration failed",
      );
      broadcastAccountChange();
      location.replace(resumeInvitation
        ? takeInvitationReturnTo() ?? DEFAULT_RETURN_TO
        : returnTo);
    } catch (error) {
      setMessage(
        actionError(error, "Existing account migration failed"),
      );
    }
  };
  const oauthReturn = (
    invitationReturn || resumeInvitation
      ? INVITATION_OAUTH_RESUME_PATH
      : returnTo
  );

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
              <AccountSessions
                accountId={user.userId}
                onSignOut={signOut}
              />
              <AccountDeletion
                accountId={user.userId}
                onDeleted={accountDeleted}
                turnstileSiteKey={turnstileSiteKey}
              />
              <section className={styles.guestPanel}>
                <h2>Workspace collaboration</h2>
                <p>Member roles, invite-link enrollment expiry and revocation, leaving, and server deletion are managed from the workspace access page.</p>
                {workspace
                  ? <Link href={workspacePath({
                      view: "access",
                      workspaceId: workspace,
                    })}>
                      Manage workspace access
                    </Link>
                  : <small>Open Account from a workspace to reach its access page.</small>}
              </section>
              <div className={styles.accountActions}>
                {user.globalRole === "admin" && <Link href="/admin">Open admin control panel</Link>}
                {providers.includes("google") && turnstileSiteKey &&
                  <GoogleSignIn
                    hasLinkedGoogleIdentity={
                      hasLinkedGoogleIdentity
                    }
                    intent="link"
                    returnTo={returnTo}
                    siteKey={turnstileSiteKey}
                  />}
              </div>
            </>
          : <>
              <p>{configured
                ? "Sign in to back up this device and collaborate in workspaces where your account is a member. Global administration requires a separate database role and Cloudflare Access."
                : "This deployment has no server database. Local organizing remains fully available; use the Node + SQLite or Cloudflare + D1 runbook to test server features."}</p>
              {providers.includes("development") && <form action={developmentSignIn} className="dev-signin">
                <h2>Local development sign-in</h2>
                <label>Name<input name="name" defaultValue="Local Owner" required /></label>
                <label>Email<input name="email" type="email" defaultValue="owner@example.test" required /></label>
                <button className="primary">Sign in locally</button>
                <small>Create any synthetic <code>@example.test</code> persona you need. Sign-in is immediate and does not send a code. Public production hosts refuse this provider even if it is accidentally enabled.</small>
              </form>}
              {accessMigrationAvailable &&
                <section className={styles.guestPanel}>
                  <h2>Existing account migration</h2>
                  <p>Use your temporary Cloudflare Access identity to recover an existing Stowplan account, then link Google below. This cannot create an account or grant authority.</p>
                  <button
                    className="auth-button"
                    onClick={accessMigrationSignIn}
                    type="button"
                  >
                    Recover existing account
                  </button>
                </section>}
              {providers.includes("google") && turnstileSiteKey &&
                <GoogleSignIn
                  returnTo={oauthReturn}
                  siteKey={turnstileSiteKey}
                />}
              {configured && !providers.length &&
                <p className="muted">The database is ready, but no sign-in provider is enabled. Local development sign-in requires <code>AUTH_DEV_ENABLED=true</code>; it creates a session immediately and never sends an email code.</p>}
              <p className="muted">Invite URLs expire and can be redeemed once; the resulting workspace membership remains until the member leaves or is removed.</p>
            </>}
      {message && <output aria-live="polite">{message}</output>}
      <Link href={returnTo}>Back to Stowplan</Link>
    </section>
  </main>;
}
