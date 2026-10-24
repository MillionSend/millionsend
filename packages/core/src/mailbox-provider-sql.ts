import { schema } from "@millionsend/db";
import { type SQL, sql } from "drizzle-orm";
import {
  APPLE_MAIL_DOMAINS,
  GMAIL_DOMAINS,
  type MailboxProvider,
  MICROSOFT_DOMAIN_PATTERN,
  NO_COMPLAINT_FEEDBACK_DOMAINS,
  YAHOO_DOMAIN_PATTERN,
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
