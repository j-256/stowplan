import type {
  D1DatabaseLike,
  D1QueryResultLike,
  D1ResultLike,
  D1StatementLike,
} from "../adapters/d1-snapshot-store";
import { newId, nowIso } from "../domain/factories";
import { ApiProblem } from "./api-problem";
import { safeAuditDetailJson } from "./audit-detail";

interface Statement extends D1StatementLike {
  all<T>(): Promise<D1QueryResultLike<T>>;
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
}

interface SessionDatabase extends D1DatabaseLike {
  prepare(query: string): Statement;
}

export interface AccountSessionPrincipal {
  sessionId: string;
  userId: string;
}

interface SessionCursor {
  createdAt: string;
  id: string;
  kind: "account-sessions";
  userId: string;
  version: 1;
}

interface SessionRow {
  created_at: string;
  expires_at: string;
  ip_prefix: string | null;
  last_seen_at: string;
  revoked_at: string | null;
  session_id: string;
  user_agent: string | null;
}

export type AccountSessionStatus = "active" | "expired" | "revoked";

export interface AccountSessionSummary {
  createdAt: string;
  current: boolean;
  expiresAt: string;
  id: string;
  ipPrefix: string | null;
  lastSeenAt: string;
  revokedAt: string | null;
  status: AccountSessionStatus;
  userAgent: string | null;
}

const DEFAULT_SESSION_PAGE_LIMIT = 25;
const MAXIMUM_CURSOR_LENGTH = 1_024;
const MAXIMUM_SESSION_ID_LENGTH = 128;
const MAXIMUM_SESSION_PAGE_LIMIT = 50;
const MAXIMUM_USER_AGENT_LENGTH = 300;

function databaseLike(database: D1DatabaseLike): SessionDatabase {
  return database as SessionDatabase;
}

function resultChanges(result: D1ResultLike | undefined): number {
  return result?.success ? result.meta?.changes ?? 0 : 0;
}

function boundedPageLimit(searchParams: URLSearchParams): number {
  const raw = searchParams.get("limit");
  if (raw === null) return DEFAULT_SESSION_PAGE_LIMIT;
  if (!/^\d+$/u.test(raw)) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      `limit must be an integer from 1 through ${MAXIMUM_SESSION_PAGE_LIMIT}`,
      400,
    );
  }
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value)
    || value < 1
    || value > MAXIMUM_SESSION_PAGE_LIMIT
  ) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      `limit must be an integer from 1 through ${MAXIMUM_SESSION_PAGE_LIMIT}`,
      400,
    );
  }
  return value;
}

function encodeBytesBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function encodeCursor(value: SessionCursor): string {
  return encodeBytesBase64Url(
    new TextEncoder().encode(JSON.stringify(value)),
  );
}

function decodeBase64Url(value: string): string {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(`${normalized}${padding}`);
  const bytes = Uint8Array.from(
    binary,
    character => character.charCodeAt(0),
  );
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function decodedCursor(
  raw: string | null,
  userId: string,
): SessionCursor | null {
  if (raw === null) return null;
  if (!raw || raw.length > MAXIMUM_CURSOR_LENGTH) {
    throw new ApiProblem("INVALID_REQUEST", "The cursor is invalid", 400);
  }
  let value: unknown;
  try {
    value = JSON.parse(decodeBase64Url(raw)) as unknown;
  } catch {
    throw new ApiProblem("INVALID_REQUEST", "The cursor is invalid", 400);
  }
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !("version" in value)
    || value.version !== 1
    || !("kind" in value)
    || value.kind !== "account-sessions"
    || !("userId" in value)
    || value.userId !== userId
    || !("createdAt" in value)
    || typeof value.createdAt !== "string"
    || !value.createdAt
    || !("id" in value)
    || typeof value.id !== "string"
    || !value.id
  ) {
    throw new ApiProblem("INVALID_REQUEST", "The cursor is invalid", 400);
  }
  return value as SessionCursor;
}

function safeUserAgent(value: string | null): string | null {
  const normalized = value
    ?.replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim()
    .slice(0, MAXIMUM_USER_AGENT_LENGTH);
  return normalized || null;
}

function safeIpv4Prefix(value: string): string | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.0\/24$/u.exec(value);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every(octet => octet >= 0 && octet <= 255)
    ? value
    : null;
}

function safeIpPrefix(value: string | null): string | null {
  if (!value) return null;
  const ipv4 = safeIpv4Prefix(value);
  if (ipv4) return ipv4;
  return /^(?:[0-9a-f]{1,4}:){2}[0-9a-f]{1,4}::\/48$/iu.test(value)
    ? value.toLowerCase()
    : null;
}

function sessionStatus(
  row: SessionRow,
  now: string,
): AccountSessionStatus {
  if (row.revoked_at) return "revoked";
  return row.expires_at <= now ? "expired" : "active";
}

