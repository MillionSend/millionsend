CREATE TABLE "received_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"domain_ids" uuid[] NOT NULL,
	"raw_sha256" text NOT NULL,
	"message_id" text NOT NULL,
	"from" text NOT NULL,
	"to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bcc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reply_to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"received_for" jsonb NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"envelope" jsonb NOT NULL,
	"authentication" jsonb NOT NULL,
	"size_bytes" integer NOT NULL,
	"attachment_count" integer DEFAULT 0 NOT NULL,
	"raw_ciphertext" "bytea",
	"raw_iv" "bytea",
	"raw_wrapped_dek" "bytea",
	"raw_key_version" integer,
	"attachments" text,
	"content_purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "receiving_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "receiving_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD COLUMN "received" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_counters_hourly" ADD COLUMN "received" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_periods" ADD COLUMN "received" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "received_emails" ADD CONSTRAINT "received_emails_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "received_emails_team_raw_idx" ON "received_emails" USING btree ("team_id","raw_sha256");--> statement-breakpoint
CREATE INDEX "received_emails_team_created_idx" ON "received_emails" USING btree ("team_id","created_at","id");--> statement-breakpoint
CREATE INDEX "received_emails_content_unpurged_idx" ON "received_emails" USING btree ("created_at") WHERE "received_emails"."content_purged_at" is null;--> statement-breakpoint
CREATE INDEX "received_emails_created_idx" ON "received_emails" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "domains_receiving_name_idx" ON "domains" USING btree ("name") WHERE "domains"."receiving_enabled";