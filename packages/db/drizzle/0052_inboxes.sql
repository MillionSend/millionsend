CREATE TYPE "public"."inbox_draft_status" AS ENUM('draft', 'pending_approval', 'sent', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."inbox_draft_type" AS ENUM('standalone', 'reply');--> statement-breakpoint
CREATE TYPE "public"."inbox_kind" AS ENUM('agent', 'human');--> statement-breakpoint
CREATE TYPE "public"."inbox_quarantine_reason" AS ENUM('failed_auth', 'unauthenticated_sender', 'not_allowlisted', 'injection', 'phishing', 'virus', 'unscreened', 'screening_cap');--> statement-breakpoint
CREATE TYPE "public"."inbox_screening_verdict" AS ENUM('pending', 'clean', 'suspicious', 'quarantined', 'released');--> statement-breakpoint
CREATE TYPE "public"."inbox_thread_folder" AS ENUM('inbox', 'archive', 'spam', 'sent', 'trash');--> statement-breakpoint
CREATE TYPE "public"."received_spam_verdict" AS ENUM('pass', 'gray', 'fail');--> statement-breakpoint
CREATE TYPE "public"."received_virus_verdict" AS ENUM('pass', 'fail', 'processing_failed');--> statement-breakpoint
CREATE TYPE "public"."sender_trust" AS ENUM('owner', 'allowlisted', 'known_thread', 'external', 'unauthenticated', 'failed');--> statement-breakpoint
ALTER TYPE "public"."monitor_sample_kind" ADD VALUE 'agent_first_contact';--> statement-breakpoint
CREATE TABLE "inbox_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"inbox_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"thread_id" uuid,
	"email_id" uuid,
	"draft_id" uuid,
	"decision" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_correspondents" (
	"inbox_id" uuid NOT NULL,
	"address" text NOT NULL,
	"first_in_at" timestamp with time zone,
	"first_out_at" timestamp with time zone,
	"last_out_at" timestamp with time zone,
	"burst_start" timestamp with time zone,
	"burst_count" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_correspondents_inbox_id_address_pk" PRIMARY KEY("inbox_id","address")
);
--> statement-breakpoint
CREATE TABLE "inbox_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"inbox_id" uuid NOT NULL,
	"type" "inbox_draft_type" NOT NULL,
	"forward" boolean DEFAULT false NOT NULL,
	"thread_id" uuid,
	"reply_to_email_id" uuid,
	"to" jsonb,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bcc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text,
	"body_ciphertext" "bytea",
	"body_iv" "bytea",
	"body_wrapped_dek" "bytea",
	"body_key_version" integer,
	"body_purged_at" timestamp with time zone,
	"status" "inbox_draft_status" DEFAULT 'draft' NOT NULL,
	"approval_reasons" text[] DEFAULT '{}' NOT NULL,
	"created_by" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"email_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_drafts_reply_pair" CHECK (("inbox_drafts"."thread_id" is null) = ("inbox_drafts"."reply_to_email_id" is null)),
	CONSTRAINT "inbox_drafts_reply_thread" CHECK (("inbox_drafts"."type" = 'reply') = ("inbox_drafts"."thread_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "inbox_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"inbox_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_labels_color_hex" CHECK ("inbox_labels"."color" ~ '^#[0-9A-F]{6}$')
);
--> statement-breakpoint
CREATE TABLE "inbox_thread_labels" (
	"thread_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_thread_labels_thread_id_label_id_pk" PRIMARY KEY("thread_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "inbox_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"inbox_id" uuid NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"folder" "inbox_thread_folder" DEFAULT 'inbox' NOT NULL,
	"trashed_at" timestamp with time zone,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"participants" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_usage_daily" (
	"inbox_id" uuid NOT NULL,
	"day" date NOT NULL,
	"received" integer DEFAULT 0 NOT NULL,
	"recipients" integer DEFAULT 0 NOT NULL,
	"new_recipients" integer DEFAULT 0 NOT NULL,
	"judged" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "inbox_usage_daily_inbox_id_day_pk" PRIMARY KEY("inbox_id","day")
);
--> statement-breakpoint
CREATE TABLE "inboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"kind" "inbox_kind" NOT NULL,
	"email_address" text NOT NULL,
	"local_part" text NOT NULL,
	"domain_id" uuid,
	"shared_domain_id" uuid,
	"receiving_address" text,
	"name" text NOT NULL,
	"from_name" text,
	"safety" jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"first_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inboxes_has_domain" CHECK ("inboxes"."domain_id" is not null or "inboxes"."shared_domain_id" is not null),
	CONSTRAINT "inboxes_receiving_address_shared" CHECK ("inboxes"."receiving_address" is null or "inboxes"."shared_domain_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "received_email_inboxes" (
	"received_email_id" uuid NOT NULL,
	"inbox_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"address" text NOT NULL,
	"sender_trust" "sender_trust" NOT NULL,
	"thread_proof" text,
	"verdict" "inbox_screening_verdict" NOT NULL,
	"quarantine_reason" "inbox_quarantine_reason",
	"reasons" text[] DEFAULT '{}' NOT NULL,
	"injection_score" smallint,
	"phishing_score" smallint,
	"judge" jsonb,
	"delivered_at" timestamp with time zone,
	"quarantined_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"released_by" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "received_email_inboxes_received_email_id_inbox_id_pk" PRIMARY KEY("received_email_id","inbox_id")
);
--> statement-breakpoint
CREATE TABLE "received_secrets" (
	"team_id" uuid NOT NULL,
	"mac" "bytea" NOT NULL,
	"received_email_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "received_secrets_team_id_mac_received_email_id_pk" PRIMARY KEY("team_id","mac","received_email_id")
);
--> statement-breakpoint
CREATE TABLE "shared_inbox_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_inbox_domains_team_id_unique" UNIQUE("team_id"),
	CONSTRAINT "shared_inbox_domains_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "inbox_id" uuid;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "receiving_catch_all" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "inbox_id" uuid;--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "first_contact" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "received_emails" ADD COLUMN "from_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "received_emails" ADD COLUMN "in_reply_to" text;--> statement-breakpoint
ALTER TABLE "received_emails" ADD COLUMN "references" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "received_emails" ADD COLUMN "from_fields" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "received_emails" ADD COLUMN "from_mailboxes" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "received_emails" ADD COLUMN "automated" text;--> statement-breakpoint
ALTER TABLE "received_emails" ADD COLUMN "auth_detail" jsonb;--> statement-breakpoint
ALTER TABLE "received_emails" ADD COLUMN "sender_trust" "sender_trust" DEFAULT 'unauthenticated' NOT NULL;--> statement-breakpoint
ALTER TABLE "received_emails" ADD COLUMN "spam_verdict" "received_spam_verdict";--> statement-breakpoint
ALTER TABLE "received_emails" ADD COLUMN "spam_score" smallint;--> statement-breakpoint
ALTER TABLE "received_emails" ADD COLUMN "spam_reasons" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "received_emails" ADD COLUMN "virus_verdict" "received_virus_verdict";--> statement-breakpoint
ALTER TABLE "received_emails" ADD COLUMN "virus_signature" text;--> statement-breakpoint
ALTER TABLE "received_emails" ADD COLUMN "hidden_text" jsonb;--> statement-breakpoint
ALTER TABLE "received_emails" ADD COLUMN "extracted_kinds" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "received_emails" ADD COLUMN "extracted" text;--> statement-breakpoint
ALTER TABLE "received_emails" ADD COLUMN "catch_all" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "received_emails" ADD COLUMN "announced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "received_emails" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "received_emails" ADD COLUMN "released_by" text;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD COLUMN "inbound_judged" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "inbox_ids" jsonb;--> statement-breakpoint
ALTER TABLE "inbox_activity" ADD CONSTRAINT "inbox_activity_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_correspondents" ADD CONSTRAINT "inbox_correspondents_inbox_id_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."inboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_drafts" ADD CONSTRAINT "inbox_drafts_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_drafts" ADD CONSTRAINT "inbox_drafts_inbox_id_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."inboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_drafts" ADD CONSTRAINT "inbox_drafts_thread_id_inbox_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."inbox_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_drafts" ADD CONSTRAINT "inbox_drafts_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_labels" ADD CONSTRAINT "inbox_labels_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_labels" ADD CONSTRAINT "inbox_labels_inbox_id_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."inboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_thread_labels" ADD CONSTRAINT "inbox_thread_labels_thread_id_inbox_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."inbox_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_thread_labels" ADD CONSTRAINT "inbox_thread_labels_label_id_inbox_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."inbox_labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_threads" ADD CONSTRAINT "inbox_threads_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_threads" ADD CONSTRAINT "inbox_threads_inbox_id_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."inboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_usage_daily" ADD CONSTRAINT "inbox_usage_daily_inbox_id_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."inboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inboxes" ADD CONSTRAINT "inboxes_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inboxes" ADD CONSTRAINT "inboxes_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inboxes" ADD CONSTRAINT "inboxes_shared_domain_id_shared_inbox_domains_id_fk" FOREIGN KEY ("shared_domain_id") REFERENCES "public"."shared_inbox_domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "received_email_inboxes" ADD CONSTRAINT "received_email_inboxes_received_email_id_received_emails_id_fk" FOREIGN KEY ("received_email_id") REFERENCES "public"."received_emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "received_email_inboxes" ADD CONSTRAINT "received_email_inboxes_inbox_id_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."inboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "received_email_inboxes" ADD CONSTRAINT "received_email_inboxes_thread_id_inbox_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."inbox_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "received_secrets" ADD CONSTRAINT "received_secrets_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "received_secrets" ADD CONSTRAINT "received_secrets_received_email_id_received_emails_id_fk" FOREIGN KEY ("received_email_id") REFERENCES "public"."received_emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_inbox_domains" ADD CONSTRAINT "shared_inbox_domains_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbox_activity_inbox_created_idx" ON "inbox_activity" USING btree ("inbox_id","created_at","id");--> statement-breakpoint
CREATE INDEX "inbox_activity_team_action_idx" ON "inbox_activity" USING btree ("team_id","action","created_at");--> statement-breakpoint
CREATE INDEX "inbox_activity_created_idx" ON "inbox_activity" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "inbox_correspondents_last_seen_idx" ON "inbox_correspondents" USING btree ("last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_drafts_reply_target_idx" ON "inbox_drafts" USING btree ("inbox_id","reply_to_email_id") WHERE "inbox_drafts"."type" = 'reply' and "inbox_drafts"."forward" = false and "inbox_drafts"."status" in ('draft', 'pending_approval');--> statement-breakpoint
CREATE INDEX "inbox_drafts_unsent_idx" ON "inbox_drafts" USING btree ("inbox_id","updated_at","id") WHERE "inbox_drafts"."status" in ('draft', 'pending_approval');--> statement-breakpoint
CREATE INDEX "inbox_drafts_pending_expiry_idx" ON "inbox_drafts" USING btree ("expires_at") WHERE "inbox_drafts"."status" = 'pending_approval';--> statement-breakpoint
CREATE INDEX "inbox_drafts_body_unpurged_idx" ON "inbox_drafts" USING btree ("updated_at") WHERE "inbox_drafts"."body_purged_at" is null;--> statement-breakpoint
CREATE INDEX "inbox_drafts_email_idx" ON "inbox_drafts" USING btree ("email_id") WHERE "inbox_drafts"."email_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_labels_inbox_name_idx" ON "inbox_labels" USING btree ("inbox_id",lower("name"));--> statement-breakpoint
CREATE INDEX "inbox_thread_labels_label_idx" ON "inbox_thread_labels" USING btree ("label_id");--> statement-breakpoint
CREATE INDEX "inbox_threads_inbox_last_idx" ON "inbox_threads" USING btree ("inbox_id","last_message_at","id");--> statement-breakpoint
CREATE INDEX "inbox_threads_inbox_folder_last_idx" ON "inbox_threads" USING btree ("inbox_id","folder","last_message_at","id");--> statement-breakpoint
CREATE INDEX "inbox_threads_trashed_idx" ON "inbox_threads" USING btree ("trashed_at") WHERE "inbox_threads"."trashed_at" is not null;--> statement-breakpoint
CREATE INDEX "inbox_usage_daily_day_idx" ON "inbox_usage_daily" USING btree ("day");--> statement-breakpoint
CREATE UNIQUE INDEX "inboxes_email_address_idx" ON "inboxes" USING btree ("email_address");--> statement-breakpoint
CREATE UNIQUE INDEX "inboxes_receiving_address_idx" ON "inboxes" USING btree ("receiving_address") WHERE "inboxes"."receiving_address" is not null;--> statement-breakpoint
CREATE INDEX "inboxes_team_created_idx" ON "inboxes" USING btree ("team_id","created_at","id");--> statement-breakpoint
CREATE INDEX "inboxes_domain_idx" ON "inboxes" USING btree ("domain_id") WHERE "inboxes"."domain_id" is not null;--> statement-breakpoint
CREATE INDEX "inboxes_expires_idx" ON "inboxes" USING btree ("expires_at") WHERE "inboxes"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "received_email_inboxes_inbox_created_idx" ON "received_email_inboxes" USING btree ("inbox_id","created_at","received_email_id");--> statement-breakpoint
CREATE INDEX "received_email_inboxes_thread_idx" ON "received_email_inboxes" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "received_email_inboxes_unread_idx" ON "received_email_inboxes" USING btree ("inbox_id") WHERE "received_email_inboxes"."read_at" is null and "received_email_inboxes"."delivered_at" is not null;--> statement-breakpoint
CREATE INDEX "received_email_inboxes_held_idx" ON "received_email_inboxes" USING btree ("inbox_id","quarantined_at") WHERE "received_email_inboxes"."quarantined_at" is not null and "received_email_inboxes"."released_at" is null;--> statement-breakpoint
CREATE INDEX "received_email_inboxes_pending_idx" ON "received_email_inboxes" USING btree ("created_at") WHERE "received_email_inboxes"."verdict" = 'pending';--> statement-breakpoint
CREATE INDEX "received_secrets_created_idx" ON "received_secrets" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_inbox_id_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."inboxes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- NOT VALID: the column is new, so every existing row is null and validating would only scan emails under the constraint's lock.
ALTER TABLE "emails" ADD CONSTRAINT "emails_inbox_id_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."inboxes"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_thread_id_inbox_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."inbox_threads"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "api_keys_inbox_idx" ON "api_keys" USING btree ("inbox_id") WHERE "api_keys"."inbox_id" is not null;--> statement-breakpoint
-- IF NOT EXISTS: an operator may build these CONCURRENTLY under the same names before deploying.
CREATE INDEX IF NOT EXISTS "emails_inbox_idx" ON "emails" USING btree ("inbox_id") WHERE "emails"."inbox_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "emails_thread_created_idx" ON "emails" USING btree ("thread_id","created_at") WHERE "emails"."thread_id" is not null;--> statement-breakpoint
CREATE INDEX "received_emails_team_message_id_idx" ON "received_emails" USING btree ("team_id","message_id");--> statement-breakpoint
UPDATE "domains" SET "receiving_catch_all" = true WHERE "receiving_enabled";--> statement-breakpoint
UPDATE "received_emails" SET "announced_at" = "created_at";