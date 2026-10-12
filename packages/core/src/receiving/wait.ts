/** A long-poll slot for the team in this process, or null at WAITS_PER_TEAM_PER_PROCESS; call the release once. */
export function acquireWaitSlot(_teamId: string): (() => void) | null {
  throw new Error("INBOX_CONTRACT_STUB");
}

/** Polls until a match, the deadline or an abort; never holds a connection between polls. */
export async function waitForReceived<T>(_p: {
  deadlineMs: number;
  signal: AbortSignal;
  poll: () => Promise<T[]>;
  now?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}): Promise<T[]> {
  throw new Error("INBOX_CONTRACT_STUB");
}
