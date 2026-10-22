import type { ContactPropertyType } from "@millionsend/core/contact-properties";

/** The message billing refuses with while the team's upgrades are held. */
export const UPGRADES_HELD = "upgrades_held";

/** The message a move up is refused with while Stripe is still counting the period's overage. */
export const OVERAGE_IN_FLIGHT = "overage_in_flight";

/** The message a topic delete is refused with while a broadcast uses the topic. */
export const TOPIC_IN_BROADCAST = "topic_in_broadcast";

/** The message a topic delete is refused with while emails sent with the topic still wait to go out. */
export const TOPIC_EMAILS_WAITING = "topic_emails_waiting";

type PropertyMustBe = Exclude<ContactPropertyType, "string">;

const PROPERTY_TYPE = "property_type";

/**
 * The message a contact save is refused with when a property's value doesn't
 * read as its key's type. The key goes last, since a key may hold a colon.
 */
export const propertyTypeMessage = (mustBe: PropertyMustBe, key: string) =>
  `${PROPERTY_TYPE}:${mustBe}:${key}`;

/** The property a propertyTypeMessage names and what its value must be, or null for any other message. */
export function propertyTypeRefusal(
  message: string,
): { mustBe: PropertyMustBe; key: string } | null {
  const [code, mustBe, ...key] = message.split(":");
  return code === PROPERTY_TYPE && (mustBe === "number" || mustBe === "date")
    ? { mustBe, key: key.join(":") }
    : null;
}

/** The tRPC error code a failed query or mutation carries, if any. */
export function trpcErrorCode(error: unknown): string | undefined {
  return (error as { data?: { code?: string } } | null)?.data?.code;
}

/** A server guard's own localized refusal (PRECONDITION_FAILED), else the caller's copy. */
export function guardMessage(error: unknown, fallback: string): string {
  return trpcErrorCode(error) === "PRECONDITION_FAILED" && error instanceof Error
    ? error.message
    : fallback;
}
