import { createRemoteJWKSet, jwtVerify } from "jose";
import type {
  D1DatabaseLike,
  D1ResultLike,
  D1StatementLike,
} from "../adapters/d1-snapshot-store";
import { newId, nowIso } from "../domain/factories";
import {
  API_QUOTAS,
  GUEST_LINK_EXPIRY_HOURS,
} from "../shared/api-quotas";
import { PUBLIC_LAUNCH_LIMITS } from "../shared/governance-policy";
import {
  OAUTH_TURNSTILE_ACTION,
  type SessionAuthenticationProvider,
} from "../shared/authentication";
import { revokeAccountSession } from "./account-sessions";
import {
  accountCreationRefusal,
  assertIdentityNotBanned,
  guestLinkCreationRefusal,
  guestRedemptionRefusal,
  identityEnforcementDigest,
  membershipAdmissionRefusal,
  sessionIssuanceOutcome,
  sessionIssuanceRefusal,
  trimTerminalSessions,
  workspaceAllocationRefusal,
} from "./account-governance";
import { ApiProblem } from "./api-problem";
import { safeAuditDetailJson } from "./audit-detail";
import { QuotaExceededError } from "./quotas";
import type { RuntimeEnv } from "./runtime";

interface Statement extends D1StatementLike {
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
}
interface AuthDb extends D1DatabaseLike {
  prepare(query: string): Statement;
}
export interface SessionUser { userId:string; email:string; displayName:string; globalRole:"admin"|"user"; expiresAt:string }
export interface AuthenticatedSessionUser extends SessionUser {
  sessionId: string;
}
export interface ProviderProfile { provider:string; subject:string; email:string; displayName:string }

export const AUTH_CLEANUP_BATCH_SIZE = 64;
export const SESSION_ACTIVITY_TOUCH_INTERVAL_MS = 5 * 60 * 1_000;
const GUEST_LINK_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const OAUTH_STATE_RETENTION_MS = 24 * 60 * 60 * 1_000;
const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAXIMUM_SESSION_TTL_SECONDS = 90 * 24 * 60 * 60;
const MINIMUM_SESSION_TTL_SECONDS = 60 * 60;
const IPV4_OCTET_COUNT = 4;
const IPV4_PREFIX_BITS = 24;
const IPV4_PREFIX_OCTET_COUNT = 3;
const IPV6_HEXTET_COUNT = 8;
const IPV6_PREFIX_BITS = 48;
const IPV6_PREFIX_HEXTET_COUNT = 3;
const DEVELOPMENT_AUTHENTICATION_BLOCKED_HOSTS = new Set([
  "stowplan.jklein.dev",
]);
const MINIMUM_IDENTITY_DIGEST_KEY_BYTES = 32;
const TURNSTILE_TEST_SECRET_KEYS = new Set([
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
]);
const TURNSTILE_TEST_SITE_KEYS = new Set([
  "1x00000000000000000000AA",
  "1x00000000000000000000BB",
  "2x00000000000000000000AB",
  "2x00000000000000000000BB",
  "3x00000000000000000000FF",
]);
const SESSION_COOKIE_NAME = "__Host-stowplan_session";
const RECENT_IDENTITY_LINK_AUTHENTICATION_MS = 10 * 60 * 1_000;

