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
 * parts arrive. Asked, images come straight from the sender over https; the
 * rest stays blocked. The frame's sandbox already stops scripts, forms and
 * meta refresh.
 */
function receivedLockdown(imageSources: string): string {
  return (
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imageSources}; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'">` +
    '<meta http-equiv="x-dns-prefetch-control" content="off">' +
    '<meta name="referrer" content="no-referrer">'
  );
}

/**
 * A received message's preview document. The policy goes first, after the
 * doctype if there is one, so it governs every element that follows: ahead
 * of <html> the parser puts it in an implied head, and the doctype it kept
 * leaves the message's rendering mode as sent.
 */
export function lockDownReceivedHtml(
  html: string,
  { remoteImages = false }: { remoteImages?: boolean } = {},
): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0] ?? "";
  return (
    doctype + receivedLockdown(remoteImages ? "data: https:" : "data:") + html.slice(doctype.length)
  );
}

/** A received message's HTML as its frame shows it, and whether it asks for remote images. */
export interface MailBody {
  html: string;
  remoteImages: boolean;
}

const REMOTE_URL = /^\s*(?:https?:)?\/\//i;
const REMOTE_CSS_URL = /url\(\s*['"]?\s*(?:https?:)?\/\//i;
const QUOTE_SELECTOR = [...QUOTE_CLASSES.map((name) => `.${name}`), 'blockquote[type="cite"]'].join(
  ", ",
);
const OUTLOOK_QUOTE_ID: ReadonlySet<string> = new Set(OUTLOOK_QUOTE_IDS);
const LINE_BLOCKS = "div, p, blockquote, li, tr, h1, h2, h3, h4, h5, h6";

/** Whether anything in the document would load an image from the network. */
function hasRemoteImages(doc: Document): boolean {
  const some = (selector: string, remote: (el: Element) => boolean) =>
    Array.from(doc.querySelectorAll(selector)).some(remote);
  const url = (name: string) => (el: Element) => REMOTE_URL.test(el.getAttribute(name) ?? "");
  return (
    some("img[src]", url("src")) ||
    some("[background]", url("background")) ||
    some("img[srcset], source[srcset]", (el) =>
      (el.getAttribute("srcset") ?? "").split(",").some((candidate) => REMOTE_URL.test(candidate)),
    ) ||
    some("[style]", (el) => REMOTE_CSS_URL.test(el.getAttribute("style") ?? "")) ||
    some("style", (el) => REMOTE_CSS_URL.test(el.textContent ?? ""))
  );
}

/** A quote container opening with a forward marker: its original is what the sender wants read. */
function isForward(el: Element): boolean {
  const copy = el.cloneNode(true) as Element;
  for (const br of copy.querySelectorAll("br")) br.replaceWith("\n");
  for (const block of copy.querySelectorAll(LINE_BLOCKS)) block.append("\n");
  const first = (copy.textContent ?? "").split("\n").find((line) => line.trim() !== "");
  return hasForwardMarker(first ?? "");
}

/** Whether a reader would see anything in the body: text, or an image. */
function showsAnything(body: HTMLElement): boolean {
  const copy = body.cloneNode(true) as HTMLElement;
  for (const el of copy.querySelectorAll("style, script, template, title")) el.remove();
  return (copy.textContent ?? "").trim() !== "" || copy.querySelector("img") !== null;
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
 * A received message's HTML, parsed once for its frame. What would override
 * the frame's own policy goes: <base>, <link> (a preconnect is a read
 * receipt), and http-equiv and referrer metas, which win over ours because
 * they come later. A reply also comes without its quoted history, unless
 * that is all there is or it holds a forward.
 */
export function prepareReceivedHtml(html: string): { full: MailBody; trimmed: MailBody | null } {
  // A server render has no DOM, and no message reaches a frame before the
  // client holds it; the frame's sandbox and policy guard it either way.
  if (typeof DOMParser === "undefined") {
    return { full: { html, remoteImages: false }, trimmed: null };
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of doc.querySelectorAll("base, link, meta")) {
    if (
      el.localName !== "meta" ||
      el.hasAttribute("http-equiv") ||
      el.getAttribute("name")?.trim().toLowerCase() === "referrer"
    ) {
      el.remove();
    }
  }
  const root = doc.documentElement;
  const full = { html: root.outerHTML, remoteImages: hasRemoteImages(doc) };
  const quotes = Array.from(doc.querySelectorAll(QUOTE_SELECTOR)).filter(
    (el) => !el.parentElement?.closest(QUOTE_SELECTOR),
  );
  const outlook = Array.from(doc.querySelectorAll("[id]")).find((el) =>
    OUTLOOK_QUOTE_ID.has(el.id.toLowerCase()),
  );
  if ((quotes.length === 0 && !outlook) || quotes.some(isForward)) return { full, trimmed: null };
  for (const el of quotes) el.remove();
  if (outlook) cutFrom(outlook, doc.body);
  if (!showsAnything(doc.body)) return { full, trimmed: null };
  return { full, trimmed: { html: root.outerHTML, remoteImages: hasRemoteImages(doc) } };
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
  return body.slice(0, body.length - quoted.length).trimEnd() || null;
}

/** Where a link in a message leads, as its tooltip names it: a mailto's address, else the URL. */
export function linkDestination(href: string): { text: string; mail: boolean } {
  if (!/^mailto:/i.test(href)) return { text: href, mail: false };
  const address = href.slice("mailto:".length).split("?")[0] ?? "";
  try {
    return { text: decodeURIComponent(address), mail: true };
  } catch {
    return { text: address, mail: true };
  }
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
