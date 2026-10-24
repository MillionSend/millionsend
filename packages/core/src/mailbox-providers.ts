// Kept free of imports: bounce-guidance, which client components load, reads these sets.

export const GMAIL_DOMAINS: ReadonlySet<string> = new Set(["gmail.com", "googlemail.com"]);
export const APPLE_MAIL_DOMAINS: ReadonlySet<string> = new Set(["icloud.com", "me.com", "mac.com"]);
export const SES_MAILBOX_SIMULATOR_DOMAIN = "simulator.amazonses.com";

export type MailboxProvider = "gmail" | "microsoft" | "yahoo" | "apple" | "other";

// Consumer webmail by the recipient's domain. A company domain reads as
// "other" even when Google or Microsoft hosts its mail.
export const MICROSOFT_DOMAIN_PATTERN =
  "^((hotmail|outlook|live|windowslive)\\.(com|[a-z]{2}|co\\.[a-z]{2}|com\\.[a-z]{2})|msn\\.com)$";
export const YAHOO_DOMAIN_PATTERN =
  "^(yahoo|ymail|rocketmail)\\.(com|[a-z]{2}|co\\.[a-z]{2}|com\\.[a-z]{2})$";

const MICROSOFT_DOMAIN = new RegExp(MICROSOFT_DOMAIN_PATTERN);
const YAHOO_DOMAIN = new RegExp(YAHOO_DOMAIN_PATTERN);

export function mailboxProvider(domain: string): MailboxProvider {
  const d = domain.toLowerCase();
  if (GMAIL_DOMAINS.has(d)) return "gmail";
  if (APPLE_MAIL_DOMAINS.has(d)) return "apple";
  if (MICROSOFT_DOMAIN.test(d)) return "microsoft";
  if (YAHOO_DOMAIN.test(d)) return "yahoo";
  return "other";
}

/** A soft bounce or delay saying the mailbox is full or abandoned, in SES's subtype or the receiving server's own words. */
export const MAILBOX_FULL_PATTERN =
  /mailboxfull|out of storage|over quota|quota ?exceeded|mailbox (is )?full|mailbox limit|insufficient (system )?storage|\binactive\b/i;

/** The part of MAILBOX_FULL_PATTERN that names an abandoned account rather than a full one: one such answer is enough. */
export const INACTIVE_MAILBOX_PATTERN = /\binactive\b/i;

/**
 * Mailbox providers that never report a complaint to SES: Gmail's feedback
 * is aggregate only (Postmaster Tools), and Apple and Deutsche Telekom run no
 * feedback loop. SES computes its complaint rate over mail to the providers
 * that do (https://docs.aws.amazon.com/ses/latest/dg/faqs-enforcement.html).
 */
export const NO_COMPLAINT_FEEDBACK_DOMAINS: ReadonlySet<string> = new Set([
  ...GMAIL_DOMAINS,
  ...APPLE_MAIL_DOMAINS,
  "t-online.de",
  "magenta.de",
]);

/**
 * SES's subtypes for a bounce or complaint about mail it accepted but never
 * attempted to send: the address was on the account's or a tenant's
 * suppression list, failed email validation, or had unsubscribed through SES
 * list management. AWS leaves such mail out of the account's bounce and
 * complaint rates (https://docs.aws.amazon.com/ses/latest/dg/notification-contents.html,
 * https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html).
 * The global list's "Suppressed" is not one of them: SES counts it.
 */
export const SES_UNATTEMPTED_SUBTYPES: ReadonlySet<string> = new Set([
  "OnAccountSuppressionList",
  "OnTenantSuppressionList",
  "EmailValidationSuppressed",
  "UnsubscribedRecipient",
]);

/**
 * Whether SES attempted the mail a bounce or complaint is about, by the
 * event's subtype (a complaint usually has none). The platform breaker's
 * hardBounceFilter and complaintFilter read it the same way in SQL, so the
 * two must change together.
 */
export function sesAttempted(subType: string | null | undefined): boolean {
  return !SES_UNATTEMPTED_SUBTYPES.has(subType ?? "");
}

/**
 * Whether no recipient of a send can report it to SES as a complaint. A
 * stored recipient's domain is what follows its last '@', less the '>' that
 * closes a display-name form; the platform breaker's recipientDomains reads
 * it the same way in SQL, so the two must change together.
 */
export function sentWithoutComplaintFeedback(recipients: readonly string[]): boolean {
  return (
    recipients.length > 0 &&
    recipients.every((r) =>
      NO_COMPLAINT_FEEDBACK_DOMAINS.has(
        r
          .slice(r.lastIndexOf("@") + 1)
          .replace(/>+$/, "")
          .toLowerCase(),
      ),
    )
  );
}
