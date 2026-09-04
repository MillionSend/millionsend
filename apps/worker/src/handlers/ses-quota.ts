/**
 * SES's rolling 24-hour sending quota, as the worker last read it. Sends hold
 * once the account is within the margin of its ceiling, so SES never has to
 * refuse them; a refusal that might be the quota rather than the rate asks
 * for a fresh read and lets the numbers decide.
 */
export interface SesQuotaGate {
  /** True while the account is at (or within the margin of) its 24-hour quota. */
  exhausted(): boolean;
  /** Re-read the account now; resolves to the new `exhausted`. A failed read keeps the last answer. */
  refresh(): Promise<boolean>;
}

/** Hold sends from this share of the quota: the last messages of the window are SES's, not ours. */
export const SES_QUOTA_MARGIN = 0.98;

export function createSesQuotaGate(
  read: () => Promise<{ max24h: number; sentLast24h: number }>,
  onError: (err: unknown) => void = (err) => console.warn("SES quota read failed", err),
): SesQuotaGate {
  let exhausted = false;
  return {
    exhausted: () => exhausted,
    async refresh() {
      try {
        const quota = await read();
        exhausted = quota.max24h > 0 && quota.sentLast24h >= quota.max24h * SES_QUOTA_MARGIN;
      } catch (err) {
        onError(err);
      }
      return exhausted;
    },
  };
}

const THROTTLE_NAMES = new Set(["TooManyRequestsException", "Throttling", "ThrottlingException"]);

/** SES refused for load: the rate, or the 24-hour quota (same exception, different message). */
export function isSesThrottle(err: unknown): boolean {
  return THROTTLE_NAMES.has((err as { name?: string }).name ?? "");
}

/** The refusal names the daily quota outright. The gate's numbers are the arbiter when it does not. */
export function isSesQuotaRefusal(err: unknown): boolean {
  return isSesThrottle(err) && /daily (message|sending) quota/i.test((err as Error).message ?? "");
}
