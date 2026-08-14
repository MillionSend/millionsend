ALTER TABLE "domains" ADD COLUMN "dkim_selector" text;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "dkim_public_key" text;--> statement-breakpoint
ALTER TABLE "domains" DROP COLUMN "dkim_tokens";