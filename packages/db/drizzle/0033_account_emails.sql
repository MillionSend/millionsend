ALTER TABLE "teams" ADD COLUMN "cancel_at" timestamp with time zone;--> statement-breakpoint
-- IF NOT EXISTS: an operator may build it CONCURRENTLY under the same name before deploying.
CREATE INDEX IF NOT EXISTS "audit_log_action_recent_idx" ON "audit_log" USING btree ("action","created_at");--> statement-breakpoint
-- Domains already verified must not be greeted as newly verified on the first sweep.
INSERT INTO "team_notifications" ("team_id", "kind", "period_key")
SELECT "team_id", 'domain.verified:' || "id", 'episode' FROM "domains" WHERE "status" = 'verified'
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Credential events from before this deploy were never owed a notice.
INSERT INTO "team_notifications" ("team_id", "kind", "period_key")
SELECT "team_id", "action", "id"::text FROM "audit_log"
WHERE "action" IN ('api_key.created', 'webhook.secret_rotated', 'member.joined')
  AND "created_at" > now() - interval '24 hours'
  AND "team_id" IN (SELECT "id" FROM "teams")
ON CONFLICT DO NOTHING;
