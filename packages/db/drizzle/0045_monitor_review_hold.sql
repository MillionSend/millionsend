ALTER TYPE "public"."suspension_reason" ADD VALUE 'review';--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "monitor_auto_hold" boolean;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "monitor_hold_score" smallint;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "monitor_hold_repeat_count" integer;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "monitor_hold_repeat_score" smallint;--> statement-breakpoint
ALTER TABLE "team_monitor" ADD COLUMN "held_at" timestamp with time zone;