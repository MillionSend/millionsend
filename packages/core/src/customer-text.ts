import { fillTemplate } from "./html.js";

/**
 * Text a customer typed (a team, person, key or broadcast name, a domain, a
 * webhook URL, an address) as the mail we send from our own domains prints
 * it. Recipients and mailbox providers trust those domains, and some of that
 * mail reaches any address (an invitation, a sign-up's verification link), so
 * a customer's words must never become a link there.
 */

/** The longest team or display name accepted, and the most of any customer value a system email prints. */
export const CUSTOMER_TEXT_MAX = 64;

/**
 * U+200A HAIR SPACE, set after every ".", "@", ":" and "\". Mail clients
 * link by scanning text (Gmail's linkifier, Apple Mail's data detectors,
 * Outlook, the plain-text part), so markup does not stop them, and a
 * zero-width character is no break to all of them: linkify-it counts it as a
 * letter, and IDNA's mapping deletes it. Whitespace ends every scheme, host
 * and address grammar, and NFKC turns a hair space into a space, which still
 * ends them. It is about 1/24 em wide, so "acme.dev" reads as acme.dev.
 */
const BREAK = "\u200a";
const SEPARATORS = new Set([".", ":", "@", "\\"]);

/**
 * Zero-width, bidi and the other format and default-ignorable characters,
 * except the joiners and presentation selectors that writing uses.
 */
const INVISIBLE = /(?!\u200c|\u200d|\ufe0e|\ufe0f)[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
/**
 * Those stay only where writing puts them: a presentation selector right
 * after an emoji (the U+FE0F of a red heart), a joiner inside an emoji
 * sequence (the U+200D between a person and a laptop) or between letters
 * of a script that shapes with it (Persian ZWNJ, Indic ZWJ). Anywhere else
 * they go.
 */
const STRAY_SELECTOR = /(?<!\p{Extended_Pictographic})(?:\ufe0e|\ufe0f)/gu;
const STRAY_JOINER =
  /(?<![\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Lo}\p{M}])(?:\u200c|\u200d)|(?:\u200c|\u200d)(?![\p{Extended_Pictographic}\p{Lo}])/gu;
/** Controls (newlines, tabs) and line or paragraph separators. */
const LINE_BREAKING = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
/**
 * Combining marks past the fourth in a row: real writing stays under that,
 * and a flood of them is one character the length cap would never cut.
 */
const MARK_FLOOD = /(\p{M}{4})\p{M}+/gu;
/**
 * Digits joined only by spaces and punctuation, the way phone numbers are
 * written and the way iOS Mail's data detectors and the Gmail and Outlook
 * apps find numbers to call; a modifier letter joins them too, as
 * libphonenumber reads the katakana prolonged sound mark (U+30FC). A run of
 * seven or more (a local number's length) keeps its first four, and the rest
 * print as "•", unless it is exactly one date or span of years (isDateOrYears).
 */
const DIGIT_RUN = /\p{N}(?:[^\p{Lu}\p{Ll}\p{Lt}\p{Lo}\p{N}]*\p{N})*/gu;
/**
 * A joined chain (emoji linked by zero-width joiners, Indic consonants linked
 * by viramas) segments as one grapheme however long it runs, so the cut also
 * stops at this many code points; 64 characters of real writing stay well
 * under it.
 */
const CODE_POINT_MAX = CUSTOMER_TEXT_MAX * 4;

function dropInvisible(value: string): string {
  return value.replace(INVISIBLE, "").replace(STRAY_SELECTOR, "").replace(STRAY_JOINER, "");
}

/** One line of visible text: line breaks and controls become spaces, invisible characters go. */
export function stripInvisible(value: string): string {
  return dropInvisible(value.replace(LINE_BREAKING, " ")).replace(/\s+/g, " ").trim();
}

/**
 * ".", ":", "@" or "\", or a character whose compatibility form is one ("．"
 * "＠" "﹕"), or the ideographic full stop, which IDNA reads as a dot.
 */
function isSeparator(c: string): boolean {
  return SEPARATORS.has(c.normalize("NFKC").replace("\u3002", "."));
}

/**
 * Whether a digit run is exactly one date in ASCII digits with one separator
 * throughout ("09/10/2026" either way round, "9.10.2026", "2026-10-09"; years
 * 1900–2099) or one span of up to ten years ("2025-2026", "2025–2026",
 * "2025/2026"). Names and subjects carry them, and the shape fixes too many
 * digits to spell a chosen number.
 */
