import { decodeEntities } from "../html.js";
import { registrableDomain } from "../org-domain.js";

/**
 * Verification codes and sign-in links in received mail, precision over
 * recall. The input is already the read pipeline's: hidden text gone,
 * quotes and signature cut, so a code only quoted or only hidden is never
 * taken. Links are only read here, never fetched: a scanner that opens one
 * burns a single-use sign-in link.
 */

/** A code word near a candidate, strong or weak ("code", "PIN", "token"). */
const CODE_WORD =
  /\b(?:verification|security|confirmation|login|log-in|sign-in|signin|access|authentication|auth|one[- ]time|2fa|two[- ]factor|otp|passcode|pin|c[oó]digo|codigo|senha (?:tempor[aá]ria|[uú]nica)|verifica[cç][aã]o|confirma[cç][aã]o|autentica[cç][aã]o|verificaci[oó]n|confirmaci[oó]n|autenticaci[oó]n|clave|contrase[nñ]a (?:temporal|de un solo uso)|token|code)\b/giu;

/**
 * At least one of these must appear somewhere in the subject or body: they
 * name a sign-in or verification step, which promo and order mail does not.
 */
const STRONG_WORD =
  /\b(?:verif\p{L}*|one[- ]time|otp|passcode|2fa|two[- ]factor|authenticat\p{L}*|security code|log[ -]?in|sign[ -]?in|confirm your (?:identity|email|account)|identity|c[oó]digo de (?:verifica|seguran|confirma|acesso|autentica|login|verificaci|seguridad|confirmaci|acceso|autenticaci)\p{L}*|senha tempor[aá]ria|senha [uú]nica|entrar|acessar|identidade|iniciar sesi[oó]n|contrase[nñ]a temporal|clave (?:temporal|de acceso|de un solo uso)|identidad)/iu;

