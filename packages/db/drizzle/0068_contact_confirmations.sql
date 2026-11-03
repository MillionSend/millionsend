ALTER TABLE "contacts" ADD COLUMN "confirmation" jsonb;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "retired_confirmation_request_ids" uuid[];