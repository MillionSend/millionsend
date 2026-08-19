CREATE TYPE "public"."contact_property_type" AS ENUM('string', 'number');--> statement-breakpoint
ALTER TABLE "contact_properties" ALTER COLUMN "type" SET DEFAULT 'string'::"public"."contact_property_type";--> statement-breakpoint
ALTER TABLE "contact_properties" ALTER COLUMN "type" SET DATA TYPE "public"."contact_property_type" USING "type"::"public"."contact_property_type";--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "unsubscribe_background_color" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "unsubscribe_text_color" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "unsubscribe_accent_color" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "unsubscribe_hide_branding" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "unsubscribe_success_message" text;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_unsubscribe_background_color_hex" CHECK ("teams"."unsubscribe_background_color" ~ '^#[0-9a-fA-F]{6}$');--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_unsubscribe_text_color_hex" CHECK ("teams"."unsubscribe_text_color" ~ '^#[0-9a-fA-F]{6}$');--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_unsubscribe_accent_color_hex" CHECK ("teams"."unsubscribe_accent_color" ~ '^#[0-9a-fA-F]{6}$');