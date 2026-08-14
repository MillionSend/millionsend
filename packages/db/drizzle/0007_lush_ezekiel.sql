ALTER TABLE "webhook_endpoints" ALTER COLUMN "events" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "email_id" uuid;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "last_response_body" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "secret_wrapped_dek" "bytea" NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "secret_last4" text NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE set null ON UPDATE no action;