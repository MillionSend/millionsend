DROP INDEX "contacts_team_idx";--> statement-breakpoint
ALTER TABLE "broadcasts" ADD COLUMN "recipient_count" integer;--> statement-breakpoint
ALTER TABLE "segments" ADD COLUMN "contact_count" integer;--> statement-breakpoint
ALTER TABLE "segments" ADD COLUMN "unsubscribed_count" integer;--> statement-breakpoint
ALTER TABLE "segments" ADD COLUMN "counted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "contacts_team_created_idx" ON "contacts" USING btree ("team_id","created_at","id");--> statement-breakpoint
CREATE INDEX "contacts_team_id_idx" ON "contacts" USING btree ("team_id","id");--> statement-breakpoint
CREATE INDEX "emails_queued_created_idx" ON "emails" USING btree ("created_at") WHERE "emails"."latest_status" = 'queued';--> statement-breakpoint
CREATE INDEX "emails_created_idx" ON "emails" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "emails_team_status_created_idx" ON "emails" USING btree ("team_id","latest_status","created_at");
--> statement-breakpoint
-- Broadcasts that finished before the column existed learn their count once.
UPDATE "broadcasts" b SET "recipient_count" = (SELECT count(*)::int FROM "emails" e WHERE e."broadcast_id" = b."id") WHERE b."status" = 'sent' AND b."recipient_count" IS NULL;
--> statement-breakpoint
-- Last, so the lock on emails is held for an instant, not across the index builds.
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_email_id_emails_id_fk";
