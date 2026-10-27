ALTER TYPE "public"."email_park_reason" ADD VALUE 'fuse';--> statement-breakpoint
CREATE TABLE "ses_unmatched_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sns_message_id" text,
	"ses_message_id" text NOT NULL,
	"type" "email_event_type" NOT NULL,
	"bounce_type" text,
	"sub_type" text,
	"pool_owner_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "free_fuse_tripped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "free_fuse_complaints" integer;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "free_fuse_released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "region_breakers" ADD COLUMN "held_teams" jsonb;--> statement-breakpoint
ALTER TABLE "region_breakers" ADD COLUMN "ses_enforcement_status" text;--> statement-breakpoint
CREATE UNIQUE INDEX "ses_unmatched_events_sns_message_id_idx" ON "ses_unmatched_events" USING btree ("sns_message_id") WHERE "ses_unmatched_events"."sns_message_id" is not null;--> statement-breakpoint
CREATE INDEX "ses_unmatched_events_created_idx" ON "ses_unmatched_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "email_events_feedback_created_idx" ON "email_events" USING btree ("created_at") WHERE "email_events"."type" in ('complained', 'bounced') and "email_events"."sns_message_id" is not null;