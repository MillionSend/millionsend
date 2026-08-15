CREATE TABLE "contact_topic_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"subscribed" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"default_subscribed" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "broadcasts" ADD COLUMN "topic_id" uuid;--> statement-breakpoint
ALTER TABLE "contact_topic_subscriptions" ADD CONSTRAINT "contact_topic_subscriptions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_topic_subscriptions" ADD CONSTRAINT "contact_topic_subscriptions_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_topic_unique" ON "contact_topic_subscriptions" USING btree ("contact_id","topic_id");--> statement-breakpoint
CREATE INDEX "topics_team_idx" ON "topics" USING btree ("team_id");--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;