function bytes(size=32){const b=new Uint8Array(size);crypto.getRandomValues(b);return b}
function token(size=32){return Array.from(bytes(size),b=>b.toString(16).padStart(2,"0")).join("")}
async function hash(value:string){const encoded=new TextEncoder().encode(value);return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",encoded)),b=>b.toString(16).padStart(2,"0")).join("")}
function normalize(email:string){return email.trim().toLowerCase()}
export function identityEnforcementConfigured(
  env: RuntimeEnv,
): env is RuntimeEnv & { AUTH_IDENTITY_DIGEST_KEY: string } {
  return new TextEncoder().encode(
    env.AUTH_IDENTITY_DIGEST_KEY ?? "",
  ).byteLength >= MINIMUM_IDENTITY_DIGEST_KEY_BYTES;
}
function isolatedAuthenticationHostnameAllowedValue(
  env: RuntimeEnv,
  value: string,
): boolean {
  let hostname: string;
  try {
    hostname = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (
    DEVELOPMENT_AUTHENTICATION_BLOCKED_HOSTS.has(hostname)
  ) {
    return false;
  }
  if (
    hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".test")
  ) {
    return true;
  }
  return new Set(
    (env.AUTH_DEV_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((candidate) => candidate.trim().toLowerCase())
      .filter(Boolean),
  ).has(hostname);
}

function isolatedAuthenticationHostnameAllowed(
  env: RuntimeEnv,
  requestUrl: string,
): boolean {
  const candidates = [
    requestUrl,
    env.AUTH_BASE_URL,
  ].filter(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.length > 0,
  );
  return candidates.length > 0
    && candidates.every((candidate) =>
      isolatedAuthenticationHostnameAllowedValue(env, candidate)
    );
}

export function developmentAuthenticationAllowed(
  env: RuntimeEnv,
  requestUrl: string,
): boolean {
  return env.AUTH_DEV_ENABLED === "true"
    && isolatedAuthenticationHostnameAllowed(env, requestUrl);
}

export function authenticationBaseUrl(
  env: RuntimeEnv,
  requestUrl = "",
): string | null {
  const configured = env.AUTH_BASE_URL?.trim() ?? "";
  let isolatedRequestOrigin = "";
  if (
    !configured
    && isolatedAuthenticationHostnameAllowedValue(env, requestUrl)
  ) {
    try {
      isolatedRequestOrigin = new URL(requestUrl).origin;
    } catch {
      isolatedRequestOrigin = "";
    }
  }
  const candidate = configured || isolatedRequestOrigin;
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (
      !["http:", "https:"].includes(url.protocol)
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
      || (
        url.protocol !== "https:"
        && !isolatedAuthenticationHostnameAllowedValue(
          env,
          url.toString(),
        )
      )
    ) {
      return null;
    }
    if (
      configured
      && configured !== url.origin
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function turnstileConfigurationAllowed(
  env: RuntimeEnv,
  requestUrl = "",
): boolean {
  const usesTestCredential =
    TURNSTILE_TEST_SITE_KEYS.has(
      env.AUTH_TURNSTILE_SITE_KEY ?? "",
    )
    || TURNSTILE_TEST_SECRET_KEYS.has(
      env.AUTH_TURNSTILE_SECRET_KEY ?? "",
    );
  return !usesTestCredential
    || isolatedAuthenticationHostnameAllowed(
      env,
      requestUrl,
    );
}
function resultChanges(result: D1ResultLike | undefined): number {
  return result?.success ? result.meta?.changes ?? 0 : 0;
}
function activityNeedsTouch(value: string | null, now: number): boolean {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return !Number.isFinite(timestamp)
    || timestamp <= now - SESSION_ACTIVITY_TOUCH_INTERVAL_MS;
}
function sessionSeconds(env: RuntimeEnv): number {
  const configured = Number(env.AUTH_SESSION_TTL_SECONDS);
  if (!Number.isFinite(configured)) return DEFAULT_SESSION_TTL_SECONDS;
  return Math.max(
    MINIMUM_SESSION_TTL_SECONDS,
    Math.min(MAXIMUM_SESSION_TTL_SECONDS, Math.floor(configured)),
  );
}

function parseIpv4(value: string): number[] | null {
  const octets = value.split(".");
  if (
    octets.length !== IPV4_OCTET_COUNT
    || octets.some((octet) => !/^\d{1,3}$/.test(octet))
  ) {
    return null;
  }
  const parsed = octets.map(Number);
  return parsed.every((octet) => octet >= 0 && octet <= 255)
    ? parsed
    : null;
}

function parseIpv6(value: string): number[] | null {
  let normalized = value.toLowerCase();
  if (normalized.includes(".")) {
    const finalSeparator = normalized.lastIndexOf(":");
    if (finalSeparator < 0) return null;
    const ipv4 = parseIpv4(normalized.slice(finalSeparator + 1));
    if (!ipv4) return null;
    const high = (ipv4[0] << 8) | ipv4[1];
    const low = (ipv4[2] << 8) | ipv4[3];
    normalized = `${normalized.slice(0, finalSeparator)}:${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (half: string): number[] | null => {
    if (!half) return [];
    const hextets = half.split(":");
    if (hextets.some((hextet) => !/^[0-9a-f]{1,4}$/.test(hextet))) {
      return null;
    }
    return hextets.map((hextet) => Number.parseInt(hextet, 16));
  };
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? "");
  if (!left || !right) return null;

  if (halves.length === 1) {
    return left.length === IPV6_HEXTET_COUNT ? left : null;
  }
  const missing = IPV6_HEXTET_COUNT - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array<number>(missing).fill(0), ...right];
}

function anonymizeIpPrefix(raw: string | null): string | null {
  const value = raw?.trim();
  if (!value) return null;

  const ipv4 = parseIpv4(value);
  if (ipv4) {
    return `${ipv4.slice(0, IPV4_PREFIX_OCTET_COUNT).join(".")}.0/${IPV4_PREFIX_BITS}`;
  }

  const mappedIpv4 = /^::ffff:(.+)$/i.exec(value);
  const mapped = mappedIpv4 ? parseIpv4(mappedIpv4[1]) : null;
  if (mapped) {
    return `${mapped.slice(0, IPV4_PREFIX_OCTET_COUNT).join(".")}.0/${IPV4_PREFIX_BITS}`;
  }

  const ipv6 = parseIpv6(value);
  if (!ipv6) return null;
  const prefix = ipv6
    .slice(0, IPV6_PREFIX_HEXTET_COUNT)
    .map((hextet) => hextet.toString(16))
    .join(":");
  return `${prefix}::/${IPV6_PREFIX_BITS}`;
}

interface SessionRecord {
  createdAt: string;
  expiresAt: string;
  ipPrefix: string | null;
  lastSeenAt: string;
  maxAge: number;
  raw: string;
  sessionId: string;
  tokenHash: string;
  userAgent: string | null;
}

async function createSessionRecord(
  env: RuntimeEnv,
  request: Request,
  maximumSeconds?: number,
): Promise<SessionRecord> {
  const raw = token();
  const createdAt = nowIso();
  const maxAge = maximumSeconds === undefined
    ? sessionSeconds(env)
    : Math.max(1, Math.floor(maximumSeconds));
  return {
    createdAt,
    expiresAt: new Date(Date.now() + maxAge * 1_000).toISOString(),
    ipPrefix: anonymizeIpPrefix(request.headers.get("cf-connecting-ip")),
    lastSeenAt: createdAt,
    maxAge,
    raw,
    sessionId: newId("ses"),
    tokenHash: await hash(raw),
    userAgent: request.headers.get("user-agent")?.slice(0, 300) ?? null,
  };
}

export async function cleanupAuthRecords(
  db: AuthDb,
  at = new Date(),
): Promise<{
  guestLinks: number;
  guestMemberships: number;
  guestUsers: number;
  oauthStates: number;
  sessions: number;
}> {
  const now = at.toISOString();
  const guestLinkCutoff = new Date(
    at.getTime() - GUEST_LINK_RETENTION_MS,
  ).toISOString();
  const oauthCutoff = new Date(
    at.getTime() - OAUTH_STATE_RETENTION_MS,
  ).toISOString();
  const sessionCutoff = new Date(
    at.getTime() - SESSION_RETENTION_MS,
  ).toISOString();
  const results = await db.batch([
    db.prepare(
      `DELETE FROM sessions
       WHERE session_id IN (
         SELECT session_id
         FROM sessions
         WHERE expires_at <= ?
         ORDER BY expires_at
         LIMIT ?
       )`,
    ).bind(sessionCutoff, AUTH_CLEANUP_BATCH_SIZE),
    db.prepare(
      `DELETE FROM oauth_states
       WHERE state_hash IN (
         SELECT state_hash
         FROM oauth_states
         WHERE expires_at <= ?
         ORDER BY expires_at
         LIMIT ?
       )`,
    ).bind(oauthCutoff, AUTH_CLEANUP_BATCH_SIZE),
    db.prepare(
      `UPDATE oauth_states
       SET verifier_ciphertext='', return_to='/'
       WHERE state_hash IN (
         SELECT state_hash
         FROM oauth_states
         WHERE expires_at <= ?
           AND (verifier_ciphertext <> '' OR return_to <> '/')
         ORDER BY expires_at
         LIMIT ?
       )`,
    ).bind(now, AUTH_CLEANUP_BATCH_SIZE),
    db.prepare(
      `UPDATE auth_audit_events
       SET actor_user_id = NULL
       WHERE actor_user_id IN (
         SELECT users.user_id
         FROM users
         WHERE EXISTS (
           SELECT 1
           FROM identities
           WHERE identities.user_id = users.user_id
             AND identities.provider = 'guest'
         )
           AND NOT EXISTS (
             SELECT 1
             FROM identities
             WHERE identities.user_id = users.user_id
               AND identities.provider <> 'guest'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM workspace_members
             WHERE workspace_members.user_id = users.user_id
           )
           AND NOT EXISTS (
             SELECT 1
             FROM guest_links
             WHERE guest_links.created_by_user_id = users.user_id
           )
           AND NOT EXISTS (
             SELECT 1
             FROM sessions
             WHERE sessions.user_id = users.user_id
               AND sessions.revoked_at IS NULL
               AND sessions.expires_at > ?
           )
         ORDER BY users.created_at
         LIMIT ?
       )`,
    ).bind(now, AUTH_CLEANUP_BATCH_SIZE),
    db.prepare(
      `DELETE FROM users
       WHERE user_id IN (
         SELECT users.user_id
         FROM users
         WHERE EXISTS (
           SELECT 1
           FROM identities
           WHERE identities.user_id = users.user_id
             AND identities.provider = 'guest'
         )
           AND NOT EXISTS (
             SELECT 1
             FROM identities
             WHERE identities.user_id = users.user_id
               AND identities.provider <> 'guest'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM workspace_members
             WHERE workspace_members.user_id = users.user_id
           )
           AND NOT EXISTS (
             SELECT 1
             FROM guest_links
             WHERE guest_links.created_by_user_id = users.user_id
           )
           AND NOT EXISTS (
             SELECT 1
             FROM sessions
             WHERE sessions.user_id = users.user_id
               AND sessions.revoked_at IS NULL
               AND sessions.expires_at > ?
           )
         ORDER BY users.created_at
         LIMIT ?
       )`,
    ).bind(now, AUTH_CLEANUP_BATCH_SIZE),
    db.prepare(
      `DELETE FROM guest_links
       WHERE guest_link_id IN (
         SELECT guest_link_id
         FROM guest_links
         WHERE expires_at <= ?
         ORDER BY expires_at
         LIMIT ?
       )`,
    ).bind(guestLinkCutoff, AUTH_CLEANUP_BATCH_SIZE),
  ]);
  if (results.length !== 6 || results.some((result) => !result.success)) {
    throw new Error("Authentication record cleanup did not complete");
  }
  const terminalSessions = await trimTerminalSessions(db, at);
  return {
    sessions: resultChanges(results[0]) + terminalSessions,
    oauthStates: resultChanges(results[1]),
    guestMemberships: 0,
    guestUsers: resultChanges(results[4]),
    guestLinks: resultChanges(results[5]),
  };
}

async function maintainAuthRecords(db: AuthDb): Promise<void> {
  await cleanupAuthRecords(db).catch(() => undefined);
}

export class AuthorizationError extends Error {
 constructor(message:string,readonly status:401|403){super(message);this.name="AuthorizationError"}
}
export class AccessVerificationError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 503,
  ) {
    super(message);
    this.name = "AccessVerificationError";
  }
}
export class InvitationError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "InvitationError";
  }
}

export function sessionCookie(raw: string, maxAge: number) {
  return `${SESSION_COOKIE_NAME}=${raw}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
export function clearSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
export function cookieValue(
  request: Request,
  name: string,
): string | null {
  const matches = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.startsWith(`${name}=`));
  return matches.length === 1
    ? matches[0].slice(name.length + 1)
    : null;
}

interface AuthUserRow {
  display_name: string;
  email: string;
  global_role: "admin" | "user";
  status: string;
  user_id: string;
}

export interface AuthenticatedIdentityLinkIntent {
  sessionId: string;
  userId: string;
}

export interface CreateOrLinkUserOptions {
  linkIntent?: AuthenticatedIdentityLinkIntent;
  requireRecentAuthentication?: boolean;
  requireExistingIdentity?: boolean;
}

async function activeIdentityLinkTarget(
  db: AuthDb,
  intent: AuthenticatedIdentityLinkIntent,
  now: string,
  requireRecentAuthentication: boolean,
): Promise<AuthUserRow | null> {
  const recentCutoff = new Date(
    Date.parse(now) - RECENT_IDENTITY_LINK_AUTHENTICATION_MS,
  ).toISOString();
  return db.prepare(
    `SELECT
       user.user_id,user.email,user.display_name,user.global_role,user.status
     FROM users user
     JOIN sessions session
       ON session.user_id=user.user_id
      AND session.session_id=?
      AND session.revoked_at IS NULL
      AND session.expires_at>?
      AND (
        ?=0
        OR COALESCE(session.reauthenticated_at,session.created_at)>=?
      )
     WHERE user.user_id=?
       AND user.status='active'
       AND user.deleted_at IS NULL`,
  ).bind(
    intent.sessionId,
    now,
    requireRecentAuthentication ? 1 : 0,
    recentCutoff,
    intent.userId,
  ).first<AuthUserRow>();
}

export async function requireRecentIdentityLinkAuthentication(
  db: AuthDb,
  intent: AuthenticatedIdentityLinkIntent,
): Promise<void> {
  const now = nowIso();
  if (!await activeIdentityLinkTarget(db, intent, now, true)) {
    throw new ApiProblem(
      "REAUTHENTICATION_REQUIRED",
      "Sign in again with an existing Google identity before linking another",
      401,
    );
  }
}

export async function createOrLinkUser(
  db: AuthDb,
  env: RuntimeEnv,
  profile: ProviderProfile,
  options: CreateOrLinkUserOptions = {},
): Promise<SessionUser> {
  const email = normalize(profile.email);
  const providerId = profile.provider.trim();
  const subject = profile.subject.trim();
  const displayName = profile.displayName.trim() || email;
  if (!providerId || !subject || !email) {
    throw new Error("Provider identity lacks required fields");
  }
  if (!identityEnforcementConfigured(env)) {
    throw new Error("Identity enforcement is not configured");
  }
  await assertIdentityNotBanned(
    db,
    await identityEnforcementDigest(
      env.AUTH_IDENTITY_DIGEST_KEY,
      providerId,
      subject,
    ),
  );
  const now = nowIso();
  const recentAuthenticationCutoff = new Date(
    Date.parse(now) - RECENT_IDENTITY_LINK_AUTHENTICATION_MS,
  ).toISOString();
  const linkTarget = options.linkIntent
    ? await activeIdentityLinkTarget(
        db,
        options.linkIntent,
        now,
        options.requireRecentAuthentication === true,
      )
    : null;
  if (options.linkIntent && !linkTarget) {
    throw new Error("Authenticated identity-link intent is no longer valid");
  }
  const existingIdentity = await db.prepare(
    `SELECT
       u.user_id, u.email, u.display_name, u.global_role, u.status
     FROM identities i
     JOIN users u ON u.user_id = i.user_id
     WHERE i.provider = ? AND i.provider_subject = ?`,
  ).bind(providerId, subject).first<AuthUserRow>();
  if (existingIdentity) {
    if (existingIdentity.status !== "active") {
      throw new ApiProblem(
        existingIdentity.status === "banned"
          ? "ACCOUNT_BANNED"
          : "AUTHENTICATION_REQUIRED",
        existingIdentity.status === "banned"
          ? "This account is banned"
          : "This account is not active",
        existingIdentity.status === "banned" ? 403 : 401,
      );
    }
    if (
      linkTarget
      && existingIdentity.user_id !== linkTarget.user_id
    ) {
      throw new Error("Provider identity belongs to another account");
    }
    await db.prepare(
      `UPDATE identities
       SET email = ?, last_used_at = ?
       WHERE provider = ? AND provider_subject = ?`,
    ).bind(email, now, providerId, subject).run();
    return {
      displayName: existingIdentity.display_name,
      email: existingIdentity.email,
      expiresAt: "",
      globalRole: existingIdentity.global_role,
      userId: existingIdentity.user_id,
    };
  }
  if (options.requireExistingIdentity) {
    throw new Error("Provider identity is not linked to an account");
  }

  if (linkTarget && options.linkIntent) {
    let linked: D1ResultLike;
    try {
      linked = await db.prepare(
        `INSERT INTO identities(
           identity_id,user_id,provider,provider_subject,email,created_at,
           last_used_at
         )
         SELECT ?,user.user_id,?,?,?,?,?
         FROM users user
         JOIN sessions session
           ON session.user_id=user.user_id
          AND session.session_id=?
          AND session.revoked_at IS NULL
          AND session.expires_at>?
          AND (
            ?=0
            OR COALESCE(session.reauthenticated_at,session.created_at)>=?
          )
         WHERE user.user_id=?
           AND user.status='active'
           AND user.deleted_at IS NULL
           AND (
             SELECT COUNT(*)
             FROM identities existing
             WHERE existing.user_id=user.user_id
           )<?`,
      ).bind(
        newId("idn"),
        providerId,
        subject,
        email,
        now,
        now,
        options.linkIntent.sessionId,
        now,
        options.requireRecentAuthentication === true ? 1 : 0,
        recentAuthenticationCutoff,
        options.linkIntent.userId,
        PUBLIC_LAUNCH_LIMITS.linkedIdentitiesPerAccount,
      ).run();
    } catch (error) {
      const usage = await db.prepare(
        `SELECT COUNT(*) AS count
         FROM identities
         WHERE user_id=?`,
      ).bind(options.linkIntent.userId).first<{ count: number }>();
      if (
        (usage?.count ?? 0) >=
          PUBLIC_LAUNCH_LIMITS.linkedIdentitiesPerAccount
      ) {
        throw new ApiProblem(
          "QUOTA_EXCEEDED",
          "The account has reached its linked identity limit",
          429,
        );
      }
      throw error;
    }
    if (!linked.success) {
      throw new Error("Provider identity could not be linked");
    }
    const linkedIdentity = await db.prepare(
      `SELECT user_id
       FROM identities
       WHERE provider=? AND provider_subject=?`,
    ).bind(providerId, subject).first<{ user_id: string }>();
    if (linkedIdentity?.user_id !== linkTarget.user_id) {
      const usage = await db.prepare(
        `SELECT COUNT(*) AS count
         FROM identities
         WHERE user_id=?`,
      ).bind(options.linkIntent.userId).first<{ count: number }>();
      if (
        (usage?.count ?? 0) >=
          PUBLIC_LAUNCH_LIMITS.linkedIdentitiesPerAccount
      ) {
        throw new ApiProblem(
          "QUOTA_EXCEEDED",
          "The account has reached its linked identity limit",
          429,
        );
      }
      throw new Error("Provider identity could not be linked");
    }
    return {
      displayName: linkTarget.display_name,
      email: linkTarget.email,
      expiresAt: "",
      globalRole: linkTarget.global_role,
      userId: linkTarget.user_id,
    };
  }

  const sameEmailUser = await db.prepare(
    `SELECT user_id, email, display_name, global_role, status
     FROM users
     WHERE email = ? COLLATE NOCASE`,
  ).bind(email).first<AuthUserRow>();
  if (sameEmailUser) {
    throw new Error(
      "This email belongs to an account without that provider identity",
    );
  }

  const refusal = await accountCreationRefusal(db);
  if (refusal) throw refusal;
  const id = newId("usr");
  let results: D1ResultLike[];
  try {
    results = await db.batch([
      db.prepare(
        `INSERT INTO users(
           user_id, email, display_name, global_role, status, created_at,
           updated_at, last_seen_at
         ) VALUES(?,?,?,'user','active',?,?,?)`,
      ).bind(id, email, displayName, now, now, now),
      db.prepare(
        `INSERT INTO identities(
           identity_id,user_id,provider,provider_subject,email,created_at,
           last_used_at
         ) VALUES(?,?,?,?,?,?,?)`,
      ).bind(
        newId("idn"),
        id,
        providerId,
        subject,
        email,
        now,
        now,
      ),
    ]);
  } catch (error) {
    const racedRefusal = await accountCreationRefusal(db);
    if (racedRefusal) throw racedRefusal;
    throw error;
  }
  if (
    results.length !== 2
    || results.some((result) => !result.success)
  ) {
    throw new Error("Ordinary account could not be created");
  }
  return {
    displayName,
    email,
    expiresAt: "",
    globalRole: "user",
    userId: id,
  };
}

export async function issueSession(
  db: AuthDb,
  env: RuntimeEnv,
  user: SessionUser,
  request: Request,
  options: {
    authenticationProvider?: SessionAuthenticationProvider;
    maximumSeconds?: number;
  } = {},
) {
  await maintainAuthRecords(db);
  const refusal = await sessionIssuanceRefusal(
    db,
    user.userId,
  );
  if (refusal) throw refusal;
  const session = await createSessionRecord(
    env,
    request,
    options.maximumSeconds,
  );
  let auditResult: D1ResultLike | undefined;
  try {
    const results = await db.batch([
      db.prepare(
        `INSERT INTO sessions(
           session_id, user_id, token_hash, created_at, expires_at,
           last_seen_at, user_agent, ip_prefix, authentication_provider
         )
         SELECT ?,user_id,?,?,?,?,?,?,?
         FROM users
         WHERE user_id=?
           AND status='active'
           AND deleted_at IS NULL`,
      ).bind(
        session.sessionId,
        session.tokenHash,
        session.createdAt,
        session.expiresAt,
        session.lastSeenAt,
        session.userAgent,
        session.ipPrefix,
        options.authenticationProvider ?? null,
        user.userId,
      ),
      db.prepare(
        `INSERT INTO auth_audit_events(
           event_id,actor_user_id,action,target_type,target_id,detail_json,
           created_at
         )
         SELECT ?,?,'session.issue','session',?,'{}',?
         WHERE changes()=1`,
      ).bind(
        newId("aud"),
        user.userId,
        session.sessionId,
        session.createdAt,
      ),
      db.prepare(
        `UPDATE users
         SET last_seen_at=?
         WHERE user_id=?
           AND status='active'
           AND deleted_at IS NULL
           AND (last_seen_at IS NULL OR last_seen_at<?)`,
      ).bind(session.createdAt, user.userId, session.createdAt),
    ]);
    auditResult = results[1];
  } catch (error) {
    const racedRefusal = await sessionIssuanceRefusal(
      db,
      user.userId,
    );
    if (racedRefusal) throw racedRefusal;
    throw error;
  }
  if (resultChanges(auditResult) !== 1) {
    const racedRefusal = await sessionIssuanceRefusal(
      db,
      user.userId,
    );
    if (racedRefusal) throw racedRefusal;
    throw new Error("The session could not be issued");
  }
  const outcome = await sessionIssuanceOutcome(
    db,
    user.userId,
    session.sessionId,
  );
  return {
    maxAge: session.maxAge,
    raw: session.raw,
    replacedSessionIds: outcome.replacedSessionIds,
    sessionId: session.sessionId,
  };
}

export async function markSessionReauthenticated(
  db: AuthDb,
  userId: string,
  sessionId: string,
): Promise<{ reauthenticatedAt: string }> {
  const reauthenticatedAt = nowIso();
  const results = await db.batch([
    db.prepare(
      `UPDATE sessions
       SET reauthenticated_at=?
       WHERE session_id=?
         AND user_id=?
         AND revoked_at IS NULL
         AND expires_at>?
         AND EXISTS (
           SELECT 1
           FROM users
           WHERE user_id=?
             AND status='active'
             AND deleted_at IS NULL
         )`,
    ).bind(
      reauthenticatedAt,
      sessionId,
      userId,
      reauthenticatedAt,
      userId,
    ),
    db.prepare(
      `INSERT INTO auth_audit_events(
         event_id,actor_user_id,action,target_type,target_id,detail_json,
         created_at
       )
       SELECT ?,?,'session.reauthenticate','session',?,'{}',?
       WHERE changes()=1`,
    ).bind(
      newId("aud"),
      userId,
      sessionId,
      reauthenticatedAt,
    ),
  ]);
  if (resultChanges(results[1]) !== 1) {
    throw new ApiProblem(
      "AUTHENTICATION_REQUIRED",
      "The current session is no longer active",
      401,
    );
  }
  return { reauthenticatedAt };
}

export async function authenticate(
  db: AuthDb,
  request: Request,
): Promise<AuthenticatedSessionUser | null> {
  const raw = cookieValue(request, SESSION_COOKIE_NAME);
  if (!raw) return null;
  const now = new Date();
  const nowValue = now.toISOString();
  const row = await db.prepare(
    `SELECT u.user_id,u.email,u.display_name,u.global_role,u.status,
            u.last_seen_at AS user_last_seen_at,s.session_id,s.expires_at,
            s.last_seen_at AS session_last_seen_at
     FROM sessions s
     JOIN users u ON u.user_id=s.user_id
     WHERE s.token_hash=?
       AND s.revoked_at IS NULL
       AND s.expires_at>?
       AND u.deleted_at IS NULL`,
  ).bind(await hash(raw), nowValue).first<{
    display_name: string;
    email: string;
    expires_at: string;
    global_role: "admin" | "user";
    session_id: string;
    session_last_seen_at: string;
    status: string;
    user_id: string;
    user_last_seen_at: string | null;
  }>();
  if (!row || row.status !== "active") return null;
  const statements: Statement[] = [];
  if (activityNeedsTouch(row.session_last_seen_at, now.getTime())) {
    statements.push(db.prepare(
      `UPDATE sessions
       SET last_seen_at=?
       WHERE session_id=? AND user_id=?
         AND last_seen_at=?
         AND revoked_at IS NULL
         AND expires_at>?
         AND EXISTS (
           SELECT 1 FROM users
           WHERE users.user_id=sessions.user_id
             AND users.status='active'
         )`,
    ).bind(
      nowValue,
      row.session_id,
      row.user_id,
      row.session_last_seen_at,
      nowValue,
    ));
  }
  if (activityNeedsTouch(row.user_last_seen_at, now.getTime())) {
    statements.push(db.prepare(
      `UPDATE users
       SET last_seen_at=?
       WHERE user_id=? AND status='active'
         AND (
           last_seen_at=?
           OR (last_seen_at IS NULL AND ? IS NULL)
         )`,
    ).bind(
      nowValue,
      row.user_id,
      row.user_last_seen_at,
      row.user_last_seen_at,
    ));
  }
  if (statements.length > 0) {
    await db.batch(statements).catch(() => []);
  }
  return {
    displayName: row.display_name,
    email: row.email,
    expiresAt: row.expires_at,
    globalRole: row.global_role,
    sessionId: row.session_id,
    userId: row.user_id,
  };
}
export interface AccessRecoveryPrincipals {
  access: ProviderProfile;
  user: AuthenticatedSessionUser;
}

export async function authenticateAccessRecoveryPrincipals(
  db: AuthDb,
  env: RuntimeEnv,
  request: Request,
): Promise<AccessRecoveryPrincipals> {
  const user = await authenticate(db, request);
  if (!user) {
    throw new AuthorizationError("Authentication required", 401);
  }
  const assertion = request.headers.get(
    "cf-access-jwt-assertion",
  );
  if (!assertion) {
    throw new AuthorizationError(
      "Cloudflare Access assertion required",
      403,
    );
  }
  let access: ProviderProfile;
  try {
    access = await verifyAccess(env, assertion);
  } catch (error) {
    if (
      error instanceof AccessVerificationError
      && error.status === 503
    ) {
      throw new ApiProblem(
        "STORAGE_UNAVAILABLE",
        "Cloudflare Access identity verification is temporarily unavailable",
        503,
      );
    }
    throw new AuthorizationError(
      "Cloudflare Access assertion is invalid",
      403,
    );
  }
  return { access, user };
}

export async function authorizeAccessBoundSession(
  db: AuthDb,
  env: RuntimeEnv,
  request: Request,
): Promise<AuthenticatedSessionUser> {
  const { access, user } =
    await authenticateAccessRecoveryPrincipals(
      db,
      env,
      request,
  );
  const accessEmail = normalize(access.email);
  const googleBinding = await db.prepare(
    `SELECT
       COUNT(*) AS identity_count,
       COALESCE(
         MAX(CASE WHEN lower(email) = ? THEN 1 ELSE 0 END),
         0
       ) AS email_matches
     FROM identities
     WHERE user_id = ?
       AND provider = 'google'`,
  ).bind(accessEmail, user.userId).first<{
    email_matches: number;
    identity_count: number;
  }>();
  const accessEmailMatches = (googleBinding?.identity_count ?? 0) > 0
    ? googleBinding?.email_matches === 1
    : accessEmail === normalize(user.email);
  if (!accessEmailMatches) {
    throw new AuthorizationError(
      "Cloudflare Access identity must match the app session",
      403,
    );
  }
  return user;
}

export async function authorizeAdmin(
  db: AuthDb,
  env: RuntimeEnv,
  request: Request,
): Promise<AuthenticatedSessionUser> {
  const user = env.AUTH_ADMIN_REQUIRE_ACCESS === "true"
    ? await authorizeAccessBoundSession(db, env, request)
    : await authenticate(db, request);
  if (!user) {
    throw new AuthorizationError("Authentication required", 401);
  }
  if (user.globalRole !== "admin") {
    throw new AuthorizationError("Admin scope required", 403);
  }
  return user;
}
export function isTrustedMutation(request:Request,configuredBaseUrl?:string):boolean{
 const fetchSite=request.headers.get("sec-fetch-site");
 if(fetchSite==="cross-site")return false;
 const origin=request.headers.get("origin");
 if(!origin){
  return fetchSite===null&&!request.headers.has("sec-fetch-mode");
 }
 const requestUrl=new URL(request.url),allowed=new Set([requestUrl.origin]);
 const forwardedHost=request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()??request.headers.get("host");
 const forwardedProtocol=request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim()??requestUrl.protocol.slice(0,-1);
 if(forwardedHost&&/^(https?)$/.test(forwardedProtocol))allowed.add(`${forwardedProtocol}://${forwardedHost}`);
 if(configuredBaseUrl){try{allowed.add(new URL(configuredBaseUrl).origin)}catch{return false}}
 try{return allowed.has(new URL(origin).origin)}catch{return false}
}
export async function workspaceRole(db:AuthDb,userId:string,workspaceId:string){const row=await db.prepare("SELECT member.role FROM workspace_members member JOIN workspace_snapshots snapshot ON snapshot.workspace_id=member.workspace_id JOIN users actor ON actor.user_id=member.user_id AND actor.status='active' WHERE member.workspace_id=? AND member.user_id=? AND NOT EXISTS (SELECT 1 FROM workspace_deletions deleted WHERE deleted.workspace_id=member.workspace_id)").bind(workspaceId,userId).first<{role:"owner"|"editor"|"viewer"}>();return row?.role??null}
export async function canReadWorkspace(db:AuthDb,userId:string,workspaceId:string){return (await workspaceRole(db,userId,workspaceId))!==null}
export async function revokeCurrentSession(
  db: AuthDb,
  request: Request,
): Promise<boolean> {
  const principal = await authenticate(db, request);
  if (!principal) return false;
  try {
    await revokeAccountSession(
      db,
      principal,
      principal.sessionId,
      "logout",
    );
  } catch (error) {
    if (
      error instanceof ApiProblem
      && (
        error.status === 404
        || error.status === 409
      )
    ) {
      return false;
    }
    throw error;
  }
  return true;
}
export async function canWriteWorkspace(db:AuthDb,userId:string,workspaceId:string){const role=await workspaceRole(db,userId,workspaceId);return role==="owner"||role==="editor"}
export async function canOwnWorkspace(db:AuthDb,userId:string,workspaceId:string){return await workspaceRole(db,userId,workspaceId)==="owner"}

async function workspaceClaimRefusal(
  db: AuthDb,
  userId: string,
  workspaceId: string,
  at: Date,
): Promise<ApiProblem | null> {
  const context = await db.prepare(
    `SELECT
       EXISTS(
         SELECT 1
         FROM workspace_members
         WHERE workspace_id=? AND user_id=?
       ) AS membership_exists,
       EXISTS(
         SELECT 1
         FROM workspace_custody
         WHERE workspace_id=snapshot.workspace_id
       ) AS has_custody,
       snapshot.stored_bytes
     FROM workspace_snapshots snapshot
     WHERE snapshot.workspace_id=?`,
  ).bind(
    workspaceId,
    userId,
    workspaceId,
  ).first<{
    has_custody: number;
    membership_exists: number;
    stored_bytes: number;
  }>();
  if (!context) return null;
  const membershipRefusal = await membershipAdmissionRefusal(
    db,
    userId,
  );
  if (
    membershipRefusal
    && (
      context.membership_exists !== 1
      || membershipRefusal.code !== "QUOTA_EXCEEDED"
    )
  ) {
    return membershipRefusal;
  }
  return context.has_custody === 1
    ? null
    : workspaceAllocationRefusal(
        db,
        userId,
        context.stored_bytes,
        at,
      );
}

export async function claimWorkspace(
  db: AuthDb,
  userId: string,
  workspaceId: string,
) {
  if (await canOwnWorkspace(db, userId, workspaceId)) return;
  const at = new Date();
  const refusal = await workspaceClaimRefusal(
    db,
    userId,
    workspaceId,
    at,
  );
  if (refusal) throw refusal;
  let result: D1ResultLike;
  try {
    result = await db.prepare(
      `INSERT OR IGNORE INTO workspace_members(
         workspace_id, user_id, role, created_at
       )
       SELECT snapshot.workspace_id, caller.user_id, 'owner', ?
       FROM workspace_snapshots snapshot
       JOIN users caller ON caller.user_id = ? AND caller.status = 'active'
       WHERE snapshot.workspace_id = ?
         AND NOT EXISTS (
           SELECT 1
           FROM workspace_deletions deleted
           WHERE deleted.workspace_id = snapshot.workspace_id
         )
         AND (
           SELECT COUNT(*)
           FROM workspace_members
           WHERE user_id = ? AND role = 'owner'
         ) < ?`,
    ).bind(
      at.toISOString(),
      userId,
      workspaceId,
      userId,
      API_QUOTAS.ownedWorkspacesPerUser,
    ).run();
  } catch (error) {
    const racedRefusal = await workspaceClaimRefusal(
      db,
      userId,
      workspaceId,
      at,
    );
    if (racedRefusal) throw racedRefusal;
    throw error;
  }
  if (resultChanges(result) === 1 || await canOwnWorkspace(
    db,
    userId,
    workspaceId,
  )) {
    return;
  }
  const usage = await db.prepare(
    `SELECT COUNT(*) AS count
     FROM workspace_members
     WHERE user_id = ? AND role = 'owner'`,
  ).bind(userId).first<{ count: number }>();
  const actual = usage?.count ?? 0;
  if (actual >= API_QUOTAS.ownedWorkspacesPerUser) {
    throw new QuotaExceededError("ownedWorkspacesPerUser", actual + 1);
  }
  throw new Error("The workspace owner membership could not be recorded");
}

interface GuestLinkUsage {
  active: number;
  retained: number;
}

async function guestLinkUsage(
  db: AuthDb,
  workspaceId: string,
  now: string,
): Promise<GuestLinkUsage> {
  const usage = await db.prepare(
    `SELECT
       COUNT(*) AS retained,
       COALESCE(SUM(
         CASE
           WHEN consumed_at IS NULL
             AND revoked_at IS NULL
             AND expires_at > ?
           THEN 1
           ELSE 0
         END
       ), 0) AS active
     FROM guest_links
     WHERE workspace_id = ?`,
  ).bind(now, workspaceId).first<GuestLinkUsage>();
  return {
    active: usage?.active ?? 0,
    retained: usage?.retained ?? 0,
  };
}

export async function createGuestLink(
  db: AuthDb,
  workspaceId: string,
  creator: string,
  role: "editor" | "viewer",
  hours: number = GUEST_LINK_EXPIRY_HOURS.default,
) {
  if (role !== "editor" && role !== "viewer") {
    throw new Error("Guest link role must be editor or viewer");
  }
  if (
    !Number.isSafeInteger(hours)
    || hours < GUEST_LINK_EXPIRY_HOURS.minimum
    || hours > GUEST_LINK_EXPIRY_HOURS.maximum
  ) {
    throw new Error(
      `Guest link expiry must be an integer from ${GUEST_LINK_EXPIRY_HOURS.minimum} through ${GUEST_LINK_EXPIRY_HOURS.maximum} hours`,
    );
  }
  if (!await canOwnWorkspace(db, creator, workspaceId)) {
    throw new AuthorizationError("Workspace owner access required", 403);
  }
  await maintainAuthRecords(db);
  const creationRefusal = await guestLinkCreationRefusal(
    db,
    creator,
  );
  if (creationRefusal) throw creationRefusal;
  const raw = token();
  const id = newId("guest");
  const now = nowIso();
  const end = new Date(
    Date.now() + hours * 3_600_000,
  ).toISOString();
  let auditResult: D1ResultLike | undefined;
  try {
    const results = await db.batch([
      db.prepare(
        `INSERT INTO guest_links(
           guest_link_id, workspace_id, created_by_user_id, token_hash, role,
           created_at, expires_at
         )
         SELECT ?, snapshot.workspace_id, ?, ?, ?, ?, ?
         FROM workspace_snapshots snapshot
         JOIN workspace_members actor
           ON actor.workspace_id = snapshot.workspace_id
          AND actor.user_id = ?
          AND actor.role = 'owner'
         JOIN users actor_user
           ON actor_user.user_id = actor.user_id
          AND actor_user.status = 'active'
         WHERE snapshot.workspace_id = ?
           AND NOT EXISTS (
             SELECT 1
             FROM workspace_deletions deleted
             WHERE deleted.workspace_id = snapshot.workspace_id
           )
           AND (
             SELECT COUNT(*)
             FROM guest_links
             WHERE workspace_id = snapshot.workspace_id
           ) < ?
           AND (
             SELECT COUNT(*)
             FROM guest_links
             WHERE workspace_id = snapshot.workspace_id
               AND consumed_at IS NULL
               AND revoked_at IS NULL
               AND expires_at > ?
           ) < ?`,
      ).bind(
        id,
        creator,
        await hash(raw),
        role,
        now,
        end,
        creator,
        workspaceId,
        API_QUOTAS.retainedGuestLinksPerWorkspace,
        now,
        API_QUOTAS.activeGuestLinksPerWorkspace,
      ),
      db.prepare(
        `INSERT INTO auth_audit_events(
           event_id,actor_user_id,action,target_type,target_id,detail_json,
           created_at
         )
         SELECT ?,?,'guest.create','guest_link',?,?,?
         WHERE changes()=1`,
      ).bind(
        newId("aud"),
        creator,
        id,
        safeAuditDetailJson(
          "guest.create",
          { expiresAt: end, role, workspaceId },
        ),
        now,
      ),
    ]);
    auditResult = results[1];
  } catch (error) {
    const racedRefusal = await guestLinkCreationRefusal(
      db,
      creator,
    );
    if (racedRefusal) throw racedRefusal;
    throw error;
  }
  if (resultChanges(auditResult) === 1) {
    return { id, raw, expiresAt: end };
  }
  if (!await canOwnWorkspace(db, creator, workspaceId)) {
    throw new AuthorizationError("Workspace owner access required", 403);
  }
  const usage = await guestLinkUsage(db, workspaceId, now);
  if (usage.retained >= API_QUOTAS.retainedGuestLinksPerWorkspace) {
    throw new QuotaExceededError(
      "retainedGuestLinksPerWorkspace",
      usage.retained + 1,
    );
  }
  if (usage.active >= API_QUOTAS.activeGuestLinksPerWorkspace) {
    throw new QuotaExceededError(
      "activeGuestLinksPerWorkspace",
      usage.active + 1,
    );
  }
  throw new Error("The guest link could not be recorded");
}

export async function consumeGuestLink(
  db: AuthDb,
  raw: string,
  userId: string,
) {
  const redemptionRefusal = await guestRedemptionRefusal(
    db,
    userId,
  );
  if (redemptionRefusal) throw redemptionRefusal;
  await maintainAuthRecords(db);
  const now = nowIso();
  const row = await db.prepare(
    `SELECT link.guest_link_id,link.workspace_id,link.role
     FROM guest_links link
     JOIN workspace_snapshots snapshot
       ON snapshot.workspace_id=link.workspace_id
     WHERE link.token_hash=?
       AND link.consumed_at IS NULL
       AND link.revoked_at IS NULL
       AND link.expires_at>?
       AND NOT EXISTS (
         SELECT 1
         FROM workspace_deletions deleted
         WHERE deleted.workspace_id=link.workspace_id
       )`,
  ).bind(await hash(raw), now).first<{
    guest_link_id: string;
    role: "editor" | "viewer";
    workspace_id: string;
  }>();
  if (!row) {
    throw new InvitationError(
      "Invite link is invalid, expired, used, or revoked",
    );
  }
  const redemptionId = newId("redemption");
  const auditId = newId("aud");
  let results: D1ResultLike[];
  try {
    results = await db.batch([
      db.prepare(
        `UPDATE guest_links
         SET consumed_at=?,redemption_id=?
         WHERE guest_link_id=?
           AND consumed_at IS NULL
           AND revoked_at IS NULL
           AND redemption_id IS NULL
           AND expires_at>?
           AND EXISTS (
             SELECT 1
             FROM users caller
             WHERE caller.user_id=?
               AND caller.status='active'
           )
           AND EXISTS (
             SELECT 1
             FROM workspace_snapshots snapshot
             WHERE snapshot.workspace_id=guest_links.workspace_id
               AND NOT EXISTS (
                 SELECT 1
                 FROM workspace_deletions deleted
                 WHERE deleted.workspace_id=snapshot.workspace_id
               )
             )
           AND NOT EXISTS (
             SELECT 1
             FROM workspace_members existing
             WHERE existing.workspace_id=guest_links.workspace_id
               AND existing.user_id=?
           )
           AND (
             SELECT COUNT(*)
             FROM workspace_members
             WHERE workspace_id=guest_links.workspace_id
           )<?`,
      ).bind(
        now,
        redemptionId,
        row.guest_link_id,
        now,
        userId,
        userId,
        API_QUOTAS.membersPerWorkspace,
      ),
      db.prepare(
        `INSERT INTO workspace_members(
           workspace_id,user_id,role,created_at
         )
         SELECT link.workspace_id,?,link.role,?
         FROM guest_links link
         JOIN users caller
           ON caller.user_id=?
          AND caller.status='active'
         WHERE link.guest_link_id=?
           AND link.redemption_id=?`,
      ).bind(
        userId,
        now,
        userId,
        row.guest_link_id,
        redemptionId,
      ),
      db.prepare(
        `INSERT INTO auth_audit_events(
           event_id,actor_user_id,action,target_type,target_id,detail_json,
           created_at
         )
         SELECT ?,
                ?,
                'member.invite.accept',
                'workspace_member',
                ?,
                ?,
                ?
         FROM guest_links link
         JOIN workspace_members member
           ON member.workspace_id=link.workspace_id
          AND member.user_id=?
          AND member.role=link.role
         WHERE link.guest_link_id=?
           AND link.redemption_id=?`,
      ).bind(
        auditId,
        userId,
        userId,
        safeAuditDetailJson(
          "member.invite.accept",
          {
            guestLinkId: row.guest_link_id,
            role: row.role,
            workspaceId: row.workspace_id,
          },
        ),
        now,
        userId,
        row.guest_link_id,
        redemptionId,
      ),
      db.prepare(
        `SELECT 1 AS completed
         FROM guest_links link
         JOIN workspace_members member
           ON member.workspace_id=link.workspace_id
          AND member.user_id=?
          AND member.role=link.role
         JOIN auth_audit_events audit
           ON audit.event_id=?
          AND audit.actor_user_id=member.user_id
         WHERE link.guest_link_id=?
           AND link.redemption_id=?
           AND link.consumed_at=?`,
      ).bind(
        userId,
        auditId,
        row.guest_link_id,
        redemptionId,
        now,
      ),
    ]);
  } catch (error) {
    const racedRedemptionRefusal = await guestRedemptionRefusal(
      db,
      userId,
    );
    if (racedRedemptionRefusal) throw racedRedemptionRefusal;
    const racedMembershipRefusal = await membershipAdmissionRefusal(
      db,
      userId,
    );
    if (racedMembershipRefusal) throw racedMembershipRefusal;
    throw error;
  }
  const completed = results.length === 4
    && results[3]?.results?.length === 1;
  if (completed) return { workspaceId: row.workspace_id };

  const context = await db.prepare(
    `SELECT
       EXISTS(
         SELECT 1
         FROM users caller
         WHERE caller.user_id=? AND caller.status='active'
       ) AS user_active,
       EXISTS(
         SELECT 1
         FROM workspace_members member
         WHERE member.workspace_id=link.workspace_id
           AND member.user_id=?
       ) AS already_member,
       (
         SELECT COUNT(*)
         FROM workspace_members
         WHERE workspace_id=link.workspace_id
       ) AS member_count
     FROM guest_links link
     WHERE link.guest_link_id=?`,
  ).bind(userId, userId, row.guest_link_id).first<{
    already_member: number;
    member_count: number;
    user_active: number;
  }>();
  if (!context) {
    throw new InvitationError(
      "Invite link is invalid, expired, used, or revoked",
    );
  }
  if (context.already_member === 1) {
    throw new InvitationError(
      "You already have access to this workspace",
    );
  }
  if (context.user_active !== 1) {
    throw new AuthorizationError("Account is disabled or unavailable", 403);
  }
  const actual = context.member_count;
  if (actual >= API_QUOTAS.membersPerWorkspace) {
    throw new QuotaExceededError("membersPerWorkspace", actual + 1);
  }
  throw new InvitationError(
    "Invite link is invalid, expired, used, or revoked",
  );
}

export type OAuthProviderId = "github" | "google";
export type OAuthIntent = "link" | "reauthenticate" | "sign-in";

export interface OAuthProvider {
  authorizationUrl: string;
  clientId: string;
  clientSecret: string;
  id: OAuthProviderId;
  scopes: string;
  tokenUrl: string;
}

interface OAuthTransactionEnvelope {
  bindingHash: string;
  intent: OAuthIntent;
  linkSessionId: string | null;
  linkUserId: string | null;
  nonce: string;
  verifier: string;
  version: 1;
}

export interface OAuthStartOptions {
  intent?: OAuthIntent;
  linkIntent?: AuthenticatedIdentityLinkIntent;
}

export interface OAuthStartResult {
  authorizationUrl: string;
  bindingCookie: string;
}

export interface OAuthFinishResult {
  intent: OAuthIntent;
  linkIntent: AuthenticatedIdentityLinkIntent | null;
  profile: ProviderProfile;
  returnTo: string;
}

interface TurnstileSiteverifyResult {
  action?: unknown;
  challenge_ts?: unknown;
  hostname?: unknown;
  success?: unknown;
}

export class TurnstileVerificationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 503,
  ) {
    super(message);
    this.name = "TurnstileVerificationError";
  }
}

export class OAuthCallbackError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 502 | 503,
  ) {
    super(message);
    this.name = "OAuthCallbackError";
  }
}

const GOOGLE_ID_TOKEN_CLOCK_TOLERANCE_SECONDS = 60;
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const OAUTH_BINDING_COOKIE_PREFIX = "__Secure-stowplan_oauth";
const OAUTH_PROVIDER_TIMEOUT_MS = 8_000;
const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const OAUTH_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const TURNSTILE_CHALLENGE_MAX_AGE_MS = 5 * 60 * 1_000;
const TURNSTILE_CLOCK_TOLERANCE_MS = 60 * 1_000;
const TURNSTILE_MAX_TOKEN_CHARACTERS = 2_048;
const TURNSTILE_SITEVERIFY_TIMEOUT_MS = 8_000;
const TURNSTILE_SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const googleJwks = createRemoteJWKSet(
  new URL(GOOGLE_JWKS_URL),
  { timeoutDuration: OAUTH_PROVIDER_TIMEOUT_MS },
);
const accessJwks = new Map<
  string,
  ReturnType<typeof createRemoteJWKSet>
>();

function isObjectRecord(
  value: unknown,
): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value);
}

