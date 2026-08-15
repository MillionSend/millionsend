/**
 * Single source for merge-field metadata and the {{{NAME}}} token grammar,
 * reused by the editor, the field picker, and the preview. The regex and
 * builtin set MUST stay identical to the send worker's substitution, which is
 * where tokens are actually resolved — mirror of apps/worker/src/handlers/send-broadcast.ts.
 * UNSUBSCRIBE_URL is resolved there by a literal string replace before merge,
 * so it is only a builtin here for the picker, never for name validation.
 */

/** next-intl namespace holding the builtin labels (messages/<locale>/merge-fields.json). */
export const MERGE_FIELDS_I18N_NS = "merge-fields";

export interface MergeFieldOption {
  /** Token name — a builtin or a contact-property key. Restricted to [A-Za-z0-9_]. */
  name: string;
  /** i18n key under MERGE_FIELDS_I18N_NS; set for builtins, absent for custom keys. */
  labelKey?: string;
  builtin: boolean;
}

export const MERGE_BUILTINS: readonly MergeFieldOption[] = [
  { name: "FIRST_NAME", labelKey: "firstName", builtin: true },
  { name: "LAST_NAME", labelKey: "lastName", builtin: true },
  { name: "EMAIL", labelKey: "email", builtin: true },
  { name: "UNSUBSCRIBE_URL", labelKey: "unsubscribeUrl", builtin: true },
];

const BUILTIN_NAMES = new Set(MERGE_BUILTINS.map((b) => b.name));

/** A whole-string valid merge-field name. */
export const MERGE_NAME_RE = /^[A-Za-z0-9_]+$/;

/**
 * Global token matcher. Kept byte-for-byte identical to the worker so a token
 * the editor can insert is exactly a token the worker resolves.
 */
export const MERGE_TOKEN_RE = /\{\{\{([A-Za-z0-9_]+)(?:\|([^{}]*))?\}\}\}/g;

/**
 * Builtins first, then each valid contact-property key not shadowing a builtin.
 * Callers pass the union of derived (in-use) keys and typed property
 * definitions, so a defined key is insertable before any contact carries a
 * value; duplicates across those two sources collapse to one option.
 *
 * Fallback precedence, for a future reader: a token's own `|fallback` always
 * wins. A definition's fallbackValue is only the default when the token has
 * none — and even then it is advisory in the editor, because the send worker
 * resolves tokens without reading definitions. Wiring it into the worker is a
 * separate change.
 */
export function buildMergeOptions(propertyKeys: string[]): MergeFieldOption[] {
  const seen = new Set(BUILTIN_NAMES);
  const custom: MergeFieldOption[] = [];
  for (const key of propertyKeys) {
    if (!MERGE_NAME_RE.test(key) || seen.has(key)) continue;
    seen.add(key);
    custom.push({ name: key, builtin: false });
  }
  return [...MERGE_BUILTINS, ...custom];
}

export function makeMergeToken(name: string, fallback?: string): string {
  return `{{{${name}${fallback != null && fallback !== "" ? `|${fallback}` : ""}}}}`;
}

/** Parse a single, whole token string; null if the input is not exactly one token. */
export function parseMergeToken(token: string): { name: string; fallback?: string } | null {
  const match = new RegExp(MERGE_TOKEN_RE.source).exec(token);
  if (!match || match[0] !== token) return null;
  const name = match[1] as string;
  return match[2] !== undefined ? { name, fallback: match[2] } : { name };
}

/**
 * True when every `{{{…}}}` group in `html` is a well-formed merge token. The
 * Maily editor only inserts valid names, so a malformed group (a stray brace,
 * a space, a fallback with a brace) means the html was tampered with or
 * hand-edited — the send worker would ship it as literal broken text. A save
 * guard rejects such html before it can become a send.
 */
export function hasWellFormedMergeTokens(html: string): boolean {
  for (const match of html.matchAll(/\{\{\{[\s\S]*?\}\}\}/g)) {
    if (parseMergeToken(match[0]) === null) return false;
  }
  return true;
}
