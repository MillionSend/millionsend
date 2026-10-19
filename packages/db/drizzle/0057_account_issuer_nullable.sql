-- Better Auth 1.7.0-1.7.2 keyed Google accounts under the issuer
-- https://accounts.google.com, while 0006 backfilled 'local:oauth:google',
-- so a Google account from before 0006 got a second row at its next sign-in.
-- 1.7.3+ keys accounts on (provider_id, account_id) and fails a sign-in two
-- rows match, so the backfilled twin goes. The row kept is the one Google
-- sign-in has resolved to since 0006, whichever user each row names.
DELETE FROM "account" AS "stale" USING "account" AS "kept" WHERE "stale"."provider_id" = 'google' AND "kept"."provider_id" = 'google' AND "stale"."account_id" = "kept"."account_id" AND "stale"."issuer" = 'local:oauth:google' AND "kept"."issuer" = 'https://accounts.google.com';--> statement-breakpoint
DROP INDEX "account_issuer_account_id_idx";--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL;