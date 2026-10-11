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
CREATE TABLE "reference_data" (
	"name" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"content" "bytea" NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "team_links" ADD CONSTRAINT "team_links_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_signups_ip_idx" ON "account_signups" USING btree ("ip") WHERE "account_signups"."ip" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_fingerprints_team_kind_value_idx" ON "campaign_fingerprints" USING btree ("team_id","kind","value");--> statement-breakpoint
CREATE INDEX "team_links_unalerted_idx" ON "team_links" USING btree ("created_at") WHERE "team_links"."alerted_at" is null;