/** The message billing refuses with while the team's upgrades are held. */
export const UPGRADES_HELD = "upgrades_held";

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
