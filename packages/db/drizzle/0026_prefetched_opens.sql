ALTER TYPE "public"."email_event_type" ADD VALUE 'prefetched';--> statement-breakpoint
ALTER TABLE "usage_counters" ADD COLUMN "prefetched" integer DEFAULT 0 NOT NULL;