CREATE TABLE `rate_limit` (
	`id` text PRIMARY KEY,
	`key` text NOT NULL UNIQUE,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `member` ADD `sign_in_wrong_tries` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `member` ADD `sign_in_next_try_at` integer;--> statement-breakpoint
ALTER TABLE `member` ADD `session_wrong_tries` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `member` ADD `session_next_try_at` integer;