ALTER TABLE "emails" ADD COLUMN "parked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_destinations" ADD COLUMN "revoked_at" timestamp with time zone;