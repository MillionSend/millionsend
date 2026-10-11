ALTER TABLE "region_breakers" ADD COLUMN "ses_complaint_rate" double precision;--> statement-breakpoint
ALTER TABLE "region_breakers" ADD COLUMN "ses_complaint_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "region_breakers" ADD COLUMN "ses_complaint_alerted_at" timestamp with time zone;