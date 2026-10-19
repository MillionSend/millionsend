import { parse } from "tldts";
import { decodeEntities, hasUnknownReference, visibleText } from "./html.js";
import { unwrapRedirect } from "./url.js";

/**
 * Every link a mail client would follow, read the way the browser reads it.
 * Tags are taken apart by the HTML tokenizer's own rules, so a quoted value
 * is never re-entered (a decoy href written inside a title stays the
 * title's text) and "/" separates attributes as whitespace does. Values are
 * decoded, then resolved by the WHATWG URL parser, so https:\\host,
 * ht&#9;tps:, //host and a <base href> land where a browser lands, and read
 * through redirect wrappers. A value that names no destination this can
 * read, and is not plainly harmless, is reported as unresolved rather than
 * dropped, so the mail carrying it is screened.
 */

export interface TagAttr {
  /** Lowercase, as the tokenizer keeps it. */
  name: string;
  /** As written: character references not decoded; "" without a value. */
  value: string;
  /** The value's span in the html, its quotes included; -1 without a value. */
  start: number;
  end: number;
  /** The quote it is written in; "" when unquoted. */
  quote: "" | '"' | "'";
}

export interface HtmlTag {
  name: string;
  closing: boolean;
  /** The first of each name: a browser ignores a repeated attribute. */
  attrs: TagAttr[];
  start: number;
  end: number;
  /** 1 inside an Outlook conditional comment, which only Outlook renders as markup. */
  depth: number;
}

export interface HtmlVisitor {
  tag?(tag: HtmlTag): void;
  /** A run of text between tags, outside comments and raw-text elements. */
  text?(start: number, end: number, depth: number): void;
}

const isSpace = (c: number) => c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

/** Elements whose content the tokenizer reads as text, never as markup, up to their end tag. */
const RAW_TEXT = new Map(
  ["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes"].map((name) => [
    name,
    new RegExp(`</${name}[\\t\\n\\f\\r />]`, "gi"),
  ]),
);

/** A start or end tag from `lt`, null when the input ends inside it (a browser drops such a tag). */
function readTag(html: string, lt: number, nameStart: number, to: number): HtmlTag | null {
  let p = nameStart;
  while (p < to) {
    const c = html.charCodeAt(p);
    if (isSpace(c) || c === 47 || c === 62) break;
    p++;
  }
  const name = html.slice(nameStart, p).toLowerCase();
  const attrs: TagAttr[] = [];
  const seen = new Set<string>();
  for (;;) {
    while (p < to && (isSpace(html.charCodeAt(p)) || html.charCodeAt(p) === 47)) p++;
    if (p >= to) return null;
    if (html.charCodeAt(p) === 62) {
      return { name, closing: nameStart === lt + 2, attrs, start: lt, end: p + 1, depth: 0 };
    }
    // The first character always belongs to the name, even "=".
    const nameAt = p++;
    while (p < to) {
      const c = html.charCodeAt(p);
      if (isSpace(c) || c === 47 || c === 62 || c === 61) break;
      p++;
    }
    const attr: TagAttr = {
      name: html.slice(nameAt, p).toLowerCase(),
      value: "",
      start: -1,
      end: -1,
      quote: "",
    };
    while (p < to && isSpace(html.charCodeAt(p))) p++;
    if (p < to && html.charCodeAt(p) === 61) {
      p++;
      while (p < to && isSpace(html.charCodeAt(p))) p++;
      if (p >= to) return null;
      const q = html.charCodeAt(p);
      if (q === 34 || q === 39) {
        const close = html.indexOf(q === 34 ? '"' : "'", p + 1);
        if (close === -1 || close >= to) return null;
        attr.value = html.slice(p + 1, close);
        attr.start = p;
        attr.end = close + 1;
        attr.quote = q === 34 ? '"' : "'";
        p = close + 1;
      } else if (q !== 62) {
        attr.start = p;
        while (p < to && !isSpace(html.charCodeAt(p)) && html.charCodeAt(p) !== 62) p++;
        attr.value = html.slice(attr.start, p);
        attr.end = p;
      }
    }
    if (!seen.has(attr.name)) {
      seen.add(attr.name);
      attrs.push(attr);
    }
  }
}

