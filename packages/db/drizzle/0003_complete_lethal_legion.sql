CREATE TYPE "public"."topic_visibility" AS ENUM('private', 'public');--> statement-breakpoint
CREATE TABLE "contact_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"type" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "visibility" "topic_visibility" DEFAULT 'private' NOT NULL;--> statement-breakpoint
-- Backfill: topics that predate the visibility column had no notion of being
-- hidden, so mark them 'public' to keep them listed on subscriber-facing
-- unsubscribe/preference pages (behavior-preserving). Only topics created
-- after this migration get the 'private' default.
UPDATE "topics" SET "visibility" = 'public';--> statement-breakpoint
ALTER TABLE "contact_activities" ADD CONSTRAINT "contact_activities_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_activities" ADD CONSTRAINT "contact_activities_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_activities_contact_idx" ON "contact_activities" USING btree ("contact_id","created_at" DESC NULLS LAST);