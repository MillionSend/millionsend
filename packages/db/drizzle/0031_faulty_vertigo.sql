CREATE INDEX "contacts_team_updated_idx" ON "contacts" USING btree ("team_id","updated_at");--> statement-breakpoint
CREATE INDEX "usage_counters_day_idx" ON "usage_counters" USING btree ("day");--> statement-breakpoint
CREATE INDEX "usage_counters_hourly_hour_idx" ON "usage_counters_hourly" USING btree ("hour");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("endpoint_id","next_attempt_at","id") WHERE "webhook_deliveries"."status" in ('pending', 'failed');--> statement-breakpoint
CREATE INDEX "webhook_deliveries_endpoint_settled_idx" ON "webhook_deliveries" USING btree ("endpoint_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "webhook_deliveries"."status" in ('success', 'exhausted');--> statement-breakpoint
CREATE INDEX "webhook_deliveries_unstripped_idx" ON "webhook_deliveries" USING btree ("created_at") WHERE "webhook_deliveries"."payload" ? 'data' or "webhook_deliveries"."last_response_body" is not null;--> statement-breakpoint
-- Rows written before next_attempt_at became the due clock are due at their creation; without this they are never drained.
UPDATE "webhook_deliveries" SET "next_attempt_at" = "created_at" WHERE "status" = 'pending' AND "next_attempt_at" IS NULL;
