CREATE TABLE "team_new_account_usage" (
	"team_id" uuid NOT NULL,
	"day_index" smallint NOT NULL,
	"accepted" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "team_new_account_usage_team_id_day_index_pk" PRIMARY KEY("team_id","day_index")
);
--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "pool_owner_id" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "new_account_first_day" integer;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "new_account_daily" integer;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "new_account_days" integer;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "burst_min_sent" integer;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "burst_window_hours" integer;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "burst_team_age_days" integer;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "burst_single_share" double precision;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "burst_provider_share" double precision;--> statement-breakpoint
ALTER TABLE "team_monitor" ADD COLUMN "limit_bypass_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_monitor" ADD COLUMN "limit_bypass_by" text;--> statement-breakpoint
ALTER TABLE "team_monitor" ADD COLUMN "limit_bypass_reason" text;--> statement-breakpoint
ALTER TABLE "team_monitor" ADD COLUMN "limit_bypass_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_monitor" ADD COLUMN "new_account_alerted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "send_burst_alerted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_new_account_usage" ADD CONSTRAINT "team_new_account_usage_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;