CREATE TABLE "free_pool_bursts" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"tat" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "free_burst_at" timestamp with time zone;