import { createRemoteJWKSet, jwtVerify } from "jose";
import type {
  D1DatabaseLike,
  D1ResultLike,
  D1StatementLike,
} from "../adapters/d1-snapshot-store";
import { newId, nowIso } from "../domain/factories";
import type { RuntimeEnv } from "./runtime";

interface Statement extends D1StatementLike {
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
}
interface AuthDb extends D1DatabaseLike {
  prepare(query: string): Statement;
}
export interface SessionUser { userId:string; email:string; displayName:string; globalRole:"admin"|"user"; expiresAt:string }
export interface ProviderProfile { provider:string; subject:string; email:string; displayName:string }

export const AUTH_CLEANUP_BATCH_SIZE = 64;
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
      `DELETE FROM workspace_members
       WHERE (workspace_id, user_id) IN (
         SELECT members.workspace_id, members.user_id
         FROM workspace_members members
         WHERE EXISTS (
           SELECT 1
           FROM identities
           WHERE identities.user_id = members.user_id
             AND identities.provider = 'guest'
         )
           AND NOT EXISTS (
             SELECT 1
             FROM sessions
             WHERE sessions.user_id = members.user_id
               AND sessions.revoked_at IS NULL
               AND sessions.expires_at > ?
           )
         ORDER BY members.created_at
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
  if (results.length !== 5 || results.some((result) => !result.success)) {
    throw new Error("Authentication record cleanup did not complete");
  }
  return {
    sessions: resultChanges(results[0]),
    oauthStates: resultChanges(results[1]),
    guestMemberships: resultChanges(results[2]),
    guestUsers: resultChanges(results[3]),
    guestLinks: resultChanges(results[4]),
  };
}

async function maintainAuthRecords(db: AuthDb): Promise<void> {
  await cleanupAuthRecords(db).catch(() => undefined);
}

export class AuthorizationError extends Error {
 constructor(message:string,readonly status:401|403){super(message);this.name="AuthorizationError"}
}

export function sessionCookie(raw:string,maxAge:number){return `stowplan_session=${raw}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`}
export function clearSessionCookie(){return "stowplan_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"}
export function cookieValue(request:Request,name:string){return request.headers.get("cookie")?.split(";").map(x=>x.trim()).find(x=>x.startsWith(`${name}=`))?.slice(name.length+1)??null}

export async function createOrLinkUser(db:AuthDb,env:RuntimeEnv,profile:ProviderProfile):Promise<SessionUser>{
 const email=normalize(profile.email),now=nowIso();
 const existingIdentity=await db.prepare("SELECT u.user_id,u.email,u.display_name,u.global_role,u.status FROM identities i JOIN users u ON u.user_id=i.user_id WHERE i.provider=? AND i.provider_subject=?").bind(profile.provider,profile.subject).first<{user_id:string;email:string;display_name:string;global_role:"admin"|"user";status:string}>();
 if(existingIdentity){if(existingIdentity.status!=="active")throw new Error("Account is disabled");await db.prepare("UPDATE identities SET last_used_at=? WHERE provider=? AND provider_subject=?").bind(now,profile.provider,profile.subject).run();return {userId:existingIdentity.user_id,email:existingIdentity.email,displayName:existingIdentity.display_name,globalRole:existingIdentity.global_role,expiresAt:""}}
 let user=await db.prepare("SELECT user_id,email,display_name,global_role,status FROM users WHERE email=? COLLATE NOCASE").bind(email).first<{user_id:string;email:string;display_name:string;global_role:"admin"|"user";status:string}>();
 if(!user){const count=await db.prepare("SELECT COUNT(*) AS count FROM users").first<{count:number}>();const role=(count?.count===0||adminEmails(env).has(email))?"admin":"user";const id=newId("usr");await db.prepare("INSERT INTO users(user_id,email,display_name,global_role,status,created_at,updated_at,last_seen_at) VALUES(?,?,?,?, 'active',?,?,?)").bind(id,email,profile.displayName,role,now,now,now).run();user={user_id:id,email,display_name:profile.displayName,global_role:role,status:"active"}}
 if(user.status!=="active")throw new Error("Account is disabled");
 await db.prepare("INSERT INTO identities(identity_id,user_id,provider,provider_subject,email,created_at,last_used_at) VALUES(?,?,?,?,?,?,?)").bind(newId("idn"),user.user_id,profile.provider,profile.subject,email,now,now).run();
 return {userId:user.user_id,email:user.email,displayName:user.display_name,globalRole:user.global_role,expiresAt:""};
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
  await db.prepare(
    `INSERT INTO sessions(
       session_id, user_id, token_hash, created_at, expires_at, last_seen_at,
       user_agent, ip_prefix
     ) VALUES(?,?,?,?,?,?,?,?)`,
  ).bind(
    session.sessionId,
    user.userId,
    session.tokenHash,
    session.createdAt,
    session.expiresAt,
    session.lastSeenAt,
    session.userAgent,
    session.ipPrefix,
  ).run();
  return { raw: session.raw, maxAge: session.maxAge };
}
export async function authenticate(db:AuthDb,request:Request):Promise<SessionUser|null>{const raw=cookieValue(request,"stowplan_session");if(!raw)return null;const row=await db.prepare("SELECT u.user_id,u.email,u.display_name,u.global_role,u.status,s.expires_at FROM sessions s JOIN users u ON u.user_id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>?").bind(await hash(raw),nowIso()).first<{user_id:string;email:string;display_name:string;global_role:"admin"|"user";status:string;expires_at:string}>();if(!row||row.status!=="active")return null;return {userId:row.user_id,email:row.email,displayName:row.display_name,globalRole:row.global_role,expiresAt:row.expires_at}}
export async function authorizeAdmin(db:AuthDb,env:RuntimeEnv,request:Request):Promise<SessionUser>{
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
 const origin=request.headers.get("origin");if(!origin)return true;
 const requestUrl=new URL(request.url),allowed=new Set([requestUrl.origin]);
 const forwardedHost=request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()??request.headers.get("host");
 const forwardedProtocol=request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim()??requestUrl.protocol.slice(0,-1);
 if(forwardedHost&&/^(https?)$/.test(forwardedProtocol))allowed.add(`${forwardedProtocol}://${forwardedHost}`);
 if(configuredBaseUrl){try{allowed.add(new URL(configuredBaseUrl).origin)}catch{return false}}
 try{return allowed.has(new URL(origin).origin)}catch{return false}
}
export async function workspaceRole(db:AuthDb,userId:string,workspaceId:string){const row=await db.prepare("SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?").bind(workspaceId,userId).first<{role:"owner"|"editor"|"viewer"}>();return row?.role??null}
export async function canReadWorkspace(db:AuthDb,userId:string,workspaceId:string){return (await workspaceRole(db,userId,workspaceId))!==null}
export async function revokeCurrentSession(db:AuthDb,request:Request){const raw=cookieValue(request,"stowplan_session");if(raw)await db.prepare("UPDATE sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL").bind(nowIso(),await hash(raw)).run()}
export async function canWriteWorkspace(db:AuthDb,userId:string,workspaceId:string){const role=await workspaceRole(db,userId,workspaceId);return role==="owner"||role==="editor"}
export async function canOwnWorkspace(db:AuthDb,userId:string,workspaceId:string){return await workspaceRole(db,userId,workspaceId)==="owner"}
export async function claimWorkspace(db:AuthDb,userId:string,workspaceId:string){await db.prepare("INSERT OR IGNORE INTO workspace_members(workspace_id,user_id,role,created_at) VALUES(?,?, 'owner',?)").bind(workspaceId,userId,nowIso()).run()}
export async function createGuestLink(db:AuthDb,workspaceId:string,creator:string,role:"editor"|"viewer",hours=24){await maintainAuthRecords(db);const raw=token(),id=newId("guest"),now=nowIso(),end=new Date(Date.now()+Math.max(1,Math.min(168,hours))*3_600_000).toISOString();await db.prepare("INSERT INTO guest_links(guest_link_id,workspace_id,created_by_user_id,token_hash,role,created_at,expires_at) VALUES(?,?,?,?,?,?,?)").bind(id,workspaceId,creator,await hash(raw),role,now,end).run();return{id,raw,expiresAt:end}}
export async function consumeGuestLink(db:AuthDb,env:RuntimeEnv,raw:string,request:Request){
 await maintainAuthRecords(db);
 const now=nowIso(),row=await db.prepare("SELECT guest_link_id,workspace_id,role,expires_at FROM guest_links WHERE token_hash=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?").bind(await hash(raw),now).first<{guest_link_id:string;workspace_id:string;role:"editor"|"viewer";expires_at:string}>();
 if(!row)throw new Error("Guest link is invalid, expired, used, or revoked");
 const redemptionId=newId("redemption"),userId=newId("usr"),email=`guest+${row.guest_link_id}@stowplan.invalid`;
 const maxAge=Math.max(1,Math.min(86400,Math.floor((Date.parse(row.expires_at)-Date.now())/1000)));
 const session=await createSessionRecord(env,request,maxAge);
 const results=await db.batch([
  db.prepare("UPDATE guest_links SET consumed_at=?,redemption_id=? WHERE guest_link_id=? AND consumed_at IS NULL AND revoked_at IS NULL AND redemption_id IS NULL AND expires_at>?").bind(now,redemptionId,row.guest_link_id,now),
  db.prepare("INSERT INTO users(user_id,email,display_name,global_role,status,created_at,updated_at,last_seen_at) SELECT ?,?,'Guest','user','active',?,?,? FROM guest_links WHERE guest_link_id=? AND redemption_id=?").bind(userId,email,now,now,now,row.guest_link_id,redemptionId),
  db.prepare("INSERT INTO identities(identity_id,user_id,provider,provider_subject,email,created_at,last_used_at) SELECT ?,?,'guest',?,?,?,? FROM guest_links WHERE guest_link_id=? AND redemption_id=?").bind(newId("idn"),userId,row.guest_link_id,email,now,now,row.guest_link_id,redemptionId),
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,created_at) SELECT workspace_id,?,role,? FROM guest_links WHERE guest_link_id=? AND redemption_id=?").bind(userId,now,row.guest_link_id,redemptionId),
  db.prepare("INSERT INTO sessions(session_id,user_id,token_hash,created_at,expires_at,last_seen_at,user_agent,ip_prefix) SELECT ?,?,?,?,?,?,?,? FROM guest_links WHERE guest_link_id=? AND redemption_id=?").bind(session.sessionId,userId,session.tokenHash,session.createdAt,session.expiresAt,session.lastSeenAt,session.userAgent,session.ipPrefix,row.guest_link_id,redemptionId),
 ]);
 if(results.length!==5||results.some((result)=>resultChanges(result)!==1))throw new Error("Guest link is invalid, expired, used, or revoked");
 return{session:{raw:session.raw,maxAge:session.maxAge},workspaceId:row.workspace_id}
}

