CREATE TABLE `workspace_deletions` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`deletion_id` text NOT NULL,
	`deleted_at` text NOT NULL,
	`deleted_by_user_id` text,
	`final_snapshot_revision` integer NOT NULL,
	`final_access_revision` integer NOT NULL,
	CONSTRAINT "workspace_deletions_final_snapshot_revision_check" CHECK("workspace_deletions"."final_snapshot_revision" >= 0 and "workspace_deletions"."final_snapshot_revision" <= 9007199254740991),
	CONSTRAINT "workspace_deletions_final_access_revision_check" CHECK("workspace_deletions"."final_access_revision" >= 0 and "workspace_deletions"."final_access_revision" <= 9007199254740991)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_deletions_deletion_id_idx` ON `workspace_deletions` (`deletion_id`);--> statement-breakpoint
ALTER TABLE `users` ADD `membership_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_snapshots` ADD `access_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
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
WHEN typeof(NEW.`membership_revision`) <> 'integer'
	OR NEW.`membership_revision` < 0
	OR NEW.`membership_revision` > 9007199254740991
BEGIN
	SELECT RAISE(
		ABORT,
		'user membership revision must remain JavaScript-safe and monotonic'
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
CREATE TRIGGER `workspace_members_identity_immutable`
BEFORE UPDATE OF `workspace_id`, `user_id` ON `workspace_members`
WHEN OLD.`workspace_id` IS NOT NEW.`workspace_id`
	OR OLD.`user_id` IS NOT NEW.`user_id`
BEGIN
	SELECT RAISE(ABORT, 'workspace membership identity is immutable');
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
AFTER UPDATE OF `role`, `expires_at`, `consumed_at`, `revoked_at` ON `guest_links`
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
