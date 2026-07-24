DROP INDEX `auth_audit_created_at_idx`;--> statement-breakpoint
CREATE INDEX `auth_audit_created_at_idx` ON `auth_audit_events` ("created_at" desc);--> statement-breakpoint
ALTER TABLE `guest_links` ADD `redemption_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `guest_links_redemption_id_idx` ON `guest_links` (`redemption_id`);
