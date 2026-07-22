import type { D1DatabaseLike } from "../adapters/d1-snapshot-store";
import { newId, nowIso } from "../domain/factories";

interface Statement {
  bind(...values: unknown[]): Statement;
  all<T>(): Promise<{ results: T[] }>;
  first<T>(): Promise<T | null>;
  run(): Promise<{ success: boolean; meta?: { changes?: number } }>;
}
type Db = { prepare(query: string): Statement };

export async function adminOverview(database: D1DatabaseLike) {
  const db = database as unknown as Db;
  const [users, identities, memberships, sessions, links, audit] = await Promise.all([
    db.prepare("SELECT user_id,email,display_name,global_role,status,created_at,last_seen_at FROM users ORDER BY created_at DESC LIMIT 250").all<Record<string, unknown>>(),
    db.prepare("SELECT i.identity_id,i.user_id,u.email AS user_email,i.provider,i.provider_subject,i.email,i.created_at,i.last_used_at FROM identities i JOIN users u ON u.user_id=i.user_id ORDER BY i.last_used_at DESC LIMIT 500").all<Record<string, unknown>>(),
    db.prepare("SELECT m.workspace_id,m.user_id,u.email,m.role,m.created_at FROM workspace_members m JOIN users u ON u.user_id=m.user_id ORDER BY m.workspace_id,u.email LIMIT 500").all<Record<string, unknown>>(),
    db.prepare("SELECT s.session_id,s.user_id,u.email,s.created_at,s.expires_at,s.last_seen_at,s.revoked_at FROM sessions s JOIN users u ON u.user_id=s.user_id ORDER BY s.created_at DESC LIMIT 250").all<Record<string, unknown>>(),
    db.prepare("SELECT guest_link_id,workspace_id,role,created_at,expires_at,consumed_at,revoked_at FROM guest_links ORDER BY created_at DESC LIMIT 250").all<Record<string, unknown>>(),
    db.prepare("SELECT event_id,actor_user_id,action,target_type,target_id,detail_json,created_at FROM auth_audit_events ORDER BY created_at DESC LIMIT 250").all<Record<string, unknown>>(),
  ]);
  return { users: users.results, identities: identities.results, memberships: memberships.results, sessions: sessions.results, guestLinks: links.results, audit: audit.results };
}

export async function audit(database: D1DatabaseLike, actor: string, action: string, targetType: string, targetId: string | null, detail: Record<string, unknown> = {}) {
  const db = database as unknown as Db;
  await db.prepare("INSERT INTO auth_audit_events(event_id,actor_user_id,action,target_type,target_id,detail_json,created_at) VALUES(?,?,?,?,?,?,?)").bind(newId("aud"), actor, action, targetType, targetId, JSON.stringify(detail), nowIso()).run();
}

async function requireAnotherActiveAdmin(db: Db, targetId: string) {
  const target = await db.prepare("SELECT global_role,status FROM users WHERE user_id=?").bind(targetId).first<{ global_role: string; status: string }>();
  if (!target) throw new Error("User was not found");
  if (target.global_role !== "admin" || target.status !== "active") return;
  const count = await db.prepare("SELECT COUNT(*) AS count FROM users WHERE global_role='admin' AND status='active'").first<{ count: number }>();
  if ((count?.count ?? 0) <= 1) throw new Error("The last active administrator cannot be removed or disabled");
}
function membershipTarget(targetId: string) {
  const [workspaceId, userId, ...rest] = targetId.split("::");
  if (!workspaceId || !userId || rest.length) throw new Error("Invalid membership target");
  return { workspaceId, userId };
}
async function requireAnotherOwner(db: Db, workspaceId: string, userId: string) {
  const current = await db.prepare("SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?").bind(workspaceId, userId).first<{ role: string }>();
  if (!current) throw new Error("Workspace membership was not found");
  if (current.role !== "owner") return;
  const count = await db.prepare("SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id=? AND role='owner'").bind(workspaceId).first<{ count: number }>();
  if ((count?.count ?? 0) <= 1) throw new Error("A workspace must retain at least one owner");
}

export async function adminMutation(database: D1DatabaseLike, actor: string, input: { action: string; targetId: string; value?: string }) {
  const db = database as unknown as Db;
  const now = nowIso();
  switch (input.action) {
    case "user.role":
      if (!["admin", "user"].includes(input.value ?? "")) throw new Error("Invalid role");
      if (input.value === "user") await requireAnotherActiveAdmin(db, input.targetId);
      await db.prepare("UPDATE users SET global_role=?,updated_at=? WHERE user_id=?").bind(input.value, now, input.targetId).run();
      break;
    case "user.status":
      if (!["active", "disabled"].includes(input.value ?? "")) throw new Error("Invalid status");
      if (input.value === "disabled") await requireAnotherActiveAdmin(db, input.targetId);
      await db.prepare("UPDATE users SET status=?,updated_at=? WHERE user_id=?").bind(input.value, now, input.targetId).run();
      break;
    case "identity.unlink": {
      const identity = await db.prepare("SELECT user_id FROM identities WHERE identity_id=?").bind(input.targetId).first<{ user_id: string }>();
      if (!identity) throw new Error("Identity was not found");
      const count = await db.prepare("SELECT COUNT(*) AS count FROM identities WHERE user_id=?").bind(identity.user_id).first<{ count: number }>();
      if ((count?.count ?? 0) <= 1) throw new Error("A user must retain at least one sign-in identity");
      await db.prepare("DELETE FROM identities WHERE identity_id=?").bind(input.targetId).run();
      break;
    }
    case "member.role": {
      if (!["owner", "editor", "viewer"].includes(input.value ?? "")) throw new Error("Invalid workspace role");
      const target = membershipTarget(input.targetId);
      if (input.value !== "owner") await requireAnotherOwner(db, target.workspaceId, target.userId);
      await db.prepare("UPDATE workspace_members SET role=? WHERE workspace_id=? AND user_id=?").bind(input.value, target.workspaceId, target.userId).run();
      break;
    }
    case "member.remove": {
      const target = membershipTarget(input.targetId);
      await requireAnotherOwner(db, target.workspaceId, target.userId);
      await db.prepare("DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?").bind(target.workspaceId, target.userId).run();
      break;
    }
    case "session.revoke":
      await db.prepare("UPDATE sessions SET revoked_at=? WHERE session_id=? AND revoked_at IS NULL").bind(now, input.targetId).run();
      break;
    case "guest.revoke":
      await db.prepare("UPDATE guest_links SET revoked_at=? WHERE guest_link_id=? AND revoked_at IS NULL").bind(now, input.targetId).run();
      break;
    default:
      throw new Error("Unsupported admin action");
  }
  await audit(database, actor, input.action, input.action.split(".")[0], input.targetId, { value: input.value });
}
