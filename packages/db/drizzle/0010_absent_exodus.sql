ALTER TABLE "api_keys" ADD COLUMN "created_by_api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "api_requests" ADD COLUMN "api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "api_requests" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "api_requests" ADD COLUMN "request_bytes" integer;--> statement-breakpoint
ALTER TABLE "api_requests" ADD COLUMN "response_bytes" integer;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_api_key_id_api_keys_id_fk" FOREIGN KEY ("created_by_api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_requests" ADD CONSTRAINT "api_requests_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "emails_team_quota_parked_idx" ON "emails" USING btree ("team_id") WHERE "emails"."latest_status" = 'queued_quota';