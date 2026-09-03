ALTER TABLE "team_invitations" ADD COLUMN "last_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_invitations" ADD COLUMN "send_count" integer DEFAULT 0 NOT NULL;