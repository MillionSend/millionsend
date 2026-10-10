CREATE TYPE "public"."domain_age_source" AS ENUM('rdap', 'whois', 'ct', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."email_park_reason" AS ENUM('warmup');--> statement-breakpoint
CREATE TABLE "domain_warmup_usage" (
	"registrable_domain" text NOT NULL,
	"day" date NOT NULL,
	"accepted" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "domain_warmup_usage_registrable_domain_day_pk" PRIMARY KEY("registrable_domain","day")
);
--> statement-breakpoint
CREATE TABLE "team_warmup_usage" (
	"team_id" uuid NOT NULL,
	"day" date NOT NULL,
	"accepted" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "team_warmup_usage_team_id_day_pk" PRIMARY KEY("team_id","day")
);
--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "registered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "age_source" "domain_age_source";--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "age_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "warmup_tier" smallint;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "warmup_tier_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "warmup_trusted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "park_reason" "email_park_reason";--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "warmup_enabled" boolean;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "warmup_cap_first_day" integer;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "warmup_cap_first_week" integer;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "warmup_cap_first_month" integer;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "warmup_trusted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_warmup_usage" ADD CONSTRAINT "team_warmup_usage_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;