function sessionSummary(
  row: SessionRow,
  now: string,
  current: boolean,
): AccountSessionSummary {
  return {
    createdAt: row.created_at,
    current,
    expiresAt: row.expires_at,
    id: row.session_id,
    ipPrefix: safeIpPrefix(row.ip_prefix),
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    status: sessionStatus(row, now),
    userAgent: safeUserAgent(row.user_agent),
  };
}

export function requireAccountSessionId(value: string): string {
  if (!value || value.length > MAXIMUM_SESSION_ID_LENGTH) {
    throw new ApiProblem(
      "INVALID_REQUEST",
      "The session ID is invalid",
      400,
    );
  }
  return value;
}

export async function listAccountSessions(
  database: D1DatabaseLike,
  principal: AccountSessionPrincipal,
  searchParams: URLSearchParams,
) {
  const db = databaseLike(database);
  const limit = boundedPageLimit(searchParams);
  const cursor = decodedCursor(
    searchParams.get("cursor"),
    principal.userId,
  );
  const now = nowIso();
  const values: unknown[] = [
    principal.userId,
    principal.sessionId,
  ];
  let cursorPredicate = "";
  if (cursor) {
    cursorPredicate =
      "AND (created_at<? OR (created_at=? AND session_id<?))";
    values.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  values.push(limit + 1);
  const [currentSession, otherSessions] = await Promise.all([
    db.prepare(
      `SELECT session_id,created_at,expires_at,last_seen_at,revoked_at,
              user_agent,ip_prefix
       FROM sessions
       WHERE user_id=? AND session_id=?
         AND revoked_at IS NULL AND expires_at>?`,
    ).bind(
      principal.userId,
      principal.sessionId,
      now,
    ).first<SessionRow>(),
    db.prepare(
      `SELECT session_id,created_at,expires_at,last_seen_at,revoked_at,
              user_agent,ip_prefix
       FROM sessions
       WHERE user_id=? AND session_id<>?
       ${cursorPredicate}
       ORDER BY created_at DESC,session_id DESC
       LIMIT ?`,
    ).bind(...values).all<SessionRow>(),
  ]);
  if (!currentSession) {
    throw new ApiProblem(
      "AUTHENTICATION_REQUIRED",
      "Authentication required",
      401,
    );
  }
  const hasMore = otherSessions.results.length > limit;
  const visible = otherSessions.results.slice(0, limit);
  const finalSession = visible.at(-1);
  return {
    currentSession: sessionSummary(currentSession, now, true),
    otherSessions: visible.map(row => sessionSummary(row, now, false)),
    page: {
      hasMore,
      limit,
      nextCursor: hasMore && finalSession
        ? encodeCursor({
            createdAt: finalSession.created_at,
            id: finalSession.session_id,
            kind: "account-sessions",
            userId: principal.userId,
            version: 1,
          })
        : null,
    },
  };
}

export async function revokeAccountSession(
  database: D1DatabaseLike,
  principal: AccountSessionPrincipal,
  requestedSessionId: string,
  source: "account" | "logout" = "account",
) {
  const db = databaseLike(database);
  const sessionId = requireAccountSessionId(requestedSessionId);
  const now = nowIso();
  const [, auditResult] = await db.batch([
    db.prepare(
      `UPDATE sessions
       SET revoked_at=?
       WHERE session_id=?
         AND user_id=?
         AND revoked_at IS NULL
         AND expires_at>?
         AND EXISTS (
           SELECT 1
           FROM sessions actor_session
           JOIN users actor_user
             ON actor_user.user_id=actor_session.user_id
            AND actor_user.status='active'
           WHERE actor_session.session_id=?
             AND actor_session.user_id=?
             AND actor_session.revoked_at IS NULL
             AND actor_session.expires_at>?
         )`,
    ).bind(
      now,
      sessionId,
      principal.userId,
      now,
      principal.sessionId,
      principal.userId,
      now,
    ),
    db.prepare(
      `INSERT INTO auth_audit_events(
         event_id,actor_user_id,action,target_type,target_id,detail_json,
         created_at
       )
       SELECT ?,?,'session.revoke','session',?,?,?
       WHERE changes()=1`,
    ).bind(
      newId("aud"),
      principal.userId,
      sessionId,
      safeAuditDetailJson("session.revoke", { source }),
      now,
    ),
  ]);
  if (resultChanges(auditResult) === 1) {
    return {
      current: sessionId === principal.sessionId,
      revoked: true as const,
      revokedAt: now,
      sessionId,
    };
  }
  const current = await db.prepare(
    `SELECT created_at,expires_at,last_seen_at,revoked_at,user_agent,
            ip_prefix,session_id
     FROM sessions
     WHERE session_id=? AND user_id=?`,
  ).bind(sessionId, principal.userId).first<SessionRow>();
  if (!current) {
    throw new ApiProblem(
      "NOT_FOUND_OR_INACCESSIBLE",
      "The session was not found or is not accessible",
      404,
    );
  }
  throw new ApiProblem(
    "INVALID_REQUEST",
    current.revoked_at
      ? "The session is already revoked"
      : current.expires_at <= now
        ? "The session has expired"
        : "The session is no longer active",
    409,
    { status: sessionStatus(current, now) },
  );
}
