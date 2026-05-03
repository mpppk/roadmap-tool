CREATE TABLE `feature_quarters` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`feature_id` integer NOT NULL,
	`quarter_id` integer NOT NULL,
	`total_capacity` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`feature_id`) REFERENCES `features`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`quarter_id`) REFERENCES `quarters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feature_quarters_feature_id_quarter_id_unique` ON `feature_quarters` (`feature_id`,`quarter_id`);--> statement-breakpoint
CREATE TABLE `features` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `features_name_unique` ON `features` (`name`);--> statement-breakpoint
CREATE TABLE `member_allocations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`feature_id` integer NOT NULL,
	`quarter_id` integer NOT NULL,
	`member_id` integer NOT NULL,
	`capacity` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`feature_id`) REFERENCES `features`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`quarter_id`) REFERENCES `quarters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_allocations_feature_id_quarter_id_member_id_unique` ON `member_allocations` (`feature_id`,`quarter_id`,`member_id`);--> statement-breakpoint
CREATE TABLE `members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `members_name_unique` ON `members` (`name`);--> statement-breakpoint
CREATE TABLE `quarters` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`year` integer NOT NULL,
	`quarter` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quarters_year_quarter_unique` ON `quarters` (`year`,`quarter`);