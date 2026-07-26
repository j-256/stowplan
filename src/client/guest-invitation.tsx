"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  guestInvitationRoleFromToken,
  guestInvitationUrl,
  INVITATION_CONTINUATION_STORAGE_KEY,
  INVITATION_OAUTH_RESUME_PATH,
  parseGuestInvitationFragment,
  type GuestInvitationFragment,
} from "../domain/app-url";
import {
  accountContextHeaders,
  responseMatchesAccount,
} from "../shared/account-context";

interface GuestInvitationProps {
  legacyReturnTo?: string;
  legacyToken?: string;
}

interface InvitationAccount {
  displayName: string;
  email: string;
  userId: string;
}

interface AccountResponse {
  configured?: boolean;
  user?: InvitationAccount | null;
}

interface ConfirmationResponse {
  code?: string;
  error?: string;
  returnTo?: string;
  workspaceId?: string;
}

function continuationPath(
  invitation: GuestInvitationFragment,
): string {
  const url = new URL(guestInvitationUrl(
    location.origin,
    invitation.token,
    invitation.returnTo,
  ));
  return `${url.pathname}${url.hash}`;
}

function rememberInvitation(
  invitation: GuestInvitationFragment,
): boolean {
  try {
    sessionStorage.setItem(
      INVITATION_CONTINUATION_STORAGE_KEY,
      continuationPath(invitation),
    );
    return true;
  } catch {
    return false;
  }
}

async function responseBody(
  response: Response,
): Promise<ConfirmationResponse> {
  try {
    return await response.json() as ConfirmationResponse;
  } catch {
    return {};
  }
}

export function GuestInvitation({
  legacyReturnTo,
  legacyToken,
}: GuestInvitationProps) {
  const [account, setAccount] =
    useState<InvitationAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");
  const [invitation, setInvitation] =
    useState<GuestInvitationFragment | null>(null);
  const accountRequest = useRef(0);

  const loadAccount = useCallback(async () => {
    const requestId = accountRequest.current + 1;
    accountRequest.current = requestId;
    setChecking(true);
    setError("");
    try {
      const response = await fetch("/api/auth/me", {
        cache: "no-store",
      });
      const body = await responseBody(response) as AccountResponse;
      if (requestId !== accountRequest.current) return;
      if (!response.ok) {
        throw new Error(
          "Stowplan could not check the signed-in account",
        );
      }
      if (!body.configured) {
        throw new Error(
          "This Stowplan server is not configured for shared workspaces",
        );
      }
      setAccount(body.user ?? null);
    } catch (reason) {
      if (requestId !== accountRequest.current) return;
      setAccount(null);
      setError(
        reason instanceof Error && reason.message
          ? reason.message
          : "Stowplan could not check the signed-in account",
      );
    } finally {
      if (requestId === accountRequest.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const fragment = parseGuestInvitationFragment(location.hash);
    const parsed = legacyToken
      ? {
          returnTo: legacyReturnTo ?? fragment?.returnTo ?? null,
          token: legacyToken,
        }
      : fragment;
    if (!parsed) {
      queueMicrotask(() => {
        if (!active) return;
        setChecking(false);
        setError(
          "This invitation URL is incomplete. Ask the workspace owner for a new link.",
        );
      });
      return () => {
        active = false;
      };
    }
    let canonical: string;
    try {
      canonical = continuationPath(parsed);
    } catch {
      queueMicrotask(() => {
        if (!active) return;
        setChecking(false);
        setError(
          "This invitation URL is invalid. Ask the workspace owner for a new link.",
        );
      });
      return () => {
        active = false;
      };
    }
    history.replaceState(history.state, "", canonical);
    queueMicrotask(() => {
      if (!active) return;
      setInvitation(parsed);
      void loadAccount();
    });
    return () => {
      active = false;
      accountRequest.current += 1;
    };
  }, [legacyReturnTo, legacyToken, loadAccount]);

  const continueToSignIn = () => {
    if (!invitation) return;
    if (!rememberInvitation(invitation)) {
      setError(
        "This browser could not retain the invitation across sign-in. Sign in in another tab, then reopen the invitation link.",
      );
      return;
    }
    location.replace(INVITATION_OAUTH_RESUME_PATH);
  };

  const accept = async () => {
    if (!invitation || busy || checking) return;
    if (!account) {
      continueToSignIn();
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/guest", {
        body: JSON.stringify({
          expectedAccountId: account.userId,
          returnTo: invitation.returnTo ?? undefined,
          token: invitation.token,
        }),
        headers: accountContextHeaders(account.userId, {
          "content-type": "application/json",
        }),
        method: "POST",
      });
      const body = await responseBody(response);
      if (response.status === 401) {
        setAccount(null);
        continueToSignIn();
        return;
      }
      if (!response.ok) {
        if (body.code === "ACCOUNT_CONTEXT_CHANGED") {
          void loadAccount();
        }
        throw new Error(
          body.error ?? "The invitation could not be accepted",
        );
      }
      if (
        !responseMatchesAccount(response, account.userId) ||
        typeof body.returnTo !== "string" ||
        typeof body.workspaceId !== "string"
      ) {
        throw new Error(
          "The server returned an invalid invitation confirmation",
        );
      }
      const destination = new URL(body.returnTo, location.origin);
      if (
        destination.origin !== location.origin ||
        !body.returnTo.startsWith("/")
      ) {
        throw new Error(
          "The server returned an unsafe invitation destination",
        );
      }
      location.replace(
        `${destination.pathname}${destination.search}${destination.hash}`,
      );
    } catch (reason) {
      setError(
        reason instanceof Error && reason.message
          ? reason.message
          : "The invitation could not be accepted",
      );
    } finally {
      setBusy(false);
    }
  };

  const offeredRole = invitation
    ? guestInvitationRoleFromToken(invitation.token)
    : null;

  return <main className="onboarding account">
    <section>
      <p className="eyebrow">Workspace invitation</p>
      <h1>Open the shared workspace?</h1>
      {invitation && (offeredRole === "editor"
        ? <p>
            <strong>Editor access offered.</strong>{" "}
            You can add, edit, move, and organize the contents of this
            workspace.
          </p>
        : offeredRole === "viewer"
          ? <p>
              <strong>Viewer access offered.</strong>{" "}
              You can browse this workspace, but you cannot change its
              contents.
            </p>
          : <p>
              This older invitation offers viewer or editor access. The
              exact access level will appear after acceptance.
            </p>)}
      <p>
        This link can enroll one signed-in account before it expires.
        Membership remains until you leave, an owner removes you, or
        the server workspace is deleted.
      </p>
      <p>
        No access is granted until you choose Accept invitation. Link
        previews and security scanners cannot consume it.
      </p>
      {checking
        ? <p role="status">Checking the signed-in account...</p>
        : account
          ? <p>
              Accepting as <strong>{account.displayName}</strong>{" "}
              ({account.email}).
            </p>
          : <p>No account is signed in yet.</p>}
      {error && <p role="alert">{error}</p>}
      <button
        className="primary"
        disabled={!invitation || checking || busy}
        onClick={() => void accept()}
        type="button"
      >
        {busy
          ? "Accepting invitation..."
          : account
            ? "Accept invitation"
            : "Sign in to accept invitation"}
      </button>
      {!checking && error && invitation &&
        <button
          disabled={busy}
          onClick={() => void loadAccount()}
          type="button"
        >
          Check sign-in again
        </button>}
      <p className="muted">
        If you did not expect this link, close this page. No access has
        been granted.
      </p>
      <Link href="/">Use Stowplan locally instead</Link>
    </section>
  </main>;
}
