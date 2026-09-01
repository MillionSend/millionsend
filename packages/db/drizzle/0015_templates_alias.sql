ALTER TABLE "templates" ADD COLUMN "alias" text;--> statement-breakpoint
CREATE UNIQUE INDEX "templates_team_alias_idx" ON "templates" USING btree ("team_id","alias");