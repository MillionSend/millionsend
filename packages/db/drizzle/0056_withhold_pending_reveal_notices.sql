-- Teams are no longer told of a break-glass content access. A grant still
-- waiting for the seven-day disclosure older builds made is marked withheld
-- (notice_sent_at set, team_visible_at null), the state that job skips, so
-- running an older build again cannot surface it. Grants a team was already
-- shown keep both stamps.
UPDATE "content_access_grants" SET "notice_sent_at" = now() WHERE "notice_sent_at" IS NULL;
