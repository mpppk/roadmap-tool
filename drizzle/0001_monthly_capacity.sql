DROP TABLE IF EXISTS `member_allocations`;
--> statement-breakpoint
DROP TABLE IF EXISTS `feature_quarters`;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `months` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`year` integer NOT NULL,
	`month` integer NOT NULL,
	`quarter_id` integer NOT NULL,
	FOREIGN KEY (`quarter_id`) REFERENCES `quarters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `months_year_month_unique` ON `months` (`year`,`month`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `months_quarter_id_month_unique` ON `months` (`quarter_id`,`month`);--> statement-breakpoint
INSERT OR IGNORE INTO `months` (`year`, `month`, `quarter_id`)
SELECT `year`, (`quarter` - 1) * 3 + 1, `id` FROM `quarters`;
--> statement-breakpoint
INSERT OR IGNORE INTO `months` (`year`, `month`, `quarter_id`)
SELECT `year`, (`quarter` - 1) * 3 + 2, `id` FROM `quarters`;
--> statement-breakpoint
INSERT OR IGNORE INTO `months` (`year`, `month`, `quarter_id`)
SELECT `year`, (`quarter` - 1) * 3 + 3, `id` FROM `quarters`;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `feature_months` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`feature_id` integer NOT NULL,
	`month_id` integer NOT NULL,
	`total_capacity` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`feature_id`) REFERENCES `features`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`month_id`) REFERENCES `months`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `feature_months_feature_id_month_id_unique` ON `feature_months` (`feature_id`,`month_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `member_month_allocations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`feature_id` integer NOT NULL,
	`month_id` integer NOT NULL,
	`member_id` integer NOT NULL,
	`capacity` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`feature_id`) REFERENCES `features`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`month_id`) REFERENCES `months`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `member_month_allocations_feature_id_month_id_member_id_unique` ON `member_month_allocations` (`feature_id`,`month_id`,`member_id`);
