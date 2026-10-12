import { WAITS_PER_PROCESS, WAITS_PER_TEAM_PER_PROCESS } from "../inboxes/limits.js";

// ponytail: counted per API process, not per instance; a shared counter
// (the database, Redis) is the upgrade if replicas multiply a team's waits.
const waiting = new Map<string, number>();
let waitingTotal = 0;

/**
 * A long-poll slot for the team in this process, or null at
 * WAITS_PER_TEAM_PER_PROCESS for the team or WAITS_PER_PROCESS in all; call
 * the release once.
 */
export function acquireWaitSlot(teamId: string): (() => void) | null {
  const held = waiting.get(teamId) ?? 0;
  if (held >= WAITS_PER_TEAM_PER_PROCESS || waitingTotal >= WAITS_PER_PROCESS) return null;
  waiting.set(teamId, held + 1);
  waitingTotal++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    waitingTotal--;
    const left = (waiting.get(teamId) ?? 1) - 1;
    if (left > 0) waiting.set(teamId, left);
    else waiting.delete(teamId);
  };
}

/** Polls every half second for the first five seconds, then every second. */
const FAST_POLL_MS = 500;
const FAST_FOR_MS = 5_000;
const SLOW_POLL_MS = 1_000;
const JITTER_MS = 100;

const abortableSleep = (signal: AbortSignal) => (ms: number) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

/**
 * Polls until a match, the deadline (an epoch millisecond) or an abort;
 * never holds a connection between polls: each poll is one query. Polling
 * works through any pooler and across replicas, and finds mail the worker
 * delivers as well as mail the API stores.
 */
export async function waitForReceived<T>(p: {
  deadlineMs: number;
  signal: AbortSignal;
  poll: () => Promise<T[]>;
  now?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}): Promise<T[]> {
  const now = p.now ?? Date.now;
  const sleep = p.sleep ?? abortableSleep(p.signal);
  const started = now();
  for (;;) {
    if (p.signal.aborted) return [];
    const rows = await p.poll();
    if (rows.length > 0) return rows;
    const at = now();
    if (at >= p.deadlineMs || p.signal.aborted) return rows;
    const interval =
      (at - started < FAST_FOR_MS ? FAST_POLL_MS : SLOW_POLL_MS) +
      Math.floor(Math.random() * JITTER_MS);
    await sleep(Math.min(interval, p.deadlineMs - at));
  }
}
