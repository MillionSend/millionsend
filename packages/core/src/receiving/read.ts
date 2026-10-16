import type { ReceivedHiddenText } from "@millionsend/db/schema";
import { plainTextDiffers } from "../abuse-judge/block.js";
import {
  IMPLIED_END,
  stripHiddenElements,
  type VisibleHtml,
  VOID_TAGS,
} from "../abuse-judge/body.js";
import { dropControls, dropInvisible, type InvisibleClass } from "../customer-text.js";
import { decodeEntities } from "../html.js";
import { type BodyLink, extractLinks, type HtmlTag, scanHtml } from "../links.js";
import { extractCode, extractLink, receivedSecretValues, type SecretKind } from "./codes.js";
import type { ReceivedExtracted } from "./message.js";
import { OUTLOOK_QUOTE_IDS, QUOTE_CLASSES, splitTextQuotes } from "./quotes.js";

/**
 * The read path agents and the dashboard's extracted view get: what a person
 * sees of a received message, as text with light markdown, its quoted
 * history and signature apart, and the verification code or sign-in link it
 * carries. Hidden text and invisible characters never reach it; the HTML and
 * the raw message stay byte-faithful elsewhere.
 */

/** Longest HTML or text body read; past it the rest is left out and `truncated` flagged. */
export const READ_BODY_MAX_CHARS = 2 * 1024 * 1024;
const TEXT_MAX = 32_000;
const QUOTED_MAX = 16_000;
const SIGNATURE_MAX = 1_000;
/** Nesting past this is pruned: nothing a person reads sits this deep. */
const MAX_DEPTH = 256;
/** Quote levels that get their own "> ": each one rewrites everything inside it once more. */
const QUOTE_PREFIX_LEVELS = 8;
/** Reply links kept for the sign-in link search, which checks each against the capped text. */
const MAX_ANCHORS = 1_000;

const BLOCK = new Set(
  "address article aside center dd details div dl dt fieldset figcaption figure footer form header main nav section summary tr body html".split(
    " ",
  ),
);
const PARAGRAPH = new Set("p h1 h2 h3 h4 h5 h6 blockquote pre table ul ol".split(" "));
const QUOTE_CLASS = new RegExp(`(?:^|\\s)(?:${QUOTE_CLASSES.join("|")})(?:\\s|$)`, "i");
const OUTLOOK_QUOTE_ID: ReadonlySet<string> = new Set(OUTLOOK_QUOTE_IDS);

export interface ModelAnchor {
  href: string;
  text: string;
}

interface Open {
  name: string;
  /** Where its content went: the reply, or the quoted history. */
  sink: string[];
  start: number;
  /** A blockquote's nesting level, counting itself; 0 for any other element. */
  level: number;
  quote: boolean;
  pre: boolean;
  /** An anchor's href, invisible characters out; null for any other element. */
  href: string | null;
}

