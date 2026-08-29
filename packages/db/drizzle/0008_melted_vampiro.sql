ALTER TABLE "teams" ALTER COLUMN "unsubscribe_hide_branding" SET DEFAULT true;--> statement-breakpoint
-- Launch-time default flip: existing rows predate the "Show your logo"
-- default and were never explicitly opted out (the toggle shipped with the
-- same release cycle), so they adopt the new default too.
UPDATE "teams" SET "unsubscribe_hide_branding" = true;
