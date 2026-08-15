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

/** Builtins first, then each valid contact-property key not shadowing a builtin. */
export function buildMergeOptions(propertyKeys: string[]): MergeFieldOption[] {
  const custom = propertyKeys
    .filter((key) => MERGE_NAME_RE.test(key) && !BUILTIN_NAMES.has(key))
    .map((key): MergeFieldOption => ({ name: key, builtin: false }));
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
