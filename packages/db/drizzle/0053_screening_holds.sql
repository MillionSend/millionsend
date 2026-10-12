ALTER TYPE "public"."email_park_reason" ADD VALUE 'review';--> statement-breakpoint
ALTER TYPE "public"."email_park_reason" ADD VALUE 'screening';--> statement-breakpoint
ALTER TYPE "public"."email_park_reason" ADD VALUE 'destination';--> statement-breakpoint
ALTER TYPE "public"."email_park_reason" ADD VALUE 'media';--> statement-breakpoint
ALTER TYPE "public"."monitor_sample_kind" ADD VALUE 'destination';--> statement-breakpoint
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
	CONSTRAINT "team_destinations_team_id_domain_pk" PRIMARY KEY("team_id","domain")
);
--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "screen_released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "monitor_samples" ADD COLUMN "screening" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor_samples" ADD COLUMN "screen_retries" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor_samples" ADD COLUMN "destinations" jsonb;--> statement-breakpoint
ALTER TABLE "monitor_samples" ADD COLUMN "link_young" boolean;--> statement-breakpoint
ALTER TABLE "monitor_samples" ADD COLUMN "media_issues" jsonb;--> statement-breakpoint
ALTER TABLE "team_destinations" ADD CONSTRAINT "team_destinations_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "emails_review_list_idx" ON "emails" USING btree ("created_at") WHERE "emails"."latest_status" = 'queued_quota' and "emails"."park_reason" <> 'warmup';