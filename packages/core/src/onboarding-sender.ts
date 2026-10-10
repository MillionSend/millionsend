import { DOMAINS_DOCS_URL } from "./docs-links.js";
import { parseSingleSender } from "./sender-address.js";
import { normalizeAddress } from "./suppressions.js";

/** True when `from` is the instance's shared onboarding sender: same addr-spec, any case or display name. */
export function isOnboardingSender(from: string, onboardingFrom: string | undefined): boolean {
  if (!onboardingFrom) return false;
  const sender = parseSingleSender(from);
  const platform = parseSingleSender(onboardingFrom);
  return (
    sender !== null &&
    platform !== null &&
    normalizeAddress(sender.address) === normalizeAddress(platform.address)
  );
}

/**
 * The shared onboarding sender (ONBOARDING_EMAIL_FROM) carries one email
 * only: the fixed onboarding message the dashboard sends once to a team's
 * owner. Every customer send path refuses it as a From, a team holding its
 * domain included, so no customer content goes out under the instance's own
 * address. Null when `from` may go on to verifySenderDomain.
 */
export function reservedSenderRefusal(
  from: string,
  onboardingFrom: string | undefined,
): { name: "reserved_sender"; message: string } | null {
  if (!onboardingFrom || !isOnboardingSender(from, onboardingFrom)) return null;
  const address = parseSingleSender(onboardingFrom)?.address ?? onboardingFrom;
  return {
    name: "reserved_sender",
    message: `${address} is reserved for MillionSend's own onboarding email. Add and verify a domain to send your own emails: ${DOMAINS_DOCS_URL}`,
  };
}
