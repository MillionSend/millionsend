import {
  abuseRules,
  DEFAULT_ABUSE_RULES,
  IMAGE_LURE_REASON,
  IMAGE_QUESTION_PREFIX,
} from "../abuse-rules.js";
import { SUBJECT_LABEL, VISIBLE_TEXT_LABEL } from "./block.js";
import { JudgeError, type JudgeVerdict } from "./types.js";

/**
 * Typed questions for TypeSafe Jev, read from the detection rules
 * (abuse-rules.ts). Policy lives in `state` so it is paid once; each
 * question is evaluated independently against that state. The exports below
 * are the built-in rules' values.
 */
const DEFAULT_OUTBOUND = DEFAULT_ABUSE_RULES.judge.outbound;
export const ABUSE_JUDGE_QUESTIONS_VERSION = DEFAULT_OUTBOUND.version;
export const ABUSE_JUDGE_POLICY = DEFAULT_OUTBOUND.policy;
export const ABUSE_JUDGE_QUESTIONS = DEFAULT_OUTBOUND.questions;
export const JUDGE_VERDICT_NOUL = DEFAULT_ABUSE_RULES.limits.judge.verdictNoul;
/**
 * is_abuse and impersonation are independent questions. A brand clone can
 * score high on impersonation and middling on is_abuse; OR them so the clone
 * still flags.
 */
export const JUDGE_IMPERSONATION_NOUL = DEFAULT_ABUSE_RULES.limits.judge.impersonationNoul;
/**
 * Joined to the policy only for mail that names MillionSend in its subject
 * or visible text: a team's own delivery or setup test names its provider.
 * It clears that one name and nothing else, so a lure that names
 * MillionSend too is judged as without it; on every other message the
 * policy is as is.
 */
export const ABUSE_JUDGE_PROVIDER_EXCEPTION = DEFAULT_OUTBOUND.providerException;

/** The name as a word: never inside a hostname or an address, such as a link stub or a shared inbox's. */
const PROVIDER_NAME = /(?<![\w.@/-])millionsend(?![\w-]|\.[a-z0-9])/i;

export function judgePolicy(block: string): string {
  const lines = block.split("\n");
  const subject = lines.find((line) => line.startsWith(SUBJECT_LABEL)) ?? "";
  const at = lines.indexOf(VISIBLE_TEXT_LABEL);
  const visible = at === -1 ? "" : (lines[at + 1] ?? "");
  const { policy, providerException } = abuseRules().judge.outbound;
  return PROVIDER_NAME.test(subject) || PROVIDER_NAME.test(visible)
    ? policy + providerException
    : policy;
}

export function judgeState(block: string): { policy: string; email: string } {
  return { policy: judgePolicy(block), email: block };
}

/** The rules' image questions under their outbound keys; none unless the rules file asks some. */
export function imageQuestions(): Record<string, { type: "noul"; instructions: string }> {
  return Object.fromEntries(
    Object.entries(abuseRules().judge.vision.questions ?? {}).map(([key, q]) => [
      `${IMAGE_QUESTION_PREFIX}${key}`,
      q,
    ]),
  );
}

export function noulOf(answers: Record<string, unknown>, key: string): number | null {
  const raw = answers[key];
  if (!raw || typeof raw !== "object") return null;
  const noul = (raw as { type?: unknown; noul?: unknown }).noul;
  return typeof noul === "number" && Number.isFinite(noul) ? noul : null;
}

/** Only one of the question's own options: anything else reads as no answer. */
function choiceOf(answers: Record<string, unknown>, key: "category" | "language"): string | null {
  const raw = answers[key];
  if (!raw || typeof raw !== "object") return null;
  const choice = (raw as { choice?: unknown }).choice;
  const criteria = abuseRules().judge.outbound.questions[key]?.criteria ?? {};
  return typeof choice === "string" && Object.hasOwn(criteria, choice) ? choice : null;
}

/**
 * Typed Jev answers → the 0–100 verdict the rest of the monitor already
 * stores. Missing is_abuse is a parse error; everything else degrades.
 */
export function composeJudgeVerdict(
  answers: unknown,
  opts: { images?: boolean } = {},
): JudgeVerdict {
  if (answers === null || typeof answers !== "object" || Array.isArray(answers)) {
    throw new JudgeError("parse_error", "no answers object");
  }
  const map = answers as Record<string, unknown>;
  const abuse = noulOf(map, "is_abuse");
  if (abuse === null) throw new JudgeError("parse_error", "no is_abuse noul");
  const rules = abuseRules();
  const lines = rules.limits.judge;
  const impersonation = noulOf(map, "impersonation") ?? 0;
  const p =
    impersonation >= lines.impersonationNoul ? Math.max(abuse, lines.impersonationNoul) : abuse;
  const score = Math.round(Math.min(100, Math.max(0, p * 100)));
  const category = choiceOf(map, "category");
  const language = choiceOf(map, "language") ?? "other";
  const reasons: string[] = [];
  for (const key of rules.judge.outbound.reasonKeys) {
    if ((noulOf(map, key) ?? 0) >= lines.reasonNoul) reasons.push(key);
  }
  const categories = category && category !== "clean" ? [category] : [];
  // Image answers count only on a call that asked them: an unanswered key is no finding.
  const vision = rules.judge.vision;
  const limit = vision.limit;
  if (opts.images && limit !== undefined) {
    const fired = Object.keys(vision.questions ?? {}).filter(
      (key) => (noulOf(map, `${IMAGE_QUESTION_PREFIX}${key}`) ?? 0) >= limit,
    );
    reasons.push(...fired.map((key) => `${IMAGE_QUESTION_PREFIX}${key}`));
    if (fired.some((key) => vision.holdKeys?.includes(key))) {
      reasons.push(IMAGE_LURE_REASON);
      if (categories.length === 0 && vision.category) categories.push(vision.category);
    }
  }
  return {
    score,
    verdict: p >= lines.verdictNoul ? "abuse" : "clean",
    categories,
    impersonatedBrand: null,
    reasons,
    language,
  };
}

/**
 * An image lure is held like any phishing-type verdict: abuse, at least at
 * the monitor's hold score, whatever the text questions answered.
 */
export function raiseImageLure(verdict: JudgeVerdict, holdScore: number): JudgeVerdict {
  if (!verdict.reasons.includes(IMAGE_LURE_REASON)) return verdict;
  return { ...verdict, verdict: "abuse", score: Math.max(verdict.score, holdScore) };
}
