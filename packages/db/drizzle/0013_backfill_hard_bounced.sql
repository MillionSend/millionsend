-- usage_counters.hard_bounced was added after bounce events started flowing,
-- so counters predating it read 0 hard bounces against fully-counted sent
-- totals — the 30-day outcome window would understate the hard-bounce rate
-- for a month after deploy. Rebuild it from historical Permanent-bounce
-- events, grouped by owning team and UTC day (the same day key utcDay()
-- writes). Events whose data was already retention-stripped carry no bounce
-- type and are unclassifiable — correctly skipped by the jsonb filter.
WITH hard_bounces AS (
  SELECT
    e.team_id,
    (ev.occurred_at AT TIME ZONE 'UTC')::date AS day,
    count(*)::int AS n
  FROM email_events ev
  JOIN emails e ON e.id = ev.email_id
  WHERE ev.type = 'bounced'
    AND ev.data -> 'bounce' ->> 'bounceType' = 'Permanent'
  GROUP BY e.team_id, (ev.occurred_at AT TIME ZONE 'UTC')::date
)
INSERT INTO usage_counters (team_id, day, hard_bounced)
SELECT team_id, day, n FROM hard_bounces
ON CONFLICT (team_id, day) DO UPDATE
  SET hard_bounced = usage_counters.hard_bounced + excluded.hard_bounced;
