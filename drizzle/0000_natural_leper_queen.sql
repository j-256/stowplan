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
CREATE INDEX `auth_audit_created_at_idx` ON `auth_audit_events` (`created_at`);--> statement-breakpoint
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
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace_snapshots`(`workspace_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "guest_links_role_check" CHECK("guest_links"."role" in ('editor', 'viewer'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guest_links_token_hash_idx` ON `guest_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `guest_links_workspace_id_idx` ON `guest_links` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `guest_links_expires_at_idx` ON `guest_links` (`expires_at`);--> statement-breakpoint
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
CREATE INDEX `identities_user_id_idx` ON `identities` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `identities_provider_subject_idx` ON `identities` (`provider`,`provider_subject`);--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`verifier_ciphertext` text NOT NULL,
	`return_to` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text
);
--> statement-breakpoint
CREATE INDEX `oauth_states_expires_at_idx` ON `oauth_states` (`expires_at`);--> statement-breakpoint
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
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_idx` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_at_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`user_id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`global_role` text DEFAULT 'user' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_seen_at` text,
	CONSTRAINT "users_global_role_check" CHECK("users"."global_role" in ('admin', 'user')),
	CONSTRAINT "users_status_check" CHECK("users"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_idx` ON `users` (lower("email"));--> statement-breakpoint
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
CREATE INDEX `workspace_members_user_id_idx` ON `workspace_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `workspace_snapshots` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`state_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "workspace_snapshots_revision_check" CHECK("workspace_snapshots"."revision" >= 0),
	CONSTRAINT "workspace_snapshots_state_json_check" CHECK(json_valid("workspace_snapshots"."state_json"))
);
