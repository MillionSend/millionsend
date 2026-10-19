import { dropInvisible } from "@millionsend/core/customer-text";
import { ownerDomain } from "@millionsend/core/org-domain";
import {
  hasForwardMarker,
  OUTLOOK_QUOTE_IDS,
  QUOTE_CLASSES,
  splitTextQuotes,
} from "@millionsend/core/receiving-quotes";

export type EmailScheme = "light" | "dark";

/** A preview frame's own color, under the message: a dark client's canvas, or paper white. */
export const PREVIEW_CANVAS: Record<EmailScheme, string> = { light: "#ffffff", dark: "#111113" };

/*
 * Approximation of how dark-mode mail clients (Gmail's auto-darkening, Apple
 * Mail with supported-color-schemes) transform a light email: invert + rotate
 * hues, then re-invert media so photos and logos keep their real colors. Full
 * invert(1) both ways keeps images pixel-exact. Preview-only — nothing here
 * ships in a send.
 */
export const DARK_CLIENT_SIM = `<style>
  html { filter: invert(1) hue-rotate(180deg); background: #fff; }
  img, video, [style*="background-image"] { filter: invert(1) hue-rotate(180deg); }
</style>`;

const SCHEME_QUERY = /prefers-color-scheme\s*:\s*(dark|light)/gi;
/* Always-true and always-false stand-ins that keep any surrounding media
   query grammatically valid ("screen and (...)" included). */
const ALWAYS = "min-width: 0px";
const NEVER = "min-width: 999999px";

/** Whether the message carries its own dark-mode treatment, the way a client would detect it. */
export function declaresColorSchemes(html: string): boolean {
  return /prefers-color-scheme|supported-color-schemes|name=["']?color-scheme/i.test(html);
}

/**
 * Preview the message as a client in `scheme` would show it. The iframe reads
 * the viewer's OS preference, not the app's, so both schemes are forced: the
 * message's own prefers-color-scheme rules are switched on or off in place.
 * A message with no dark treatment at all gets what Gmail and friends do to
 * it: the auto-darkening filter.
 */
export function emulateEmailScheme(html: string, scheme: EmailScheme): string {
  const dark = scheme === "dark";
  const declares = declaresColorSchemes(html);
  const forced = html.replace(SCHEME_QUERY, (_m, which: string) =>
    (which.toLowerCase() === "dark") === dark ? ALWAYS : NEVER,
  );
  // The auto-darkening simulation inverts a LIGHT rendering: under
  // color-scheme:dark the UA would already paint unstyled text light, and the
  // invert would turn it dark again (a text-only message reads black on black).
  const simulate = dark && !declares;
  const base = `<style>:root{color-scheme:${simulate ? "light" : scheme}}</style>`;
  return openLinksOutside(forced) + base + (simulate ? DARK_CLIENT_SIM : "");
}

const LINKS_OUTSIDE = '<base target="_blank">';

/**
 * A click in the preview opens in the viewer's own browser. Inside the
 * sandboxed frame a link could only navigate the frame, which the sandbox
 * blocks; the frame's sandbox lets popups out for the same reason. The base
 * goes in the head when there is one, where every browser honours it.
 */
function openLinksOutside(html: string): string {
  const head = /<head[^>]*>/i.exec(html);
  return head
    ? `${html.slice(0, head.index + head[0].length)}${LINKS_OUTSIDE}${html.slice(head.index + head[0].length)}`
    : LINKS_OUTSIDE + html;
}

/*
 * Mail from a stranger loads nothing from the network until the reader asks:
 * a remote image is a read receipt, and remote CSS, fonts and DNS prefetches
 * leak the same way. Inline styles and data: images stay, which is how cid:
 * parts arrive. Asked, images come straight from the hosts the message names
 * over https; the rest stays blocked. The frame's sandbox already stops
 * scripts, forms and meta refresh.
 */
function receivedLockdown(imageSources: string): string {
  return (
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imageSources}; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'">` +
    '<meta http-equiv="x-dns-prefetch-control" content="off">' +
    '<meta name="referrer" content="no-referrer">'
  );
}

/**
 * A received message's preview document, with images from `imageHosts`
 * allowed. The policy goes first, after the doctype if there is one, so it
 * governs every element that follows: ahead of <html> the parser puts it in
 * an implied head, and the doctype it kept leaves the message's rendering
 * mode as sent.
 */
