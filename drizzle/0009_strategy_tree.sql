CREATE TABLE `visions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`position` integer NOT NULL DEFAULT 0,
	`created_at` integer NOT NULL,
	CONSTRAINT `visions_name_trimmed_check` CHECK (`name` = trim(`name`)),
	CONSTRAINT `visions_name_not_empty_check` CHECK (length(`name`) > 0),
	CONSTRAINT `visions_position_check` CHECK (`position` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `visions_name_trim_unique` ON `visions` (trim(`name`));
--> statement-breakpoint
CREATE TABLE `strategic_intents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vision_id` integer NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`position` integer NOT NULL DEFAULT 0,
	`created_at` integer NOT NULL,
	CONSTRAINT `strategic_intents_name_trimmed_check` CHECK (`name` = trim(`name`)),
	CONSTRAINT `strategic_intents_name_not_empty_check` CHECK (length(`name`) > 0),
	CONSTRAINT `strategic_intents_position_check` CHECK (`position` >= 0),
	FOREIGN KEY (`vision_id`) REFERENCES `visions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `strategic_intents_name_trim_unique` ON `strategic_intents` (trim(`name`));
--> statement-breakpoint
ALTER TABLE `initiatives` ADD COLUMN `strategic_intent_id` integer REFERENCES `strategic_intents`(`id`);
