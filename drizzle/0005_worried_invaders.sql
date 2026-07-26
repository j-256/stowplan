CREATE TABLE `account_deletion_receipts` (
	`deletion_id` text PRIMARY KEY NOT NULL,
	`account_digest` text NOT NULL,
	`deleted_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_deletion_receipts_account_digest_idx` ON `account_deletion_receipts` (`account_digest`);--> statement-breakpoint
CREATE TABLE `circuit_breakers` (
	`scope` text PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`reason` text,
	`updated_at` text NOT NULL,
	`updated_by_user_id` text,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "circuit_breakers_scope_check" CHECK("circuit_breakers"."scope" in ('guest_links', 'guest_redemptions', 'new_accounts', 'new_workspaces', 'snapshot_growth')),
	CONSTRAINT "circuit_breakers_state_check" CHECK("circuit_breakers"."state" in ('open', 'paused'))
);
--> statement-breakpoint
CREATE TABLE `creation_ledger` (
	`event_id` text PRIMARY KEY NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text NOT NULL,
	`resource` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "creation_ledger_scope_type_check" CHECK("creation_ledger"."scope_type" in ('account', 'installation')),
	CONSTRAINT "creation_ledger_resource_check" CHECK("creation_ledger"."resource" in ('account', 'guest_link', 'session', 'workspace'))
);
--> statement-breakpoint
CREATE INDEX `creation_ledger_scope_resource_created_idx` ON `creation_ledger` (`scope_type`,`scope_id`,`resource`,`created_at`);--> statement-breakpoint
CREATE TABLE `governance_limits` (
	`limit_key` text PRIMARY KEY NOT NULL,
	`limit_value` integer NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by_user_id` text,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "governance_limits_key_check" CHECK("governance_limits"."limit_key" in ('new_accounts_per_day')),
	CONSTRAINT "governance_limits_value_check" CHECK("governance_limits"."limit_value" >= 0 and "governance_limits"."limit_value" <= 1000000)
);
--> statement-breakpoint
CREATE TABLE `identity_ban_digests` (
	`identity_digest` text PRIMARY KEY NOT NULL,
	`source_user_id` text,
	`reason` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by_user_id` text,
	`lifted_at` text,
	`lifted_by_user_id` text,
	FOREIGN KEY (`source_user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lifted_by_user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `identity_ban_digests_source_user_idx` ON `identity_ban_digests` (`source_user_id`);--> statement-breakpoint
CREATE TABLE `workspace_custody` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`custodian_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace_snapshots`(`workspace_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`custodian_user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workspace_custody_user_id_idx` ON `workspace_custody` (`custodian_user_id`);--> statement-breakpoint
DROP TRIGGER `workspace_members_insert_revisions`;--> statement-breakpoint
DROP TRIGGER `workspace_members_role_revisions`;--> statement-breakpoint
DROP TRIGGER `workspace_members_delete_revisions`;--> statement-breakpoint
DROP TRIGGER `guest_links_insert_access_revision`;--> statement-breakpoint
DROP TRIGGER `guest_links_update_access_revision`;--> statement-breakpoint
DROP TRIGGER `guest_links_delete_access_revision`;--> statement-breakpoint
DROP TRIGGER `workspace_snapshots_access_revision_insert_guard`;--> statement-breakpoint
DROP TRIGGER `workspace_snapshots_access_revision_update_guard`;--> statement-breakpoint
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__stowplan_auth_audit_events_backup` AS
SELECT * FROM `auth_audit_events`;--> statement-breakpoint
CREATE TABLE `__stowplan_guest_links_backup` AS
SELECT * FROM `guest_links`;--> statement-breakpoint
CREATE TABLE `__stowplan_identities_backup` AS
SELECT * FROM `identities`;--> statement-breakpoint
CREATE TABLE `__stowplan_sessions_backup` AS
SELECT * FROM `sessions`;--> statement-breakpoint
CREATE TABLE `__stowplan_workspace_members_backup` AS
SELECT * FROM `workspace_members`;--> statement-breakpoint
DROP TABLE `auth_audit_events`;--> statement-breakpoint
DROP TABLE `guest_links`;--> statement-breakpoint
DROP TABLE `identities`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
DROP TABLE `workspace_members`;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`user_id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`global_role` text DEFAULT 'user' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`account_revision` integer DEFAULT 0 NOT NULL,
	`membership_revision` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_seen_at` text,
	`deleted_at` text,
	CONSTRAINT "users_global_role_check" CHECK("__new_users"."global_role" in ('admin', 'user')),
	CONSTRAINT "users_status_check" CHECK("__new_users"."status" in ('active', 'banned', 'disabled'))
);
--> statement-breakpoint
INSERT INTO `__new_users`("user_id", "email", "display_name", "global_role", "status", "account_revision", "membership_revision", "created_at", "updated_at", "last_seen_at", "deleted_at") SELECT "user_id", "email", "display_name", "global_role", "status", 0, "membership_revision", "created_at", "updated_at", "last_seen_at", NULL FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
SELECT 1;--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_idx` ON `users` (lower("email"));--> statement-breakpoint
CREATE TABLE `auth_audit_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`detail_json` text NOT NULL,
	`created_at` text NOT NULL,
	`ip_prefix` text,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "auth_audit_detail_json_check" CHECK(json_valid("auth_audit_events"."detail_json"))
);
--> statement-breakpoint
INSERT INTO `auth_audit_events`
SELECT * FROM `__stowplan_auth_audit_events_backup`;--> statement-breakpoint
CREATE INDEX `auth_audit_created_at_idx` ON `auth_audit_events` ("created_at" desc);--> statement-breakpoint
CREATE INDEX `auth_audit_actor_idx` ON `auth_audit_events` (`actor_user_id`);--> statement-breakpoint
CREATE TABLE `guest_links` (
	`guest_link_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`revoked_at` text,
	`redemption_id` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace_snapshots`(`workspace_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "guest_links_role_check" CHECK("guest_links"."role" in ('editor', 'viewer'))
);
--> statement-breakpoint
INSERT INTO `guest_links`
SELECT * FROM `__stowplan_guest_links_backup`;--> statement-breakpoint
CREATE UNIQUE INDEX `guest_links_token_hash_idx` ON `guest_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `guest_links_workspace_id_idx` ON `guest_links` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `guest_links_expires_at_idx` ON `guest_links` (`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `guest_links_redemption_id_idx` ON `guest_links` (`redemption_id`);--> statement-breakpoint
CREATE TABLE `identities` (
	`identity_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_subject` text NOT NULL,
	`email` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `identities`
SELECT * FROM `__stowplan_identities_backup`;--> statement-breakpoint
CREATE INDEX `identities_user_id_idx` ON `identities` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `identities_provider_subject_idx` ON `identities` (`provider`,`provider_subject`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`revoked_at` text,
	`user_agent` text,
	`ip_prefix` text,
	`replaced_by_session_id` text,
	`reauthenticated_at` text,
	`authentication_provider` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `sessions`(
	`session_id`,
	`user_id`,
	`token_hash`,
	`created_at`,
	`expires_at`,
	`last_seen_at`,
	`revoked_at`,
	`user_agent`,
	`ip_prefix`,
	`replaced_by_session_id`,
	`reauthenticated_at`,
	`authentication_provider`
)
SELECT
	`session_id`,
	`user_id`,
	`token_hash`,
	`created_at`,
	`expires_at`,
	`last_seen_at`,
	`revoked_at`,
	`user_agent`,
	`ip_prefix`,
	NULL,
	NULL,
	NULL
FROM `__stowplan_sessions_backup`;--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_idx` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_at_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace_snapshots`(`workspace_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workspace_members_role_check" CHECK("workspace_members"."role" in ('owner', 'editor', 'viewer'))
);
--> statement-breakpoint
INSERT INTO `workspace_members`
SELECT * FROM `__stowplan_workspace_members_backup`;--> statement-breakpoint
CREATE INDEX `workspace_members_user_id_idx` ON `workspace_members` (`user_id`);--> statement-breakpoint
DROP TABLE `__stowplan_auth_audit_events_backup`;--> statement-breakpoint
DROP TABLE `__stowplan_guest_links_backup`;--> statement-breakpoint
DROP TABLE `__stowplan_identities_backup`;--> statement-breakpoint
DROP TABLE `__stowplan_sessions_backup`;--> statement-breakpoint
DROP TABLE `__stowplan_workspace_members_backup`;--> statement-breakpoint
ALTER TABLE `workspace_snapshots` ADD `stored_bytes` integer DEFAULT 0 NOT NULL
	CONSTRAINT "workspace_snapshots_stored_bytes_check" CHECK(`stored_bytes` >= 0);--> statement-breakpoint
UPDATE `workspace_snapshots`
SET `stored_bytes` = length(CAST(`state_json` AS BLOB));--> statement-breakpoint
INSERT INTO `workspace_custody`(
	`workspace_id`,
	`custodian_user_id`,
	`created_at`,
	`updated_at`
)
SELECT
	snapshot.`workspace_id`,
	(
		SELECT owner.`user_id`
		FROM `workspace_members` owner
		WHERE owner.`workspace_id` = snapshot.`workspace_id`
			AND owner.`role` = 'owner'
		ORDER BY owner.`created_at`, owner.`user_id`
		LIMIT 1
	),
	snapshot.`created_at`,
	snapshot.`updated_at`
FROM `workspace_snapshots` snapshot
WHERE EXISTS (
	SELECT 1
	FROM `workspace_members` owner
	WHERE owner.`workspace_id` = snapshot.`workspace_id`
		AND owner.`role` = 'owner'
);--> statement-breakpoint
INSERT INTO `creation_ledger`(
	`event_id`,
	`scope_type`,
	`scope_id`,
	`resource`,
	`created_at`
)
SELECT
	'account:' || `user_id`,
	'installation',
	'installation',
	'account',
	`created_at`
FROM `users`;--> statement-breakpoint
INSERT INTO `creation_ledger`(
	`event_id`,
	`scope_type`,
	`scope_id`,
	`resource`,
	`created_at`
)
SELECT
	'workspace:' || `workspace_id`,
	'account',
	`custodian_user_id`,
	'workspace',
	`created_at`
FROM `workspace_custody`;--> statement-breakpoint
INSERT INTO `creation_ledger`(
	`event_id`,
	`scope_type`,
	`scope_id`,
	`resource`,
	`created_at`
)
SELECT
	'session:' || `session_id`,
	'account',
	`user_id`,
	'session',
	`created_at`
FROM `sessions`;--> statement-breakpoint
INSERT INTO `creation_ledger`(
	`event_id`,
	`scope_type`,
	`scope_id`,
	`resource`,
	`created_at`
)
SELECT
	'guest_link:' || `guest_link_id`,
	'account',
	`created_by_user_id`,
	'guest_link',
	`created_at`
FROM `guest_links`;--> statement-breakpoint
INSERT INTO `circuit_breakers`(
	`scope`,
	`state`,
	`reason`,
	`updated_at`,
	`updated_by_user_id`
)
VALUES
	('guest_links', 'open', NULL, '1970-01-01T00:00:00.000Z', NULL),
	('guest_redemptions', 'open', NULL, '1970-01-01T00:00:00.000Z', NULL),
	('new_accounts', 'open', NULL, '1970-01-01T00:00:00.000Z', NULL),
	('new_workspaces', 'open', NULL, '1970-01-01T00:00:00.000Z', NULL),
	('snapshot_growth', 'open', NULL, '1970-01-01T00:00:00.000Z', NULL);--> statement-breakpoint
INSERT INTO `governance_limits`(
	`limit_key`,
	`limit_value`,
	`updated_at`,
	`updated_by_user_id`
)
VALUES (
	'new_accounts_per_day',
	25,
	'1970-01-01T00:00:00.000Z',
	NULL
);--> statement-breakpoint
CREATE TRIGGER `workspace_snapshots_access_revision_insert_guard`
BEFORE INSERT ON `workspace_snapshots`
WHEN typeof(NEW.`access_revision`) <> 'integer'
	OR NEW.`access_revision` < 0
	OR NEW.`access_revision` > 9007199254740991
BEGIN
	SELECT RAISE(
		ABORT,
		'workspace access revision must remain JavaScript-safe and monotonic'
	);
END;--> statement-breakpoint
CREATE TRIGGER `workspace_snapshots_access_revision_update_guard`
BEFORE UPDATE OF `access_revision` ON `workspace_snapshots`
WHEN typeof(NEW.`access_revision`) <> 'integer'
	OR NEW.`access_revision` < 0
	OR NEW.`access_revision` < OLD.`access_revision`
	OR NEW.`access_revision` > 9007199254740991
BEGIN
	SELECT RAISE(
		ABORT,
		'workspace access revision must remain JavaScript-safe and monotonic'
	);
END;--> statement-breakpoint
CREATE TRIGGER `users_membership_revision_insert_guard`
BEFORE INSERT ON `users`
WHEN typeof(NEW.`account_revision`) <> 'integer'
	OR NEW.`account_revision` < 0
	OR NEW.`account_revision` > 9007199254740991
	OR typeof(NEW.`membership_revision`) <> 'integer'
	OR NEW.`membership_revision` < 0
	OR NEW.`membership_revision` > 9007199254740991
BEGIN
	SELECT RAISE(
		ABORT,
		'user membership revision must remain JavaScript-safe and monotonic'
	);
END;--> statement-breakpoint
CREATE TRIGGER `users_account_revision_update_guard`
BEFORE UPDATE OF `account_revision` ON `users`
WHEN typeof(NEW.`account_revision`) <> 'integer'
	OR NEW.`account_revision` < 0
	OR NEW.`account_revision` < OLD.`account_revision`
	OR NEW.`account_revision` > 9007199254740991
BEGIN
	SELECT RAISE(
		ABORT,
		'user account revision must remain JavaScript-safe and monotonic'
	);
END;--> statement-breakpoint
CREATE TRIGGER `users_membership_revision_update_guard`
BEFORE UPDATE OF `membership_revision` ON `users`
WHEN typeof(NEW.`membership_revision`) <> 'integer'
	OR NEW.`membership_revision` < 0
	OR NEW.`membership_revision` < OLD.`membership_revision`
	OR NEW.`membership_revision` > 9007199254740991
BEGIN
	SELECT RAISE(
		ABORT,
		'user membership revision must remain JavaScript-safe and monotonic'
	);
END;--> statement-breakpoint
CREATE TRIGGER `users_account_revision_updates`
AFTER UPDATE OF `email`, `display_name`, `global_role`, `status`, `deleted_at`
ON `users`
WHEN OLD.`email` IS NOT NEW.`email`
	OR OLD.`display_name` IS NOT NEW.`display_name`
	OR OLD.`global_role` IS NOT NEW.`global_role`
	OR OLD.`status` IS NOT NEW.`status`
	OR OLD.`deleted_at` IS NOT NEW.`deleted_at`
BEGIN
	UPDATE `users`
	SET `account_revision` = `account_revision` + 1
	WHERE `user_id` = NEW.`user_id`;
END;--> statement-breakpoint
CREATE TRIGGER `identities_insert_account_revision`
AFTER INSERT ON `identities`
BEGIN
	UPDATE `users`
	SET `account_revision` = `account_revision` + 1
	WHERE `user_id` = NEW.`user_id`;
END;--> statement-breakpoint
CREATE TRIGGER `identities_update_account_revision`
AFTER UPDATE OF `user_id`, `provider`, `provider_subject`, `email`
ON `identities`
WHEN OLD.`user_id` IS NOT NEW.`user_id`
	OR OLD.`provider` IS NOT NEW.`provider`
	OR OLD.`provider_subject` IS NOT NEW.`provider_subject`
	OR OLD.`email` IS NOT NEW.`email`
BEGIN
	UPDATE `users`
	SET `account_revision` = `account_revision` + 1
	WHERE `user_id` IN (OLD.`user_id`, NEW.`user_id`);
END;--> statement-breakpoint
CREATE TRIGGER `identities_delete_account_revision`
AFTER DELETE ON `identities`
BEGIN
	UPDATE `users`
	SET `account_revision` = `account_revision` + 1
	WHERE `user_id` = OLD.`user_id`;
END;--> statement-breakpoint
CREATE TRIGGER `users_status_revisions`
AFTER UPDATE OF `status` ON `users`
WHEN OLD.`status` IS NOT NEW.`status`
BEGIN
	UPDATE `users`
	SET `membership_revision` = `membership_revision` + 1
	WHERE `user_id` = NEW.`user_id`;

	UPDATE `workspace_snapshots`
	SET `access_revision` = `access_revision` + 1
	WHERE `workspace_id` IN (
		SELECT `workspace_id`
		FROM `workspace_members`
		WHERE `user_id` = NEW.`user_id`
	);
END;--> statement-breakpoint
CREATE TRIGGER `workspace_members_insert_revisions`
AFTER INSERT ON `workspace_members`
BEGIN
	UPDATE `users`
	SET `membership_revision` = `membership_revision` + 1
	WHERE `user_id` = NEW.`user_id`;

	UPDATE `workspace_snapshots`
	SET `access_revision` = `access_revision` + 1
	WHERE `workspace_id` = NEW.`workspace_id`;
END;--> statement-breakpoint
CREATE TRIGGER `workspace_members_role_revisions`
AFTER UPDATE OF `role` ON `workspace_members`
WHEN OLD.`role` IS NOT NEW.`role`
BEGIN
	UPDATE `users`
	SET `membership_revision` = `membership_revision` + 1
	WHERE `user_id` = NEW.`user_id`;

	UPDATE `workspace_snapshots`
	SET `access_revision` = `access_revision` + 1
	WHERE `workspace_id` = NEW.`workspace_id`;
END;--> statement-breakpoint
CREATE TRIGGER `workspace_members_delete_revisions`
AFTER DELETE ON `workspace_members`
BEGIN
	UPDATE `users`
	SET `membership_revision` = `membership_revision` + 1
	WHERE `user_id` = OLD.`user_id`;

	UPDATE `workspace_snapshots`
	SET `access_revision` = `access_revision` + 1
	WHERE `workspace_id` = OLD.`workspace_id`;
END;--> statement-breakpoint
CREATE TRIGGER `guest_links_insert_access_revision`
AFTER INSERT ON `guest_links`
BEGIN
	UPDATE `workspace_snapshots`
	SET `access_revision` = `access_revision` + 1
	WHERE `workspace_id` = NEW.`workspace_id`;
END;--> statement-breakpoint
CREATE TRIGGER `guest_links_update_access_revision`
AFTER UPDATE OF `role`, `expires_at`, `consumed_at`, `revoked_at`
ON `guest_links`
WHEN OLD.`role` IS NOT NEW.`role`
	OR OLD.`expires_at` IS NOT NEW.`expires_at`
	OR OLD.`consumed_at` IS NOT NEW.`consumed_at`
	OR OLD.`revoked_at` IS NOT NEW.`revoked_at`
BEGIN
	UPDATE `workspace_snapshots`
	SET `access_revision` = `access_revision` + 1
	WHERE `workspace_id` = NEW.`workspace_id`;
END;--> statement-breakpoint
CREATE TRIGGER `guest_links_delete_access_revision`
AFTER DELETE ON `guest_links`
BEGIN
	UPDATE `workspace_snapshots`
	SET `access_revision` = `access_revision` + 1
	WHERE `workspace_id` = OLD.`workspace_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `users_last_admin_role_guard`
BEFORE UPDATE OF `global_role` ON `users`
WHEN OLD.`global_role` = 'admin'
	AND OLD.`status` = 'active'
	AND OLD.`deleted_at` IS NULL
	AND NEW.`global_role` <> 'admin'
	AND (
		SELECT COUNT(*)
		FROM `users`
		WHERE `global_role` = 'admin'
			AND `status` = 'active'
			AND `deleted_at` IS NULL
	) <= 1
BEGIN
	SELECT RAISE(ABORT, 'the last active administrator must be retained');
END;--> statement-breakpoint
CREATE TRIGGER `users_last_admin_status_guard`
BEFORE UPDATE OF `status`, `deleted_at` ON `users`
WHEN OLD.`global_role` = 'admin'
	AND OLD.`status` = 'active'
	AND OLD.`deleted_at` IS NULL
	AND (
		NEW.`status` <> 'active'
		OR NEW.`deleted_at` IS NOT NULL
	)
	AND (
		SELECT COUNT(*)
		FROM `users`
		WHERE `global_role` = 'admin'
			AND `status` = 'active'
			AND `deleted_at` IS NULL
	) <= 1
BEGIN
	SELECT RAISE(ABORT, 'the last active administrator must be retained');
END;--> statement-breakpoint
CREATE TRIGGER `users_final_owner_status_guard`
BEFORE UPDATE OF `status`, `deleted_at` ON `users`
WHEN OLD.`status` = 'active'
	AND OLD.`deleted_at` IS NULL
	AND (
		NEW.`status` <> 'active'
		OR NEW.`deleted_at` IS NOT NULL
	)
	AND EXISTS (
		SELECT 1
		FROM `workspace_members` owned
		WHERE owned.`user_id` = OLD.`user_id`
			AND owned.`role` = 'owner'
			AND NOT EXISTS (
				SELECT 1
				FROM `workspace_deletions` deleted
				WHERE deleted.`workspace_id` = owned.`workspace_id`
			)
			AND NOT EXISTS (
				SELECT 1
				FROM `workspace_members` other
				JOIN `users` other_user
					ON other_user.`user_id` = other.`user_id`
				WHERE other.`workspace_id` = owned.`workspace_id`
					AND other.`user_id` <> OLD.`user_id`
					AND other.`role` = 'owner'
					AND other_user.`status` = 'active'
					AND other_user.`deleted_at` IS NULL
			)
	)
BEGIN
	SELECT RAISE(ABORT, 'the last active workspace owner must be retained');
END;--> statement-breakpoint
CREATE TRIGGER `users_last_admin_delete_guard`
BEFORE DELETE ON `users`
WHEN OLD.`global_role` = 'admin'
	AND OLD.`status` = 'active'
	AND OLD.`deleted_at` IS NULL
	AND (
		SELECT COUNT(*)
		FROM `users`
		WHERE `global_role` = 'admin'
			AND `status` = 'active'
			AND `deleted_at` IS NULL
	) <= 1
BEGIN
	SELECT RAISE(ABORT, 'the last active administrator must be retained');
END;--> statement-breakpoint
CREATE TRIGGER `auth_audit_routine_detail_retention`
AFTER INSERT ON `auth_audit_events`
BEGIN
	UPDATE `auth_audit_events`
	SET `detail_json` = '{}'
	WHERE `event_id` IN (
		SELECT `event_id`
		FROM `auth_audit_events`
		WHERE `action` IN ('session.issue', 'session.revoke')
			AND `detail_json` <> '{}'
			AND julianday(`created_at`) <=
				julianday(NEW.`created_at`) - 180
		ORDER BY `created_at`, `event_id`
		LIMIT 100
	);
END;--> statement-breakpoint
CREATE TRIGGER `users_public_creation_guard`
BEFORE INSERT ON `users`
WHEN julianday(NEW.`created_at`) >= julianday('now') - (1.0 / 24)
	AND (
	COALESCE(
		(
			SELECT `state`
			FROM `circuit_breakers`
			WHERE `scope` = 'new_accounts'
		),
		'paused'
	) <> 'open'
	OR (
		SELECT COUNT(*)
		FROM `creation_ledger`
		WHERE `scope_type` = 'installation'
			AND `scope_id` = 'installation'
			AND `resource` = 'account'
			AND date(`created_at`) = date(NEW.`created_at`)
	) >= COALESCE(
		(
			SELECT `limit_value`
			FROM `governance_limits`
			WHERE `limit_key` = 'new_accounts_per_day'
		),
		0
	)
	)
BEGIN
	SELECT RAISE(ABORT, 'new account creation is temporarily unavailable');
END;--> statement-breakpoint
CREATE TRIGGER `users_public_creation_ledger`
AFTER INSERT ON `users`
BEGIN
	INSERT INTO `creation_ledger`(
		`event_id`,
		`scope_type`,
		`scope_id`,
		`resource`,
		`created_at`
	)
	VALUES (
		'account:' || NEW.`user_id`,
		'installation',
		'installation',
		'account',
		NEW.`created_at`
	);
END;--> statement-breakpoint
CREATE TRIGGER `workspace_snapshots_stored_bytes_insert`
AFTER INSERT ON `workspace_snapshots`
BEGIN
	UPDATE `workspace_snapshots`
	SET `stored_bytes` = length(CAST(NEW.`state_json` AS BLOB))
	WHERE `workspace_id` = NEW.`workspace_id`;
END;--> statement-breakpoint
CREATE TRIGGER `workspace_snapshots_account_storage_guard`
BEFORE UPDATE OF `state_json` ON `workspace_snapshots`
WHEN length(CAST(NEW.`state_json` AS BLOB)) > OLD.`stored_bytes`
	AND EXISTS (
		SELECT 1
		FROM `workspace_custody` custody
		WHERE custody.`workspace_id` = OLD.`workspace_id`
	)
	AND (
		SELECT COALESCE(SUM(snapshot.`stored_bytes`), 0)
		FROM `workspace_custody` custody
		JOIN `workspace_snapshots` snapshot
			ON snapshot.`workspace_id` = custody.`workspace_id`
		WHERE custody.`custodian_user_id` = (
			SELECT owner.`custodian_user_id`
			FROM `workspace_custody` owner
			WHERE owner.`workspace_id` = OLD.`workspace_id`
		)
	) - OLD.`stored_bytes` +
		length(CAST(NEW.`state_json` AS BLOB)) > 8000000
BEGIN
	SELECT RAISE(ABORT, 'account snapshot storage quota exceeded');
END;--> statement-breakpoint
CREATE TRIGGER `workspace_snapshots_stored_bytes_update`
AFTER UPDATE OF `state_json` ON `workspace_snapshots`
BEGIN
	UPDATE `workspace_snapshots`
	SET `stored_bytes` = length(CAST(NEW.`state_json` AS BLOB))
	WHERE `workspace_id` = NEW.`workspace_id`;
END;--> statement-breakpoint
CREATE TRIGGER `workspace_custody_insert_guard`
BEFORE INSERT ON `workspace_custody`
WHEN COALESCE(
		(
			SELECT `state`
			FROM `circuit_breakers`
			WHERE `scope` = 'new_workspaces'
		),
		'paused'
	) <> 'open'
	OR NOT EXISTS (
		SELECT 1
		FROM `users`
		WHERE `user_id` = NEW.`custodian_user_id`
			AND `status` = 'active'
			AND `deleted_at` IS NULL
	)
	OR (
		SELECT COUNT(*)
		FROM `workspace_custody`
		WHERE `custodian_user_id` = NEW.`custodian_user_id`
	) >= 5
	OR (
		SELECT COALESCE(SUM(snapshot.`stored_bytes`), 0)
		FROM `workspace_custody` custody
		JOIN `workspace_snapshots` snapshot
			ON snapshot.`workspace_id` = custody.`workspace_id`
		WHERE custody.`custodian_user_id` = NEW.`custodian_user_id`
	) + COALESCE(
		(
			SELECT `stored_bytes`
			FROM `workspace_snapshots`
			WHERE `workspace_id` = NEW.`workspace_id`
		),
		0
	) > 8000000
	OR (
		SELECT COUNT(*)
		FROM `creation_ledger`
		WHERE `scope_type` = 'account'
			AND `scope_id` = NEW.`custodian_user_id`
			AND `resource` = 'workspace'
			AND date(`created_at`) = date(NEW.`created_at`)
	) >= 5
	OR (
		SELECT COUNT(*)
		FROM `creation_ledger`
		WHERE `scope_type` = 'account'
			AND `scope_id` = NEW.`custodian_user_id`
			AND `resource` = 'workspace'
			AND julianday(`created_at`) >
				julianday(NEW.`created_at`) - 30
	) >= 20
	OR (
		SELECT COUNT(*)
		FROM `creation_ledger`
		WHERE `scope_type` = 'account'
			AND `scope_id` = NEW.`custodian_user_id`
			AND `resource` = 'workspace'
	) >= 100
BEGIN
	SELECT RAISE(ABORT, 'new workspace allocation is unavailable');
END;--> statement-breakpoint
CREATE TRIGGER `workspace_custody_insert_ledger`
AFTER INSERT ON `workspace_custody`
BEGIN
	INSERT INTO `creation_ledger`(
		`event_id`,
		`scope_type`,
		`scope_id`,
		`resource`,
		`created_at`
	)
	VALUES (
		'workspace:' || NEW.`workspace_id`,
		'account',
		NEW.`custodian_user_id`,
		'workspace',
		NEW.`created_at`
	);
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_custody_transfer_guard`
BEFORE UPDATE OF `custodian_user_id` ON `workspace_custody`
WHEN OLD.`custodian_user_id` IS NOT NEW.`custodian_user_id`
	AND (
		NOT EXISTS (
			SELECT 1
			FROM `users`
			WHERE `user_id` = NEW.`custodian_user_id`
				AND `status` = 'active'
				AND `deleted_at` IS NULL
		)
		OR (
			SELECT COUNT(*)
			FROM `workspace_custody`
			WHERE `custodian_user_id` = NEW.`custodian_user_id`
				AND `workspace_id` <> OLD.`workspace_id`
		) >= 5
		OR (
			SELECT COALESCE(SUM(snapshot.`stored_bytes`), 0)
			FROM `workspace_custody` custody
			JOIN `workspace_snapshots` snapshot
				ON snapshot.`workspace_id` = custody.`workspace_id`
			WHERE custody.`custodian_user_id` = NEW.`custodian_user_id`
				AND custody.`workspace_id` <> OLD.`workspace_id`
		) + (
			SELECT `stored_bytes`
			FROM `workspace_snapshots`
			WHERE `workspace_id` = OLD.`workspace_id`
		) > 8000000
	)
BEGIN
	SELECT RAISE(ABORT, 'workspace custody recipient lacks capacity');
END;--> statement-breakpoint
CREATE TRIGGER `workspace_members_account_quota_guard`
BEFORE INSERT ON `workspace_members`
WHEN NOT EXISTS (
		SELECT 1
		FROM `users`
		WHERE `user_id` = NEW.`user_id`
			AND `status` = 'active'
			AND `deleted_at` IS NULL
	)
	OR (
		NOT EXISTS (
			SELECT 1
			FROM `workspace_members` existing
			WHERE existing.`workspace_id` = NEW.`workspace_id`
				AND existing.`user_id` = NEW.`user_id`
		)
		AND (
			SELECT COUNT(*)
			FROM `workspace_members`
			WHERE `user_id` = NEW.`user_id`
		) >= 25
	)
BEGIN
	SELECT RAISE(ABORT, 'account membership quota exceeded');
END;--> statement-breakpoint
CREATE TRIGGER `workspace_members_assign_initial_custody`
AFTER INSERT ON `workspace_members`
WHEN NEW.`role` = 'owner'
	AND NOT EXISTS (
		SELECT 1
		FROM `workspace_custody`
		WHERE `workspace_id` = NEW.`workspace_id`
	)
BEGIN
	INSERT INTO `workspace_custody`(
		`workspace_id`,
		`custodian_user_id`,
		`created_at`,
		`updated_at`
	)
	VALUES (
		NEW.`workspace_id`,
		NEW.`user_id`,
		NEW.`created_at`,
		NEW.`created_at`
	);
END;--> statement-breakpoint
CREATE TRIGGER `sessions_public_issuance_guard`
BEFORE INSERT ON `sessions`
WHEN julianday(NEW.`created_at`) >= julianday('now') - (1.0 / 24)
	AND (
	NOT EXISTS (
		SELECT 1
		FROM `users`
		WHERE `user_id` = NEW.`user_id`
			AND `status` = 'active'
			AND `deleted_at` IS NULL
	)
	OR (
		SELECT COUNT(*)
		FROM `creation_ledger`
		WHERE `scope_type` = 'account'
			AND `scope_id` = NEW.`user_id`
			AND `resource` = 'session'
			AND date(`created_at`) = date(NEW.`created_at`)
	) >= 12
	OR (
		SELECT COUNT(*)
		FROM `creation_ledger`
		WHERE `scope_type` = 'account'
			AND `scope_id` = NEW.`user_id`
			AND `resource` = 'session'
			AND julianday(`created_at`) >
				julianday(NEW.`created_at`) - 30
	) >= 60
	)
BEGIN
	SELECT RAISE(ABORT, 'session issuance budget exceeded');
END;--> statement-breakpoint
CREATE TRIGGER `sessions_public_issuance_ledger`
AFTER INSERT ON `sessions`
BEGIN
	INSERT INTO `creation_ledger`(
		`event_id`,
		`scope_type`,
		`scope_id`,
		`resource`,
		`created_at`
	)
	VALUES (
		'session:' || NEW.`session_id`,
		'account',
		NEW.`user_id`,
		'session',
		NEW.`created_at`
	);

	DELETE FROM `creation_ledger`
	WHERE `scope_type` = 'account'
		AND `scope_id` = NEW.`user_id`
		AND `resource` = 'session'
		AND julianday(`created_at`) <=
			julianday(NEW.`created_at`) - 31;

	UPDATE `sessions`
	SET
		`revoked_at` = NEW.`created_at`,
		`replaced_by_session_id` = NEW.`session_id`
	WHERE `session_id` IN (
		SELECT `session_id`
		FROM `sessions`
		WHERE `user_id` = NEW.`user_id`
			AND `session_id` <> NEW.`session_id`
			AND `revoked_at` IS NULL
			AND `expires_at` > NEW.`created_at`
		ORDER BY `created_at` DESC, `rowid` DESC
		LIMIT -1 OFFSET 7
	);

	DELETE FROM `sessions`
	WHERE `user_id` = NEW.`user_id`
		AND `session_id` <> NEW.`session_id`
		AND (
			`revoked_at` IS NOT NULL
			OR `expires_at` <= NEW.`created_at`
		)
		AND (
			julianday(COALESCE(`revoked_at`, `expires_at`)) <=
				julianday(NEW.`created_at`) - 30
			OR `session_id` IN (
				SELECT terminal.`session_id`
				FROM `sessions` terminal
				WHERE terminal.`user_id` = NEW.`user_id`
					AND terminal.`session_id` <> NEW.`session_id`
					AND (
						terminal.`revoked_at` IS NOT NULL
						OR terminal.`expires_at` <= NEW.`created_at`
					)
				ORDER BY
					COALESCE(
						terminal.`revoked_at`,
						terminal.`expires_at`
					) DESC,
					terminal.`session_id` DESC
				LIMIT -1 OFFSET 32
			)
		);
END;--> statement-breakpoint
CREATE TRIGGER `guest_links_public_creation_guard`
BEFORE INSERT ON `guest_links`
WHEN julianday(NEW.`created_at`) >= julianday('now') - (1.0 / 24)
	AND (
	COALESCE(
		(
			SELECT `state`
			FROM `circuit_breakers`
			WHERE `scope` = 'guest_links'
		),
		'paused'
	) <> 'open'
	OR NOT EXISTS (
		SELECT 1
		FROM `users`
		WHERE `user_id` = NEW.`created_by_user_id`
			AND `status` = 'active'
			AND `deleted_at` IS NULL
	)
	OR (
		SELECT COUNT(*)
		FROM `creation_ledger`
		WHERE `scope_type` = 'account'
			AND `scope_id` = NEW.`created_by_user_id`
			AND `resource` = 'guest_link'
			AND date(`created_at`) = date(NEW.`created_at`)
	) >= 10
	OR (
		SELECT COUNT(*)
		FROM `creation_ledger`
		WHERE `scope_type` = 'account'
			AND `scope_id` = NEW.`created_by_user_id`
			AND `resource` = 'guest_link'
			AND julianday(`created_at`) >
				julianday(NEW.`created_at`) - 30
	) >= 50
	)
BEGIN
	SELECT RAISE(ABORT, 'guest link creation is temporarily unavailable');
END;--> statement-breakpoint
CREATE TRIGGER `guest_links_public_creation_ledger`
AFTER INSERT ON `guest_links`
BEGIN
	INSERT INTO `creation_ledger`(
		`event_id`,
		`scope_type`,
		`scope_id`,
		`resource`,
		`created_at`
	)
	VALUES (
		'guest_link:' || NEW.`guest_link_id`,
		'account',
		NEW.`created_by_user_id`,
		'guest_link',
		NEW.`created_at`
	);

	DELETE FROM `creation_ledger`
	WHERE `scope_type` = 'account'
		AND `scope_id` = NEW.`created_by_user_id`
		AND `resource` = 'guest_link'
		AND julianday(`created_at`) <=
			julianday(NEW.`created_at`) - 31;
END;--> statement-breakpoint
CREATE TRIGGER `guest_links_public_redemption_guard`
BEFORE UPDATE OF `consumed_at` ON `guest_links`
WHEN OLD.`consumed_at` IS NULL
	AND NEW.`consumed_at` IS NOT NULL
	AND COALESCE(
		(
			SELECT `state`
			FROM `circuit_breakers`
			WHERE `scope` = 'guest_redemptions'
		),
		'paused'
	) <> 'open'
BEGIN
	SELECT RAISE(ABORT, 'guest link redemption is temporarily unavailable');
END;