export function lockDownReceivedHtml(
  html: string,
  { imageHosts = [] }: { imageHosts?: readonly string[] } = {},
): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0] ?? "";
  const sources = ["data:", ...imageHosts.map((host) => `https://${host}`)].join(" ");
  return doctype + receivedLockdown(sources) + html.slice(doctype.length);
}

/** A received message's HTML as its frame shows it, and the hosts its remote images come from. */
export interface MailBody {
  html: string;
  imageHosts: string[];
}

const REMOTE_URL = /^\s*(?:https?:)?\/\//i;
const CSS_URL = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
/** What a policy's host source can name; anything else stays blocked. */
const POLICY_HOST = /^[a-z0-9.-]+(?::\d+)?$/;
const QUOTE_SELECTOR = [...QUOTE_CLASSES.map((name) => `.${name}`), 'blockquote[type="cite"]'].join(
  ", ",
);
const OUTLOOK_QUOTE_ID: ReadonlySet<string> = new Set(OUTLOOK_QUOTE_IDS);
const GMAIL_QUOTE = ".gmail_quote, .gmail_quote_container";
const LINE_BLOCKS = "div, p, blockquote, li, tr, h1, h2, h3, h4, h5, h6";
/** Elements whose text never shows. */
const UNSEEN = new Set(["style", "script", "template", "title"]);
/**
 * Parse rounds a message gets to read the same twice. Mail settles on the
 * second; markup that keeps changing is built to slip past the checks.
 */
const SETTLE_ROUNDS = 4;

/**
 * The hosts a document's remote images come from: what the reader's "Show
 * images" lets through. The dashboard's own host never is: the frame shares
 * its origin, so an image there would go out with the reader's session.
 */
function imageHosts(doc: Document): string[] {
  const hosts = new Set<string>();
  const add = (raw: string) => {
    if (!REMOTE_URL.test(raw)) return;
    try {
      const url = new URL(raw.trim(), location.href);
      if (
        /^https?:$/.test(url.protocol) &&
        url.host !== location.host &&
        POLICY_HOST.test(url.host)
      ) {
        hosts.add(url.host);
      }
    } catch {
      // Not a URL: nothing loads from it.
    }
  };
  const css = (text: string) => {
    for (const [, , url = ""] of text.matchAll(CSS_URL)) add(url);
  };
  for (const el of doc.querySelectorAll("img[src]")) add(el.getAttribute("src") ?? "");
  for (const el of doc.querySelectorAll("[background]")) add(el.getAttribute("background") ?? "");
  for (const el of doc.querySelectorAll("img[srcset], source[srcset]")) {
    for (const candidate of (el.getAttribute("srcset") ?? "").split(",")) {
      add(candidate.trim().split(/\s+/)[0] ?? "");
    }
  }
  for (const el of doc.querySelectorAll("[style]")) css(el.getAttribute("style") ?? "");
  for (const el of doc.querySelectorAll("style")) css(el.textContent ?? "");
  return [...hosts];
}

/**
 * Takes out what would override the frame's own policy or reach past it:
 * <base>, <link> (a preconnect is a read receipt), http-equiv and referrer
 * metas (later than ours, they win), nested frames (a srcdoc document none
 * of this reaches) and declarative shadow roots (a tree no query enters).
 * Every link opens a new tab that cannot reach back: a named target, or an
 * SVG link's own, would keep an opener to the dashboard.
 */
function strip(doc: Document): void {
  for (const el of doc.querySelectorAll("base, link, meta, iframe")) {
    if (
      el.localName !== "meta" ||
      el.hasAttribute("http-equiv") ||
      el.getAttribute("name")?.trim().toLowerCase() === "referrer"
    ) {
      el.remove();
    }
  }
  for (const el of doc.querySelectorAll("template")) {
    el.removeAttribute("shadowrootmode");
    el.removeAttribute("shadowroot");
  }
  for (const el of doc.querySelectorAll("a, area")) {
    el.setAttribute("target", "_blank");
    el.setAttribute("rel", "noopener noreferrer");
  }
}

/**
 * The message as its frame will build it, stripped, or null when it never
 * reads the same twice. The frame parses the markup again, and some trees
 * serialize to markup that parses differently (MathML and SVG text read back
 * as elements), so the strip runs until a round changes nothing. The doctype
 * gives the frame's no-quirks parse.
 */
