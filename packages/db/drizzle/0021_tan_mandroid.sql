ALTER TABLE "contacts" ADD COLUMN "unsubscribed_at" timestamp with time zone;
--> statement-breakpoint
-- Approximate backfill: for rows already unsubscribed the toggle time was
-- not recorded; updated_at is the closest known moment.
UPDATE "contacts" SET "unsubscribed_at" = "updated_at" WHERE "unsubscribed" = true;