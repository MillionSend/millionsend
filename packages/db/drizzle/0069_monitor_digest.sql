CREATE TABLE "monitor_digest" (
	"team_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "monitor_digest_team_id_kind_pk" PRIMARY KEY("team_id","kind")
);
--> statement-breakpoint
ALTER TABLE "monitor_digest" ADD CONSTRAINT "monitor_digest_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;