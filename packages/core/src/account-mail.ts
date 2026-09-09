import { en, enPhrases } from "./account-mail/en.js";
import { ptBR, ptBRPhrases } from "./account-mail/pt-BR.js";
import { accountMailCard, fillTemplate } from "./html.js";
import { PLAN_DAILY_LIMIT, type Plan } from "./plans.js";

/** The languages account mail is written in; the dashboard's own two. */
export const MAIL_LOCALES = ["en", "pt-BR"] as const;
export type MailLocale = (typeof MAIL_LOCALES)[number];

export function isMailLocale(value: unknown): value is MailLocale {
  return typeof value === "string" && (MAIL_LOCALES as readonly string[]).includes(value);
}

/** Every email the instance sends about accounts, teams, billing and sends. */
export const ACCOUNT_MAIL_KINDS = [
  "welcome",
  "password_changed",
  "mcp.connected",
  "api_key.created",
  "webhook.secret_rotated",
  "member.joined",
  "domain.verified",
  "domain.lost",
  "domain.lost.identity",
  "broadcast.sent",
  "broadcast.held_quota",
  "broadcast.held",
  "billing.payment_failed",
  "billing.plan_activated",
  "billing.plan_changed",
  "billing.cancel_scheduled",
  "billing.cancel_reminder",
  "billing.downgraded",
] as const;
export type AccountMailKind = (typeof ACCOUNT_MAIL_KINDS)[number];

/** One catalog entry: `{slot}` placeholders are filled from the caller's values. */
export interface AccountMailEntry {
  subject: string;
  body: string[];
  button: string;
  muted?: string[];
  /** Sentences a caller picks by key and fills in as a value, e.g. a payment's retry line. */
  extra?: Record<string, string>;
}

export interface MailContent {
  subject: string;
  html: string;
  text: string;
}

const CATALOGS: Record<MailLocale, Record<AccountMailKind, AccountMailEntry>> = {
  en,
  "pt-BR": ptBR,
};

export type MailPhraseKey = "capUpTo" | "capNone";

const PHRASES: Record<MailLocale, Record<MailPhraseKey, string>> = {
  en: enPhrases,
  "pt-BR": ptBRPhrases,
};

/** Plan names as the mails say them: the same word in every language. */
export const PLAN_NAME: Record<Plan, string> = { free: "Free", pro: "Pro", scale: "Scale" };

/** What a plan lets a team send, as a clause: "up to 3,000 emails a day", or the no-cap phrase. */
export function planCapPhrase(locale: MailLocale, plan: Plan): string {
  const limit = PLAN_DAILY_LIMIT[plan];
  return limit === null
    ? PHRASES[locale].capNone
    : fillTemplate(PHRASES[locale].capUpTo, { n: limit.toLocaleString(locale) });
}

/** A calendar date in the reader's language, on the UTC day billing and quotas run on. */
export function formatMailDate(locale: MailLocale, date: Date): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(date);
}

/** Days ahead of a scheduled cancellation at which owners are reminded. */
export const CANCEL_REMINDER_DAYS = 3;

export interface PlanSnapshot {
  plan: Plan;
  currentPeriodEnd: Date | null;
  cancelAt: Date | null;
}

export interface PlanMove {
  kind: "billing.plan_activated" | "billing.plan_changed" | "billing.downgraded";
  /** Claim key every surface computes alike, so the first to notice is the one that speaks. */
  periodKey: string;
  values: (locale: MailLocale, team: string) => Record<string, string>;
}

/**
 * What a team's owners hear when its plan moved from `before` to `after`,
 * read off the team row rather than the event, so the Stripe webhook, the
 * daily reconcile and the grace sweep agree on the mail and on its claim.
 */
export function planMove(
  before: PlanSnapshot,
  after: PlanSnapshot,
  now: Date = new Date(),
): PlanMove | null {
  const freeCap = (locale: MailLocale) => (PLAN_DAILY_LIMIT.free ?? 0).toLocaleString(locale);
  if (before.plan !== "free" && after.plan === "free") {
    // The plan cannot have outlived a scheduled cancellation, its period, or today.
    const ended = [before.cancelAt, before.currentPeriodEnd, now]
      .filter((d): d is Date => d !== null)
      .reduce((a, b) => (a < b ? a : b));
    return {
      kind: "billing.downgraded",
      periodKey: before.currentPeriodEnd?.toISOString() ?? "none",
      values: (locale, team) => ({
        team,
        plan: PLAN_NAME[before.plan],
        date: formatMailDate(locale, ended),
        freeCap: freeCap(locale),
      }),
    };
  }
  const period = after.currentPeriodEnd?.toISOString() ?? "none";
  if (before.plan === "free" && after.plan !== "free") {
    return {
      kind: "billing.plan_activated",
      periodKey: `${after.plan}:${period}`,
      values: (locale, team) => ({
        team,
        plan: PLAN_NAME[after.plan],
        cap: planCapPhrase(locale, after.plan),
      }),
    };
  }
  if (before.plan !== after.plan) {
    return {
      kind: "billing.plan_changed",
      periodKey: `${before.plan}>${after.plan}:${period}`,
      values: (locale, team) => ({
        team,
        old: PLAN_NAME[before.plan],
        new: PLAN_NAME[after.plan],
        cap: planCapPhrase(locale, after.plan),
      }),
    };
  }
  return null;
}

/** A moment in the reader's language, said in UTC so two readers agree on it. */
export function formatMailDateTime(locale: MailLocale, date: Date): string {
  const at = new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
  return `${at} UTC`;
}

/** A phrase from an entry's `extra`, filled; the caller passes it back in as a value. */
export function accountMailPhrase(input: {
  locale: MailLocale;
  kind: AccountMailKind;
  key: string;
  values?: Record<string, string>;
}): string {
  const phrase = CATALOGS[input.locale][input.kind].extra?.[input.key];
  if (phrase === undefined) throw new Error(`no phrase ${input.key} for ${input.kind}`);
  return fillTemplate(phrase, input.values ?? {});
}

/** Renders one kind in one language on the shared card; `url` is the button's target. */
export function buildAccountMail(input: {
  kind: AccountMailKind;
  locale: MailLocale;
  url: string;
  values?: Record<string, string>;
}): MailContent {
  const entry = CATALOGS[input.locale][input.kind];
  const values = input.values ?? {};
  return {
    subject: fillTemplate(entry.subject, values),
    ...accountMailCard({
      paragraphs: entry.body.map((p) => fillTemplate(p, values)),
      button: fillTemplate(entry.button, values),
      url: input.url,
      muted: (entry.muted ?? []).map((m) => fillTemplate(m, values)),
    }),
  };
}
