-- IF NOT EXISTS: an operator may build these CONCURRENTLY under the same names before deploying.
CREATE INDEX IF NOT EXISTS "emails_sent_body_unpurged_idx" ON "emails" USING btree ("created_at") WHERE "emails"."body_purged_at" is null and "emails"."thread_id" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "emails_thread_body_unpurged_idx" ON "emails" USING btree ("created_at") WHERE "emails"."body_purged_at" is null and "emails"."thread_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "emails_sent_created_idx" ON "emails" USING btree ("created_at") WHERE "emails"."thread_id" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "emails_thread_only_created_idx" ON "emails" USING btree ("created_at") WHERE "emails"."thread_id" is not null;--> statement-breakpoint
DROP INDEX IF EXISTS "emails_body_unpurged_idx";
