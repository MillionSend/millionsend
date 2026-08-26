CREATE TYPE "public"."plan_status" AS ENUM('none', 'active', 'trialing', 'past_due', 'unpaid', 'canceled', 'incomplete');--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "plan_status" "plan_status" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "current_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_stripe_customer_id_unique" UNIQUE("stripe_customer_id");