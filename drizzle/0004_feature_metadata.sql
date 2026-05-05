ALTER TABLE `features` ADD COLUMN `description` text;--> statement-breakpoint
CREATE TABLE `feature_links` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `feature_id` integer NOT NULL,
  `title` text NOT NULL,
  `url` text NOT NULL,
  `position` integer NOT NULL,
  CONSTRAINT `feature_links_title_not_empty_check` CHECK (length(`title`) > 0),
  CONSTRAINT `feature_links_url_not_empty_check` CHECK (length(`url`) > 0),
  CONSTRAINT `feature_links_position_check` CHECK (`position` >= 0),
  FOREIGN KEY (`feature_id`) REFERENCES `features`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `feature_links_feature_id_position_unique` ON `feature_links` (`feature_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `feature_links_feature_id_url_unique` ON `feature_links` (`feature_id`,`url`);
