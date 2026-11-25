import type { AbuseJudgeConfig } from "@millionsend/config";
import { abuseRules, DEFAULT_ABUSE_RULES } from "../abuse-rules.js";
import type { SharedNameReview } from "../inboxes/shared-domain.js";
import { SCREEN_JUDGE_TIMEOUT_MS } from "../screening.js";
import { oneLine } from "./block.js";
import { noulOf } from "./questions.js";
import { JudgeError } from "./types.js";
import { askTypesafe, type TypesafeOptions } from "./typesafe.js";

/**
 * Typed questions for TypeSafe Jev on the names a team publishes on the
 * shared domain: an inbox's username and display name, and the team's
 * subdomain label. They are the sender's own identity, so they go as
 * written, whitespace collapsed, like From in the mail judge's block, and
 * nothing else about the team or the inbox goes with them. Section 5 of the
 * landing page's privacy policy (millionsend-lp src/app/privacy/page.tsx)
 * lists what the judge sees; change them together. The policy, questions
 * and refusal line come from the detection rules (abuse-rules.ts); the
 * built-in line is a starting value, uncalibrated until measured.
 */

export const SHARED_NAME_POLICY = DEFAULT_ABUSE_RULES.judge.names.policy;
export const SHARED_NAME_QUESTIONS = DEFAULT_ABUSE_RULES.judge.names.questions;

type SharedName = Parameters<SharedNameReview>[0][number];

function refusedNames(texts: SharedName[], answers: unknown): string[] {
  if (answers === null || typeof answers !== "object" || Array.isArray(answers)) {
    throw new JudgeError("parse_error", "no answers object");
  }
  const line = abuseRules().limits.names.refuseNoul;
  const refused: string[] = [];
  for (const { field, value } of texts) {
    const noul = noulOf(answers as Record<string, unknown>, field);
    // An unanswered name would otherwise pass unreviewed.
    if (noul === null) throw new JudgeError("parse_error", `no ${field} noul`);
    if (noul >= line) refused.push(value);
  }
  return refused;
}

/**
 * The identity review of names on the shared domain, or undefined when no
 * judge is configured. It needs only the judge's config, so any process can
 * build it. One text per field; one call judges them all. It rejects with a
 * JudgeError on a timeout, an HTTP or network failure, or a name left
 * unanswered.
 */
export function createSharedNameReview(
  config: (TypesafeOptions & Pick<AbuseJudgeConfig, "timeoutMs">) | null,
): SharedNameReview | undefined {
  if (!config) return undefined;
  // Someone waits on the answer: no longer than mail waits on a screening call.
  const timeoutMs = Math.min(config.timeoutMs, SCREEN_JUDGE_TIMEOUT_MS);
  return async (texts) => {
    if (texts.length === 0) return { refused: [] };
    const { policy, questions } = abuseRules().judge.names;
    const json = await askTypesafe(
      config,
      {
        state: {
          policy,
          ...Object.fromEntries(texts.map(({ field, value }) => [field, oneLine(value)])),
        },
        questions: Object.fromEntries(texts.map(({ field }) => [field, questions[field]])),
      },
      AbortSignal.timeout(timeoutMs),
    );
    return { refused: refusedNames(texts, json.answers) };
  };
}
