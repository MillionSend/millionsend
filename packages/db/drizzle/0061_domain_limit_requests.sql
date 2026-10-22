CREATE TYPE "public"."domain_limit_request_sends" AS ENUM('account', 'notifications', 'marketing', 'mix');--> statement-breakpoint
CREATE TYPE "public"."domain_limit_request_source" AS ENUM('new', 'other_provider', 'own_servers');--> statement-breakpoint
CREATE TYPE "public"."domain_limit_request_status" AS ENUM('open', 'granted', 'declined');--> statement-breakpoint
CREATE TABLE "domain_limit_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	"requested_by" text,
	"sends" "domain_limit_request_sends" NOT NULL,
	"per_day" integer NOT NULL,
	"source" "domain_limit_request_source" NOT NULL,
	"note" text,
	"status" "domain_limit_request_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"operator_notified_at" timestamp with time zone,
	"outcome_notified_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "domain_limit_requests" ADD CONSTRAINT "domain_limit_requests_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_limit_requests" ADD CONSTRAINT "domain_limit_requests_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_limit_requests" ADD CONSTRAINT "domain_limit_requests_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "domain_limit_requests_open_domain_idx" ON "domain_limit_requests" USING btree ("domain_id") WHERE "domain_limit_requests"."status" = 'open';--> statement-breakpoint
CREATE INDEX "domain_limit_requests_status_idx" ON "domain_limit_requests" USING btree ("status","created_at");