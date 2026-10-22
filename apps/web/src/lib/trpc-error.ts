/** The message billing refuses with while the team's upgrades are held. */
export const UPGRADES_HELD = "upgrades_held";

/** The message a move up is refused with while Stripe is still counting the period's overage. */
export const OVERAGE_IN_FLIGHT = "overage_in_flight";

/** The message a topic delete is refused with while a broadcast uses the topic. */
export const TOPIC_IN_BROADCAST = "topic_in_broadcast";

/** The message a topic delete is refused with while emails sent with the topic still wait to go out. */
export const TOPIC_EMAILS_WAITING = "topic_emails_waiting";

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
