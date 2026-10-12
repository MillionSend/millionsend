CREATE TABLE "campaign_capture_failures" (
	"team_id" uuid PRIMARY KEY NOT NULL,
	"failed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_capture_failures" ADD CONSTRAINT "campaign_capture_failures_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;