CREATE TABLE "email_insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"email_id" uuid,
	"broadcast_id" uuid,
	"marketing" boolean NOT NULL,
	"checks" jsonb NOT NULL,
	"score_tenths" integer NOT NULL,
	"score_version" integer NOT NULL,
	"html_size_bytes" integer,
	"mime_size_bytes" integer,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_insights_email_id_unique" UNIQUE("email_id"),
	CONSTRAINT "email_insights_broadcast_id_unique" UNIQUE("broadcast_id"),
	CONSTRAINT "email_insights_one_target" CHECK (("email_insights"."email_id" IS NULL) <> ("email_insights"."broadcast_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "dns_records" jsonb;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "dmarc_policy" text;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "dmarc_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD COLUMN "hard_bounced" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "email_insights" ADD CONSTRAINT "email_insights_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_insights" ADD CONSTRAINT "email_insights_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_insights" ADD CONSTRAINT "email_insights_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;