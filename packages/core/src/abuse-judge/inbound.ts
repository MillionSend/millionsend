import { abuseRules, DEFAULT_ABUSE_RULES } from "../abuse-rules.js";
import { countInvisible, dropInvisible } from "../customer-text.js";
import type { SenderTrust } from "../inboxes/types.js";
import { extractLinks } from "../links.js";
import { registrableDomain } from "../org-domain.js";
import { readReceived, replyWithSignature } from "../receiving/read.js";
import {
  clip,
  hiddenCharCount,
  JUDGE_HIDDEN_TEXT_MAX_CHARS,
  JUDGE_PLAIN_TEXT_MAX_CHARS,
  JUDGE_PREVIEW_MAX_CHARS,
  linkRows,
  oneLine,
  plainTextDiffers,
  redacted,
} from "./block.js";
import { type InboundJudgeVerdict, JudgeError } from "./types.js";

/**
 * The inbound judge: TypeSafe Jev's typed questions on mail an agent inbox
 * received, asked whether it tries to make the agent act against its owner
 * or to deceive the owner. Its verdict only ever moves that one message
 * (quarantine, the spam folder, a suspicious mark): it never reaches the
 * sending team's risk, which is the outbound judge's. Its questions and lines
 * come from the detection rules (abuse-rules.ts); the built-in ones are
 * starting values, uncalibrated until measured on real agent mail.
 */

const DEFAULT_INBOUND = DEFAULT_ABUSE_RULES.judge.inbound;
export const INBOUND_JUDGE_QUESTIONS_VERSION = DEFAULT_INBOUND.version;
export const INBOUND_JUDGE_POLICY = DEFAULT_INBOUND.policy;
export const INBOUND_JUDGE_QUESTIONS = DEFAULT_INBOUND.questions;

export function inboundJudgeState(block: string): { policy: string; email: string } {
  return { policy: abuseRules().judge.inbound.policy, email: block };
}

function noulOf(answers: Record<string, unknown>, key: string): number | null {
  const raw = answers[key];
  if (!raw || typeof raw !== "object") return null;
  const noul = (raw as { noul?: unknown }).noul;
  return typeof noul === "number" && Number.isFinite(noul) ? Math.min(1, Math.max(0, noul)) : null;
}

function choiceOf(answers: Record<string, unknown>, key: "category" | "language"): string | null {
  const raw = answers[key];
  if (!raw || typeof raw !== "object") return null;
  const choice = (raw as { choice?: unknown }).choice;
  const criteria = abuseRules().judge.inbound.questions[key]?.criteria ?? {};
  return typeof choice === "string" && Object.hasOwn(criteria, choice) ? choice : null;
}

/**
 * Typed answers → 0-100 scores and reason keys. A strong override, or a
 * strong ask to exfiltrate aimed at an agent, lifts injection to the
 * quarantine line; a strong credential lure does the same for phishing.
 * Missing is_injection is a parse error; everything else degrades.
 */
export function composeInboundVerdict(answers: unknown): InboundJudgeVerdict {
  if (answers === null || typeof answers !== "object" || Array.isArray(answers)) {
    throw new JudgeError("parse_error", "no answers object");
  }
  const map = answers as Record<string, unknown>;
  let injection = noulOf(map, "is_injection");
  if (injection === null) throw new JudgeError("parse_error", "no is_injection noul");
  const { judge, limits } = abuseRules();
  const { strongNoul, reasonNoul } = limits.inbound;
  const strong = (key: string, at = strongNoul) => (noulOf(map, key) ?? 0) >= at;
  if (strong("override") || (strong("exfiltration") && strong("targets_agent", reasonNoul))) {
    injection = Math.max(injection, strongNoul);
  }
  let phishing = noulOf(map, "is_phishing") ?? 0;
  if (strong("credential_lure")) phishing = Math.max(phishing, strongNoul);
  const score = (p: number) => Math.round(100 * p);
  return {
    injectionScore: score(injection),
    phishingScore: score(phishing),
    spamScore: score(noulOf(map, "is_spam") ?? 0),
    reasons: judge.inbound.reasonKeys.filter((key) => (noulOf(map, key) ?? 0) >= reasonNoul),
    category: choiceOf(map, "category"),
    language: choiceOf(map, "language") ?? "other",
  };
}

