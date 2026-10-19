ALTER TABLE "shared_inbox_domains" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "inboxes_shared_domain_idx" ON "inboxes" USING btree ("shared_domain_id") WHERE "inboxes"."shared_domain_id" is not null;--> statement-breakpoint
-- Every existing label is locked, tombstones included: deleted inboxes leave
-- no trace, so a label whose addresses are gone can't be told from one never used.
UPDATE "shared_inbox_domains" SET "locked_at" = now() WHERE "locked_at" IS NULL;
