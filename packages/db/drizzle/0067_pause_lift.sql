ALTER TABLE "usage_counters" ADD COLUMN "excluded_sent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD COLUMN "excluded_hard_bounced" integer DEFAULT 0 NOT NULL;