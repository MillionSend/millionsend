-- IF NOT EXISTS: an operator may build this CONCURRENTLY under the same name before deploying.
CREATE INDEX IF NOT EXISTS "monitor_samples_team_pending_screening_idx" ON "monitor_samples" USING btree ("team_id") WHERE "monitor_samples"."status" = 'pending' and "monitor_samples"."screening";
