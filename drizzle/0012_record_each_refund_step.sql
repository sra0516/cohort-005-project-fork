ALTER TABLE `refunds` ADD `failed_at` text;--> statement-breakpoint
ALTER TABLE `refunds` ADD `failed_by_user_id` integer REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `refunds` ADD `issued_at` text;--> statement-breakpoint
ALTER TABLE `refunds` ADD `issued_by_user_id` integer REFERENCES users(id);--> statement-breakpoint
UPDATE `refunds` SET `failed_at` = `confirmed_at`, `failed_by_user_id` = `confirmed_by_user_id` WHERE `status` = 'failed';--> statement-breakpoint
UPDATE `refunds` SET `issued_at` = `confirmed_at`, `issued_by_user_id` = `confirmed_by_user_id` WHERE `status` = 'issued';
