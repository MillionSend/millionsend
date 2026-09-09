import { en } from "./account-mail/en.js";
import { ptBR } from "./account-mail/pt-BR.js";
import { accountMailCard, fillTemplate } from "./html.js";

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
