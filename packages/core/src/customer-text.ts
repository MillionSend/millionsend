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

/** Zero-width, bidi and the other format and default-ignorable characters. */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
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
 * print as "•".
 */
const DIGIT_RUN = /\p{N}(?:[^\p{Lu}\p{Ll}\p{Lt}\p{Lo}\p{N}]*\p{N})*/gu;

/** One line of visible text: line breaks and controls become spaces, invisible characters go. */
export function stripInvisible(value: string): string {
  return value.replace(LINE_BREAKING, " ").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
}

/**
 * Customer text for a system email's body, the same string in the HTML and
 * the plain-text part (the card escapes it for HTML): one line, at most
 * CUSTOMER_TEXT_MAX characters, nothing a mail client turns into a link or
 * offers to call. A character whose compatibility form is a separator ("．"
 * "＠" "﹕") and the ideographic full stop, which IDNA reads as a dot, count
 * as that separator, so "ｅｖｉｌ．ｃｏｍ" and "evil。com" break like evil.com.
 */
export function inertText(value: string): string {
  const text = stripInvisible(value)
    .replace(MARK_FLOOD, "$1")
    .replace(/\P{ASCII}/gu, (c) => {
      const folded = c.normalize("NFKC").replace("\u3002", ".");
      return SEPARATORS.has(folded) ? folded : c;
    })
    .replace(DIGIT_RUN, (run) => {
      if ((run.match(/\p{N}/gu)?.length ?? 0) < 7) return run;
      let kept = 0;
      return run.replace(/\p{N}/gu, (digit) => (++kept > 4 ? "•" : digit));
    });
  // Cut on grapheme boundaries, so an emoji or an accented letter stays whole.
  const parts =
    text.length > CUSTOMER_TEXT_MAX
      ? Array.from(new Intl.Segmenter().segment(text), (s) => s.segment)
      : [];
  const capped =
    parts.length > CUSTOMER_TEXT_MAX
      ? `${parts
          .slice(0, CUSTOMER_TEXT_MAX - 1)
          .join("")
          .trimEnd()}…`
      : text;
  return capped.replace(/[.:@\\]/g, `$&${BREAK}`);
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
const NOT_PLAIN = /[@\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

/**
 * Whether a team or display name may be stored: one line of visible text, at
 * most CUSTOMER_TEXT_MAX characters, no "@" and no URL scheme, judged on the
 * NFKC form so fullwidth look-alikes count. A name that only looks like a
 * domain ("acme.dev") is a company's name and passes; system mail prints
 * every name through inertText anyway.
 */
export function isPlainName(value: string): boolean {
  const folded = value.normalize("NFKC");
  return value.length <= CUSTOMER_TEXT_MAX && !NOT_PLAIN.test(folded) && !URL_SCHEME.test(folded);
}