/** Where a comment from `lt` ("<!--") ends: after "-->" or "--!>", at once for "<!-->" and "<!--->". */
function commentEnd(html: string, lt: number, to: number): number {
  const body = lt + 4;
  if (html.startsWith(">", body)) return body + 1;
  if (html.startsWith("->", body)) return body + 2;
  for (let k = html.indexOf("--", body); k !== -1 && k < to; k = html.indexOf("--", k + 1)) {
    if (html.charCodeAt(k + 2) === 62) return k + 3;
    if (html.charCodeAt(k + 2) === 33 && html.charCodeAt(k + 3) === 62) return k + 4;
  }
  return to;
}

/**
 * Walks html as the HTML tokenizer does, from `from` to `to`: start and
 * end tags with their attributes, and the text between them. Comments,
 * doctypes and raw-text element content (script, style, title, textarea)
 * are skipped. An Outlook conditional comment (<!--[if mso]>) is a comment
 * to every other client and markup to Outlook, so its content is walked
 * too, at depth 1, up to where a browser ends the comment. Linear: no
 * position is read twice, save a conditional comment's content once more.
 */
export function scanHtml(
  html: string,
  visitor: HtmlVisitor,
  from = 0,
  to = html.length,
  depth = 0,
): void {
  let i = from;
  let textStart = from;
  const flush = (end: number) => {
    if (end > textStart) visitor.text?.(textStart, end, depth);
  };
  while (i < to) {
    const lt = html.indexOf("<", i);
    if (lt === -1 || lt >= to) break;
    const c = html.charCodeAt(lt + 1);
    if (c === 33 || c === 63) {
      flush(lt);
      if (c === 33 && html.startsWith("--", lt + 2)) {
        i = commentEnd(html, lt, to);
        if (depth === 0 && /^\[if\b/i.test(html.slice(lt + 4, lt + 8))) {
          const open = html.slice(lt + 4, i).indexOf("]>");
          if (open !== -1)
            scanHtml(html, visitor, lt + 6 + open, Math.max(lt + 6 + open, i - 3), 1);
        }
      } else {
        // <!DOCTYPE>, <![endif]--> and <?...> are bogus comments, ended by the next ">".
        const end = html.indexOf(">", lt + 2);
        i = end === -1 || end >= to ? to : end + 1;
      }
      textStart = i;
      continue;
    }
    const closing = c === 47;
    const nameStart = closing ? lt + 2 : lt + 1;
    if (nameStart >= to || !isAlpha(html.charCodeAt(nameStart))) {
      if (!closing) {
        i = lt + 1;
        continue;
      }
      // "</>" is dropped, and "</ x>" is a bogus comment.
      flush(lt);
      const end = html.indexOf(">", lt + 2);
      i = end === -1 || end >= to ? to : end + 1;
      textStart = i;
      continue;
    }
    const tag = readTag(html, lt, nameStart, to);
    flush(lt);
    if (!tag) return;
    tag.depth = depth;
    visitor.tag?.(tag);
    i = tag.end;
    textStart = i;
    if (closing) continue;
    if (tag.name === "plaintext") return;
    const close = RAW_TEXT.get(tag.name);
    if (close) {
      close.lastIndex = i;
      const end = close.exec(html);
      i = end && end.index < to ? end.index : to;
      textStart = i;
    }
  }
  flush(to);
}

export interface ResolvedLink {
  /** The http(s) URL a client opens for the value; null when it names none. */
  href: string | null;
  /** Where the reader lands: `href` read through redirect wrappers; null when that cannot be told. */
  url: string | null;
  /** The value names no destination this can read, yet is not plainly harmless. */
  unresolved: boolean;
}

/** Relative values resolve here when the body sets no <base>; a link to it went nowhere. */
const PLACEHOLDER_BASE = "https://placeholder.invalid/";
const PLACEHOLDER_HOST = "placeholder.invalid";
/** Schemes that open no web page: a mail, a call or a message, an inline part, or script no mail client runs. */
const HARMLESS_SCHEMES = new Set([
  "mailto:",
  "tel:",
  "sms:",
  "callto:",
  "facetime:",
  "facetime-audio:",
  "whatsapp:",
  "javascript:",
  "about:",
  "cid:",
]);
/** Redirect wrappers read through per link; one nested deeper hides where it leads. */
const MAX_UNWRAP = 3;
const NOWHERE: ResolvedLink = { href: null, url: null, unresolved: false };
const UNKNOWN: ResolvedLink = { href: null, url: null, unresolved: true };

function parseUrl(value: string, base?: string): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

/** A host a client could open: a name under a public suffix, or www. before a dotted name. */
function reachableHost(host: string): boolean {
  if (!/\.(?:[a-z]{2,}|xn--[a-z0-9-]+)$/.test(host)) return false;
  if (host.startsWith("www.") && host.indexOf(".", 4) !== -1) return true;
  const parsed = parse(host);
  return parsed.isIcann === true && parsed.domain !== null;
}

function readThrough(href: string): ResolvedLink {
  let url = href;
  for (let level = 0; level < MAX_UNWRAP; level++) {
    const next = unwrapRedirect(url);
    if (next === url) return { href, url, unresolved: false };
    url = next;
  }
  return unwrapRedirect(url) === url
    ? { href, url, unresolved: false }
    : { href, url: null, unresolved: true };
}

/**
 * Where a link's value (references already decoded) takes the reader. A
 * value with no scheme resolves against `base`, the body's <base href>; one
 * that resolves nowhere (a relative path, a merge field) names no
 * destination, unless it starts with a host name a client may read as one
 * (www.evil.example/login). A scheme other than http(s) is followed through
 * a web URL or a reachable host it carries (microsoft-edge:https://...,
 * intent://host/...); otherwise it is harmless (mailto:, tel:, ...) or
 * unresolved.
 */
export function resolveLink(raw: string, base: string | null = null): ResolvedLink {
  const value = raw.replace(/[\t\n\r]/g, "").trim();
  if (value === "" || value.startsWith("#")) return NOWHERE;
  const url = parseUrl(value) ?? parseUrl(value, base ?? PLACEHOLDER_BASE);
  if (!url) return UNKNOWN;
  if (url.protocol === "http:" || url.protocol === "https:") {
    if (url.hostname !== PLACEHOLDER_HOST) return readThrough(url.href);
    const first = value.split(/[/?#\\]/, 1)[0]?.toLowerCase() ?? "";
    if (!first.includes(".") || !reachableHost(first)) return NOWHERE;
    const guessed = parseUrl(`https://${value}`);
    return guessed ? readThrough(guessed.href) : UNKNOWN;
  }
  if (HARMLESS_SCHEMES.has(url.protocol)) return NOWHERE;
  const inner = /https?:\/\/[^\s"'<>]+/i.exec(value)?.[0];
  const carried = inner ? parseUrl(inner) : null;
  if (carried && carried.hostname !== "") return readThrough(carried.href);
  if (url.hostname !== "" && reachableHost(url.hostname)) {
    return readThrough(`https://${url.hostname}/`);
  }
  return UNKNOWN;
}

/**
 * A URL found in text, an image or a file, which a client links only when
 * it reads as one: what it lands on, or nothing (an otpauth: QR code, "starts
 * with https://" in prose). Only markup carries an unresolved link.
 */
export function resolveTextUrl(raw: string): ResolvedLink {
  const link = resolveLink(raw);
  return link.unresolved ? NOWHERE : link;
}

/**
 * The destination screening records for an unresolved link. Under .invalid
 * it can never name a real host, and screening never clears it, as it never
 * clears a shortener: both hide where they lead.
 */
export const UNRESOLVED_DESTINATION = "unresolved.invalid";

export type LinkSource = "a" | "area" | "form" | "xlink" | "text";

export interface BodyLink extends ResolvedLink {
  source: LinkSource;
  /** The value as written, character references decoded. */
  raw: string;
  /** An anchor's text (tags taken out, references kept), an area's alt, a text link as written. */
  text: string;
  /** Where it starts: its tag in the html, or the text part's offset for a link found there. */
  index: number;
}

type Found = Omit<BodyLink, keyof ResolvedLink> & { unreadable: boolean };

/** A URL a client links in text by itself: one with a scheme, or a bare www. host. */
const TEXT_LINK = /(?:https?:\/\/|\bwww\.)[^\s<>"'`]+/gi;
const TEXT_LINK_TAIL = /[.,;:!?)\]}'"]+$/;
/** Links read per body. Past them one unresolved entry stands for the rest, so padding hides nothing. */
const MAX_LINKS = 10_000;

/**
 * Every link in an email: href on <a> and <area>, xlink:href on <a>, a
 * form's action and a button's formaction, and the URLs in the visible
 * text (outside anchors) and in `text`, the plain-text part, which clients
 * link by themselves.
 */
export function extractLinks(html: string | null, text: string | null): BodyLink[] {
  const found: Found[] = [];
  // The first <base href> sets where relative values resolve, wherever it sits.
  let base: string | null = null;
  let baseSeen = false;
  let full = false;
  const add = (source: LinkSource, raw: string, index: number, label = "", unreadable = false) => {
    if (found.length >= MAX_LINKS) {
      full = true;
      return -1;
    }
    found.push({ source, raw, text: label, index, unreadable });
    return found.length - 1;
  };
  const textLinks = (s: string, offset: number) => {
    for (const m of s.matchAll(TEXT_LINK)) {
      const url = m[0].replace(TEXT_LINK_TAIL, "");
      if (url.length > 4) add("text", url, offset + m.index, url);
    }
  };
  if (html) {
    // An anchor's text runs to its end tag or the next anchor, which closes it.
    const open: ({ links: number[]; from: number } | null)[] = [null, null];
    const close = (depth: number, at: number) => {
      const anchor = open[depth];
      if (!anchor) return;
      const label = visibleText(html.slice(anchor.from, at));
      for (const k of anchor.links) {
        const link = found[k];
        if (link) link.text = label;
      }
      open[depth] = null;
    };
    scanHtml(html, {
      tag(tag) {
        const attr = (name: string) => tag.attrs.find((a) => a.name === name);
        const value = (name: string) => {
          const a = attr(name);
          return a && a.start !== -1 ? decodeEntities(a.value) : a ? "" : undefined;
        };
        // A reference decodeEntities does not know may still spell part of the URL to a browser.
        const unreadable = (name: string) => hasUnknownReference(attr(name)?.value ?? "");
        if (tag.name === "a") {
          close(tag.depth, tag.start);
          if (tag.closing) return;
          const links: number[] = [];
          for (const [name, source] of [
            ["href", "a"],
            ["xlink:href", "xlink"],
          ] as const) {
            const raw = value(name);
            if (raw !== undefined) links.push(add(source, raw, tag.start, "", unreadable(name)));
          }
          if (links.length > 0) open[tag.depth] = { links, from: tag.end };
          return;
        }
        if (tag.closing) return;
        if (tag.name === "area") {
          const raw = value("href");
          if (raw !== undefined)
            add("area", raw, tag.start, value("alt") ?? "", unreadable("href"));
        } else if (tag.name === "form") {
          const raw = value("action");
          if (raw !== undefined) add("form", raw, tag.start, "", unreadable("action"));
        } else if (tag.name === "base" && !baseSeen) {
          const raw = value("href");
          baseSeen = raw !== undefined;
          const url = raw === undefined ? null : parseUrl(raw, PLACEHOLDER_BASE);
          if (url && /^https?:$/.test(url.protocol) && url.hostname !== PLACEHOLDER_HOST) {
            base = url.href;
          }
        }
        const action = value("formaction");
        if (action !== undefined) add("form", action, tag.start, "", unreadable("formaction"));
      },
      text(start, end, depth) {
        if (!open[depth]) textLinks(decodeEntities(html.slice(start, end)), start);
      },
    });
    close(0, html.length);
    close(1, html.length);
  }
  if (text) textLinks(text, 0);
  const resolved = new Map<string, ResolvedLink>();
  const links: BodyLink[] = found.map(({ unreadable, ...link }) => {
    const key = `${link.source === "text" ? "t" : "m"}${link.raw}`;
    let to = resolved.get(key);
    if (!to) {
      to = link.source === "text" ? resolveTextUrl(link.raw) : resolveLink(link.raw, base);
      resolved.set(key, to);
    }
    return { ...link, ...(unreadable ? UNKNOWN : to) };
  });
  if (full) {
    links.push({ source: "a", raw: "", text: "", index: html?.length ?? 0, ...UNKNOWN });
  }
  return links;
}
