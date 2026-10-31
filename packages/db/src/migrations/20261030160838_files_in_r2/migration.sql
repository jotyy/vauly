CREATE TABLE `file_purge` (
	`attachment_id` text PRIMARY KEY,
	`chunks` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `attachment` ADD `stored_in` text DEFAULT 'd1' NOT NULL;