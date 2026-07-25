"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ACCOUNT_CONTEXT_HEADER,
  accountContextHeaders,
} from "../shared/account-context";
import { ModalDialog } from "./modal-dialog";
import styles from "./account-sessions.module.css";

interface AccountSession {
  createdAt: string;
  current: boolean;
  expiresAt: string;
  id: string;
  ipPrefix: string | null;
  lastSeenAt: string;
  revokedAt: string | null;
  status: "active" | "expired" | "revoked";
  userAgent: string | null;
}

interface AccountSessionsResponse {
  currentSession: AccountSession;
  otherSessions: AccountSession[];
  page: {
    hasMore: boolean;
    limit: number;
    nextCursor: string | null;
  };
}

interface RevokeSessionResponse {
  current: boolean;
  revoked: true;
  revokedAt: string;
  sessionId: string;
}

interface AccountSessionsProps {
  accountId: string;
  onSignOut: () => Promise<string | null>;
}

function formatDate(value: string | null): string {
  if (!value) return "not recorded";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString()
    : "not recorded";
}

function sessionLabel(session: AccountSession): string {
  return `${session.userAgent?.trim() || "Unknown browser or device"} (${
    session.id
  })`;
}

function responseError(body: unknown, fallback: string): string {
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

function responseHasAccountMismatch(
  response: Response,
  accountId: string,
): boolean {
  const responseAccountId = response.headers.get(ACCOUNT_CONTEXT_HEADER);
  return responseAccountId === null
    ? response.ok
    : responseAccountId !== accountId;
}

export function AccountSessions({
  accountId,
  onSignOut,
}: AccountSessionsProps) {
  const [current, setCurrent] = useState<AccountSession | null>(null);
  const [otherSessions, setOtherSessions] = useState<AccountSession[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<AccountSession | null>(null);
  const [revoking, setRevoking] = useState(false);
  const requestSequence = useRef(0);

  const load = useCallback(async (cursor: string | null = null) => {
    const sequence = ++requestSequence.current;
    if (cursor) setLoadingMore(true);
    else setLoading(true);
    setError("");
    try {
      const url = new URL("/api/auth/sessions", location.origin);
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await fetch(url, {
        cache: "no-store",
        headers: accountContextHeaders(accountId),
      });
      const body = await readJson(response);
      if (responseHasAccountMismatch(response, accountId)) {
        throw new Error(
          "The signed-in account changed; refresh before managing sessions",
        );
      }
      if (!response.ok) {
        throw new Error(
          responseError(body, "Could not load your sessions"),
        );
      }
      if (sequence !== requestSequence.current) return;
      const data = body as AccountSessionsResponse;
      setCurrent(data.currentSession);
      setOtherSessions(existing =>
        cursor
          ? [
              ...existing,
              ...data.otherSessions.filter(candidate =>
                !existing.some(session => session.id === candidate.id)
              ),
            ]
          : data.otherSessions
      );
      setHasMore(Boolean(data.page?.hasMore));
      setNextCursor(data.page?.nextCursor ?? null);
    } catch (reason) {
      if (sequence !== requestSequence.current) return;
      setError(
        reason instanceof Error && reason.message
          ? reason.message
          : "Could not load your sessions",
      );
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [accountId]);

  useEffect(() => {
    queueMicrotask(() => void load());
    return () => {
      requestSequence.current += 1;
    };
  }, [load]);

  const revoke = async () => {
    if (!pending) return;
    if (pending.current) {
      setRevoking(true);
      setError("");
      setNotice("");
      const failure = await onSignOut().finally(() => {
        setRevoking(false);
      });
      if (failure) {
        setError(failure);
        return;
      }
      setPending(null);
      return;
    }
    setRevoking(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `/api/auth/sessions/${encodeURIComponent(pending.id)}`,
        {
          headers: accountContextHeaders(accountId),
          method: "DELETE",
        },
      );
      const body = await readJson(response);
      if (responseHasAccountMismatch(response, accountId)) {
        throw new Error(
          "The signed-in account changed; refresh before managing sessions",
        );
      }
      if (!response.ok) {
        throw new Error(
          responseError(body, "Could not revoke that session"),
        );
      }
      const result = body as RevokeSessionResponse;
      setOtherSessions(sessions => sessions.map(session =>
        session.id === result.sessionId
          ? {
              ...session,
              revokedAt: result.revokedAt,
              status: "revoked",
            }
          : session
      ));
      setNotice("Session revoked. Local work on that device was not deleted.");
      setPending(null);
    } catch (reason) {
      setError(
        reason instanceof Error && reason.message
          ? reason.message
          : "Could not revoke that session",
      );
      setPending(null);
    } finally {
      setRevoking(false);
    }
  };

  const sessions = current
    ? [current, ...otherSessions]
    : otherSessions;

  return <section
    aria-labelledby="account-sessions-heading"
    className={styles.panel}
  >
    <h2 id="account-sessions-heading">Your sessions</h2>
    <p>
      Review every retained server session for this account. Revoking a
      session removes its server access but does not delete that device&apos;s
      local workspace replicas or queued work.
    </p>
    {error && <div className={styles.error} role="alert">
      <strong>{error}</strong>
      <div className={styles.errorActions}>
        <button onClick={() => void load()} type="button">Retry</button>
        {!current && <button
          onClick={() => void onSignOut()}
          type="button"
        >
          Sign out this session
        </button>}
      </div>
    </div>}
    {notice && <output className={styles.notice}>{notice}</output>}
    {loading && !sessions.length
      ? <>
          <p>Loading sessions...</p>
          <button
            onClick={() => void onSignOut()}
            type="button"
          >
            Sign out this session
          </button>
        </>
      : <div className={styles.list}>
          {sessions.map(session => <article
            className={styles.session}
            key={session.id}
          >
            <header>
              <span>
                <strong>
                  {session.current ? "Current session" : "Saved session"}
                </strong>
                <small>{session.id}</small>
              </span>
              <b data-status={session.status}>{session.status}</b>
            </header>
            <dl>
              <div>
                <dt>Browser or device</dt>
                <dd>{session.userAgent ?? "Not recorded"}</dd>
              </div>
              <div>
                <dt>Coarse network</dt>
                <dd>{session.ipPrefix ?? "Not recorded"}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{formatDate(session.createdAt)}</dd>
              </div>
              <div>
                <dt>Last server activity</dt>
                <dd>{formatDate(session.lastSeenAt)}</dd>
              </div>
              <div>
                <dt>Expires</dt>
                <dd>{formatDate(session.expiresAt)}</dd>
              </div>
              {session.revokedAt && <div>
                <dt>Revoked</dt>
                <dd>{formatDate(session.revokedAt)}</dd>
              </div>}
            </dl>
            {session.status === "active" && <button
              aria-label={session.current
                ? undefined
                : `Revoke session ${sessionLabel(session)}`}
              className={session.current ? undefined : "danger"}
              onClick={() => {
                setNotice("");
                setPending(session);
              }}
              type="button"
            >
              {session.current ? "Sign out this session" : "Revoke session"}
            </button>}
          </article>)}
          {!sessions.length && !error && <p>No retained sessions were found.</p>}
        </div>}
    {hasMore && <button
      disabled={loadingMore || !nextCursor}
      onClick={() => void load(nextCursor)}
      type="button"
    >
      {loadingMore ? "Loading..." : "Load more sessions"}
    </button>}
    <small className={styles.explanation}>
      Last server activity is approximate. Device-only and offline use is not
      visible until the device reaches the server. An identity still allowed
      by the sign-in provider can create a new session; a global administrator
      can disable an abusive account.
    </small>
    <ModalDialog
      busy={revoking}
      description={<p>
        {pending?.current
          ? "This browser will lose server access and return to sign-in."
          : pending
            ? `${sessionLabel(pending)} will lose server access the next time it contacts Stowplan. Its on-device data remains intact.`
            : ""}
      </p>}
      destructive
      onClose={() => {
        if (!revoking) setPending(null);
      }}
      open={Boolean(pending)}
      title={pending?.current ? "Sign out this session?" : "Revoke this session?"}
    >
      <div className={styles.dialogActions}>
        <button
          data-dialog-initial-focus
          disabled={revoking}
          onClick={() => setPending(null)}
          type="button"
        >
          Cancel
        </button>
        <button
          className="danger"
          disabled={revoking}
          onClick={() => void revoke()}
          type="button"
        >
          {revoking
            ? "Working..."
            : pending?.current
              ? "Sign out"
              : "Revoke session"}
        </button>
      </div>
    </ModalDialog>
  </section>;
}
