CREATE TABLE `rate_limit` (
	`id` text PRIMARY KEY,
	`key` text NOT NULL UNIQUE,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `member` ADD `wrong_tries` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `member` ADD `next_try_at` integer;