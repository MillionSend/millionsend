CREATE TYPE "public"."api_key_permission" AS ENUM('full_access', 'sending_access');--> statement-breakpoint
CREATE TYPE "public"."domain_status" AS ENUM('pending', 'verified', 'temporary_failure', 'failed');--> statement-breakpoint
CREATE TYPE "public"."tls_mode" AS ENUM('opportunistic', 'enforced');--> statement-breakpoint
CREATE TYPE "public"."email_event_type" AS ENUM('queued', 'queued_quota', 'sent', 'delivery_delayed', 'delivered', 'opened', 'clicked', 'bounced', 'complained', 'suppressed', 'rendering_failure', 'failed');--> statement-breakpoint
CREATE TYPE "public"."email_status" AS ENUM('queued_quota', 'queued', 'sent', 'delivery_delayed', 'delivered', 'opened', 'clicked', 'bounced', 'complained', 'suppressed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."suppression_reason" AS ENUM('hard_bounce', 'complaint', 'manual', 'one_click_unsubscribe');--> statement-breakpoint
CREATE TYPE "public"."plan" AS ENUM('free', 'pro', 'scale');--> statement-breakpoint
CREATE TYPE "public"."webhook_delivery_status" AS ENUM('pending', 'success', 'failed', 'exhausted');--> statement-breakpoint
CREATE TYPE "public"."webhook_status" AS ENUM('enabled', 'disabled', 'auto_disabled');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"last4" text NOT NULL,
	"permission" "api_key_permission" DEFAULT 'full_access' NOT NULL,
	"domain_id" uuid,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid,
	"actor_id" text,
	"action" text NOT NULL,
	"target" text,
	"ip" text,
	"user_agent" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	"region" text NOT NULL,
	"status" "domain_status" DEFAULT 'pending' NOT NULL,
	"dkim_tokens" jsonb,
	"mail_from_subdomain" text DEFAULT 'send' NOT NULL,
	"tracking_subdomain" text,
	"click_tracking" boolean DEFAULT true NOT NULL,
	"open_tracking" boolean DEFAULT false NOT NULL,
	"tls_mode" "tls_mode" DEFAULT 'opportunistic' NOT NULL,
	"ses_configuration_set" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "email_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_id" uuid NOT NULL,
	"type" "email_event_type" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"domain_id" uuid,
	"api_key_id" uuid,
	"ses_message_id" text,
	"from" text NOT NULL,
	"to" jsonb NOT NULL,
	"cc" jsonb,
	"bcc" jsonb,
	"reply_to" jsonb,
	"subject" text NOT NULL,
	"tags" jsonb,
	"latest_status" "email_status" DEFAULT 'queued' NOT NULL,
	"body_ciphertext" "bytea",
	"body_iv" "bytea",
	"body_wrapped_dek" "bytea",
	"body_key_version" integer,
	"body_purged_at" timestamp with time zone,
	"scheduled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"team_id" uuid NOT NULL,
	"key" text NOT NULL,
	"body_hash" text NOT NULL,
	"response_email_ids" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_team_id_key_pk" PRIMARY KEY("team_id","key")
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"email" text,
	"email_hash" text NOT NULL,
	"reason" "suppression_reason" NOT NULL,
	"source_email_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"plan" "plan" DEFAULT 'free' NOT NULL,
	"ses_tenant_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"team_id" uuid NOT NULL,
	"day" date NOT NULL,
	"accepted" integer DEFAULT 0 NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	"delivered" integer DEFAULT 0 NOT NULL,
	"bounced" integer DEFAULT 0 NOT NULL,
	"complained" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_counters_team_id_day_pk" PRIMARY KEY("team_id","day")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "webhook_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_response_code" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"url" text NOT NULL,
	"secret_ciphertext" "bytea" NOT NULL,
	"secret_iv" "bytea" NOT NULL,
	"secret_key_version" integer NOT NULL,
	"events" jsonb NOT NULL,
	"status" "webhook_status" DEFAULT 'enabled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_token_prefix_idx" ON "api_keys" USING btree ("token_prefix");--> statement-breakpoint
CREATE INDEX "audit_log_team_idx" ON "audit_log" USING btree ("team_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "domains_team_name_idx" ON "domains" USING btree ("team_id","name");--> statement-breakpoint
CREATE INDEX "email_events_email_idx" ON "email_events" USING btree ("email_id","occurred_at");--> statement-breakpoint
CREATE INDEX "emails_team_created_idx" ON "emails" USING btree ("team_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "emails_ses_message_id_idx" ON "emails" USING btree ("ses_message_id") WHERE "emails"."ses_message_id" is not null;--> statement-breakpoint
CREATE INDEX "emails_body_unpurged_idx" ON "emails" USING btree ("created_at") WHERE "emails"."body_purged_at" is null;--> statement-breakpoint
CREATE INDEX "idempotency_expiry_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_team_hash_idx" ON "suppressions" USING btree ("team_id","email_hash");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_endpoint_idx" ON "webhook_deliveries" USING btree ("endpoint_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_open_idx" ON "webhook_deliveries" USING btree ("created_at") WHERE "webhook_deliveries"."status" in ('pending', 'failed');