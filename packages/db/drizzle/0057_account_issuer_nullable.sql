DROP INDEX "account_issuer_account_id_idx";--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL;