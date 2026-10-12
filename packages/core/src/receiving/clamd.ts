export type VirusResult =
  | { verdict: "pass" }
  | { verdict: "fail"; signature: string }
  | { verdict: "processing_failed"; reason: string };

/** clamd INSTREAM over TCP. Never throws: a failure is processing_failed. */
export async function scanWithClamd(
  _raw: Buffer,
  _p: { host: string; timeoutMs: number; maxBytes: number },
): Promise<VirusResult> {
  throw new Error("INBOX_CONTRACT_STUB");
}
