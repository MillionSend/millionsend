CREATE TABLE "contact_properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"key" text NOT NULL,
	"type" text DEFAULT 'string' NOT NULL,
	"fallback_value" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contact_properties" ADD CONSTRAINT "contact_properties_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_properties_team_key_idx" ON "contact_properties" USING btree ("team_id",lower("key"));