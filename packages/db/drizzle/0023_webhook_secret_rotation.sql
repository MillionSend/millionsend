ALTER TABLE "webhook_endpoints" ADD COLUMN "prev_secret_ciphertext" "bytea";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "prev_secret_iv" "bytea";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "prev_secret_wrapped_dek" "bytea";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "prev_secret_key_version" integer;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "prev_secret_expires_at" timestamp with time zone;