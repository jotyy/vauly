CREATE TABLE `proposal` (
	`id` text PRIMARY KEY,
	`agent_id` text NOT NULL,
	`item_id` text,
	`sealed` text,
	`count` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`result_item_id` text,
	`decided_by` text,
	`decided_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	CONSTRAINT `fk_proposal_agent_id_agent_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_proposal_item_id_item_id_fk` FOREIGN KEY (`item_id`) REFERENCES `item`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `proposal_rule` (
	`agent_id` text PRIMARY KEY,
	`vault_id` text NOT NULL,
	`sealed` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	CONSTRAINT `fk_proposal_rule_agent_id_agent_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_proposal_rule_vault_id_vault_id_fk` FOREIGN KEY (`vault_id`) REFERENCES `vault`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `agent` ADD `rule_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `proposal_agent_idx` ON `proposal` (`agent_id`,`status`);