const tidy = (parts: string[]): string =>
  parts
    .join("")
    .split("\n")
    .map((line) => line.replace(/^[ \t|]+|[ \t|]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/**
 * Text with light markdown (# headings, - items, > quotes, | cells,
 * [text](url) links) straight from the tokens of already-stripped HTML,
 * with the quote containers mail clients write (and everything from
 * Outlook's reply header on) apart. Entities are decoded on text runs only
 * and nothing is ever serialized back to HTML, so text that spelled markup
 * stays text.
 * ponytail: malformed nesting can misplace a quote cut, the same ceiling
 * the hidden-text walk has.
 */
export function htmlToModelText(html: string): {
  text: string;
  quoted: string;
  /** The reply part's http(s) links, as written. */
  anchors: ModelAnchor[];
  depthLimited: boolean;
} {
  const main: string[] = [];
  const quoted: string[] = [];
  const anchors: ModelAnchor[] = [];
  const stack: Open[] = [];
  let quoteDepth = 0;
  let preDepth = 0;
  let blockquotes = 0;
  let overflow = 0;
  let depthLimited = false;
  let cut = false;
  const sink = () => (cut || quoteDepth > 0 ? quoted : main);
  const attr = (t: HtmlTag, name: string) => {
    const a = t.attrs.find((x) => x.name === name);
    return a ? decodeEntities(a.value) : undefined;
  };
  const finish = (o: Open) => {
    const out = o.sink;
    if (o.level > 0) blockquotes--;
    if (o.level > 0 && o.level <= QUOTE_PREFIX_LEVELS) {
      const inner = out.splice(o.start).join("").trim();
      if (inner) {
        out.push(
          `\n\n${inner
            .split("\n")
            .map((l) => `> ${l}`)
            .join("\n")}\n\n`,
        );
      }
    } else if (o.href !== null) {
      const label = out.slice(o.start).join("").replace(/\s+/g, " ").trim();
      if (/^(?:https?|mailto):/i.test(o.href) && label !== o.href && `mailto:${label}` !== o.href) {
        out.splice(o.start, out.length - o.start, `[${label || o.href}](${o.href})`);
      }
      if (out === main && /^https?:/i.test(o.href) && anchors.length < MAX_ANCHORS) {
        anchors.push({ href: o.href, text: label });
      }
    }
    out.push(PARAGRAPH.has(o.name) ? "\n\n" : BLOCK.has(o.name) ? "\n" : "");
    if (o.quote) quoteDepth--;
    if (o.pre) preDepth--;
  };
  scanHtml(html, {
    tag(t) {
      // Outlook-only markup inside a conditional comment: stripping already took it out.
      if (t.depth > 0) return;
      if (t.closing) {
        if (overflow > 0) {
          overflow--;
          return;
        }
        let at = -1;
        for (let i = stack.length - 1; i >= 0 && at === -1; i--) {
          if ((stack[i] as Open).name === t.name) at = i;
        }
        while (at !== -1 && stack.length > at) finish(stack.pop() as Open);
        return;
      }
      if (overflow > 0) {
        if (!VOID_TAGS.has(t.name)) overflow++;
        return;
      }
      const id = attr(t, "id")?.toLowerCase();
      // Outlook marks where the quoted original starts: it and everything after is history.
      if (id !== undefined && OUTLOOK_QUOTE_ID.has(id)) cut = true;
      if (t.name === "br") {
        sink().push("\n");
        return;
      }
      if (t.name === "hr") {
        sink().push("\n\n---\n\n");
        return;
      }
      if (VOID_TAGS.has(t.name)) return;
      // A link never holds another: a browser ends the open one first.
      if (t.name === "a") {
        const open = stack.findLastIndex((o) => o.name === "a");
        while (open !== -1 && stack.length > open) finish(stack.pop() as Open);
      }
      for (
        let top = stack.at(-1);
        top && IMPLIED_END.get(top.name)?.has(t.name);
        top = stack.at(-1)
      ) {
        finish(stack.pop() as Open);
      }
      if (stack.length >= MAX_DEPTH) {
        overflow = 1;
        depthLimited = true;
        return;
      }
      const quote =
        QUOTE_CLASS.test(attr(t, "class") ?? "") ||
        (t.name === "blockquote" && (attr(t, "type") ?? "").toLowerCase() === "cite");
      if (quote) quoteDepth++;
      const pre = t.name === "pre";
      if (pre) preDepth++;
      const out = sink();
      out.push(
        PARAGRAPH.has(t.name)
          ? "\n\n"
          : BLOCK.has(t.name)
            ? "\n"
            : t.name === "li"
              ? "\n- "
              : t.name === "td" || t.name === "th"
                ? " | "
                : "",
      );
      if (/^h[1-6]$/.test(t.name)) out.push(`${"#".repeat(Number(t.name[1]))} `);
      if (t.name === "blockquote") blockquotes++;
      stack.push({
        name: t.name,
        sink: out,
        start: out.length,
        level: t.name === "blockquote" ? blockquotes : 0,
        quote,
        pre,
        href: t.name === "a" ? dropInvisible(attr(t, "href")?.trim() ?? "") : null,
      });
    },
    text(start, end, depth) {
      if (depth > 0 || overflow > 0) return;
      const run = decodeEntities(html.slice(start, end));
      sink().push(preDepth > 0 ? run : run.replace(/\s+/g, " "));
    },
  });
  while (stack.length > 0) finish(stack.pop() as Open);
  return { text: tidy(main), quoted: tidy(quoted), anchors, depthLimited };
}

export interface ReceivedRead {
  /** What received_emails.extracted seals. */
  extracted: ReceivedExtracted;
  /** received_emails.hidden_text: counts and flags, never content. */
  hiddenText: ReceivedHiddenText;
  /** received_emails.extracted_kinds. */
  kinds: ("code" | "link")[];
  /** What received_secrets keys for this message. */
  secrets: { kind: SecretKind; value: string }[];
  /** Every link a reader can follow, read but never fetched: the spam score's link facts. */
  links: BodyLink[];
  /** The HTML's hidden-text pass, kept in memory for the judge; never stored. */
  stripped: VisibleHtml | null;
}

/** At most `max` UTF-16 units, never half a surrogate pair. */
function cap(value: string, max: number, flags: Set<string>): string {
  if (value.length <= max) return value;
  flags.add("truncated");
  const end = /[\ud800-\udbff]/.test(value[max - 1] ?? "") ? max - 1 : max;
  return value.slice(0, end);
}

/**
 * One received message's read: the HTML (hidden text stripped, then walked
 * to text) or else its text part; invisible characters dropped; quotes and
 * signature split off; capped; and the code or sign-in link found in the
 * subject and the reply part only.
 */
export function readReceived(p: {
  subject: string;
  html: string | null;
  text: string | null;
  /** The parse cut the HTML or the text at READ_BODY_MAX_CHARS. */
  bodyTruncated?: boolean | undefined;
  /** The From address's domain: whether a sign-in link points at the sender. */
  fromDomain: string | null;
}): ReceivedRead {
  const flags = new Set<string>();
  if (p.bodyTruncated) flags.add("truncated");
  const invisible: Partial<Record<InvisibleClass, number>> = {};
  let chars = 0;
  let previewChars = 0;
  let body = (p.text ?? "").slice(0, READ_BODY_MAX_CHARS);
  let htmlQuoted = "";
  let anchors: ModelAnchor[] | null = null;
  let links: BodyLink[];
  let stripped: VisibleHtml | null = null;
  const html = p.html?.trim() ? p.html.slice(0, READ_BODY_MAX_CHARS) : null;
  if (html) {
    stripped = stripHiddenElements(html);
    links = extractLinks(stripped.html, null);
    for (const flag of stripped.flags) flags.add(flag);
    chars = stripped.hiddenChars;
    previewChars = stripped.preview.length;
    const read = htmlToModelText(stripped.html);
    if (read.depthLimited) flags.add("depth_limit");
    body = read.text;
    htmlQuoted = read.quoted;
    anchors = read.anchors;
    if (p.text?.trim() && plainTextDiffers(p.text, `${read.text}\n${read.quoted}`)) {
      flags.add("alternative_mismatch");
    }
  } else {
    links = extractLinks(null, body);
  }
  const parts = splitTextQuotes(dropInvisible(dropControls(body), invisible));
  const quoted = [parts.quoted, dropInvisible(dropControls(htmlQuoted), invisible)]
    .filter(Boolean)
    .join("\n\n");
  const text = cap(parts.reply, TEXT_MAX, flags);
  const subject = dropInvisible(p.subject);
  const code = extractCode({ subject, text });
  const link = extractLink({
    subject,
    text,
    // Links in the reply part only: a quoted or hidden link is never the one to follow.
    anchors: anchors
      ? anchors.filter((a) => text.includes(a.href))
      : extractLinks(null, text).map((l) => ({ href: l.raw, text: l.raw })),
    senderDomain: p.fromDomain,
  });
  const quotedPart = cap(quoted, QUOTED_MAX, flags);
  const signature = cap(parts.signature, SIGNATURE_MAX, flags);
  for (const [kind, n] of Object.entries(invisible)) if (n > 0) flags.add(kind);
  const sorted = [...flags].sort();
  return {
    extracted: {
      text,
      quoted: quotedPart,
      signature,
      code: code.code,
      link: link.link,
      flags: sorted,
    },
    hiddenText: {
      chars,
      preview_chars: previewChars,
      invisible_chars: Object.values(invisible).reduce((a, b) => a + b, 0),
      flags: sorted,
    },
    kinds: [...(code.code ? ["code" as const] : []), ...(link.link ? ["link" as const] : [])],
    secrets: receivedSecretValues(code, link),
    links,
    stripped,
  };
}
