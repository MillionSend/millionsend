ALTER TABLE "audiences" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "audiences" CASCADE;--> statement-breakpoint
ALTER TABLE "contacts" DROP CONSTRAINT IF EXISTS "contacts_audience_id_audiences_id_fk";
--> statement-breakpoint
ALTER TABLE "broadcasts" DROP CONSTRAINT IF EXISTS "broadcasts_audience_id_audiences_id_fk";
--> statement-breakpoint
ALTER TABLE "segments" DROP CONSTRAINT IF EXISTS "segments_audience_id_audiences_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "contacts_audience_email_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "segments_audience_idx";--> statement-breakpoint
-- Contacts were unique per (audience, email); team-global uniqueness can
-- collide across audiences. Keep the newest row per (team, email).
DELETE FROM "contacts" c USING "contacts" newer
WHERE c.team_id = newer.team_id AND lower(c.email) = lower(newer.email)
  AND (c.created_at, c.id) < (newer.created_at, newer.id);--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_team_email_idx" ON "contacts" USING btree ("team_id",lower("email"));--> statement-breakpoint
ALTER TABLE "contacts" DROP COLUMN "audience_id";--> statement-breakpoint
ALTER TABLE "broadcasts" DROP COLUMN "audience_id";--> statement-breakpoint
ALTER TABLE "segments" DROP COLUMN "audience_id";