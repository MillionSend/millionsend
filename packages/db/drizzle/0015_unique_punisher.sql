ALTER TABLE "usage_counters" ADD COLUMN "opened" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD COLUMN "clicked" integer DEFAULT 0 NOT NULL;