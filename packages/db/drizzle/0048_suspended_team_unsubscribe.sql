-- Custom SQL migration file, put your code below! --
-- Backfill for suspendTeam, which unsubscribes a team's members from the
-- instance's own contact list (the contacts of the system plan team) when the
-- team is suspended for manual, reputation or phishing: members of teams
-- suspended for those reasons before it did so are unsubscribed the same way,
-- once. A contact written since its team's suspension (an opt-in, a
-- re-subscribe, a later sign-up) is left as it is.
-- The enums compare as text: an instance upgrading from before 0036 adds plan
-- 'system' in this same transaction, and Postgres refuses a new enum value
-- until the transaction that added it commits.
WITH "unsubscribed" AS (
  UPDATE "contacts" AS c
  SET "unsubscribed" = true, "unsubscribed_at" = now(), "updated_at" = now()
  FROM "teams" AS s, "teams" AS t, "team_members" AS m, "user" AS u
  WHERE s."plan"::text = 'system'
    AND c."team_id" = s."id"
    AND c."unsubscribed" = false
    AND t."suspended_at" IS NOT NULL
    AND t."suspension_reason"::text IN ('manual', 'reputation', 'phishing')
    AND m."team_id" = t."id"
    AND u."id" = m."user_id"
    AND lower(c."email") = lower(u."email")
    AND c."updated_at" <= t."suspended_at"
  RETURNING c."id", c."team_id"
)
INSERT INTO "contact_activities" ("team_id", "contact_id", "type")
SELECT "team_id", "id", 'unsubscribed_team_suspended' FROM "unsubscribed";
