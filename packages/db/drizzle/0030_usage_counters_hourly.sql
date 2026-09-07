CREATE TABLE "usage_counters_hourly" (
	"team_id" uuid NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"accepted" integer DEFAULT 0 NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	"delivered" integer DEFAULT 0 NOT NULL,
	"bounced" integer DEFAULT 0 NOT NULL,
	"hard_bounced" integer DEFAULT 0 NOT NULL,
	"complained" integer DEFAULT 0 NOT NULL,
	"opened" integer DEFAULT 0 NOT NULL,
	"clicked" integer DEFAULT 0 NOT NULL,
	"prefetched" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_counters_hourly_team_id_hour_pk" PRIMARY KEY("team_id","hour")
);
--> statement-breakpoint
ALTER TABLE "usage_counters_hourly" ADD CONSTRAINT "usage_counters_hourly_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Backfill: each existing UTC day lands at its noon, which is the same
-- calendar date in every timezone between UTC-11 and UTC+11, so the
-- viewer-local chart shows past days exactly where the UTC chart did.
INSERT INTO "usage_counters_hourly" ("team_id", "hour", "accepted", "sent", "delivered", "bounced", "hard_bounced", "complained", "opened", "clicked", "prefetched")
SELECT "team_id", ("day"::timestamp + interval '12 hours') AT TIME ZONE 'UTC', "accepted", "sent", "delivered", "bounced", "hard_bounced", "complained", "opened", "clicked", "prefetched"
FROM "usage_counters"
ON CONFLICT ("team_id", "hour") DO NOTHING;
