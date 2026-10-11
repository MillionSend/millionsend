import { redactRevealedText } from "../content-reveal-render.js";
import { type Anchor, extractAnchors } from "../email-insights.js";
import { unescapeHtml } from "../html.js";
import { maskEmailLocalParts } from "../mask.js";
import { ownerDomain, registrableDomain, vouchedRegistrableDomain } from "../org-domain.js";
import { unwrapRedirect } from "../url.js";
import { decodeEntities, INVISIBLE, opaqueFactsOf, readBody } from "./body.js";

/**
 * The text block the judge sees: the sender's context, the headers, the body
 * as a reader sees it and a link table. Text that an inline style, a
 * stylesheet rule, a 1px font or a colour matching its ground keeps from the
 * reader leaves the visible text for a section of its own, the inbox preview
 * line apart, and the plain-text part goes too when it says something the
 * HTML does not. What the message says (subject, every body section, anchor
 * text, attachment names) goes through the operator content view's
 * redaction first: links cut to a domain and a path stub, known secret
 * formats, codes that follow a code word and valid CPF and CNPJ numbers
 * masked, and every address in it keeps only its domain; names written in
 * the text are not detected and go as written. The sender's own identity
 * (team, From, Reply-To) goes as-is. Every field's whitespace is collapsed,
 * each section is indented like the link rows, so nothing the sender writes
 * can open a line posing as a header, and each has its own cap, so padding
 * one cannot push another out. No recipient address, raw HTML or attachment
 * content is ever part of it, and the block itself is never stored anywhere:
 * it exists in the judge call only. Section 5 of the landing page's privacy
 * policy (millionsend-lp src/app/privacy/page.tsx) lists these fields;
 * change them together.
 */

/** The visible text's cap, kept as its first two thirds and its last third. */
export const JUDGE_TEXT_MAX_CHARS = 6000;
export const JUDGE_LINK_ROWS_MAX = 30;
const ANCHOR_TEXT_MAX = 80;
const HIDDEN_TEXT_MAX_CHARS = 1000;
const PLAIN_TEXT_MAX_CHARS = 1500;
/** About what an inbox lists of a preview line; past it the line is hidden text like any other. */
const PREVIEW_MAX_CHARS = 200;
/** A plain-text part with fewer of its words in the HTML's visible text says something else. */
const PLAIN_TEXT_SHARED_WORDS = 0.8;

export interface JudgeBlockInput {
  team: {
    name: string;
    verifiedDomains: string[];
    /** Days since the team's first accepted send; null before it. */
    ageDays: number | null;
    plan: string;
  };
  from: string;
  replyTo: string[] | null;
  subject: string;
  html: string | null;
  text: string | null;
  attachments: { filename: string; contentType?: string | undefined }[];
  /** Domains the team has never sent to before (registrable or owner form): their links lead the table. */
  novelDomains?: ReadonlySet<string> | undefined;
}

// \s leaves out NEL and the C0 separators, which some readers take for line breaks.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control bytes are the target
const ANY_SPACE = /[\s\x1c-\x1e\x85]+/g;
const WORD = /[\p{L}\p{N}]+/gu;
const URL_IN_TEXT = /(?:https?:\/\/|www\.)\S+/gi;

function oneLine(s: string): string {
  return s.replace(ANY_SPACE, " ").trim();
}

/**
 * Each verified domain and, where the suffix list can vouch for it, its
 * registrable domain. Links are listed by registrable domain, so a team that
 * verified only mail.acme.com.br must also be seen to own acme.com.br, or
 * every link to its own site reads as off-domain. A name the list cannot
 * vouch for is left out: eu.org above foo.eu.org is shared by strangers, and
 * listing it would hand the team every brand under it.
 */
function verifiedDomains(names: string[]): string[] {
  const verified = names.map(oneLine);
  const owned = verified.flatMap((name) => vouchedRegistrableDomain(name) ?? []);
  return [...new Set([...verified, ...owned])];
}

function redacted(s: string): string {
  // Addresses are masked on both sides of the link pass: a path stub can end
  // inside one before its @, and a mask written into a link would come back
  // percent-encoded, so the first pass leaves a plain placeholder.
  const { spans } = redactRevealedText(maskEmailLocalParts(oneLine(s), "x"));
  return maskEmailLocalParts(spans.map((span) => span.text).join(""));
}

function label(text: string): string {
  const t = redacted(text.replace(INVISIBLE, ""));
  return t ? t.slice(0, ANCHOR_TEXT_MAX) : "(image)";
}

/** At most `max` characters of the text: its first two thirds and its last third, the gap named. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = Math.floor(max / 3);
  return `${text.slice(0, max - tail)} […${text.length - max} characters left out…] ${text.slice(-tail)}`;
}

/** Where a link leads, a known redirect wrapper decoded: the host, and the name its row shows. */
function linkTarget(href: string): { host: string | null; shown: string } {
  const value = unwrapRedirect(unescapeHtml(href).trim());
  if (/^https?:\/\//i.test(value)) {
    try {
      const host = new URL(value).hostname;
      return { host, shown: registrableDomain(host) };
    } catch {
      return { host: null, shown: "(invalid)" };
    }
  }
  if (/^mailto:/i.test(value)) return { host: null, shown: "mailto" };
  if (/^tel:/i.test(value)) return { host: null, shown: "tel" };
  return { host: null, shown: "(other)" };
}

