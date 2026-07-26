"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ACCOUNT_CONTEXT_HEADER,
  accountContextHeaders,
} from "../shared/account-context";
import { GoogleSignIn } from "./google-sign-in";
import styles from "./account-deletion.module.css";

interface AccountDeletionBlocker {
  code: string;
  workspaceId?: string;
}

interface AccountDeletionPreparation {
  accountRevision: number;
  blockers: AccountDeletionBlocker[];
  custodyTransfers: Array<{
    fromUserId: string;
    toUserId: string;
    workspaceId: string;
  }>;
  globalRole: string;
  membershipCount: number;
  membershipRevision: number;
  status: string;
  userId: string;
}

interface AccountDeletionResponse {
  deletion: AccountDeletionPreparation;
}

interface AccountDeletionProps {
  accountId: string;
  onDeleted: () => Promise<void>;
  turnstileSiteKey: string | null;
}

function readError(body: unknown, fallback: string): string {
  return body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string"
    ? body.error
    : fallback;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function accountChanged(
  response: Response,
  accountId: string,
): boolean {
  const responseAccountId = response.headers.get(
    ACCOUNT_CONTEXT_HEADER,
  );
  return responseAccountId === null
    ? response.ok
    : responseAccountId !== accountId;
}

function blockerText(blocker: AccountDeletionBlocker): string {
  if (blocker.code === "FINAL_ADMIN") {
    return "This is the last active global administrator. Promote and verify another administrator before demoting this account.";
  }
  if (blocker.code === "GLOBAL_ADMIN") {
    return "Demote this account from global administrator before deleting it.";
  }
  if (blocker.code === "FINAL_WORKSPACE_OWNER") {
    return `Transfer or delete workspace ${
      blocker.workspaceId ?? "with final ownership"
    } before deleting the account.`;
  }
  if (blocker.code === "CUSTODY_TRANSFER_UNAVAILABLE") {
    return `Workspace ${
      blocker.workspaceId ?? "custody"
    } has no eligible co-owner with server capacity.`;
  }
  if (blocker.code === "ACCOUNT_INACTIVE") {
    return "Only an active account can use self-service deletion.";
  }
  return "Resolve the reported account authority before deleting.";
}

export function AccountDeletion({
  accountId,
  onDeleted,
  turnstileSiteKey,
}: AccountDeletionProps) {
  const [preparation, setPreparation] =
    useState<AccountDeletionPreparation | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [needsReauthentication, setNeedsReauthentication] =
    useState(false);

  const prepare = async () => {
    setLoading(true);
    setError("");
    setNeedsReauthentication(false);
    try {
      const response = await fetch("/api/account/deletion", {
        cache: "no-store",
        headers: accountContextHeaders(accountId),
      });
      const body = await readJson(response);
      if (accountChanged(response, accountId)) {
        throw new Error(
          "The signed-in account changed; refresh before deleting it",
        );
      }
      if (!response.ok) {
        throw new Error(
          readError(body, "Could not review account deletion"),
        );
      }
      const result = body as AccountDeletionResponse;
      if (
        !result.deletion ||
        result.deletion.userId !== accountId
      ) {
        throw new Error(
          "The server returned an invalid account deletion review",
        );
      }
      setPreparation(result.deletion);
      setConfirmation("");
    } catch (reason) {
      setPreparation(null);
      setError(
        reason instanceof Error && reason.message
          ? reason.message
          : "Could not review account deletion",
      );
    } finally {
      setLoading(false);
    }
  };

  const execute = async () => {
    if (!preparation || confirmation !== "DELETE") return;
    setDeleting(true);
    setError("");
    setNeedsReauthentication(false);
    try {
      const response = await fetch("/api/account/deletion", {
        body: JSON.stringify({
          confirmation,
          expectedAccountRevision:
            preparation.accountRevision,
          expectedMembershipRevision:
            preparation.membershipRevision,
        }),
        headers: {
          ...accountContextHeaders(accountId),
          "content-type": "application/json",
        },
        method: "POST",
      });
      const body = await readJson(response);
      if (accountChanged(response, accountId)) {
        throw new Error(
          "The signed-in account changed; refresh before deleting it",
        );
      }
      if (!response.ok) {
        const code = body &&
          typeof body === "object" &&
          "code" in body &&
          typeof body.code === "string"
          ? body.code
          : "";
        if (code === "REAUTHENTICATION_REQUIRED") {
          setNeedsReauthentication(true);
        }
        if (
          code === "ACCESS_STALE" ||
          code === "ACCOUNT_DELETION_BLOCKED"
        ) {
          setPreparation(null);
        }
        throw new Error(
          readError(body, "Could not delete the account"),
        );
      }
      await onDeleted();
    } catch (reason) {
      setError(
        reason instanceof Error && reason.message
          ? reason.message
          : "Could not delete the account",
      );
    } finally {
      setDeleting(false);
    }
  };

  const blocked = Boolean(preparation?.blockers.length);

  return <section
    aria-labelledby="account-deletion-heading"
    className={styles.panel}
  >
    <h2 id="account-deletion-heading">Delete server account</h2>
    <p>
      This immediately removes your Stowplan sign-in identities and safe
      workspace memberships, revokes sessions and unused invite links, and
      redacts retained security records. Shared history keeps a neutral
      &quot;Deleted user&quot; label.
    </p>
    <p>
      Device workspace replicas and queued work are not erased. Export
      anything you need from <Link href="/recovery">Recovery</Link>, then
      remove individual device copies from <Link href="/workspaces">
        Workspaces
      </Link> if you choose.
    </p>
    {!preparation && <button
      disabled={loading}
      onClick={() => void prepare()}
      type="button"
    >
      {loading ? "Reviewing..." : "Review account deletion"}
    </button>}
    {preparation && <>
      {blocked
        ? <div className={styles.blockers} role="alert">
            <strong>Deletion is blocked</strong>
            <ul>
              {preparation.blockers.map((blocker, index) =>
                <li key={`${blocker.code}:${blocker.workspaceId ?? index}`}>
                  {blockerText(blocker)}
                </li>
              )}
            </ul>
          </div>
        : <div className={styles.review}>
            <strong>Server changes ready for confirmation</strong>
            <ul>
              <li>
                Remove {preparation.membershipCount} workspace
                {preparation.membershipCount === 1 ? " membership" : " memberships"}
              </li>
              <li>
                Transfer {preparation.custodyTransfers.length} hosted
                workspace
                {preparation.custodyTransfers.length === 1 ? "" : "s"} to
                eligible co-owners
              </li>
              <li>Revoke every app session and unused invite link</li>
              <li>Redact the server profile and linked provider identities</li>
            </ul>
            <label>
              Type DELETE to confirm
              <input
                autoComplete="off"
                disabled={deleting}
                onChange={(event) =>
                  setConfirmation(event.target.value)}
                value={confirmation}
              />
            </label>
            <button
              className="danger"
              disabled={deleting || confirmation !== "DELETE"}
              onClick={() => void execute()}
              type="button"
            >
              {deleting ? "Deleting..." : "Delete server account now"}
            </button>
          </div>}
      <button
        disabled={loading || deleting}
        onClick={() => void prepare()}
        type="button"
      >
        Review again
      </button>
    </>}
    {error && <div className={styles.error} role="alert">
      <strong>{error}</strong>
      {needsReauthentication && turnstileSiteKey
        ? <>
            <p>
              Confirm the already-linked Google identity. Stowplan will
              return here with a fresh authentication confirmation, then
              you can review and confirm deletion again.
            </p>
            <GoogleSignIn
              intent="reauthenticate"
              returnTo="/account"
              siteKey={turnstileSiteKey}
            />
          </>
        : needsReauthentication
          ? <p>Sign out and sign in again, then repeat the deletion review.</p>
          : null}
    </div>}
  </section>;
}
