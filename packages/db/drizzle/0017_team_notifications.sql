CREATE TABLE "team_notifications" (
	"team_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"period_key" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_notifications_team_id_kind_period_key_pk" PRIMARY KEY("team_id","kind","period_key")
);
--> statement-breakpoint
ALTER TABLE "team_notifications" ADD CONSTRAINT "team_notifications_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;