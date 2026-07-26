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
  storedBytes: integer("stored_bytes").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("workspace_snapshots_revision_check", sql`${table.revision} >= 0`),
  check(
    "workspace_snapshots_stored_bytes_check",
    sql`${table.storedBytes} >= 0`,
  ),
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
  status: text("status", { enum: ["active", "banned", "disabled"] })
    .notNull()
    .default("active"),
  accountRevision: integer("account_revision").notNull().default(0),
  membershipRevision: integer("membership_revision").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastSeenAt: text("last_seen_at"),
  deletedAt: text("deleted_at"),
}, (table) => [
  check("users_global_role_check", sql`${table.globalRole} in ('admin', 'user')`),
  check(
    "users_status_check",
    sql`${table.status} in ('active', 'banned', 'disabled')`,
  ),
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

export const workspaceCustody = sqliteTable("workspace_custody", {
  workspaceId: text("workspace_id").primaryKey().references(
    () => workspaceSnapshots.workspaceId,
    { onDelete: "cascade" },
  ),
  custodianUserId: text("custodian_user_id").notNull().references(
    () => users.userId,
  ),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("workspace_custody_user_id_idx").on(table.custodianUserId),
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
  replacedBySessionId: text("replaced_by_session_id"),
  reauthenticatedAt: text("reauthenticated_at"),
  authenticationProvider: text("authentication_provider"),
}, (table) => [
  uniqueIndex("sessions_token_hash_idx").on(table.tokenHash),
  index("sessions_user_id_idx").on(table.userId),
  index("sessions_expires_at_idx").on(table.expiresAt),
]);

export const creationLedger = sqliteTable("creation_ledger", {
  eventId: text("event_id").primaryKey(),
  scopeType: text("scope_type", { enum: ["account", "installation"] })
    .notNull(),
  scopeId: text("scope_id").notNull(),
  resource: text("resource", {
    enum: ["account", "guest_link", "session", "workspace"],
  }).notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  check(
    "creation_ledger_scope_type_check",
    sql`${table.scopeType} in ('account', 'installation')`,
  ),
  check(
    "creation_ledger_resource_check",
    sql`${table.resource} in ('account', 'guest_link', 'session', 'workspace')`,
  ),
  index("creation_ledger_scope_resource_created_idx").on(
    table.scopeType,
    table.scopeId,
    table.resource,
    table.createdAt,
  ),
]);

export const circuitBreakers = sqliteTable("circuit_breakers", {
  scope: text("scope", {
    enum: [
      "guest_links",
      "guest_redemptions",
      "new_accounts",
      "new_workspaces",
      "snapshot_growth",
    ],
  }).primaryKey(),
  state: text("state", { enum: ["open", "paused"] })
    .notNull()
    .default("open"),
  reason: text("reason"),
  updatedAt: text("updated_at").notNull(),
  updatedByUserId: text("updated_by_user_id").references(
    () => users.userId,
  ),
  pauseKind: text("pause_kind", {
    enum: ["capacity", "security"],
  }).notNull().default("security"),
  resumeAt: text("resume_at"),
  triggerCount: integer("trigger_count").notNull().default(0),
}, (table) => [
  check(
    "circuit_breakers_scope_check",
    sql`${table.scope} in ('guest_links', 'guest_redemptions', 'new_accounts', 'new_workspaces', 'snapshot_growth')`,
  ),
  check(
    "circuit_breakers_state_check",
    sql`${table.state} in ('open', 'paused')`,
  ),
  check(
    "circuit_breakers_pause_kind_check",
    sql`${table.pauseKind} in ('capacity', 'security')`,
  ),
  check(
    "circuit_breakers_trigger_count_check",
    sql`${table.triggerCount} >= 0`,
  ),
]);

export const governanceLimits = sqliteTable("governance_limits", {
  limitKey: text("limit_key", {
    enum: ["new_accounts_per_day"],
  }).primaryKey(),
  limitValue: integer("limit_value").notNull(),
  updatedAt: text("updated_at").notNull(),
  updatedByUserId: text("updated_by_user_id").references(
    () => users.userId,
  ),
}, (table) => [
  check(
    "governance_limits_key_check",
    sql`${table.limitKey} in ('new_accounts_per_day')`,
  ),
  check(
    "governance_limits_value_check",
    sql`${table.limitValue} >= 0 and ${table.limitValue} <= 1000000`,
  ),
]);

export const identityBanDigests = sqliteTable("identity_ban_digests", {
  identityDigest: text("identity_digest").primaryKey(),
  sourceUserId: text("source_user_id").references(
    () => users.userId,
  ),
  reason: text("reason").notNull(),
  createdAt: text("created_at").notNull(),
  createdByUserId: text("created_by_user_id").references(
    () => users.userId,
  ),
  liftedAt: text("lifted_at"),
  liftedByUserId: text("lifted_by_user_id").references(
    () => users.userId,
  ),
}, (table) => [
  index("identity_ban_digests_source_user_idx").on(table.sourceUserId),
]);

export const accountDeletionReceipts = sqliteTable(
  "account_deletion_receipts",
  {
    deletionId: text("deletion_id").primaryKey(),
    accountDigest: text("account_digest").notNull(),
    deletedAt: text("deleted_at").notNull(),
  },
  table => [
    uniqueIndex("account_deletion_receipts_account_digest_idx").on(
      table.accountDigest,
    ),
  ],
);

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
