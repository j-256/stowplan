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
import { revokeAccountSession } from "./account-sessions";
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

function bytes(size=32){const b=new Uint8Array(size);crypto.getRandomValues(b);return b}
function token(size=32){return Array.from(bytes(size),b=>b.toString(16).padStart(2,"0")).join("")}
async function hash(value:string){const encoded=new TextEncoder().encode(value);return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",encoded)),b=>b.toString(16).padStart(2,"0")).join("")}
function normalize(email:string){return email.trim().toLowerCase()}
function adminEmails(env:RuntimeEnv){return new Set((env.AUTH_ADMIN_EMAILS??"").split(",").map(normalize).filter(Boolean))}
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
  return {
    sessions: resultChanges(results[0]),
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
export class InvitationError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "InvitationError";
  }
}

export function sessionCookie(raw:string,maxAge:number){return `stowplan_session=${raw}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`}
export function clearSessionCookie(){return "stowplan_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"}
export function cookieValue(request:Request,name:string){return request.headers.get("cookie")?.split(";").map(x=>x.trim()).find(x=>x.startsWith(`${name}=`))?.slice(name.length+1)??null}

interface AuthUserRow {
  display_name: string;
  email: string;
  global_role: "admin" | "user";
  status: string;
  user_id: string;
}

async function applyConfiguredAdminRole(
  db: AuthDb,
  env: RuntimeEnv,
  user: AuthUserRow,
  now: string,
): Promise<AuthUserRow> {
  if (
    user.global_role === "admin"
    || !adminEmails(env).has(normalize(user.email))
  ) {
    return user;
  }
  await db.prepare(
    `UPDATE users
     SET global_role = 'admin', updated_at = ?
     WHERE user_id = ? AND global_role <> 'admin'`,
  ).bind(now, user.user_id).run();
  return { ...user, global_role: "admin" };
}

export async function createOrLinkUser(
  db: AuthDb,
  env: RuntimeEnv,
  profile: ProviderProfile,
): Promise<SessionUser> {
  const email = normalize(profile.email);
  const now = nowIso();
  let existingIdentity = await db.prepare(
    `SELECT
       u.user_id, u.email, u.display_name, u.global_role, u.status
     FROM identities i
     JOIN users u ON u.user_id = i.user_id
     WHERE i.provider = ? AND i.provider_subject = ?`,
  ).bind(profile.provider, profile.subject).first<AuthUserRow>();
  if (existingIdentity) {
    if (existingIdentity.status !== "active") {
      throw new Error("Account is disabled");
    }
    existingIdentity = await applyConfiguredAdminRole(
      db,
      env,
      existingIdentity,
      now,
    );
    await db.prepare(
      `UPDATE identities
       SET last_used_at = ?
       WHERE provider = ? AND provider_subject = ?`,
    ).bind(now, profile.provider, profile.subject).run();
    return {
      displayName: existingIdentity.display_name,
      email: existingIdentity.email,
      expiresAt: "",
      globalRole: existingIdentity.global_role,
      userId: existingIdentity.user_id,
    };
  }
  let user = await db.prepare(
    `SELECT user_id, email, display_name, global_role, status
     FROM users
     WHERE email = ? COLLATE NOCASE`,
  ).bind(email).first<AuthUserRow>();
  if (!user) {
    const configuredAdmins = adminEmails(env);
    const count = await db.prepare(
      "SELECT COUNT(*) AS count FROM users",
    ).first<{ count: number }>();
    const role = (
      configuredAdmins.has(email)
      || (configuredAdmins.size === 0 && count?.count === 0)
    ) ? "admin" : "user";
    const id = newId("usr");
    await db.prepare(
      `INSERT INTO users(
         user_id, email, display_name, global_role, status, created_at,
         updated_at, last_seen_at
       ) VALUES(?,?,?,?, 'active',?,?,?)`,
    ).bind(id, email, profile.displayName, role, now, now, now).run();
    user = {
      display_name: profile.displayName,
      email,
      global_role: role,
      status: "active",
      user_id: id,
    };
  }
  if (user.status !== "active") throw new Error("Account is disabled");
  user = await applyConfiguredAdminRole(db, env, user, now);
  await db.prepare(
    `INSERT INTO identities(
       identity_id, user_id, provider, provider_subject, email, created_at,
       last_used_at
     ) VALUES(?,?,?,?,?,?,?)`,
  ).bind(
    newId("idn"),
    user.user_id,
    profile.provider,
    profile.subject,
    email,
    now,
    now,
  ).run();
  return {
    displayName: user.display_name,
    email: user.email,
    expiresAt: "",
    globalRole: user.global_role,
    userId: user.user_id,
  };
}