/** A number right after one of these is not a code. */
const NOT_A_CODE_BEFORE =
  /(?:promo(?:tion(?:al)?)? code|coupon|cupom|cup[oó]n|discount|desconto|descuento|voucher|call(?: us)?(?: at)?|ligue(?: para)?|llame(?: al)?|order|pedido|ticket|chamado|protocolo|invoice|fatura|nota fiscal|nf-?e?|n[º°o]\.?|#|ref\.?|refer[eê]ncia|tracking|rastreio|rastreamento|cep|cpf|cnpj|account|conta|ag[eê]ncia|card|cart[aã]o|ending in|final|terminad[oa] en|tel\.?|phone|telefone|celular|whatsapp|fax|r\$|us\$|\$|€|£|usd|brl|eur|total|valor|price|pre[cç]o)\s*[:-]?\s*$/i;

/**
 * Code shapes not glued to letters, digits or the characters of addresses,
 * paths, amounts and tags: 4-8 digits, 3+3 or 4+4 digits with one space or
 * hyphen, 4-8 uppercase letters and digits, or two groups of 3-4; an
 * optional one-letter prefix (Google's G-) is dropped.
 */
const CANDIDATE =
  /(?<![\p{L}\p{N}_@./:%$#-])([A-Z]-)?(\d{3}[ -]\d{3}|\d{4}[ -]\d{4}|\d{4,8}|[A-Z0-9]{4,8}|[A-Z0-9]{3,4}-[A-Z0-9]{3,4})(?![\p{L}\p{N}_@%]|[.,:/-]\p{N})/gu;

const YEAR = /^(?:19|20)\d\d$/;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;

/** A code as the receiver types it and received_secrets keys it: no separators, uppercase. */
export function normalizeCode(token: string): string {
  return token.replace(/[ -]/g, "").toUpperCase();
}

function plausible(value: string): boolean {
  if (value.length < 4 || value.length > 8) return false;
  if (/^\d+$/.test(value)) return true;
  // Alphanumeric codes are uppercase with at least one digit and one letter.
  return /^[A-Z0-9]+$/.test(value) && /\d/.test(value) && /[A-Z]/.test(value);
}

/** Every code-shaped token in `text`, URLs taken out first; no gate, no score. */
export function codeShapes(text: string): string[] {
  const out: string[] = [];
  for (const m of text.replace(URL_IN_TEXT, " ").matchAll(CANDIDATE)) {
    const value = normalizeCode(m[2] as string);
    if (plausible(value)) out.push(value);
  }
  return out;
}

function scored(text: string, inSubject: boolean): { value: string; score: number }[] {
  // URLs go first: a value inside one is never a code.
  const body = text.replace(URL_IN_TEXT, (u) => " ".repeat(u.length));
  const words = [...body.matchAll(CODE_WORD)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
  }));
  const out: { value: string; score: number }[] = [];
  for (const m of body.matchAll(CANDIDATE)) {
    const value = normalizeCode(m[2] as string);
    if (!plausible(value)) continue;
    const start = m.index + (m[1]?.length ?? 0);
    const end = m.index + m[0].length;
    if (NOT_A_CODE_BEFORE.test(body.slice(Math.max(0, start - 30), start))) continue;
    const nearBefore = words.some((w) => w.end <= start && start - w.end <= 60);
    // "482913 is your code": the word follows on the same line only.
    const nearAfter = words.some(
      (w) => w.start >= end && w.start - end <= 40 && !body.slice(end, w.start).includes("\n"),
    );
    if (YEAR.test(value) && !nearBefore) continue;
    const lineStart = body.lastIndexOf("\n", start - 1) + 1;
    const lineEnd = body.indexOf("\n", end);
    const line = body.slice(lineStart, lineEnd === -1 ? body.length : lineEnd).trim();
    let score = 0;
    if (nearBefore) score += 3;
    if (nearAfter) score += 2;
    if (line === m[0].trim()) score += 2;
    if (inSubject && (nearBefore || nearAfter)) score += 1;
    out.push({ value, score });
  }
  return out;
}

export interface CodeExtraction {
  /** The one code a person would type; ambiguous when two different ones tie at the top. */
  code: { kind: "otp"; value: string } | { ambiguous: true } | null;
  /** Every value that scored as a code: what received_secrets keys, the winner or not. */
  values: string[];
}

/**
 * The verification code of a message (its subject and reply part). A code
 * needs a code word near it, or a line of its own in a message that names
 * a verification step; two different codes that score the same answer
 * ambiguous rather than guess.
 */
export function extractCode(p: { subject: string; text: string }): CodeExtraction {
  if (!STRONG_WORD.test(`${p.subject}\n${p.text}`)) return { code: null, values: [] };
  const best = new Map<string, { max: number; n: number }>();
  for (const c of [...scored(p.subject, true), ...scored(p.text, false)]) {
    const seen = best.get(c.value);
    best.set(c.value, { max: Math.max(seen?.max ?? 0, c.score), n: (seen?.n ?? 0) + 1 });
  }
  // Repeated (subject and body, button and fallback) earns one point, once.
  const ranked = [...best]
    .map(([value, { max, n }]) => [value, max + (n > 1 ? 1 : 0)] as const)
    .filter(([, score]) => score >= 3)
    .sort((a, b) => b[1] - a[1]);
  const values = ranked.map(([value]) => value);
  const [first, second] = ranked;
  if (!first) return { code: null, values };
  if (second && second[1] === first[1]) return { code: { ambiguous: true }, values };
  return { code: { kind: "otp", value: first[0] }, values };
}

const LINK_WORD =
  /\b(?:sign[ -]?in|log[ -]?in|verify|confirm|activate|magic link|reset (?:your )?password|accept (?:the )?invitation|join|entrar|acessar|fazer login|confirmar|verificar|ativar|redefinir (?:a )?senha|aceitar (?:o )?convite|iniciar sesi[oó]n|acceder|activar|restablecer (?:la )?contrase[nñ]a|aceptar (?:la )?invitaci[oó]n)\b/iu;
const LINK_PATH =
  /(?:verif|confirm|activat|magic|login|log-in|signin|sign-in|sign_in|auth|token|otp|reset|invit|session|passwordless)/i;
const NOT_LINK_WORD =
  /\b(?:unsubscribe|opt[ -]?out|preferences|privacy|terms|help|support|view (?:it )?in (?:your )?browser|descadastr|cancelar (?:a )?inscri|prefer[eê]ncias|privacidade|termos|ajuda|ver no navegador|darse de baja|preferencias|privacidad|t[eé]rminos|ayuda|ver en el navegador)\b/iu;
const SOCIAL =
  /(?:^|\.)(?:facebook|twitter|x|instagram|linkedin|youtube|tiktok|apple|google)\.com$/i;
/** A run that reads as a token: 20+ URL-safe characters mixing letters and digits. */
const TOKEN_RUN = /[A-Za-z0-9_.~%-]{20,}/g;

const tokenLike = (s: string) => /\d/.test(s) && /[A-Za-z]/.test(s);

/** The token-like path segments and query values of a link. */
export function linkTokens(url: URL): string[] {
  return [...url.searchParams.values(), ...url.pathname.split("/")].filter(
    (part) => part.length >= 20 && /^[A-Za-z0-9_.~%-]+$/.test(part) && tokenLike(part),
  );
}

/** A link as received_secrets keys it: parsed, its fragment dropped; null for anything but http(s). */
export function normalizeSecretLink(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  url.hash = "";
  return url.href;
}

export interface LinkExtraction {
  /** The sign-in or verification link exactly as written; ambiguous on a tie between different URLs. */
  link: { url: string; linkDomainMatchesSender: boolean } | { ambiguous: true } | null;
  /** Every link that scored as one, for received_secrets. */
  urls: string[];
}

/**
 * The sign-in or verification link of a message. `anchors` are the visible
 * links of its reply part ({href, text}), or the bare URLs of a text body.
 * Tracking wrappers are not unwrapped: the URL is returned as written.
 */
export function extractLink(p: {
  subject: string;
  text: string;
  anchors: readonly { href: string; text: string }[];
  senderDomain: string | null;
}): LinkExtraction {
  const context = `${p.subject}\n${p.text}`;
  const contextHit = LINK_WORD.test(context);
  const sender = p.senderDomain ? registrableDomain(p.senderDomain) : null;
  const scores = new Map<string, number>();
  for (const a of p.anchors) {
    let url: URL;
    try {
      url = new URL(a.href);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    const label = a.text ?? "";
    if (NOT_LINK_WORD.test(label) || NOT_LINK_WORD.test(url.pathname)) continue;
    if (SOCIAL.test(url.hostname) && !LINK_PATH.test(url.pathname)) continue;
    const labelHit = LINK_WORD.test(label);
    const pathHit = LINK_PATH.test(url.pathname + url.search);
    let score = 0;
    if (labelHit) score += 3;
    if (pathHit) score += 2;
    if (linkTokens(url).length > 0) score += 2;
    if (contextHit) score += 1;
    if (sender && registrableDomain(url.hostname) === sender) score += 1;
    if (!(labelHit || pathHit) || score < 4) continue;
    scores.set(a.href, Math.max(scores.get(a.href) ?? 0, score));
  }
  const ranked = [...scores].sort((a, b) => b[1] - a[1]);
  const urls = ranked.map(([url]) => url);
  const [first, second] = ranked;
  if (!first) return { link: null, urls };
  if (second && second[1] === first[1]) return { link: { ambiguous: true }, urls };
  const host = new URL(first[0]).hostname;
  return {
    link: {
      url: first[0],
      linkDomainMatchesSender: sender !== null && registrableDomain(host) === sender,
    },
    urls,
  };
}

export type SecretKind = "code" | "link" | "token";

/** What a message's codes and links key in received_secrets: codes, links without fragment, their tokens. */
export function receivedSecretValues(
  code: CodeExtraction,
  link: LinkExtraction,
): { kind: SecretKind; value: string }[] {
  const out = new Map<string, SecretKind>();
  for (const value of code.values) out.set(value, "code");
  for (const raw of link.urls) {
    const value = normalizeSecretLink(raw);
    if (!value) continue;
    out.set(value, "link");
    for (const token of linkTokens(new URL(value))) if (!out.has(token)) out.set(token, "token");
  }
  return [...out].map(([value, kind]) => ({ kind, value }));
}

/**
 * Everything in outgoing text that could be a received secret passed on:
 * code shapes, links without their fragment, and token-like runs. Normalized
 * as receivedSecretValues normalizes, so a MAC of each finds a match. HTML
 * may be passed as is: entities are decoded first.
 */
export function outgoingSecretValues(...texts: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const raw of texts) {
    if (!raw) continue;
    const text = decodeEntities(raw);
    for (const value of codeShapes(text)) out.add(value);
    for (const m of text.matchAll(URL_IN_TEXT)) {
      const link = normalizeSecretLink(m[0]);
      if (link) out.add(link);
    }
    for (const m of text.matchAll(TOKEN_RUN)) if (tokenLike(m[0])) out.add(m[0]);
  }
  return [...out];
}