export interface OAuthProvider { id:"google"|"github"; authorizationUrl:string; tokenUrl:string; scopes:string; clientId:string; clientSecret:string }
export function provider(env:RuntimeEnv,id:string):OAuthProvider|null {if(id==="google"&&env.AUTH_GOOGLE_CLIENT_ID&&env.AUTH_GOOGLE_CLIENT_SECRET)return{id,authorizationUrl:"https://accounts.google.com/o/oauth2/v2/auth",tokenUrl:"https://oauth2.googleapis.com/token",scopes:"openid email profile",clientId:env.AUTH_GOOGLE_CLIENT_ID,clientSecret:env.AUTH_GOOGLE_CLIENT_SECRET};if(id==="github"&&env.AUTH_GITHUB_CLIENT_ID&&env.AUTH_GITHUB_CLIENT_SECRET)return{id,authorizationUrl:"https://github.com/login/oauth/authorize",tokenUrl:"https://github.com/login/oauth/access_token",scopes:"read:user user:email",clientId:env.AUTH_GITHUB_CLIENT_ID,clientSecret:env.AUTH_GITHUB_CLIENT_SECRET};return null}
function b64url(data:Uint8Array){return btoa(String.fromCharCode(...data)).replaceAll("+","-").replaceAll("/","_").replaceAll("=","")}
export async function beginOAuth(db:AuthDb,p:OAuthProvider,base:string,returnTo:string){await maintainAuthRecords(db);const state=token(),verifier=b64url(bytes(48)),challenge=b64url(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier)))),end=new Date(Date.now()+10*60_000).toISOString();await db.prepare("INSERT INTO oauth_states(state_hash,provider,verifier_ciphertext,return_to,created_at,expires_at) VALUES(?,?,?,?,?,?)").bind(await hash(state),p.id,verifier,returnTo,nowIso(),end).run();const u=new URL(p.authorizationUrl);u.searchParams.set("client_id",p.clientId);u.searchParams.set("redirect_uri",`${base}/api/auth/${p.id}/callback`);u.searchParams.set("response_type","code");u.searchParams.set("scope",p.scopes);u.searchParams.set("state",state);u.searchParams.set("code_challenge",challenge);u.searchParams.set("code_challenge_method","S256");return u.toString()}
export async function finishOAuth(db:AuthDb,p:OAuthProvider,base:string,state:string,code:string):Promise<{profile:ProviderProfile;returnTo:string}>{const stateHash=await hash(state),row=await db.prepare("SELECT verifier_ciphertext,return_to FROM oauth_states WHERE state_hash=? AND provider=? AND consumed_at IS NULL AND expires_at>?").bind(stateHash,p.id,nowIso()).first<{verifier_ciphertext:string;return_to:string}>();if(!row)throw new Error("OAuth state is invalid or expired");const claimed=await db.prepare("UPDATE oauth_states SET consumed_at=? WHERE state_hash=? AND provider=? AND consumed_at IS NULL").bind(nowIso(),stateHash,p.id).run();if((claimed.meta?.changes??0)!==1)throw new Error("OAuth state is invalid or expired");const body=new URLSearchParams({client_id:p.clientId,client_secret:p.clientSecret,code,redirect_uri:`${base}/api/auth/${p.id}/callback`,code_verifier:row.verifier_ciphertext,grant_type:"authorization_code"});const tokenResponse=await fetch(p.tokenUrl,{method:"POST",headers:{accept:"application/json","content-type":"application/x-www-form-urlencoded"},body});if(!tokenResponse.ok)throw new Error("OAuth token exchange failed");const tokens=await tokenResponse.json() as {access_token?:string;id_token?:string};if(p.id==="google"){if(!tokens.id_token)throw new Error("Google did not return an ID token");const jwks=createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));const {payload}=await jwtVerify(tokens.id_token,jwks,{audience:p.clientId,issuer:["https://accounts.google.com","accounts.google.com"]});const email=String(payload.email??"");if(!payload.sub||!email)throw new Error("Google identity lacks required claims");return{profile:{provider:p.id,subject:payload.sub,email,displayName:String(payload.name??email)},returnTo:row.return_to}}if(!tokens.access_token)throw new Error("GitHub did not return an access token");const headers={authorization:`Bearer ${tokens.access_token}`,accept:"application/vnd.github+json","user-agent":"Stowplan"};const [account,emails]=await Promise.all([fetch("https://api.github.com/user",{headers}).then(r=>r.json()) as Promise<{id:number;login:string;name?:string;email?:string}>,fetch("https://api.github.com/user/emails",{headers}).then(r=>r.json()) as Promise<{email:string;primary:boolean;verified:boolean}[]>]);const email=account.email??emails.find(x=>x.primary&&x.verified)?.email??emails.find(x=>x.verified)?.email;if(!email)throw new Error("GitHub account has no verified email");return{profile:{provider:p.id,subject:String(account.id),email,displayName:account.name??account.login},returnTo:row.return_to}}
export async function verifyAccess(env:RuntimeEnv,assertion:string):Promise<ProviderProfile>{if(!env.AUTH_CLOUDFLARE_ACCESS_TEAM_DOMAIN||!env.AUTH_CLOUDFLARE_ACCESS_AUD)throw new Error("Cloudflare Access is not configured");const domain=env.AUTH_CLOUDFLARE_ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//,"").replace(/\/$/,"");const jwks=createRemoteJWKSet(new URL(`https://${domain}/cdn-cgi/access/certs`));const {payload}=await jwtVerify(assertion,jwks,{audience:env.AUTH_CLOUDFLARE_ACCESS_AUD,issuer:`https://${domain}`});const email=String(payload.email??"");if(!payload.sub||!email)throw new Error("Access assertion lacks identity claims");return{provider:"cloudflare-access",subject:payload.sub,email,displayName:String(payload.name??email)}}
