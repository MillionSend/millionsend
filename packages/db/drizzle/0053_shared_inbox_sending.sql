ALTER TYPE "public"."email_park_reason" ADD VALUE 'recipient';--> statement-breakpoint
ALTER TABLE "shared_inbox_domains" DROP CONSTRAINT "shared_inbox_domains_team_id_teams_id_fk";
--> statement-breakpoint
ALTER TABLE "shared_inbox_domains" ALTER COLUMN "team_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "inboxes" ADD COLUMN "last_used_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_inbox_domains" ADD COLUMN "ses_tenant_region" text;--> statement-breakpoint
ALTER TABLE "shared_inbox_domains" ADD COLUMN "ses_tenant_config_set" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "shared_inbox_send" boolean;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "shared_inbox_open" boolean;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "shared_inbox_tenants" boolean;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "shared_inbox_team_daily_cap" integer;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD COLUMN "shared_recipients" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD COLUMN "shared_name_refusals" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD COLUMN "shared_name_reviews" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_inbox_domains" ADD CONSTRAINT "shared_inbox_domains_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;