function oauthProviderFailureStatus(response: Response): 401 | 503 {
  return response.status === 429 || response.status >= 500
    ? 503
    : 401;
}

async function oauthProviderFetch(
  input: string,
  init: RequestInit,
): Promise<Response> {
  const abort = new AbortController();
  const timeout = setTimeout(
    () => abort.abort(),
    OAUTH_PROVIDER_TIMEOUT_MS,
  );
  try {
    return await fetch(input, {
      ...init,
      signal: abort.signal,
    });
  } catch {
    throw new OAuthCallbackError(
      "OAuth provider request failed",
      503,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function jwksUnavailable(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (!isObjectRecord(error)) return false;
  return error.code === "ERR_JWKS_TIMEOUT"
    || error.code === "ERR_JWKS_FETCH_FAILED"
    || error.code === "ERR_JWKS_INVALID"
    || (
      error.code === "ERR_JOSE_GENERIC"
      && (
        error.message ===
          "Expected 200 OK from the JSON Web Key Set HTTP response"
        || error.message ===
          "Failed to parse the JSON Web Key Set HTTP response as JSON"
      )
    );
}

function b64url(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function oauthBindingCookieName(
  providerId: OAuthProviderId,
  state: string,
): string {
  if (!OAUTH_TOKEN_PATTERN.test(state)) {
    throw new Error("OAuth state is malformed");
  }
  return `${OAUTH_BINDING_COOKIE_PREFIX}_${providerId}_${state.slice(0, 16)}`;
}

function oauthBindingCookiePath(
  providerId: OAuthProviderId,
): string {
  return `/api/auth/${providerId}/callback`;
}

function oauthBindingCookie(
  providerId: OAuthProviderId,
  state: string,
  binding: string,
): string {
  return [
    `${oauthBindingCookieName(providerId, state)}=${binding}`,
    `Path=${oauthBindingCookiePath(providerId)}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${OAUTH_STATE_TTL_SECONDS}`,
  ].join("; ");
}

export function clearOAuthBindingCookie(
  providerId: OAuthProviderId,
  state: string,
): string {
  return [
    `${oauthBindingCookieName(providerId, state)}=`,
    `Path=${oauthBindingCookiePath(providerId)}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=0",
  ].join("; ");
}

export function oauthBrowserBinding(
  request: Request,
  providerId: OAuthProviderId,
  state: string,
): string | null {
  return cookieValue(
    request,
    oauthBindingCookieName(providerId, state),
  );
}

function transactionEnvelope(
  value: string,
): OAuthTransactionEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("OAuth transaction is malformed");
  }
  if (
    !isObjectRecord(parsed)
    || parsed.version !== 1
    || !OAUTH_TOKEN_PATTERN.test(String(parsed.bindingHash ?? ""))
    || !OAUTH_TOKEN_PATTERN.test(String(parsed.nonce ?? ""))
    || !PKCE_VERIFIER_PATTERN.test(String(parsed.verifier ?? ""))
    || (
      parsed.intent !== "link"
      && parsed.intent !== "reauthenticate"
      && parsed.intent !== "sign-in"
    )
  ) {
    throw new Error("OAuth transaction is malformed");
  }
  const linkUserId = parsed.linkUserId;
  const linkSessionId = parsed.linkSessionId;
  if (
    (
      parsed.intent !== "sign-in"
      && (
        typeof linkUserId !== "string"
        || !linkUserId
        || typeof linkSessionId !== "string"
        || !linkSessionId
      )
    )
    || (
      parsed.intent === "sign-in"
      && (linkUserId !== null || linkSessionId !== null)
    )
  ) {
    throw new Error("OAuth transaction intent is malformed");
  }
  return {
    bindingHash: String(parsed.bindingHash),
    intent: parsed.intent,
    linkSessionId: linkSessionId as string | null,
    linkUserId: linkUserId as string | null,
    nonce: String(parsed.nonce),
    verifier: String(parsed.verifier),
    version: 1,
  };
}

export function provider(
  env: RuntimeEnv,
  id: string,
  requestUrl = "",
): OAuthProvider | null {
  if (
    id === "google"
    && env.AUTH_GOOGLE_CLIENT_ID
    && env.AUTH_GOOGLE_CLIENT_SECRET
    && identityEnforcementConfigured(env)
    && env.AUTH_TURNSTILE_SITE_KEY
    && env.AUTH_TURNSTILE_SECRET_KEY
    && authenticationBaseUrl(env, requestUrl)
    && turnstileConfigurationAllowed(env, requestUrl)
  ) {
    return {
      authorizationUrl:
        "https://accounts.google.com/o/oauth2/v2/auth",
      clientId: env.AUTH_GOOGLE_CLIENT_ID,
      clientSecret: env.AUTH_GOOGLE_CLIENT_SECRET,
      id,
      scopes: "openid email profile",
      tokenUrl: "https://oauth2.googleapis.com/token",
    };
  }
  return null;
}

export async function verifyTurnstile(
  env: RuntimeEnv,
  responseToken: string,
  requestUrl: string,
  remoteIp?: string | null,
): Promise<void> {
  const secret = env.AUTH_TURNSTILE_SECRET_KEY;
  const tokenValue = responseToken.trim();
  if (
    !secret
    || !turnstileConfigurationAllowed(env, requestUrl)
  ) {
    throw new TurnstileVerificationError(
      "Browser verification is unavailable",
      503,
    );
  }
  if (
    !tokenValue
    || tokenValue.length > TURNSTILE_MAX_TOKEN_CHARACTERS
  ) {
    throw new TurnstileVerificationError(
      "Complete the browser verification and try again",
      400,
    );
  }

  let expectedHostname: string;
  try {
    const base = authenticationBaseUrl(env, requestUrl);
    if (!base) throw new Error("Invalid authentication base URL");
    expectedHostname = new URL(base).hostname.toLowerCase();
  } catch {
    throw new TurnstileVerificationError(
      "Browser verification is unavailable",
      503,
    );
  }
  const abort = new AbortController();
  const timeout = setTimeout(
    () => abort.abort(),
    TURNSTILE_SITEVERIFY_TIMEOUT_MS,
  );
  let response: Response;
  try {
    const body = new URLSearchParams({
      response: tokenValue,
      secret,
    });
    const candidateIp = remoteIp?.trim() ?? "";
    if (
      parseIpv4(candidateIp)
      || parseIpv6(candidateIp)
    ) {
      body.set("remoteip", candidateIp);
    }
    response = await fetch(TURNSTILE_SITEVERIFY_URL, {
      body,
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
      signal: abort.signal,
    });
  } catch {
    throw new TurnstileVerificationError(
      "Browser verification is temporarily unavailable",
      503,
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new TurnstileVerificationError(
      "Browser verification is temporarily unavailable",
      503,
    );
  }

  let result: TurnstileSiteverifyResult;
  try {
    result = await response.json() as TurnstileSiteverifyResult;
  } catch {
    throw new TurnstileVerificationError(
      "Browser verification is temporarily unavailable",
      503,
    );
  }
  const challengeAt = Date.parse(
    typeof result.challenge_ts === "string"
      ? result.challenge_ts
      : "",
  );
  const challengeAge = Date.now() - challengeAt;
  if (
    result.success !== true
    || result.action !== OAUTH_TURNSTILE_ACTION
    || typeof result.hostname !== "string"
    || result.hostname.toLowerCase() !== expectedHostname
    || !Number.isFinite(challengeAt)
    || challengeAge < -TURNSTILE_CLOCK_TOLERANCE_MS
    || challengeAge >
      TURNSTILE_CHALLENGE_MAX_AGE_MS
      + TURNSTILE_CLOCK_TOLERANCE_MS
  ) {
    throw new TurnstileVerificationError(
      "Browser verification was not accepted; try again",
      400,
    );
  }
}

export async function beginOAuth(
  db: AuthDb,
  oauthProvider: OAuthProvider,
  base: string,
  returnTo: string,
  options: OAuthStartOptions = {},
): Promise<OAuthStartResult> {
  await maintainAuthRecords(db);
  const intent = options.intent ?? "sign-in";
  if (
    (intent !== "sign-in") !== Boolean(options.linkIntent)
  ) {
    throw new Error("Authenticated OAuth intent is incomplete");
  }
  const state = token();
  const binding = token();
  const nonce = token();
  const verifier = b64url(bytes(48));
  const challenge = b64url(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(verifier),
      ),
    ),
  );
  const createdAt = nowIso();
  const expiresAt = new Date(
    Date.now() + OAUTH_STATE_TTL_SECONDS * 1_000,
  ).toISOString();
  const envelope: OAuthTransactionEnvelope = {
    bindingHash: await hash(binding),
    intent,
    linkSessionId: options.linkIntent?.sessionId ?? null,
    linkUserId: options.linkIntent?.userId ?? null,
    nonce,
    verifier,
    version: 1,
  };
  await db.prepare(
    `INSERT INTO oauth_states(
       state_hash,provider,verifier_ciphertext,return_to,created_at,expires_at
     ) VALUES(?,?,?,?,?,?)`,
  ).bind(
    await hash(state),
    oauthProvider.id,
    JSON.stringify(envelope),
    returnTo,
    createdAt,
    expiresAt,
  ).run();

  const authorization = new URL(oauthProvider.authorizationUrl);
  authorization.searchParams.set(
    "client_id",
    oauthProvider.clientId,
  );
  authorization.searchParams.set(
    "redirect_uri",
    `${base}/api/auth/${oauthProvider.id}/callback`,
  );
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("scope", oauthProvider.scopes);
  authorization.searchParams.set("state", state);
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set(
    "code_challenge_method",
    "S256",
  );
  if (oauthProvider.id === "google") {
    authorization.searchParams.set("nonce", nonce);
    if (intent === "reauthenticate") {
      authorization.searchParams.set("prompt", "select_account");
    } else if (intent === "link") {
      authorization.searchParams.set("prompt", "select_account");
    }
  }
  return {
    authorizationUrl: authorization.toString(),
    bindingCookie: oauthBindingCookie(
      oauthProvider.id,
      state,
      binding,
    ),
  };
}

async function googleProfile(
  idToken: string,
  oauthProvider: OAuthProvider,
  expectedNonce: string,
): Promise<ProviderProfile> {
  let payload;
  try {
    ({ payload } = await jwtVerify(
      idToken,
      googleJwks,
      {
        algorithms: ["RS256"],
        audience: oauthProvider.clientId,
        clockTolerance: GOOGLE_ID_TOKEN_CLOCK_TOLERANCE_SECONDS,
        issuer: [
          "https://accounts.google.com",
          "accounts.google.com",
        ],
        maxTokenAge: OAUTH_STATE_TTL_SECONDS,
        requiredClaims: [
          "email",
          "email_verified",
          "exp",
          "iat",
          "nonce",
          "sub",
        ],
      },
    ));
  } catch (error) {
    throw new OAuthCallbackError(
      jwksUnavailable(error)
        ? "Google verification keys are unavailable"
        : "Google ID token verification failed",
      jwksUnavailable(error) ? 503 : 401,
    );
  }
  const email = typeof payload.email === "string"
    ? normalize(payload.email)
    : "";
  const audience = Array.isArray(payload.aud)
    ? payload.aud
    : [payload.aud];
  if (
    (
      payload.azp !== undefined
      && payload.azp !== oauthProvider.clientId
    )
    || (
      audience.length > 1
      && payload.azp !== oauthProvider.clientId
    )
    || payload.nonce !== expectedNonce
    || payload.email_verified !== true
    || typeof payload.sub !== "string"
    || !payload.sub.trim()
    || !email
  ) {
    throw new OAuthCallbackError(
      "Google identity lacks required claims",
      401,
    );
  }
  const name = typeof payload.name === "string"
    ? payload.name.trim()
    : "";
  return {
    displayName: name || email,
    email,
    provider: oauthProvider.id,
    subject: payload.sub,
  };
}

async function githubProfile(
  accessToken: string,
  oauthProvider: OAuthProvider,
): Promise<ProviderProfile> {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${accessToken}`,
    "user-agent": "Stowplan",
  };
  const [accountResponse, emailsResponse] = await Promise.all([
    oauthProviderFetch("https://api.github.com/user", { headers }),
    oauthProviderFetch(
      "https://api.github.com/user/emails",
      { headers },
    ),
  ]);
  if (!accountResponse.ok || !emailsResponse.ok) {
    throw new OAuthCallbackError(
      "GitHub profile request failed",
      accountResponse.ok
        ? oauthProviderFailureStatus(emailsResponse)
        : oauthProviderFailureStatus(accountResponse),
    );
  }
  let account: {
    email?: string;
    id?: number;
    login?: string;
    name?: string;
  };
  let emails: unknown;
  try {
    account = await accountResponse.json() as typeof account;
    emails = await emailsResponse.json();
  } catch {
    throw new OAuthCallbackError(
      "GitHub returned an invalid profile response",
      502,
    );
  }
  if (!Array.isArray(emails)) {
    throw new OAuthCallbackError(
      "GitHub account lacks required identity claims",
      401,
    );
  }
  const typedEmails = emails as Array<{
    email?: string;
    primary?: boolean;
    verified?: boolean;
  }>;
  const verifiedEmails = typedEmails.filter(
    (candidate) => candidate.verified && candidate.email,
  );
  const accountEmail = account.email?.trim().toLowerCase();
  const email = verifiedEmails.find(
    (candidate) =>
      candidate.email?.trim().toLowerCase() === accountEmail,
  )?.email
    ?? verifiedEmails.find((candidate) =>
      candidate.primary && candidate.verified
    )?.email
    ?? verifiedEmails[0]?.email;
  if (
    !Number.isSafeInteger(account.id)
    || !email
  ) {
    throw new OAuthCallbackError(
      "GitHub account lacks required identity claims",
      401,
    );
  }
  return {
    displayName: account.name?.trim()
      || account.login?.trim()
      || email,
    email,
    provider: oauthProvider.id,
    subject: String(account.id),
  };
}

export async function finishOAuth(
  db: AuthDb,
  oauthProvider: OAuthProvider,
  base: string,
  state: string,
  code: string,
  browserBinding: string | null,
): Promise<OAuthFinishResult> {
  if (!OAUTH_TOKEN_PATTERN.test(state) || !code) {
    throw new OAuthCallbackError(
      "OAuth callback is malformed",
      400,
    );
  }
  const stateHash = await hash(state);
  const claimedAt = nowIso();
  const row = await db.prepare(
    `SELECT verifier_ciphertext,return_to
     FROM oauth_states
     WHERE state_hash=? AND provider=?
       AND consumed_at IS NULL AND expires_at>?`,
  ).bind(
    stateHash,
    oauthProvider.id,
    claimedAt,
  ).first<{
    return_to: string;
    verifier_ciphertext: string;
  }>();
  if (!row) {
    throw new OAuthCallbackError(
      "OAuth state is invalid or expired",
      400,
    );
  }
  let transaction: OAuthTransactionEnvelope;
  try {
    transaction = transactionEnvelope(
      row.verifier_ciphertext,
    );
  } catch {
    throw new OAuthCallbackError(
      "OAuth transaction is invalid",
      400,
    );
  }
  if (
    !browserBinding
    || await hash(browserBinding) !== transaction.bindingHash
  ) {
    throw new OAuthCallbackError(
      "OAuth browser binding is invalid",
      400,
    );
  }
  const claimed = await db.prepare(
    `UPDATE oauth_states
     SET consumed_at=?,verifier_ciphertext='',return_to='/'
     WHERE state_hash=? AND provider=?
       AND consumed_at IS NULL AND expires_at>?`,
  ).bind(
    claimedAt,
    stateHash,
    oauthProvider.id,
    claimedAt,
  ).run();
  if (resultChanges(claimed) !== 1) {
    throw new OAuthCallbackError(
      "OAuth state is invalid or expired",
      400,
    );
  }
  const body = new URLSearchParams({
    client_id: oauthProvider.clientId,
    client_secret: oauthProvider.clientSecret,
    code,
    code_verifier: transaction.verifier,
    grant_type: "authorization_code",
    redirect_uri:
      `${base}/api/auth/${oauthProvider.id}/callback`,
  });
  const tokenResponse = await oauthProviderFetch(
    oauthProvider.tokenUrl,
    {
    body,
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
    },
  );
  if (!tokenResponse.ok) {
    throw new OAuthCallbackError(
      "OAuth token exchange failed",
      oauthProviderFailureStatus(tokenResponse),
    );
  }
  let tokens: {
    access_token?: string;
    id_token?: string;
  };
  try {
    tokens = await tokenResponse.json() as typeof tokens;
  } catch {
    throw new OAuthCallbackError(
      "OAuth provider returned an invalid token response",
      502,
    );
  }
  let profile: ProviderProfile;
  if (oauthProvider.id === "google") {
    if (!tokens.id_token) {
      throw new OAuthCallbackError(
        "Google did not return an ID token",
        401,
      );
    }
    profile = await googleProfile(
      tokens.id_token,
      oauthProvider,
      transaction.nonce,
    );
  } else {
    if (!tokens.access_token) {
      throw new OAuthCallbackError(
        "GitHub did not return an access token",
        401,
      );
    }
    profile = await githubProfile(
      tokens.access_token,
      oauthProvider,
    );
  }
  return {
    intent: transaction.intent,
    linkIntent: transaction.intent === "link"
      || transaction.intent === "reauthenticate"
      ? {
          sessionId: transaction.linkSessionId!,
          userId: transaction.linkUserId!,
        }
      : null,
    profile,
    returnTo: row.return_to,
  };
}

export async function verifyAccess(
  env: RuntimeEnv,
  assertion: string,
): Promise<ProviderProfile> {
  const configuredDomain =
    env.AUTH_CLOUDFLARE_ACCESS_TEAM_DOMAIN?.trim();
  const audience = env.AUTH_CLOUDFLARE_ACCESS_AUD?.trim();
  if (!configuredDomain || !audience) {
    throw new AccessVerificationError(
      "Cloudflare Access is not configured",
      503,
    );
  }
  let domain: string;
  try {
    const url = new URL(
      configuredDomain.includes("://")
        ? configuredDomain
        : `https://${configuredDomain}`,
    );
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
    ) {
      throw new Error("Invalid Access team domain");
    }
    domain = url.hostname.toLowerCase();
  } catch {
    throw new AccessVerificationError(
      "Cloudflare Access is not configured",
      503,
    );
  }
  let jwks = accessJwks.get(domain);
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`https://${domain}/cdn-cgi/access/certs`),
      { timeoutDuration: OAUTH_PROVIDER_TIMEOUT_MS },
    );
    accessJwks.set(domain, jwks);
  }
  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
  try {
    ({ payload } = await jwtVerify(assertion, jwks, {
      audience,
      issuer: `https://${domain}`,
    }));
  } catch (error) {
    throw new AccessVerificationError(
      jwksUnavailable(error)
        ? "Cloudflare Access signing keys are unavailable"
        : "Cloudflare Access assertion is invalid",
      jwksUnavailable(error) ? 503 : 403,
    );
  }
  const email = String(payload.email ?? "").trim();
  if (!payload.sub || !email) {
    throw new AccessVerificationError(
      "Cloudflare Access assertion lacks identity claims",
      403,
    );
  }
  return {
    displayName: String(payload.name ?? email),
    email,
    provider: "cloudflare-access",
    subject: payload.sub,
  };
}