function settle(html: string): Document | null {
  let source = html;
  for (let round = 0; round < SETTLE_ROUNDS; round++) {
    const doc = new DOMParser().parseFromString(`<!doctype html>${source}`, "text/html");
    strip(doc);
    const out = doc.documentElement.outerHTML;
    if (out === source) return doc;
    source = out;
  }
  return null;
}

function mailBody(doc: Document): MailBody {
  return { html: doc.documentElement.outerHTML, imageHosts: imageHosts(doc) };
}

/** A quote container opening with a forward marker: its original is what the sender wants read. */
function isForward(el: Element): boolean {
  const copy = el.cloneNode(true) as Element;
  for (const br of copy.querySelectorAll("br")) br.replaceWith("\n");
  for (const block of copy.querySelectorAll(LINE_BLOCKS)) block.append("\n");
  const first = (copy.textContent ?? "").split("\n").find((line) => line.trim() !== "");
  return hasForwardMarker(first ?? "");
}

/** An element its own style hides, the way mail hides a preheader. */
function hidden(el: Element): boolean {
  if (el.hasAttribute("hidden")) return true;
  // Not every DOM gives a MathML element a style.
  const style = (el as Partial<HTMLElement>).style;
  if (!style) return false;
  const collapsed =
    Number.parseFloat(style.maxHeight) === 0 || Number.parseFloat(style.height) === 0;
  return (
    style.display === "none" ||
    style.visibility === "hidden" ||
    (collapsed && style.overflow === "hidden")
  );
}

/**
 * Whether `node`, inside `quote`, is an answer written inline: Gmail keeps
 * those in its quote, after its first quoted part (the attribution comes
 * before it) and outside them all.
 */
function answeredInline(quote: Element, node: Node): boolean {
  if (!quote.matches(GMAIL_QUOTE) || quote.localName === "blockquote") return false;
  const first = quote.querySelector("blockquote");
  const quoted = node.parentElement?.closest("blockquote") ?? null;
  return (
    first !== null &&
    (first.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
    !quote.contains(quoted)
  );
}

/**
 * The last text or image a reader would see that the sender wrote: outside
 * `quotes`, or answered inline in one. Null when there is none.
 */
function lastWritten(body: HTMLElement, quotes: readonly Element[]): Node | null {
  const walker = body.ownerDocument.createTreeWalker(
    body,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) =>
        node.nodeType === Node.ELEMENT_NODE &&
        (UNSEEN.has((node as Element).localName) || hidden(node as Element))
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    },
  );
  let last: Node | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const shows =
      node.nodeType === Node.TEXT_NODE
        ? dropInvisible(node.textContent ?? "").trim() !== ""
        : (node as Element).localName === "img";
    if (!shows) continue;
    const quote = quotes.find((q) => q.contains(node));
    if (!quote || answeredInline(quote, node)) last = node;
  }
  return last;
}

/** Removes `el`, the rule Outlook draws right above it, and everything after it up to the body. */
function cutFrom(el: Element, body: HTMLElement): void {
  if (el.previousElementSibling?.localName === "hr") el.previousElementSibling.remove();
  for (let node: Element | null = el; node && node !== body; node = node.parentElement) {
    while (node.nextSibling) node.nextSibling.remove();
  }
  el.remove();
}

/**
 * Folds a reply's quoted history in place: Outlook's, from its marker on,
 * and every quote after the last thing the sender wrote. Answers written
 * between quotes keep theirs. False when nothing folds: there is no quote,
 * the quote is all there is, or it holds a forward.
 */
