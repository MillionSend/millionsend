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
CREATE TABLE "reference_data" (
	"name" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"content" "bytea" NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "account_signups_ip_idx" ON "account_signups" USING btree ("ip") WHERE "account_signups"."ip" is not null;