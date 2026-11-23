ALTER TABLE `items` ADD COLUMN `sheet_dirty` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE `sync_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text DEFAULT '' NOT NULL
);
