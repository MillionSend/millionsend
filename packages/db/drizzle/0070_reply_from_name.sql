CREATE TYPE "public"."inbox_reply_from_name" AS ENUM('inbox', 'teammate_inbox', 'teammate');--> statement-breakpoint
ALTER TABLE "inbox_drafts" ADD COLUMN "reply_from_name" "inbox_reply_from_name";--> statement-breakpoint
ALTER TABLE "inboxes" ADD COLUMN "reply_from_name" "inbox_reply_from_name" DEFAULT 'inbox' NOT NULL;