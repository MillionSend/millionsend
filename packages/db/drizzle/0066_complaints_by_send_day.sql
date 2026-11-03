-- Complaints count on the UTC day their mail went out, the day SES's own
-- complaint rate files them under. Each one still on record moves there from
-- the day it arrived, where older releases counted it. Only complaints whose
-- SES payload is kept move: a stripped one cannot say whether it was counted
-- (mail SES never attempted and the mailbox simulator's never are), so it
-- keeps its day, as does one whose email row is gone. The 31 days keep the
-- scan on email_events_feedback_created_idx and cover the longest window a
-- reader judges.
CREATE TEMP TABLE "complaint_moves" AS
SELECT e."team_id",
  (ev."occurred_at" AT TIME ZONE 'UTC')::date AS "arrived",
  (e."sent_at" AT TIME ZONE 'UTC')::date AS "sent",
  count(*)::int AS "n"
FROM "email_events" ev
JOIN "emails" e ON e."id" = ev."email_id"
WHERE ev."type" = 'complained'
  AND ev."sns_message_id" IS NOT NULL
  AND ev."created_at" >= now() - interval '31 days'
  AND ev."data" IS NOT NULL
  AND coalesce(ev."data" -> 'complaint' ->> 'complaintSubType', '') NOT IN
    ('OnAccountSuppressionList', 'OnTenantSuppressionList', 'EmailValidationSuppressed', 'UnsubscribedRecipient')
  AND NOT coalesce((
    SELECT bool_and(lower(rtrim(split_part(r ->> 'emailAddress', '@', -1), '>')) = 'simulator.amazonses.com')
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ev."data" -> 'complaint' -> 'complainedRecipients') = 'array'
      THEN ev."data" -> 'complaint' -> 'complainedRecipients' ELSE '[]'::jsonb END) r
  ), false)
  AND (e."sent_at" AT TIME ZONE 'UTC')::date < (ev."occurred_at" AT TIME ZONE 'UTC')::date
GROUP BY 1, 2, 3;
--> statement-breakpoint
UPDATE "usage_counters" AS c SET "complained" = c."complained" - m."n"
FROM (SELECT "team_id", "arrived", sum("n")::int AS "n" FROM "complaint_moves" GROUP BY 1, 2) AS m
WHERE c."team_id" = m."team_id" AND c."day" = m."arrived";
--> statement-breakpoint
INSERT INTO "usage_counters" ("team_id", "day", "complained")
SELECT "team_id", "sent", sum("n")::int FROM "complaint_moves" GROUP BY 1, 2
ON CONFLICT ("team_id", "day") DO UPDATE SET "complained" = "usage_counters"."complained" + excluded."complained";
--> statement-breakpoint
DROP TABLE "complaint_moves";
