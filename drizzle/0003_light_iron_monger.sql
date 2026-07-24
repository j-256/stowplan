CREATE TABLE `stowplan_migration_stream` (
	`id` integer PRIMARY KEY NOT NULL,
	`stream` text NOT NULL,
	CONSTRAINT "stowplan_migration_stream_id_check" CHECK("stowplan_migration_stream"."id" = 1),
	CONSTRAINT "stowplan_migration_stream_value_check" CHECK("stowplan_migration_stream"."stream" in ('numbered', 'sites'))
);
--> statement-breakpoint
INSERT INTO `stowplan_migration_stream` (`id`, `stream`)
VALUES (1, 'sites');
