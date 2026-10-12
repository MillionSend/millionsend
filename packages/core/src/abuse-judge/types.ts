/**
 * The content monitor's judge. A verdict is composed in code from TypeSafe
 * Jev's typed answers; every failure is a JudgeError with a class the sample
 * records as "unjudged". Nothing here touches sending.
 */

export const JUDGE_PROVIDERS = ["typesafe"] as const;
export type JudgeProvider = (typeof JUDGE_PROVIDERS)[number];

export interface JudgeVerdict {
  /** 0–100, 100 = certainly abusive. */
  score: number;
  verdict: "abuse" | "clean";
  categories: string[];
  impersonatedBrand: string | null;
  /** Short reason codes, at most a handful. */
  reasons: string[];
  language: string;
  /** The versioned model id that answered, when the provider reported one. */
  model?: string;
}

/** The inbound question set's answer for one received message (abuse-judge/inbound.ts). */
export interface InboundJudgeVerdict {
  /** 0-100 each. */
  injectionScore: number;
  phishingScore: number;
  spamScore: number;
  /** Reason keys among targets_agent, override, exfiltration, unsafe_action, concealed, credential_lure. */
  reasons: string[];
  category: string | null;
  language: string;
  /** The versioned model id that answered, when the provider reported one. */
  model?: string;
}

export interface AbuseJudge {
  readonly provider: JudgeProvider;
  readonly model: string;
  judge(block: string, opts: { signal: AbortSignal }): Promise<JudgeVerdict>;
  /** The inbound set on received mail; a judge without it screens nothing. */
  screen?(block: string, opts: { signal: AbortSignal }): Promise<InboundJudgeVerdict>;
}

/**
 * Why a sample went unjudged. `off`, `no_credentials`, `throttled`,
 * `timeout`, `upstream` and `parse_error` are the judge's; `body_purged`
 * means retention removed the body first, `lost` that the job never ran.
 */
export const JUDGE_ERROR_CLASSES = [
  "off",
  "no_credentials",
  "throttled",
  "timeout",
  "upstream",
  "parse_error",
  "body_purged",
  "lost",
] as const;
export type JudgeErrorClass = (typeof JUDGE_ERROR_CLASSES)[number];

export class JudgeError extends Error {
  readonly class: JudgeErrorClass;
  constructor(errorClass: JudgeErrorClass, message?: string, options?: { cause?: unknown }) {
    super(message ?? errorClass, options);
    this.name = "JudgeError";
    this.class = errorClass;
  }
}

/** The class of any error a judge call threw: its own, an abort, or an upstream fault. */
export function judgeErrorClass(err: unknown): JudgeErrorClass {
  if (err instanceof JudgeError) return err.class;
  const name = (err as { name?: string } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") return "timeout";
  return "upstream";
}
