-- ADR 0001: the old `refunds` table held Refund Requests. Move its rows into
-- `refund_requests`, and give every approved one a Refund in the new `refunds`.
ALTER TABLE `refunds` RENAME TO `__old_refunds`;--> statement-breakpoint
DROP INDEX IF EXISTS `refunds_purchase_idx`;--> statement-breakpoint
CREATE TABLE `refund_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`purchase_id` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`reason` text NOT NULL,
	`requested_at` text NOT NULL,
	`decided_at` text,
	`decided_by_user_id` integer,
	`decline_reason` text,
	`internal_note` text,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `refund_requests_purchase_idx` ON `refund_requests` (`purchase_id`);--> statement-breakpoint
INSERT INTO `refund_requests`("id", "purchase_id", "status", "reason", "requested_at", "decided_at", "decided_by_user_id") SELECT "id", "purchase_id", "status", "reason", "requested_at", "resolved_at", "resolved_by_user_id" FROM `__old_refunds`;--> statement-breakpoint
CREATE TABLE `refunds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`refund_request_id` integer NOT NULL,
	`amount` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`confirmed_at` text,
	`confirmed_by_user_id` integer,
	`internal_note` text,
	FOREIGN KEY (`refund_request_id`) REFERENCES `refund_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`confirmed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_refund_request_id_unique` ON `refunds` (`refund_request_id`);--> statement-breakpoint
INSERT INTO `refunds`("refund_request_id", "amount", "status", "created_at") SELECT r."id", COALESCE(r."amount_refunded", p."amount_paid"), 'pending', COALESCE(r."resolved_at", r."requested_at") FROM `__old_refunds` r INNER JOIN `purchases` p ON p."id" = r."purchase_id" WHERE r."status" = 'approved';--> statement-breakpoint
DROP TABLE `__old_refunds`;