/**
 * The link table, at most JUDGE_LINK_ROWS_MAX distinct rows: links to a
 * domain the team never used first, then other links off its verified
 * domains, then the rest, each group in document order, so a lure cannot
 * hide behind thirty links to the sender's own site.
 */
function linkRows(anchors: Anchor[], verified: string[], novel?: ReadonlySet<string>): string[] {
  const owned = new Set(verified.map(ownerDomain));
  const group = (host: string | null, shown: string): number => {
    if (host === null) return shown === "(invalid)" ? 1 : 2;
    if (novel?.has(registrableDomain(host)) || novel?.has(ownerDomain(host))) return 0;
    return owned.has(ownerDomain(host)) ? 2 : 1;
  };
  const groups: [Anchor, string][][] = [[], [], []];
  const seen = new Map<string, [number, string]>();
  for (const anchor of anchors) {
    let target = seen.get(anchor.href);
    if (!target) {
      const { host, shown } = linkTarget(anchor.href);
      target = [group(host, shown), shown];
      seen.set(anchor.href, target);
    }
    groups[target[0]]?.push([anchor, target[1]]);
  }
  const rows = new Set<string>();
  for (const [anchor, shown] of groups.flat()) {
    rows.add(`  ${label(decodeEntities(anchor.text))} -> ${shown}`);
    if (rows.size >= JUDGE_LINK_ROWS_MAX) break;
  }
  return [...rows];
}

/** Whether the plain-text part says something the HTML's visible text does not. */
function plainTextDiffers(text: string, visible: string): boolean {
  const words = text.replace(URL_IN_TEXT, " ").toLowerCase().match(WORD);
  if (!words) return false;
  const seen = new Set(visible.toLowerCase().match(WORD));
  return words.filter((w) => seen.has(w)).length < PLAIN_TEXT_SHARED_WORDS * words.length;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function buildJudgeBlock(input: JudgeBlockInput): string {
  const body = readBody(input.html, input.text);
  const facts = opaqueFactsOf(body, input.attachments.length);
  const stripped = body.stripped;
  // Redacted before it is cut, so a secret across the cut is masked whole.
  const preview = redacted((stripped?.preview ?? "").replace(INVISIBLE, ""));
  const hidden = [
    preview.slice(PREVIEW_MAX_CHARS),
    redacted((stripped?.hidden ?? "").replace(INVISIBLE, "")),
  ]
    .filter(Boolean)
    .join(" ");
  const plain = stripped && input.text ? input.text : "";
  const plainShown = plain && plainTextDiffers(plain, body.visible);
  const plainInvisible = plainShown ? (plain.match(INVISIBLE)?.length ?? 0) : 0;
  const attachments = input.attachments
    .map((a) => {
      const name = redacted(a.filename);
      return a.contentType ? `${name} (${oneLine(a.contentType)})` : name;
    })
    .join(", ");
  const rows = linkRows(
    stripped ? extractAnchors(stripped.html) : [],
    input.team.verifiedDomains,
    input.novelDomains,
  );
  const lines = [
    `Team name: ${oneLine(input.team.name)}`,
    `Verified domains: ${verifiedDomains(input.team.verifiedDomains).join(", ") || "(none)"}`,
    `Team age (days): ${input.team.ageDays ?? "unknown"}`,
    `Plan: ${oneLine(input.team.plan)}`,
    `From: ${oneLine(input.from)}`,
    `Reply-To: ${input.replyTo?.map(oneLine).join(", ") || "(none)"}`,
    `Subject: ${redacted(input.subject)}`,
  ];
  if (preview) {
    lines.push("Inbox preview (hidden in the body):", `  ${preview.slice(0, PREVIEW_MAX_CHARS)}`);
  }
  lines.push("Visible text:", `  ${clip(redacted(body.visible), JUDGE_TEXT_MAX_CHARS)}`);
  if (hidden) {
    lines.push(
      "Hidden text (not shown to the reader):",
      `  ${clip(hidden, HIDDEN_TEXT_MAX_CHARS)}`,
    );
  }
  if (plainShown) {
    lines.push(
      "Plain-text part (differs from the HTML):",
      `  ${clip(redacted(plain.replace(INVISIBLE, "")), PLAIN_TEXT_MAX_CHARS)}`,
    );
  }
  if (facts.opaque) {
    const qr = facts.qrArt ? "; a QR code drawn with characters or table cells" : "";
    lines.push(
      `Opaque: yes (visible text ${facts.visibleChars} chars; ${plural(facts.imageRefs.length, "image")}, ${plural(input.attachments.length, "attachment")}${qr})`,
    );
  }
  lines.push(
    "Links (anchor text -> domain):",
    rows.join("\n") || "  (none)",
    `Image count: ${facts.imageRefs.length}`,
    `Attachments: ${attachments || "(none)"}`,
    `Hidden characters count: ${(stripped?.hiddenChars ?? 0) + body.invisible + plainInvisible}`,
  );
  return lines.join("\n");
}
