import { desc, sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const MAX_SAFE_AUTHORIZATION_REVISION_SQL = sql.raw(
  String(Number.MAX_SAFE_INTEGER),
);

export const workspaceSnapshots = sqliteTable("workspace_snapshots", {
  workspaceId: text("workspace_id").primaryKey(),
  revision: integer("revision").notNull(),
  accessRevision: integer("access_revision").notNull().default(0),
  stateJson: text("state_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("workspace_snapshots_revision_check", sql`${table.revision} >= 0`),
  check("workspace_snapshots_state_json_check", sql`json_valid(${table.stateJson})`),
]);

export const stowplanMigrationStream = sqliteTable("stowplan_migration_stream", {
  id: integer("id").primaryKey(),
  stream: text("stream", { enum: ["numbered", "sites"] }).notNull(),
}, (table) => [
  check("stowplan_migration_stream_id_check", sql`${table.id} = 1`),
  check(
    "stowplan_migration_stream_value_check",
    sql`${table.stream} in ('numbered', 'sites')`,
  ),
]);

export const users = sqliteTable("users", {
  userId: text("user_id").primaryKey(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  globalRole: text("global_role", { enum: ["admin", "user"] })
    .notNull()
    .default("user"),
  status: text("status", { enum: ["active", "disabled"] })
    .notNull()
    .default("active"),
  membershipRevision: integer("membership_revision").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastSeenAt: text("last_seen_at"),
}, (table) => [
  check("users_global_role_check", sql`${table.globalRole} in ('admin', 'user')`),
  check("users_status_check", sql`${table.status} in ('active', 'disabled')`),
  uniqueIndex("users_email_idx").on(sql`lower(${table.email})`),
]);

export const identities = sqliteTable("identities", {
  identityId: text("identity_id").primaryKey(),
  userId: text("user_id").notNull().references(
    () => users.userId,
    { onDelete: "cascade" },
  ),
  provider: text("provider").notNull(),
  providerSubject: text("provider_subject").notNull(),
  email: text("email").notNull(),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at").notNull(),
}, (table) => [
  index("identities_user_id_idx").on(table.userId),
  uniqueIndex("identities_provider_subject_idx").on(
    table.provider,
    table.providerSubject,
  ),
]);

export const workspaceMembers = sqliteTable("workspace_members", {
  workspaceId: text("workspace_id").notNull().references(
    () => workspaceSnapshots.workspaceId,
    { onDelete: "cascade" },
  ),
  userId: text("user_id").notNull().references(
    () => users.userId,
    { onDelete: "cascade" },
  ),
  role: text("role", { enum: ["owner", "editor", "viewer"] }).notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.userId] }),
  check("workspace_members_role_check", sql`${table.role} in ('owner', 'editor', 'viewer')`),
  index("workspace_members_user_id_idx").on(table.userId),
]);

export const workspaceDeletions = sqliteTable("workspace_deletions", {
  workspaceId: text("workspace_id").primaryKey(),
  deletionId: text("deletion_id").notNull(),
  deletedAt: text("deleted_at").notNull(),
  deletedByUserId: text("deleted_by_user_id"),
  finalSnapshotRevision: integer("final_snapshot_revision").notNull(),
  finalAccessRevision: integer("final_access_revision").notNull(),
}, (table) => [
  check(
    "workspace_deletions_final_snapshot_revision_check",
    sql`${table.finalSnapshotRevision} >= 0 and ${table.finalSnapshotRevision} <= ${MAX_SAFE_AUTHORIZATION_REVISION_SQL}`,
  ),
  check(
    "workspace_deletions_final_access_revision_check",
    sql`${table.finalAccessRevision} >= 0 and ${table.finalAccessRevision} <= ${MAX_SAFE_AUTHORIZATION_REVISION_SQL}`,
  ),
  uniqueIndex("workspace_deletions_deletion_id_idx").on(table.deletionId),
]);

export const sessions = sqliteTable("sessions", {
  sessionId: text("session_id").primaryKey(),
  userId: text("user_id").notNull().references(
    () => users.userId,
    { onDelete: "cascade" },
  ),
  tokenHash: text("token_hash").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  revokedAt: text("revoked_at"),
  userAgent: text("user_agent"),
  ipPrefix: text("ip_prefix"),
}, (table) => [
  uniqueIndex("sessions_token_hash_idx").on(table.tokenHash),
  index("sessions_user_id_idx").on(table.userId),
  index("sessions_expires_at_idx").on(table.expiresAt),
]);

export const guestLinks = sqliteTable("guest_links", {
  guestLinkId: text("guest_link_id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(
    () => workspaceSnapshots.workspaceId,
    { onDelete: "cascade" },
  ),
  createdByUserId: text("created_by_user_id").notNull().references(
    () => users.userId,
  ),
  tokenHash: text("token_hash").notNull(),
  role: text("role", { enum: ["editor", "viewer"] }).notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  consumedAt: text("consumed_at"),
  revokedAt: text("revoked_at"),
  redemptionId: text("redemption_id"),
}, (table) => [
  check("guest_links_role_check", sql`${table.role} in ('editor', 'viewer')`),
  uniqueIndex("guest_links_token_hash_idx").on(table.tokenHash),
  uniqueIndex("guest_links_redemption_id_idx").on(table.redemptionId),
  index("guest_links_workspace_id_idx").on(table.workspaceId),
  index("guest_links_expires_at_idx").on(table.expiresAt),
]);

export const oauthStates = sqliteTable("oauth_states", {
  stateHash: text("state_hash").primaryKey(),
  provider: text("provider").notNull(),
  verifierCiphertext: text("verifier_ciphertext").notNull(),
  returnTo: text("return_to").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  consumedAt: text("consumed_at"),
}, (table) => [
  index("oauth_states_expires_at_idx").on(table.expiresAt),
]);

export const authAuditEvents = sqliteTable("auth_audit_events", {
  eventId: text("event_id").primaryKey(),
  actorUserId: text("actor_user_id").references(() => users.userId),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id"),
  detailJson: text("detail_json").notNull(),
  createdAt: text("created_at").notNull(),
  ipPrefix: text("ip_prefix"),
}, (table) => [
  check("auth_audit_detail_json_check", sql`json_valid(${table.detailJson})`),
  index("auth_audit_created_at_idx").on(desc(table.createdAt)),
  index("auth_audit_actor_idx").on(table.actorUserId),
]);
