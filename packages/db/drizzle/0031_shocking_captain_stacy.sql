-- Rows written before next_attempt_at became the due clock are due at their creation; without this they are never drained. Runs before the indexes so they are built once.
UPDATE "webhook_deliveries" SET "next_attempt_at" = "created_at" WHERE "status" = 'pending' AND "next_attempt_at" IS NULL;--> statement-breakpoint
-- IF NOT EXISTS: an operator may build these CONCURRENTLY under the same names before deploying.
CREATE INDEX IF NOT EXISTS "contacts_team_updated_idx" ON "contacts" USING btree ("team_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "emails_quota_parked_created_idx" ON "emails" USING btree ("created_at","id") WHERE "emails"."latest_status" = 'queued_quota';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "segment_members_segment_created_idx" ON "segment_members" USING btree ("segment_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_counters_day_idx" ON "usage_counters" USING btree ("day");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_counters_hourly_hour_idx" ON "usage_counters_hourly" USING btree ("hour");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("endpoint_id","next_attempt_at","id") WHERE "webhook_deliveries"."status" in ('pending', 'failed');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_endpoint_settled_idx" ON "webhook_deliveries" USING btree ("endpoint_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "webhook_deliveries"."status" = 'success' or ("webhook_deliveries"."status" = 'exhausted' and ("webhook_deliveries"."attempts" >= 6 or "webhook_deliveries"."last_response_code" = 429));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_unstripped_idx" ON "webhook_deliveries" USING btree ("created_at") WHERE "webhook_deliveries"."payload" ? 'data' or "webhook_deliveries"."last_response_body" is not null;--> statement-breakpoint
-- A churny table whose probes are index-only scans needs its visibility map kept fresh: vacuum and analyze at 1% churn instead of the 20%/10% defaults.
ALTER TABLE "webhook_deliveries" SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_analyze_scale_factor = 0.01);
