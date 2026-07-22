"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface Overview {
  users: Record<string, unknown>[];
  identities: Record<string, unknown>[];
  memberships: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  guestLinks: Record<string, unknown>[];
  audit: Record<string, unknown>[];
}

export default function AdminPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    void fetch("/api/admin/overview", { cache: "no-store" }).then(async (response) => {
      const body = await response.json() as Overview & { error?: string };
      if (!response.ok) throw new Error(body.error);
      setData(body);
      setError("");
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load admin data"));
  }, []);
  useEffect(() => load(), [load]);
  const mutate = async (action: string, targetId: string, value?: string) => {
    const response = await fetch("/api/admin/mutate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, targetId, value }) });
    if (!response.ok) {
      const body = await response.json() as { error?: string };
      setError(body.error ?? "Admin mutation failed");
    } else load();
  };

  return <main className="admin-page"><header><div><p className="eyebrow">Server-enforced control plane</p><h1>Stowplan administration</h1></div><Link href="/">Back to organizer</Link></header>{error && <div className="admin-error">{error}</div>}{!data && !error && <p>Loading administrative records…</p>}{data && <>
    <section><h2>Users <small>{data.users.length}</small></h2><div className="admin-table">{data.users.map((user) => <div key={String(user.user_id)}><span><strong>{String(user.display_name)}</strong><small>{String(user.email)}</small></span><select aria-label={`Role for ${String(user.email)}`} value={String(user.global_role)} onChange={(event) => void mutate("user.role", String(user.user_id), event.target.value)}><option>user</option><option>admin</option></select><button onClick={() => void mutate("user.status", String(user.user_id), user.status === "active" ? "disabled" : "active")}>{user.status === "active" ? "Disable" : "Enable"}</button></div>)}</div></section>
    <section><h2>Linked identities <small>{data.identities.length}</small></h2><div className="admin-table">{data.identities.map((identity) => <div key={String(identity.identity_id)}><span><strong>{String(identity.provider)} · {String(identity.email)}</strong><small>User {String(identity.user_email)} · last used {new Date(String(identity.last_used_at)).toLocaleString()}</small></span><button className="danger" onClick={() => { if (confirm(`Unlink ${String(identity.provider)} identity ${String(identity.email)}?`)) void mutate("identity.unlink", String(identity.identity_id)); }}>Unlink</button></div>)}</div></section>
    <section><h2>Workspace access <small>{data.memberships.length}</small></h2><div className="admin-table">{data.memberships.map((membership) => { const target = `${String(membership.workspace_id)}::${String(membership.user_id)}`; return <div key={target}><span><strong>{String(membership.email)}</strong><small>{String(membership.workspace_id)}</small></span><select aria-label={`Workspace role for ${String(membership.email)}`} value={String(membership.role)} onChange={(event) => void mutate("member.role", target, event.target.value)}><option>viewer</option><option>editor</option><option>owner</option></select><button className="danger" onClick={() => { if (confirm(`Remove ${String(membership.email)} from this workspace?`)) void mutate("member.remove", target); }}>Remove</button></div>; })}</div></section>
    <section><h2>Sessions <small>{data.sessions.length}</small></h2><div className="admin-table">{data.sessions.map((session) => <div key={String(session.session_id)}><span><strong>{String(session.email)}</strong><small>Expires {new Date(String(session.expires_at)).toLocaleString()}</small></span><b>{session.revoked_at ? "revoked" : "active"}</b><button disabled={!!session.revoked_at} onClick={() => void mutate("session.revoke", String(session.session_id))}>Revoke</button></div>)}</div></section>
    <section><h2>Guest links <small>{data.guestLinks.length}</small></h2><div className="admin-table">{data.guestLinks.map((link) => <div key={String(link.guest_link_id)}><span><strong>{String(link.role)} · {String(link.workspace_id)}</strong><small>Expires {new Date(String(link.expires_at)).toLocaleString()}</small></span><b>{link.revoked_at ? "revoked" : link.consumed_at ? "used" : "available"}</b><button disabled={!!link.revoked_at} onClick={() => void mutate("guest.revoke", String(link.guest_link_id))}>Revoke</button></div>)}</div></section>
    <section><h2>Auth audit <small>{data.audit.length}</small></h2><div className="admin-table">{data.audit.map((event) => <div key={String(event.event_id)}><span><strong>{String(event.action)}</strong><small>{new Date(String(event.created_at)).toLocaleString()} · {String(event.target_type)} · {String(event.target_id ?? "")}</small></span></div>)}</div></section>
  </>}</main>;
}
