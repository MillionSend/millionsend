import { sql } from "drizzle-orm";
import { boolean, check, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Billing concept only — deployment mode lives exclusively in env.IS_CLOUD;
// self-host ignores plan entirely (quota code guards on IS_CLOUD first).
export const planEnum = pgEnum("plan", ["free", "pro", "scale"]);

// Mirrors Stripe subscription statuses; "none" = never subscribed. The
// entitlement is `teams.plan`, written only by the verified Stripe webhook.
export const planStatusEnum = pgEnum("plan_status", [
  "none",
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "canceled",
  "incomplete",
]);

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    plan: planEnum("plan").notNull().default("free"),
    // Cloud-only Stripe linkage; all null/"none" on self-host.
    stripeCustomerId: text("stripe_customer_id").unique(),
    stripeSubscriptionId: text("stripe_subscription_id"),
    planStatus: planStatusEnum("plan_status").notNull().default("none"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    // SES tenant name for cloud reputation isolation; null on self-host.
    sesTenantName: text("ses_tenant_name"),
    // Per-team customization of the hosted unsubscribe pages. All null =
    // the built-in defaults (wordmark, generic copy, in-place done state).
    unsubscribeBrandName: text("unsubscribe_brand_name"),
    unsubscribeMessage: text("unsubscribe_message"),
    unsubscribeRedirectUrl: text("unsubscribe_redirect_url"),
    // Page theme colors: 6-digit '#rrggbb' enforced by CHECK; null = default.
    unsubscribeBackgroundColor: text("unsubscribe_background_color"),
    unsubscribeTextColor: text("unsubscribe_text_color"),
    unsubscribeAccentColor: text("unsubscribe_accent_color"),
    // Default on: recipients should see the sender's brand, not MillionSend's.
    unsubscribeHideBranding: boolean("unsubscribe_hide_branding").notNull().default(true),
    // Success-state copy shown after preferences are saved.
    unsubscribeSuccessMessage: text("unsubscribe_success_message"),
    // Public URL of the uploaded team logo (S3-compatible storage), including a
    // ?v= cache-buster stamped at upload. Null = the initial-letter tile.
    logoUrl: text("logo_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "teams_unsubscribe_background_color_hex",
      sql`${t.unsubscribeBackgroundColor} ~ '^#[0-9a-fA-F]{6}$'`,
    ),
    check("teams_unsubscribe_text_color_hex", sql`${t.unsubscribeTextColor} ~ '^#[0-9a-fA-F]{6}$'`),
    check(
      "teams_unsubscribe_accent_color_hex",
      sql`${t.unsubscribeAccentColor} ~ '^#[0-9a-fA-F]{6}$'`,
    ),
  ],
);
