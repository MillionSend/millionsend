import { decodeEntities, stripHiddenElements } from "./abuse-judge/body.js";
import {
  CONTENT_REVEAL_TEXT_MAX_CHARS,
  type RevealedContent,
  type RevealSpan,
} from "./content-reveal.js";
import { isIpLiteral, visibleText } from "./email-insights.js";
import { API_KEY_PATTERN, MASK } from "./mask.js";
import { registrableDomain } from "./org-domain.js";

/**
 * The one redaction pass an operator's view of a customer's message goes
 * through. Pure: nothing here decrypts, reads or writes.
 */

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
  API_KEY_PATTERN,
];

/** Words a one-time code follows, in both of the dashboard's languages. */
const CODE_WORD = /\b(?:c[óo]digos?|codes?|otp|pins?|tokens?|senhas?|passwords?|verification)\b/gi;
/** How far past such a word a bare number is read as that code. */
const CODE_WINDOW = 40;
const CODE_DIGITS = /(?<!\d)\d{4,8}(?!\d)/g;

/**
 * A CPF (11 digits) or a CNPJ (14, the first 12 alphanumeric since the
 * 2026 format), with or without its dots, slash and dash. Masked only when
 * its check digits hold, so an order number of the same length goes through.
 */
const TAX_ID =
  /(?<![\p{L}\p{N}])(?:\d{3}\.?\d{3}\.?\d{3}-?\d{2}|[0-9A-Z]{2}\.?[0-9A-Z]{3}\.?[0-9A-Z]{3}\/?[0-9A-Z]{4}-?\d{2})(?![\p{L}\p{N}])/gu;

/** The mod-11 check digit of `body`, each character worth its code point minus 48 ("A" is 17), as the alphanumeric CNPJ defines. */
function checkDigit(body: string, weights: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += (body.charCodeAt(i) - 48) * (weights[i] as number);
  const r = sum % 11;
  return r < 2 ? 0 : 11 - r;
}

const CPF_WEIGHTS = [11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_WEIGHTS = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

function validTaxId(raw: string): boolean {
  const id = raw.replace(/[./-]/g, "");
  // All-same strings pass the arithmetic and are never issued.
  if (/^(.)\1*$/.test(id)) return false;
  const weights = id.length === 11 ? CPF_WEIGHTS : id.length === 14 ? CNPJ_WEIGHTS : null;
  if (!weights || (id.length === 11 && !/^\d+$/.test(id))) return false;
  const n = id.length - 2;
  return (
    checkDigit(id.slice(0, n), weights.slice(1)) === Number(id[n]) &&
    checkDigit(id.slice(0, n + 1), weights) === Number(id[n + 1])
  );
}

function maskTaxIds(text: string): string {
  return text.replace(TAX_ID, (m) => (validTaxId(m) ? MASK : m));
}

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
    hits.push({ start: m.index, end: m.index + raw.length, text: maskTaxIds(reduceUrl(raw)) });
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

function taxIdHits(text: string): Hit[] {
  return [...text.matchAll(TAX_ID)]
    .filter((m) => validTaxId(m[0]))
    .map((m) => ({ start: m.index, end: m.index + m[0].length, text: MASK }));
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
 * Reduce every link to where it points and mask what reads as a credential
 * or a CPF or CNPJ.
 * Earlier hits win an overlap, and the passes are ordered so a token inside a
 * link is cut by the link's own path stub rather than masked twice.
 */
export function redactRevealedText(text: string): RevealedContent {
  const hits = [...urlHits(text), ...secretHits(text), ...codeHits(text), ...taxIdHits(text)].sort(
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
