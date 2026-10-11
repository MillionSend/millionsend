ALTER TYPE "public"."email_park_reason" ADD VALUE 'review';--> statement-breakpoint
ALTER TYPE "public"."email_park_reason" ADD VALUE 'screening';--> statement-breakpoint
ALTER TYPE "public"."email_park_reason" ADD VALUE 'media';--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "screen_released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "monitor_samples" ADD COLUMN "screening" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor_samples" ADD COLUMN "screen_retries" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "emails_review_list_idx" ON "emails" USING btree ("created_at") WHERE "emails"."latest_status" = 'queued_quota' and "emails"."park_reason" <> 'warmup';