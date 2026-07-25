import type { D1DatabaseLike } from "../adapters/d1-snapshot-store";

const SCHEMA_PROBE_QUERY = `
  SELECT
    EXISTS(
      SELECT workspace_id, revision, access_revision
      FROM workspace_snapshots
      WHERE revision >= 0
      LIMIT 1
    ) AS has_snapshots,
    EXISTS(
      SELECT user_id, membership_revision
      FROM users
      LIMIT 1
    ) AS has_users,
    EXISTS(
      SELECT identity_id
      FROM identities
      LIMIT 1
    ) AS has_identities,
    EXISTS(
      SELECT workspace_id, user_id, role
      FROM workspace_members
      LIMIT 1
    ) AS has_memberships,
    EXISTS(
      SELECT session_id, expires_at, revoked_at
      FROM sessions
      LIMIT 1
    ) AS has_sessions,
    EXISTS(
      SELECT guest_link_id, expires_at, consumed_at, revoked_at, redemption_id
      FROM guest_links
      LIMIT 1
    ) AS has_guest_links,
    EXISTS(
      SELECT state_hash, expires_at, consumed_at
      FROM oauth_states
      LIMIT 1
    ) AS has_oauth_states,
    EXISTS(
      SELECT event_id, detail_json
      FROM auth_audit_events
      LIMIT 1
    ) AS has_audit_events,
    EXISTS(
      SELECT workspace_id, deletion_id, final_snapshot_revision,
        final_access_revision
      FROM workspace_deletions
      LIMIT 1
    ) AS has_workspace_deletions
`;

export async function probeDatabaseSchema(
  database: D1DatabaseLike,
): Promise<void> {
  const result = await database.prepare(SCHEMA_PROBE_QUERY).first();
  if (!result) throw new Error("Database schema probe returned no result");
}
