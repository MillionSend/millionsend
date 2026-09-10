ALTER TYPE "public"."plan" ADD VALUE 'starter' BEFORE 'pro';--> statement-breakpoint
CREATE TABLE "usage_periods" (
	"team_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"accepted" integer DEFAULT 0 NOT NULL,
	"reported_overage" integer DEFAULT 0 NOT NULL,
	"pending_overage" integer,
	CONSTRAINT "usage_periods_team_id_period_start_pk" PRIMARY KEY("team_id","period_start")
);
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "plan_quota" integer;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "stripe_overage_item_id" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "overage_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "pending_rung" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "current_period_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "usage_periods" ADD CONSTRAINT "usage_periods_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
UPDATE "teams" SET "plan_quota" = 500000 WHERE "plan" = 'scale';--> statement-breakpoint
UPDATE "teams" SET "plan_quota" = 100000 WHERE "plan" = 'pro';--> statement-breakpoint
UPDATE "teams" SET "current_period_start" = "current_period_end" - interval '1 month' WHERE "plan" IN ('pro', 'scale') AND "current_period_end" IS NOT NULL AND "current_period_start" IS NULL;
