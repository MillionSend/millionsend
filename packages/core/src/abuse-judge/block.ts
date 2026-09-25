import { maskEmailLocalParts, redactRevealedText } from "../content-reveal-render.js";
import { extractAnchors, extractImages, visibleText } from "../email-insights.js";
import { registrableDomain } from "../org-domain.js";

/**
 * The text block the judge sees: the sender's context, the headers, the
 * visible text and a link table. What the message says (subject, visible
 * text, anchor text, attachment names) goes through the operator content
 * view's redaction first, links cut to a domain and a path stub, known secret
 * formats and codes that follow a code word masked, and every address in it
 * keeps only its domain; names written in the text are not detected and go as
 * written. The sender's own identity (team, From, Reply-To) goes as-is. Every
 * field's whitespace is collapsed and the visible text is indented like the
 * link rows, so nothing the sender writes can open a line posing as a header.
 * No recipient address, raw HTML or attachment content is ever part of it,
 * and the block itself is never stored anywhere: it exists in the judge
 * call only. Section 5 of the landing page's privacy policy (millionsend-lp
 * src/app/privacy/page.tsx) lists these fields; change them together.
 */

export const JUDGE_TEXT_MAX_CHARS = 6000;
export const JUDGE_LINK_ROWS_MAX = 30;
const ANCHOR_TEXT_MAX = 80;

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
}

const HIDDEN_STYLE =
  /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![.\d])|font-size\s*:\s*0(?:px|pt|em|rem|%)?(?![.\d])|max-height\s*:\s*0(?:px)?(?![.\d])|mso-hide\s*:\s*all/i;
const OPEN_TAG = /<([a-z][a-z0-9-]*)\b([^<>]*)>/gi;
const VOID_TAGS = new Set(["img", "br", "hr", "input", "meta", "link", "area", "col", "wbr"]);
// Zero-width, soft-hyphen and bidi controls: invisible to the reader, used to split words the judge would otherwise read.
const INVISIBLE = /[​-‏⁠﻿­‪-‮]/g;
// \s leaves out NEL and the C0 separators, which some readers take for line breaks.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control bytes are the target
const ANY_SPACE = /[\s\x1c-\x1e\x85]+/g;
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1]?.toLowerCase() === "x" ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}

/**
 * Drops elements hidden by their own inline style or `hidden` attribute and
 * counts the text they held. ponytail: inline styles only; a `<style>` rule
 * that hides a class is not resolved, and the closing tag is found by
 * counting same-name tags, which malformed nesting can fool.
 */
export function stripHiddenElements(html: string): { html: string; hiddenChars: number } {
  let out = "";
  let cursor = 0;
  let hiddenChars = 0;
  for (const m of html.matchAll(OPEN_TAG)) {
    if (m.index < cursor) continue;
    const tag = (m[1] as string).toLowerCase();
    const attrs = m[2] as string;
    const style = attrs.match(/\sstyle\s*=\s*(["'])(.*?)\1/i)?.[2] ?? "";
    if (!HIDDEN_STYLE.test(style) && !/\shidden(?=[\s=>/]|$)/i.test(attrs)) continue;
    const open = m.index;
    let end = open + m[0].length;
    if (!VOID_TAGS.has(tag) && !attrs.trimEnd().endsWith("/")) {
      const walker = new RegExp(`<(/?)${tag}\\b[^<>]*>`, "gi");
      let depth = 1;
      let close = html.length;
      for (const t of html.slice(end).matchAll(walker)) {
        depth += t[1] === "/" ? -1 : 1;
        if (depth === 0) {
          close = end + t.index + t[0].length;
          break;
        }
      }
      hiddenChars += visibleText(html.slice(end, close)).length;
      end = close;
    }
    out += html.slice(cursor, open);
    cursor = end;
  }
  return { html: out + html.slice(cursor), hiddenChars };
}

function linkTarget(href: string): string {
  const value = href.trim();
  if (/^https?:\/\//i.test(value)) {
    try {
      return registrableDomain(new URL(value).hostname);
    } catch {
      return "(invalid)";
    }
  }
  if (/^mailto:/i.test(value)) return "mailto";
  if (/^tel:/i.test(value)) return "tel";
  return "(other)";
}

function oneLine(s: string): string {
  return s.replace(ANY_SPACE, " ").trim();
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

export function buildJudgeBlock(input: JudgeBlockInput): string {
  const stripped = input.html === null ? null : stripHiddenElements(input.html);
  const raw = stripped ? decodeEntities(visibleText(stripped.html)) : (input.text ?? "");
  const invisible = raw.match(INVISIBLE)?.length ?? 0;
  const text = redacted(raw.replace(INVISIBLE, "")).slice(0, JUDGE_TEXT_MAX_CHARS);
  const rows = new Set<string>();
  for (const a of stripped ? extractAnchors(stripped.html) : []) {
    rows.add(`  ${label(decodeEntities(a.text))} -> ${linkTarget(a.href)}`);
    if (rows.size >= JUDGE_LINK_ROWS_MAX) break;
  }
  const attachments = input.attachments
    .map((a) => {
      const name = redacted(a.filename);
      return a.contentType ? `${name} (${oneLine(a.contentType)})` : name;
    })
    .join(", ");
  return [
    `Team name: ${oneLine(input.team.name)}`,
    `Verified domains: ${input.team.verifiedDomains.map(oneLine).join(", ") || "(none)"}`,
    `Team age (days): ${input.team.ageDays ?? "unknown"}`,
    `Plan: ${oneLine(input.team.plan)}`,
    `From: ${oneLine(input.from)}`,
    `Reply-To: ${input.replyTo?.map(oneLine).join(", ") || "(none)"}`,
    `Subject: ${redacted(input.subject)}`,
    "Visible text:",
    `  ${text}`,
    "Links (anchor text -> domain):",
    [...rows].join("\n") || "  (none)",
    `Image count: ${stripped ? extractImages(stripped.html).length : 0}`,
    `Attachments: ${attachments || "(none)"}`,
    `Hidden characters count: ${(stripped?.hiddenChars ?? 0) + invisible}`,
  ].join("\n");
}