export interface InboundJudgeBlockInput {
  teamName: string;
  /** The team's verified domains. */
  ownerDomains: string[];
  fromName: string;
  from: string;
  tier: SenderTrust;
  authentication: { spf: string; dkim: string; dmarc: string };
  replyTo: string[];
  subject: string;
  html: string | null;
  text: string | null;
  attachments: { filename: string | null; contentType: string }[];
  /** RFC 3834 reason, or null. */
  automated: string | null;
}

/**
 * The block the inbound judge reads: who wrote and how they authenticated,
 * the reply and its quoted history as a reader sees them, hidden text in a
 * section of its own, the plain-text part when it says something else, and
 * the links reduced to their domains. Everything the message says goes
 * through the outbound judge's redaction (codes after a code word masked,
 * addresses kept to their domain), so no verification code reaches the
 * provider. Links are listed, never fetched. Built in memory, never stored.
 */
export function buildInboundJudgeBlock(input: InboundJudgeBlockInput): string {
  const read = readReceived({
    subject: input.subject,
    html: input.html,
    text: input.text,
    fromDomain: null,
  });
  const stripped = read.stripped;
  const reply = replyWithSignature(read.extracted);
  const visible = read.extracted.quoted ? `${reply}\nQuoted:\n${read.extracted.quoted}` : reply;
  const preview = redacted(dropInvisible(stripped?.preview ?? ""));
  const hidden = [
    preview.slice(JUDGE_PREVIEW_MAX_CHARS),
    redacted(dropInvisible(stripped?.hidden ?? "")),
  ]
    .filter(Boolean)
    .join(" ");
  const plain = stripped && input.text?.trim() ? input.text : "";
  const plainShown = plain !== "" && plainTextDiffers(plain, visible);
  const fromDomain = registrableDomain(input.from.slice(input.from.lastIndexOf("@") + 1));
  const replyToDiffers = input.replyTo.some(
    (r) => registrableDomain(r.slice(r.lastIndexOf("@") + 1)) !== fromDomain,
  );
  const rows = linkRows(
    extractLinks(stripped?.html ?? null, !stripped || plainShown ? input.text : null),
    input.ownerDomains,
  );
  const attachments = input.attachments
    .map((a) => `${redacted(a.filename ?? "(unnamed)")} (${oneLine(a.contentType)})`)
    .join(", ");
  const auth = input.authentication;
  const lines = [
    `Inbox: agent inbox of team "${oneLine(input.teamName)}"`,
    `Owner domains: ${input.ownerDomains.map(oneLine).join(", ") || "(none)"}`,
    `From: ${oneLine(input.fromName ? `${input.fromName} <${input.from}>` : input.from)}`,
    `Sender authentication: ${input.tier} (SPF ${oneLine(auth.spf)}, DKIM ${oneLine(auth.dkim)}, DMARC ${oneLine(auth.dmarc)})`,
    `Reply-To: ${input.replyTo.map(oneLine).join(", ") || "(none)"}; domain differs from From: ${replyToDiffers ? "yes" : "no"}`,
    `Subject: ${redacted(input.subject)}`,
  ];
  if (preview) {
    lines.push(
      "Inbox preview (hidden in the body):",
      `  ${preview.slice(0, JUDGE_PREVIEW_MAX_CHARS)}`,
    );
  }
  lines.push(
    "Visible text:",
    `  ${clip(redacted(visible), abuseRules().limits.judge.textMaxChars)}`,
  );
  if (hidden) {
    lines.push(
      "Hidden text (not shown to the reader):",
      `  ${clip(hidden, JUDGE_HIDDEN_TEXT_MAX_CHARS)}`,
    );
  }
  if (plainShown) {
    lines.push(
      "Plain-text part (differs from the HTML):",
      `  ${clip(redacted(dropInvisible(plain)), JUDGE_PLAIN_TEXT_MAX_CHARS)}`,
    );
  }
  lines.push(
    "Links (anchor text -> domain):",
    rows.join("\n") || "  (none)",
    `Attachments: ${attachments || "(none)"}`,
    `Hidden characters count: ${hiddenCharCount(stripped, preview) + read.hiddenText.invisible_chars + (plainShown ? countInvisible(plain) : 0)}`,
    `Automated: ${input.automated ?? "no"}`,
  );
  return lines.join("\n");
}
