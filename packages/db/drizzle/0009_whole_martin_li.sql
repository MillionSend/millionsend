ALTER TABLE "domains" ALTER COLUMN "click_tracking" SET DEFAULT false;--> statement-breakpoint
-- Default-only change: existing rows keep whatever they have — a self-hoster
-- relying on click tracking must not have it silently switched off by an
-- upgrade. New domains start with both tracking kinds off, as documented.
