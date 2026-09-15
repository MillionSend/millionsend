CREATE TYPE "public"."team_flag_reason" AS ENUM('monitor', 'complaints', 'guardrail', 'score', 'report', 'manual');--> statement-breakpoint
CREATE TYPE "public"."team_flag_status" AS ENUM('open', 'cleared');--> statement-breakpoint
CREATE TYPE "public"."suspension_reason" AS ENUM('manual', 'reputation', 'phishing', 'non_payment');--> statement-breakpoint
CREATE TABLE "instance_probes" (
	"probe" text NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"value" double precision,
	"ok" boolean NOT NULL,
	CONSTRAINT "instance_probes_probe_taken_at_pk" PRIMARY KEY("probe","taken_at")
);
--> statement-breakpoint
CREATE TABLE "team_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"reason" "team_flag_reason" NOT NULL,
	"status" "team_flag_status" DEFAULT 'open' NOT NULL,
	"note" text,
	"detail" jsonb,
	"opened_by" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_by" text,
	"cleared_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "team_standings" (
	"team_id" uuid PRIMARY KEY NOT NULL,
	"score_tenths" integer,
	"guardrail" text NOT NULL,
	"guardrail_metric" text,
	"complaint_rate_7d" double precision DEFAULT 0 NOT NULL,
	"hard_bounce_rate_7d" double precision DEFAULT 0 NOT NULL,
	"sent_7d" integer DEFAULT 0 NOT NULL,
	"sent_30d" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "region_breakers" ADD COLUMN "manual_reason" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "daily_send_ceiling" integer;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "broadcasts_paused_by_operator_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "suspension_reason" "suspension_reason";--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "suspension_note" text;--> statement-breakpoint
ALTER TABLE "team_flags" ADD CONSTRAINT "team_flags_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_standings" ADD CONSTRAINT "team_standings_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "instance_probes_taken_at_idx" ON "instance_probes" USING btree ("taken_at");--> statement-breakpoint
CREATE UNIQUE INDEX "team_flags_open_idx" ON "team_flags" USING btree ("team_id") WHERE "team_flags"."status" = 'open';--> statement-breakpoint
CREATE INDEX "team_flags_team_idx" ON "team_flags" USING btree ("team_id","opened_at");