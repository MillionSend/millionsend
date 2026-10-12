-- The new column is filled in for the trailing week, the span the complaint
-- rate reads, from the stored recipients the way the platform breaker reads
-- its 24-hour window; days left at 0 would count every send, Gmail's
-- included. The rows are scanned before the column is added: adding it locks
-- usage_counters, which every send writes, until the migration commits.
CREATE TEMP TABLE "no_feedback_sends" AS
SELECT "team_id", ("sent_at" AT TIME ZONE 'UTC')::date AS "day", count(*)::int AS "n"
FROM "emails"
WHERE "sent_at" >= ((now() AT TIME ZONE 'UTC')::date - 6)::timestamp AT TIME ZONE 'UTC'
  AND coalesce((
    SELECT bool_and(lower(rtrim(split_part(r, '@', -1), '>')) IN ('gmail.com', 'googlemail.com', 'icloud.com', 'me.com', 'mac.com', 't-online.de', 'magenta.de'))
    FROM jsonb_array_elements_text("to" || coalesce("cc", '[]') || coalesce("bcc", '[]')) AS r
  ), false)
GROUP BY 1, 2;
--> statement-breakpoint
ALTER TABLE "usage_counters" ADD COLUMN "sent_no_feedback" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "usage_counters" AS c SET "sent_no_feedback" = LEAST(s."n", c."sent")
FROM "no_feedback_sends" AS s
WHERE c."team_id" = s."team_id" AND c."day" = s."day";
--> statement-breakpoint
DROP TABLE "no_feedback_sends";
