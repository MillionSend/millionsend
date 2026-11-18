ALTER TABLE "team_monitor" ADD COLUMN "vouched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_monitor" ADD COLUMN "vouched_by" text;--> statement-breakpoint
ALTER TABLE "team_monitor" ADD COLUMN "vouch_reason" text;--> statement-breakpoint
ALTER TABLE "team_monitor" ADD COLUMN "vouch_until" timestamp with time zone;