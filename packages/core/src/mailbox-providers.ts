// Kept free of imports: bounce-guidance, which client components load, reads these sets.

export const GMAIL_DOMAINS: ReadonlySet<string> = new Set(["gmail.com", "googlemail.com"]);
export const APPLE_MAIL_DOMAINS: ReadonlySet<string> = new Set(["icloud.com", "me.com", "mac.com"]);
export const SES_MAILBOX_SIMULATOR_DOMAIN = "simulator.amazonses.com";

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
