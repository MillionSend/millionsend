import { escapeHtml } from "./html.js";

// Resend's broadcast merge syntax: {{{NAME}}} or {{{NAME|fallback}}}. NAME is a
// builtin (FIRST_NAME/LAST_NAME/EMAIL) or a custom-property key; a name with no
// matching value falls back (or resolves to "") so no raw token reaches an inbox.
const MERGE_TOKEN = /\{\{\{([A-Za-z0-9_]+)(?:\|([^{}]*))?\}\}\}/g;
// A token opening an href/src value: the contact value becomes the link's
// scheme, so only web/mail URLs may land there (a javascript:/data: link
// from an imported property is a phishing primitive, not personalization).
const URL_ATTRIBUTE_OPEN = /(?:href|src)\s*=\s*["']?$/i;
const LINK_SCHEME = /^(?:https?:\/\/|mailto:)/i;

export interface MergeContact {
  email: string;
  firstName: string | null;
  lastName: string | null;
  properties: Record<string, string>;
}

/**
 * Substitutes contact merge tokens. Builtins (EMAIL/FIRST_NAME/LAST_NAME) win
 * over a same-named custom property; any other name resolves against
 * `properties` by exact key. A null/empty value falls back to the token's
 * `|fallback` text, or to "" without one — the raw token must never reach an
 * inbox. Contact values are user data landing in markup, so the html body gets
 * them escaped; fallbacks are the author's own content and stay literal.
 */
export function applyMergeFields(
  content: string,
  contact: MergeContact,
  opts: { html: boolean },
): string {
  return content.replace(
    MERGE_TOKEN,
    (_match, field: string, fallback: string | undefined, offset: number) => {
      const value =
        field === "EMAIL"
          ? contact.email
          : field === "FIRST_NAME"
            ? contact.firstName
            : field === "LAST_NAME"
              ? contact.lastName
              : (contact.properties[field] ?? null);
      if (!value) return fallback ?? "";
      if (!opts.html) return value;
      const opensUrl = URL_ATTRIBUTE_OPEN.test(content.slice(Math.max(0, offset - 12), offset));
      if (opensUrl && !LINK_SCHEME.test(value)) return fallback ?? "";
      return escapeHtml(value);
    },
  );
}

/**
 * Hidden-preheader injection (the standard inbox-preview pattern): the preview
 * text goes first in the body inside a display:none container, padded with
 * zero-width characters so clients that ignore the hiding styles still don't
 * pull visible body content into the snippet. Inserted right after `<body>`
 * when present (full documents), else prepended (fragments).
 */
export function injectPreheader(html: string, previewText: string): string {
  const preheader = `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escapeHtml(previewText)}${"&nbsp;&zwnj;".repeat(40)}</div>`;
  const bodyTag = /<body[^>]*>/i.exec(html);
  const at = bodyTag ? bodyTag.index + bodyTag[0].length : 0;
  return html.slice(0, at) + preheader + html.slice(at);
}
