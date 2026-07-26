ALTER TABLE `circuit_breakers`
ADD `pause_kind` text DEFAULT 'security' NOT NULL
CHECK (`pause_kind` in ('capacity', 'security'));--> statement-breakpoint
ALTER TABLE `circuit_breakers`
ADD `resume_at` text;--> statement-breakpoint
ALTER TABLE `circuit_breakers`
ADD `trigger_count` integer DEFAULT 0 NOT NULL
CHECK (`trigger_count` >= 0);--> statement-breakpoint
UPDATE `circuit_breakers`
SET `pause_kind` = 'capacity'
WHERE `scope` IN ('new_workspaces', 'snapshot_growth');--> statement-breakpoint
CREATE TRIGGER `workspace_snapshots_growth_guard`
BEFORE UPDATE OF `state_json` ON `workspace_snapshots`
WHEN length(CAST(NEW.`state_json` AS BLOB)) > OLD.`stored_bytes`
	AND COALESCE(
		(
			SELECT CASE
				WHEN `state` = 'paused'
					AND `pause_kind` = 'security'
					AND `resume_at` IS NOT NULL
					AND `resume_at` <= NEW.`updated_at`
				THEN 'open'
				ELSE `state`
			END
			FROM `circuit_breakers`
			WHERE `scope` = 'snapshot_growth'
		),
		'paused'
	) <> 'open'
BEGIN
	SELECT RAISE(ABORT, 'snapshot growth is temporarily unavailable');
END;--> statement-breakpoint
DROP TRIGGER `users_public_creation_guard`;--> statement-breakpoint
CREATE TRIGGER `users_public_creation_guard`
BEFORE INSERT ON `users`
WHEN julianday(NEW.`created_at`) >= julianday('now') - (1.0 / 24)
	AND (
	COALESCE(
		(
			SELECT CASE
				WHEN `state` = 'paused'
					AND `pause_kind` = 'security'
					AND `resume_at` IS NOT NULL
					AND `resume_at` <= NEW.`created_at`
				THEN 'open'
				ELSE `state`
			END
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
DROP TRIGGER `workspace_custody_insert_guard`;--> statement-breakpoint
CREATE TRIGGER `workspace_custody_insert_guard`
BEFORE INSERT ON `workspace_custody`
WHEN COALESCE(
		(
			SELECT CASE
				WHEN `state` = 'paused'
					AND `pause_kind` = 'security'
					AND `resume_at` IS NOT NULL
					AND `resume_at` <= NEW.`created_at`
				THEN 'open'
				ELSE `state`
			END
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
DROP TRIGGER `guest_links_public_creation_guard`;--> statement-breakpoint
CREATE TRIGGER `guest_links_public_creation_guard`
BEFORE INSERT ON `guest_links`
WHEN julianday(NEW.`created_at`) >= julianday('now') - (1.0 / 24)
	AND (
	COALESCE(
		(
			SELECT CASE
				WHEN `state` = 'paused'
					AND `pause_kind` = 'security'
					AND `resume_at` IS NOT NULL
					AND `resume_at` <= NEW.`created_at`
				THEN 'open'
				ELSE `state`
			END
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
DROP TRIGGER `guest_links_public_redemption_guard`;--> statement-breakpoint
CREATE TRIGGER `guest_links_public_redemption_guard`
BEFORE UPDATE OF `consumed_at` ON `guest_links`
WHEN OLD.`consumed_at` IS NULL
	AND NEW.`consumed_at` IS NOT NULL
	AND COALESCE(
		(
			SELECT CASE
				WHEN `state` = 'paused'
					AND `pause_kind` = 'security'
					AND `resume_at` IS NOT NULL
					AND `resume_at` <= NEW.`consumed_at`
				THEN 'open'
				ELSE `state`
			END
			FROM `circuit_breakers`
			WHERE `scope` = 'guest_redemptions'
		),
		'paused'
	) <> 'open'
BEGIN
	SELECT RAISE(ABORT, 'guest link redemption is temporarily unavailable');
END;