function foldQuotes(doc: Document): boolean {
  const outlook = Array.from(doc.body.querySelectorAll("[id]")).find(
    (el) => OUTLOOK_QUOTE_ID.has(el.id.toLowerCase()) && el.closest(QUOTE_SELECTOR) === null,
  );
  if (outlook) cutFrom(outlook, doc.body);
  const quotes = Array.from(doc.body.querySelectorAll(QUOTE_SELECTOR)).filter(
    (el) => !el.parentElement?.closest(QUOTE_SELECTOR),
  );
  const last = lastWritten(doc.body, quotes);
  if (!last) return false;
  const trailing = quotes.filter(
    (el) => (last.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
  );
  if (trailing.some(isForward)) return false;
  for (const el of trailing) el.remove();
  return outlook !== undefined || trailing.length > 0;
}

/**
 * A received message's HTML, read once for its frame: stripped (see strip),
 * and a reply also without its quoted history (see foldQuotes).
 */
export function prepareReceivedHtml(html: string): { full: MailBody; trimmed: MailBody | null } {
  // A server render has no DOM, and no message reaches a frame before the
  // client holds it; the frame's sandbox and policy guard it either way.
  if (typeof DOMParser === "undefined") {
    return { full: { html, imageHosts: [] }, trimmed: null };
  }
  const doc = settle(html);
  // Markup built to slip past the checks: none of it is shown.
  if (!doc) return { full: { html: "", imageHosts: [] }, trimmed: null };
  const full = mailBody(doc);
  const folded = foldQuotes(doc) ? settle(doc.documentElement.outerHTML) : null;
  return { full, trimmed: folded ? mailBody(folded) : null };
}

/** Whether a subject names a forward, as mail clients prefix one (Fwd:, FW:, ENC:, RV:, WG:, TR:). */
export function isForwardSubject(subject: string | null): boolean {
  return /^\s*(?:fwd?|enc|rv|wg|tr)\s*:/i.test(subject ?? "");
}

/**
 * A plain-text body without the quoted history that ends it, read by the
 * same rules as the agents' read; null when there is none, when the quote is
 * all there is, or when answers sit between quoted lines.
 */
export function withoutTrailingQuote(text: string): string | null {
  const body = text.replace(/\r\n?/g, "\n").trimEnd();
  const { quoted } = splitTextQuotes(body);
  if (!quoted || !body.endsWith(quoted)) return null;
  // Answered inline: lines of the sender's own between the quoted ones.
  const lines = quoted.split("\n");
  const first = lines.findIndex((line) => line.trimStart().startsWith(">"));
  if (
    first >= 0 &&
    lines.slice(first).some((line) => line.trim() !== "" && !line.trimStart().startsWith(">"))
  ) {
    return null;
  }
  return body.slice(0, body.length - quoted.length).trimEnd() || null;
}

/** Where a link in a message leads, as its tooltip names it. */
export interface LinkDestination {
  /** Never cut: a web link's scheme and host up to `domain`, or a mailto's address. */
  lead: string;
  /** The domain the host's owner registered, set apart: what a look-alike host buries. */
  domain: string;
  /** The port, path and query after it, which a tracking link runs long in. */
  rest: string;
  mail: boolean;
}

export function linkDestination(href: string): LinkDestination {
  if (/^mailto:/i.test(href)) {
    const address = href.slice("mailto:".length).split("?")[0] ?? "";
    let lead = address;
    try {
      lead = decodeURIComponent(address);
    } catch {
      // Malformed escapes: the address as written.
    }
    return { lead, domain: "", rest: "", mail: true };
  }
  try {
    const url = new URL(href);
    if (/^https?:$/.test(url.protocol)) {
      const domain = ownerDomain(url.hostname);
      const at = url.hostname.endsWith(domain) ? url.hostname.length - domain.length : -1;
      const path = `${url.pathname}${url.search}${url.hash}`;
      const rest = `${url.port ? `:${url.port}` : ""}${path === "/" ? "" : path}`;
      return at < 0
        ? { lead: `${url.protocol}//${url.hostname}`, domain: "", rest, mail: false }
        : { lead: `${url.protocol}//${url.hostname.slice(0, at)}`, domain, rest, mail: false };
    }
  } catch {
    // Not a URL the parser reads: shown as written.
  }
  return { lead: "", domain: "", rest: href, mail: false };
}

/** localStorage key prefix: one key per sender domain whose remote images always load. */
export const MAIL_IMAGES_KEY_PREFIX = "ms-mail-images:";
// Tells every message on screen, not only the one clicked; "storage" covers other tabs.
const MAIL_IMAGES_EVENT = "ms-mail-images";

export function imagesAlwaysShown(domain: string): boolean {
  try {
    return localStorage.getItem(MAIL_IMAGES_KEY_PREFIX + domain) === "1";
  } catch {
    return false;
  }
}

export function alwaysShowImages(domain: string): void {
  try {
    localStorage.setItem(MAIL_IMAGES_KEY_PREFIX + domain, "1");
  } catch {
    // Storage unavailable (private mode): the message on screen still shows them.
  }
  window.dispatchEvent(new Event(MAIL_IMAGES_EVENT));
}

/** Subscribes to changes of the domains whose images always load; returns the unsubscribe. */
export function onImagesAlwaysShown(callback: () => void): () => void {
  window.addEventListener(MAIL_IMAGES_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(MAIL_IMAGES_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}
