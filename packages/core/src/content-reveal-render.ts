import { decodeEntities, stripHiddenElements } from "./abuse-judge/block.js";
import {
  CONTENT_REVEAL_TEXT_MAX_CHARS,
  type RevealedContent,
  type RevealSpan,
} from "./content-reveal.js";
import { isIpLiteral, visibleText } from "./email-insights.js";
import { registrableDomain } from "./org-domain.js";

/**
 * The one redaction pass an operator's view of a customer's message goes
 * through. Pure: nothing here decrypts, reads or writes.
 */

/** What a masked run is replaced with. The original never leaves the server. */
const MASK = "••••••";

/** Enough of a link to judge where it points, never enough to follow a one-time one. */
const URL_PATH_STUB_MAX = 24;
/** A cut link ends here, so a shortened one is never mistaken for the whole. */
const CUT = "…";
/**
 * Written with a scheme or as a bare www host; both are links to a reader.
 * The scheme branch takes no word boundary: a link glued to the word before
 * it — or to the tail of a run some other rule matched — is still a link, and
 * a boundary there would let the whole of it through.
 */
const URL_RE = /(?:https?:\/\/|\bwww\.)[^\s<>"'`)\]]+/gi;
/** Trailing sentence punctuation is not part of the link. */
const URL_TAIL = /[.,;:!?]+$/;

/**
 * Each run is bounded by its own alphabet rather than by \b: an underscore is
 * a word character, so a boundary would refuse to match after the prefix every
 * modern key wears — sk_live_, whsec_, ghp_ — and hand the secret back whole.
 */
const SECRETS: RegExp[] = [
  // JWT: three base64url segments.
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
  /(?<![0-9a-fA-F])[0-9a-fA-F]{32,}(?![0-9a-fA-F])/g,
  /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}/g,
  // This platform's own API key: base64url, so neither the hex nor the base64
  // shape above catches it, and it is the credential most likely to be quoted
  // back into a message the operator ends up reading.
  /\bms_[A-Za-z0-9_-]{20,}/g,
];

/** Words a one-time code follows, in both of the dashboard's languages. */
const CODE_WORD = /\b(?:c[óo]digos?|codes?|otp|pins?|tokens?|senhas?|passwords?|verification)\b/gi;
/** How far past such a word a bare number is read as that code. */
const CODE_WINDOW = 40;
const CODE_DIGITS = /(?<!\d)\d{4,8}(?!\d)/g;
/**
 * The local part of an address: RFC 5322 atext and dots, Unicode letters and
 * marks for internationalised ones. "/" is left out: legal, never seen in a
 * real address, and it is what glues a link's path to an @ (youtube.com/@x).
 * A run starts only where its alphabet does, so a long run with no @ is
 * scanned once rather than from each of its characters.
 */
const EMAIL_LOCAL_PART =
  /(?<![\p{L}\p{M}\p{N}.!#$%&'*+=?^_`{|}~-])[\p{L}\p{M}\p{N}.!#$%&'*+=?^_`{|}~-]+@(?=[\p{L}\p{N}])/gu;

interface Hit {
  start: number;
  end: number;
  text: string;
}

function reduceUrl(raw: string): string {
  const scheme = /^https?:\/\//i.exec(raw)?.[0] ?? "";
  let url: URL;
  try {
    url = new URL(scheme ? raw : `https://${raw}`);
  } catch {
    return MASK;
  }
  // The query and the fragment are dropped rather than capped: a one-time
  // token often fits inside the cap there, and nothing in a query helps an
  // operator judge where a link goes.
  const path = url.pathname.replace(/^\/$/, "");
  const trimmed = path.length > URL_PATH_STUB_MAX ? path.slice(0, URL_PATH_STUB_MAX) : path;
  const cut =
    trimmed.length < path.length || url.search !== "" || url.hash !== ""
      ? `${trimmed}${CUT}`
      : trimmed;
  // A bare address keeps its host: reducing 10.0.0.7 to a "domain" would
  // name a host that does not exist, and the literal is itself the signal.
  const host = isIpLiteral(url.hostname) ? url.hostname : registrableDomain(url.hostname);
  // A link written without a scheme keeps none: naming one it did not have
  // would put words in the sender's mouth.
  return `${scheme.toLowerCase()}${host}${cut}`;
}

function urlHits(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0].replace(URL_TAIL, "");
    if (raw.length === 0) continue;
    hits.push({ start: m.index, end: m.index + raw.length, text: reduceUrl(raw) });
  }
  return hits;
}

function secretHits(text: string): Hit[] {
  return SECRETS.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((m) => ({
      start: m.index,
      end: m.index + m[0].length,
      text: MASK,
    })),
  );
}

function codeHits(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const word of text.matchAll(CODE_WORD)) {
    const from = word.index + word[0].length;
    const window = text.slice(from, from + CODE_WINDOW);
    for (const digits of window.matchAll(CODE_DIGITS)) {
      hits.push({
        start: from + digits.index,
        end: from + digits.index + digits[0].length,
        text: MASK,
      });
    }
  }
  return hits;
}

/**
 * Reduce every link to where it points and mask what reads as a credential.
 * Earlier hits win an overlap, and the passes are ordered so a token inside a
 * link is cut by the link's own path stub rather than masked twice.
 */
export function redactRevealedText(text: string): RevealedContent {
  const hits = [...urlHits(text), ...secretHits(text), ...codeHits(text)].sort(
    (a, b) => a.start - b.start || b.end - a.end,
  );
  const spans: RevealSpan[] = [];
  let cursor = 0;
  let redactions = 0;
  for (const hit of hits) {
    // A hit already covered is dropped; one that only overlaps still emits, so
    // the tail an earlier hit left behind is replaced rather than published.
    if (hit.end <= cursor) continue;
    if (hit.start > cursor) spans.push({ text: text.slice(cursor, hit.start) });
    spans.push({ text: hit.text, redacted: true });
    redactions += 1;
    cursor = hit.end;
  }
  if (cursor < text.length) spans.push({ text: text.slice(cursor) });
  return { spans, redactions };
}

/** `someone@example.com` → `••••••@example.com`: the domain is the signal, the local part names a person. */
export function maskEmailLocalParts(text: string, mask = MASK): string {
  return text.replace(EMAIL_LOCAL_PART, `${mask}@`);
}

/** Cut the spans to a character budget, keeping whole spans where they fit. */
function truncate(content: RevealedContent, max: number): RevealedContent {
  let left = max;
  const spans: RevealSpan[] = [];
  for (const span of content.spans) {
    if (left <= 0) break;
    if (span.text.length <= left) {
      spans.push(span);
      left -= span.text.length;
      continue;
    }
    // A redacted run is all or nothing: half a mask says less than none.
    if (!span.redacted) spans.push({ text: `${span.text.slice(0, left)}…` });
    left = 0;
  }
  return { spans, redactions: spans.filter((s) => s.redacted).length };
}

/**
 * The only shape of a customer's message an operator ever sees: the rendered
 * visible text of the HTML (hidden elements stripped first, as the content
 * monitor does), or the plain-text part when there is no HTML — redacted and
 * cut. Never the HTML itself, the recipients, the headers or the attachments.
 */
export function renderRevealedBody(body: {
  html: string | null;
  text: string | null;
}): RevealedContent {
  // Empty HTML is no HTML: a message carrying only a text part must not read
  // as an empty body.
  const source = body.html
    ? decodeEntities(visibleText(stripHiddenElements(body.html).html))
    : (body.text ?? "").trim();
  return truncate(redactRevealedText(source), CONTENT_REVEAL_TEXT_MAX_CHARS);
}
