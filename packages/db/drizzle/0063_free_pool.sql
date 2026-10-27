CREATE TABLE "free_pool_usage" (
	"owner_id" text NOT NULL,
	"day" date NOT NULL,
	"accepted" integer DEFAULT 0 NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	"sent_no_feedback" integer DEFAULT 0 NOT NULL,
	"hard_bounced" integer DEFAULT 0 NOT NULL,
	"complained" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "free_pool_usage_owner_id_day_pk" PRIMARY KEY("owner_id","day")
);
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "pool_owner_id" text;--> statement-breakpoint
CREATE INDEX "teams_pool_owner_idx" ON "teams" USING btree ("pool_owner_id");