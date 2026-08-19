CREATE TABLE "segment_members" (
	"segment_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "segment_members_segment_id_contact_id_pk" PRIMARY KEY("segment_id","contact_id")
);
--> statement-breakpoint
ALTER TABLE "segments" ALTER COLUMN "filter" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD COLUMN "preview_text" text;--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "topic_id" uuid;--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "headers" jsonb;--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "attachments" text;--> statement-breakpoint
ALTER TABLE "segment_members" ADD CONSTRAINT "segment_members_segment_id_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."segments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_members" ADD CONSTRAINT "segment_members_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "segment_members_contact_idx" ON "segment_members" USING btree ("contact_id");--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;