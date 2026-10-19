CREATE TYPE "public"."domain_warmup_outcome" AS ENUM('grew', 'held', 'stepped_back', 'paused', 'done', 'light', 'idle');--> statement-breakpoint
CREATE TYPE "public"."domain_warmup_status" AS ENUM('off', 'warming', 'paused', 'done');--> statement-breakpoint
CREATE TABLE "domain_warmup_days" (
	"domain_id" uuid NOT NULL,
	"day" date NOT NULL,
	"allowance" integer NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	"outcome" "domain_warmup_outcome",
	"signals" jsonb,
	"checked_at" timestamp with time zone,
	CONSTRAINT "domain_warmup_days_domain_id_day_pk" PRIMARY KEY("domain_id","day")
);
--> statement-breakpoint
CREATE TABLE "domain_warmups" (
	"domain_id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"status" "domain_warmup_status" DEFAULT 'warming' NOT NULL,
	"volume" integer NOT NULL,
	"start_volume" integer NOT NULL,
	"daily_target" integer NOT NULL,
	"sending_days" integer DEFAULT 0 NOT NULL,
	"checked_through" date,
	"order_by_engagement" boolean DEFAULT true NOT NULL,
	"order_by_transactional" boolean DEFAULT true NOT NULL,
	"order_property" text,
	"skip_inactive" boolean DEFAULT true NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paused_at" timestamp with time zone,
	"pause_signals" jsonb,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "broadcasts" ADD COLUMN "warmup_skipped" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "last_engaged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "mailbox_full_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "send_order" bigint;--> statement-breakpoint
ALTER TABLE "domain_warmup_days" ADD CONSTRAINT "domain_warmup_days_domain_id_domain_warmups_domain_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domain_warmups"("domain_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_warmups" ADD CONSTRAINT "domain_warmups_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_warmups" ADD CONSTRAINT "domain_warmups_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "emails_warmup_send_order_idx" ON "emails" USING btree ("broadcast_id","send_order","id") WHERE "emails"."latest_status" = 'queued_quota' and "emails"."send_order" is not null;