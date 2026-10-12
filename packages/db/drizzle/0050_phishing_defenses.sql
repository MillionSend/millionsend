ALTER TYPE "public"."email_park_reason" ADD VALUE 'review';--> statement-breakpoint
ALTER TYPE "public"."email_park_reason" ADD VALUE 'screening';--> statement-breakpoint
ALTER TYPE "public"."email_park_reason" ADD VALUE 'destination';--> statement-breakpoint
ALTER TYPE "public"."email_park_reason" ADD VALUE 'media';--> statement-breakpoint
ALTER TYPE "public"."monitor_sample_kind" ADD VALUE 'destination';--> statement-breakpoint
ALTER TYPE "public"."team_flag_reason" ADD VALUE 'brand';--> statement-breakpoint
ALTER TYPE "public"."team_flag_reason" ADD VALUE 'linked';--> statement-breakpoint
CREATE TABLE "account_signups" (
	"user_id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"abuse_suspended" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "campaign_capture_failures" (
	"team_id" uuid PRIMARY KEY NOT NULL,
	"failed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_fingerprints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"team_name" text NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_links" (
	"team_id" uuid NOT NULL,
	"linked_team_id" uuid NOT NULL,
	"linked_team_name" text NOT NULL,
	"matches" jsonb NOT NULL,
	"trigger" text NOT NULL,
	"held" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"alerted_at" timestamp with time zone,
	CONSTRAINT "team_links_team_id_linked_team_id_pk" PRIMARY KEY("team_id","linked_team_id")
);
--> statement-breakpoint
CREATE TABLE "link_domain_ages" (
	"domain" text PRIMARY KEY NOT NULL,
	"registered_at" timestamp with time zone,
	"source" "domain_age_source" NOT NULL,
	"checked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_destinations" (
	"team_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"cleared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "team_destinations_team_id_domain_pk" PRIMARY KEY("team_id","domain")
);
--> statement-breakpoint
CREATE TABLE "reference_data" (
	"name" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"content" "bytea" NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_access_grants" ADD COLUMN "media_viewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "media" text;--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "screen_released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "parked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "monitor_samples" ADD COLUMN "screening" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor_samples" ADD COLUMN "screen_retries" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor_samples" ADD COLUMN "destinations" jsonb;--> statement-breakpoint
ALTER TABLE "monitor_samples" ADD COLUMN "link_young" boolean;--> statement-breakpoint
ALTER TABLE "monitor_samples" ADD COLUMN "media_issues" jsonb;--> statement-breakpoint
ALTER TABLE "region_breakers" ADD COLUMN "ses_complaint_rate" double precision;--> statement-breakpoint
ALTER TABLE "region_breakers" ADD COLUMN "ses_complaint_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "region_breakers" ADD COLUMN "ses_complaint_alerted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaign_capture_failures" ADD CONSTRAINT "campaign_capture_failures_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_links" ADD CONSTRAINT "team_links_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_destinations" ADD CONSTRAINT "team_destinations_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_signups_ip_idx" ON "account_signups" USING btree ("ip") WHERE "account_signups"."ip" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_fingerprints_team_kind_value_idx" ON "campaign_fingerprints" USING btree ("team_id","kind","value");--> statement-breakpoint
CREATE INDEX "team_links_unalerted_idx" ON "team_links" USING btree ("created_at") WHERE "team_links"."alerted_at" is null;--> statement-breakpoint
-- IF NOT EXISTS: an operator may build it CONCURRENTLY under the same name before deploying.
CREATE INDEX IF NOT EXISTS "emails_review_list_idx" ON "emails" USING btree ("created_at") WHERE "emails"."latest_status" = 'queued_quota' and "emails"."park_reason" <> 'warmup';