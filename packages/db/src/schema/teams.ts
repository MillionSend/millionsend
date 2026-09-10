import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// Billing concept only — deployment mode lives exclusively in env.IS_CLOUD;
// self-host ignores plan entirely (quota code guards on IS_CLOUD first).
export const planEnum = pgEnum("plan", ["free", "starter", "pro", "scale"]);

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

// Corner radius of the team logo on the hosted unsubscribe page.
export const unsubscribeLogoRadiusEnum = pgEnum("unsubscribe_logo_radius", [
  "square",
  "gentle",
  "rounded",
  "circle",
]);

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    plan: planEnum("plan").notNull().default("free"),
    // Emails included per billing period on a monthly plan — the rung the
    // team bought; null on daily plans. Written by the Stripe webhook only.
    planQuota: integer("plan_quota"),
    // Cloud-only Stripe linkage; all null/"none" on self-host.
    stripeCustomerId: text("stripe_customer_id").unique(),
    stripeSubscriptionId: text("stripe_subscription_id"),
    // The metered overage item on the subscription (every monthly plan
    // carries one); what it bills is what the worker reports, so the switch
    // below is the customer's choice, not the item's presence.
    stripeOverageItemId: text("stripe_overage_item_id"),
    // Sends past the included volume bill instead of stopping. Default off.
    overageEnabled: boolean("overage_enabled").notNull().default(false),
    // The rung a scheduled downgrade moves to when the period renews; null
    // while none is pending. Mirrors the Stripe subscription schedule.
    pendingRung: text("pending_rung"),
    planStatus: planStatusEnum("plan_status").notNull().default("none"),
    // The Stripe billing period: monthly quotas count sends from its start.
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    // When Stripe will end the subscription (cancel_at); null while it renews.
    // Mirrored so a scheduled cancellation is a visible transition and the
    // reminder before it needs no Stripe call.
    cancelAt: timestamp("cancel_at", { withTimezone: true }),
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
    unsubscribeLogoRadius: unsubscribeLogoRadiusEnum("unsubscribe_logo_radius")
      .notNull()
      .default("gentle"),
    // Success-state copy shown after preferences are saved.
    unsubscribeSuccessMessage: text("unsubscribe_success_message"),
    // "Powered by MillionSend" under the page. Default on; on the cloud a free
    // plan cannot turn it off (the settings router and the page enforce it).
    unsubscribePoweredBy: boolean("unsubscribe_powered_by").notNull().default(true),
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
