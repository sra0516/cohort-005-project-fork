PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_refunds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`refund_request_id` integer NOT NULL,
	`amount` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`failed_at` text,
	`failed_by_user_id` integer,
	`issued_at` text,
	`issued_by_user_id` integer,
	`internal_note` text,
	FOREIGN KEY (`refund_request_id`) REFERENCES `refund_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`failed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`issued_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_refunds`("id", "refund_request_id", "amount", "status", "created_at", "failed_at", "failed_by_user_id", "issued_at", "issued_by_user_id", "internal_note") SELECT "id", "refund_request_id", "amount", "status", "created_at", "failed_at", "failed_by_user_id", "issued_at", "issued_by_user_id", "internal_note" FROM `refunds`;--> statement-breakpoint
DROP TABLE `refunds`;--> statement-breakpoint
ALTER TABLE `__new_refunds` RENAME TO `refunds`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_refund_request_id_unique` ON `refunds` (`refund_request_id`);