export async function issueSession(
  db: AuthDb,
  env: RuntimeEnv,
  user: SessionUser,
  request: Request,
  maximumSeconds?: number,
) {
  await maintainAuthRecords(db);
  const session = await createSessionRecord(env, request, maximumSeconds);
  const [, auditResult] = await db.batch([
    db.prepare(
      `INSERT INTO sessions(
         session_id, user_id, token_hash, created_at, expires_at,
         last_seen_at, user_agent, ip_prefix
       )
       SELECT ?,user_id,?,?,?,?,?,?
       FROM users
       WHERE user_id=? AND status='active'`,
    ).bind(
      session.sessionId,
      session.tokenHash,
      session.createdAt,
      session.expiresAt,
      session.lastSeenAt,
      session.userAgent,
      session.ipPrefix,
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
       WHERE user_id=? AND status='active'
         AND (last_seen_at IS NULL OR last_seen_at<?)`,
    ).bind(session.createdAt, user.userId, session.createdAt),
  ]);
  if (resultChanges(auditResult) !== 1) {
    throw new Error("The session could not be issued");
  }
  return {
    maxAge: session.maxAge,
    raw: session.raw,
    sessionId: session.sessionId,
  };
}
export async function authenticate(
  db: AuthDb,
  request: Request,
): Promise<AuthenticatedSessionUser | null> {
  const raw = cookieValue(request, "stowplan_session");
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
       AND s.expires_at>?`,
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
export async function authorizeAdmin(db:AuthDb,env:RuntimeEnv,request:Request):Promise<AuthenticatedSessionUser>{
 const user=await authenticate(db,request);
 if(!user)throw new AuthorizationError("Authentication required",401);
 if(user.globalRole!=="admin")throw new AuthorizationError("Admin scope required",403);
 if(env.AUTH_ADMIN_REQUIRE_ACCESS==="true"){
  const assertion=request.headers.get("cf-access-jwt-assertion");
  if(!assertion)throw new AuthorizationError("Cloudflare Access assertion required",403);
  let access:ProviderProfile;
  try{access=await verifyAccess(env,assertion)}catch{throw new AuthorizationError("Cloudflare Access assertion is invalid",403)}
  if(normalize(access.email)!==normalize(user.email))throw new AuthorizationError("Cloudflare Access identity must match the app session",403);
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
export async function claimWorkspace(
  db: AuthDb,
  userId: string,
  workspaceId: string,
) {
  const result = await db.prepare(
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
    nowIso(),
    userId,
    workspaceId,
    userId,
    API_QUOTAS.ownedWorkspacesPerUser,
  ).run();
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
  const raw = token();
  const id = newId("guest");
  const now = nowIso();
  const end = new Date(
    Date.now() + hours * 3_600_000,
  ).toISOString();
  const [, auditResult] = await db.batch([
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
  const results = await db.batch([
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

export interface OAuthProvider { id:"google"|"github"; authorizationUrl:string; tokenUrl:string; scopes:string; clientId:string; clientSecret:string }
export function provider(env:RuntimeEnv,id:string):OAuthProvider|null {if(id==="google"&&env.AUTH_GOOGLE_CLIENT_ID&&env.AUTH_GOOGLE_CLIENT_SECRET)return{id,authorizationUrl:"https://accounts.google.com/o/oauth2/v2/auth",tokenUrl:"https://oauth2.googleapis.com/token",scopes:"openid email profile",clientId:env.AUTH_GOOGLE_CLIENT_ID,clientSecret:env.AUTH_GOOGLE_CLIENT_SECRET};if(id==="github"&&env.AUTH_GITHUB_CLIENT_ID&&env.AUTH_GITHUB_CLIENT_SECRET)return{id,authorizationUrl:"https://github.com/login/oauth/authorize",tokenUrl:"https://github.com/login/oauth/access_token",scopes:"read:user user:email",clientId:env.AUTH_GITHUB_CLIENT_ID,clientSecret:env.AUTH_GITHUB_CLIENT_SECRET};return null}
function b64url(data:Uint8Array){return btoa(String.fromCharCode(...data)).replaceAll("+","-").replaceAll("/","_").replaceAll("=","")}
export async function beginOAuth(db:AuthDb,p:OAuthProvider,base:string,returnTo:string){await maintainAuthRecords(db);const state=token(),verifier=b64url(bytes(48)),challenge=b64url(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier)))),end=new Date(Date.now()+10*60_000).toISOString();await db.prepare("INSERT INTO oauth_states(state_hash,provider,verifier_ciphertext,return_to,created_at,expires_at) VALUES(?,?,?,?,?,?)").bind(await hash(state),p.id,verifier,returnTo,nowIso(),end).run();const u=new URL(p.authorizationUrl);u.searchParams.set("client_id",p.clientId);u.searchParams.set("redirect_uri",`${base}/api/auth/${p.id}/callback`);u.searchParams.set("response_type","code");u.searchParams.set("scope",p.scopes);u.searchParams.set("state",state);u.searchParams.set("code_challenge",challenge);u.searchParams.set("code_challenge_method","S256");return u.toString()}
export async function finishOAuth(db:AuthDb,p:OAuthProvider,base:string,state:string,code:string):Promise<{profile:ProviderProfile;returnTo:string}>{const stateHash=await hash(state),row=await db.prepare("SELECT verifier_ciphertext,return_to FROM oauth_states WHERE state_hash=? AND provider=? AND consumed_at IS NULL AND expires_at>?").bind(stateHash,p.id,nowIso()).first<{verifier_ciphertext:string;return_to:string}>();if(!row)throw new Error("OAuth state is invalid or expired");const claimed=await db.prepare("UPDATE oauth_states SET consumed_at=?, verifier_ciphertext='', return_to='/' WHERE state_hash=? AND provider=? AND consumed_at IS NULL").bind(nowIso(),stateHash,p.id).run();if((claimed.meta?.changes??0)!==1)throw new Error("OAuth state is invalid or expired");const body=new URLSearchParams({client_id:p.clientId,client_secret:p.clientSecret,code,redirect_uri:`${base}/api/auth/${p.id}/callback`,code_verifier:row.verifier_ciphertext,grant_type:"authorization_code"});const tokenResponse=await fetch(p.tokenUrl,{method:"POST",headers:{accept:"application/json","content-type":"application/x-www-form-urlencoded"},body});if(!tokenResponse.ok)throw new Error("OAuth token exchange failed");const tokens=await tokenResponse.json() as {access_token?:string;id_token?:string};if(p.id==="google"){if(!tokens.id_token)throw new Error("Google did not return an ID token");const jwks=createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));const {payload}=await jwtVerify(tokens.id_token,jwks,{audience:p.clientId,issuer:["https://accounts.google.com","accounts.google.com"]});const email=String(payload.email??"");if(!payload.sub||!email)throw new Error("Google identity lacks required claims");return{profile:{provider:p.id,subject:payload.sub,email,displayName:String(payload.name??email)},returnTo:row.return_to}}if(!tokens.access_token)throw new Error("GitHub did not return an access token");const headers={authorization:`Bearer ${tokens.access_token}`,accept:"application/vnd.github+json","user-agent":"Stowplan"};const [account,emails]=await Promise.all([fetch("https://api.github.com/user",{headers}).then(r=>r.json()) as Promise<{id:number;login:string;name?:string;email?:string}>,fetch("https://api.github.com/user/emails",{headers}).then(r=>r.json()) as Promise<{email:string;primary:boolean;verified:boolean}[]>]);const email=account.email??emails.find(x=>x.primary&&x.verified)?.email??emails.find(x=>x.verified)?.email;if(!email)throw new Error("GitHub account has no verified email");return{profile:{provider:p.id,subject:String(account.id),email,displayName:account.name??account.login},returnTo:row.return_to}}
export async function verifyAccess(env:RuntimeEnv,assertion:string):Promise<ProviderProfile>{if(!env.AUTH_CLOUDFLARE_ACCESS_TEAM_DOMAIN||!env.AUTH_CLOUDFLARE_ACCESS_AUD)throw new Error("Cloudflare Access is not configured");const domain=env.AUTH_CLOUDFLARE_ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//,"").replace(/\/$/,"");const jwks=createRemoteJWKSet(new URL(`https://${domain}/cdn-cgi/access/certs`));const {payload}=await jwtVerify(assertion,jwks,{audience:env.AUTH_CLOUDFLARE_ACCESS_AUD,issuer:`https://${domain}`});const email=String(payload.email??"");if(!payload.sub||!email)throw new Error("Access assertion lacks identity claims");return{provider:"cloudflare-access",subject:payload.sub,email,displayName:String(payload.name??email)}}
