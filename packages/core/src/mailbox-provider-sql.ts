import { schema } from "@millionsend/db";
import { type SQL, sql } from "drizzle-orm";
import {
  APPLE_MAIL_DOMAINS,
  GMAIL_DOMAINS,
  MAIL_RU_GROUP_DOMAINS,
  type MailboxProvider,
  MICROSOFT_DOMAIN_PATTERN,
  NO_COMPLAINT_FEEDBACK_DOMAINS,
  YAHOO_DOMAIN_PATTERN,
  YANDEX_GROUP_DOMAINS,
} from "./mailbox-providers.js";

/** A send's first recipient's domain, read the way recipientDomains reads each recipient. */
export const firstRecipientDomain = sql<string>`lower(rtrim(split_part(${schema.emails.to}->>0, '@', -1), '>'))`;

/** Whether a send's first recipient is at a provider that reports complaints to SES. */
export const firstRecipientReportsComplaints = sql<boolean>`${firstRecipientDomain} not in ${[...NO_COMPLAINT_FEEDBACK_DOMAINS]}`;

/** mailboxProvider() in SQL, over an expression holding a lowercased domain. */
export function mailboxProviderSql(domain: SQL): SQL<MailboxProvider> {
  return sql<MailboxProvider>`case
    when ${domain} in ${[...GMAIL_DOMAINS]} then 'gmail'
    when ${domain} in ${[...APPLE_MAIL_DOMAINS]} then 'apple'
    when ${domain} ~ ${MICROSOFT_DOMAIN_PATTERN} then 'microsoft'
    when ${domain} ~ ${YAHOO_DOMAIN_PATTERN} then 'yahoo'
    else 'other' end`;
}

/**
 * The operator behind a lowercased domain: mailboxProviderSql's provider,
 * the Mail.ru and Yandex groups, else the domain itself.
 */
export function providerFamilySql(domain: SQL): SQL<string> {
  return sql<string>`case
    when ${mailboxProviderSql(domain)} <> 'other' then ${mailboxProviderSql(domain)}
    when ${domain} in ${[...MAIL_RU_GROUP_DOMAINS]} then 'mail.ru'
    when ${domain} in ${[...YANDEX_GROUP_DOMAINS]} then 'yandex'
    else ${domain} end`;
}