function isDateOrYears(run: string): boolean {
  const dayMonth = /^(\d\d?)([/.-])(\d\d?)\2(?:19|20)\d\d$/.exec(run);
  if (dayMonth) {
    const [low = 0, high = 0] = [Number(dayMonth[1]), Number(dayMonth[3])].sort((a, b) => a - b);
    return low >= 1 && low <= 12 && high <= 31;
  }
  const yearFirst = /^(?:19|20)\d\d([/.-])(\d\d?)\1(\d\d?)$/.exec(run);
  if (yearFirst) {
    const [month, day] = [Number(yearFirst[2]), Number(yearFirst[3])];
    return month >= 1 && month <= 12 && day >= 1 && day <= 31;
  }
  const years = /^((?:19|20)\d\d)[-\u2013/]((?:19|20)\d\d)$/.exec(run);
  const span = Number(years?.[2]) - Number(years?.[1]);
  return span >= 1 && span <= 10;
}

function maskNumbers(text: string): string {
  return text.replace(DIGIT_RUN, (run) => {
    if ((run.match(/\p{N}/gu)?.length ?? 0) < 7 || isDateOrYears(run)) return run;
    let kept = 0;
    return run.replace(/\p{N}/gu, (digit) => (++kept > 4 ? "•" : digit));
  });
}

/**
 * Customer text for a system email's body, the same string in the HTML and
 * the plain-text part (the card escapes it for HTML): one line, at most
 * CUSTOMER_TEXT_MAX characters, nothing a mail client turns into a link or
 * offers to call. Look-alike separators break like the ASCII ones and keep
 * their form, so "ｅｖｉｌ．ｃｏｍ" and "evil。com" link no more than evil.com
 * does, and "市场部：华东区" reads as typed.
 */
export function inertText(value: string): string {
  const text = maskNumbers(stripInvisible(value).replace(MARK_FLOOD, "$1"));
  // Cut on grapheme boundaries, so an emoji or an accented letter stays whole.
  const parts =
    text.length > CUSTOMER_TEXT_MAX
      ? Array.from(new Intl.Segmenter().segment(text), (s) => s.segment)
      : [];
  const cut =
    parts.length > CUSTOMER_TEXT_MAX
      ? `${parts
          .slice(0, CUSTOMER_TEXT_MAX - 1)
          .join("")
          .trimEnd()}…`
      : text;
  const points = Array.from(cut);
  const capped =
    points.length > CODE_POINT_MAX
      ? `${points
          .slice(0, CODE_POINT_MAX - 1)
          .join("")
          .replace(STRAY_JOINER, "")}…`
      : cut;
  // A cut through a date can leave seven of its digits, which are no date.
  return maskNumbers(capped).replace(/[^\p{L}\p{N}\s]/gu, (c) =>
    isSeparator(c) ? `${c}${BREAK}` : c,
  );
}

/**
 * Template slots that carry customer text in every system email catalog;
 * fillMailTemplate prints them through inertText. No subject names one.
 */
export const CUSTOMER_SLOTS: ReadonlySet<string> = new Set([
  "team",
  "name",
  "inviter",
  "actor",
  "email",
  "app",
  "domain",
  "host",
  "url",
  "subject",
  "note",
]);

/** fillTemplate for system email: the customer slots print inert. */
export function fillMailTemplate(template: string, values: Record<string, string>): string {
  return fillTemplate(
    template,
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        CUSTOMER_SLOTS.has(key) ? inertText(value) : value,
      ]),
    ),
  );
}

/**
 * Any "scheme://", or a scheme that links without slashes when something
 * follows the colon ("mailto:x", "tel:+1"); "Data: Sales" is a name.
 */
const URL_SCHEME =
  /[a-z][a-z\d+.-]*:\/\/|\b(?:mailto|tel|sms|callto|javascript|data|file|ftp|https?):(?!\s)/i;
const NOT_PLAIN = /[@\p{Cc}\p{Zl}\p{Zp}]/u;

/**
 * Whether a team or display name may be stored: one line of visible text, at
 * most CUSTOMER_TEXT_MAX characters, no "@" and no URL scheme, judged on the
 * NFKC form so fullwidth look-alikes count. A name that only looks like a
 * domain ("acme.dev") is a company's name and passes; system mail prints
 * every name through inertText anyway.
 */
export function isPlainName(value: string): boolean {
  const folded = value.normalize("NFKC");
  return (
    value.length <= CUSTOMER_TEXT_MAX &&
    !NOT_PLAIN.test(folded) &&
    dropInvisible(folded) === folded &&
    !URL_SCHEME.test(folded)
  );
}
