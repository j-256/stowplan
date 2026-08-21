"use client";

import Link from "next/link";
import {
  type FormEvent,
  useEffect,
  useState,
} from "react";
import {
  accountContextHeaders,
} from "../../../src/shared/account-context";
import {
  ADMIN_RECOVERY_TOKEN_HEADER,
} from "../../../src/shared/admin-recovery";

interface RecoveryUser {
  displayName: string;
  email: string;
  userId: string;
}

interface AccountStatus {
  adminAccessRequired: boolean;
  configured: boolean;
  user: RecoveryUser | null;
}

export default function AdminRecoveryPage() {
  const [account, setAccount] = useState<AccountStatus | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [token, setToken] = useState("");

  useEffect(() => {
    let active = true;
    void fetch("/api/auth/me", { cache: "no-store" })
      .then(async response => {
        const body = await response.json() as AccountStatus;
        if (!active) return;
        setAccount(body);
      })
      .catch(() => {
        if (active) {
          setError("The app session could not be checked");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const recover = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const user = account?.user;
    if (!user || pending || !token) return;
    setError("");
    setPending(true);
    try {
      const response = await fetch("/api/admin/recovery", {
        headers: accountContextHeaders(user.userId, {
          [ADMIN_RECOVERY_TOKEN_HEADER]: token,
        }),
        method: "POST",
      });
      setToken("");
      if (!response.ok) {
        throw new Error("Recovery was refused");
      }
      window.location.replace("/account?returnTo=/admin");
    } catch {
      setToken("");
      setError(
        account.adminAccessRequired
          ? "Recovery was refused. Verify the app session, Access login, and temporary recovery token before retrying."
          : "Recovery was refused. Verify the app session and temporary recovery token before retrying.",
      );
      setPending(false);
    }
  };

  return <div className="admin-recovery-page">
    <section>
      <p className="eyebrow">Break-glass administration</p>
      <h2>Recover global-admin authority</h2>
      {account?.adminAccessRequired
        ? <p>
          This path requires an existing Stowplan app session, the independent Cloudflare Access gate, and a temporary recovery token. A successful recovery promotes only the signed-in app account, retains that exact recovery session, and revokes every other active session for every global-admin account.
        </p>
        : account
          ? <p>
            This path requires an existing Stowplan app session and a temporary recovery token. A successful recovery promotes only the signed-in app account, retains that exact recovery session, and revokes every other active session for every global-admin account.
          </p>
          : <p>
            Checking recovery requirements...
          </p>}
      {!account && !error && <p>Checking the app session...</p>}
      {account && !account.configured && <p role="alert">
        Server-backed accounts are unavailable.
      </p>}
      {account?.configured && !account.user && <>
        <p role="alert">
          Sign in to the ordinary app account that should receive global-admin authority, then return here.
        </p>
        <Link href="/account?returnTo=/admin/recovery">
          Sign in to Stowplan
        </Link>
      </>}
      {account?.user && <form
        className="editor-form"
        onSubmit={recover}
      >
        <p>
          Signed in as <strong>{account.user.displayName}</strong>
          {" "}
          ({account.user.email})
        </p>
        <label>
          Temporary recovery token
          <input
            autoComplete="off"
            disabled={pending}
            name="recoveryToken"
            onChange={event => setToken(event.target.value)}
            required
            spellCheck={false}
            type="password"
            value={token}
          />
        </label>
        <button
          className="danger"
          disabled={pending || !token}
          type="submit"
        >
          {pending
            ? "Revoking other admin sessions..."
            : "Recover authority and revoke other admin sessions"}
        </button>
      </form>}
      {error && <p className="admin-error" role="alert">{error}</p>}
      <p>
        <Link href="/account">Return to account settings</Link>
      </p>
    </section>
  </div>;
}
