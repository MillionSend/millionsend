CREATE INDEX "emails_quota_parked_created_idx" ON "emails" USING btree ("created_at","id") WHERE "emails"."latest_status" = 'queued_quota';--> statement-breakpoint
CREATE INDEX "segment_members_segment_created_idx" ON "segment_members" USING btree ("segment_id","created_at");--> statement-breakpoint
-- A churny table whose probes are index-only scans needs its visibility map kept fresh: vacuum and analyze at 1% churn instead of the 20%/10% defaults.
ALTER TABLE "webhook_deliveries" SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_analyze_scale_factor = 0.01);
