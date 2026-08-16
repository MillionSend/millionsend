import { type JSONContent, Maily } from "@maily-to/render";
import { isMailyDoc } from "./email-doc";
import { htmlToText } from "./html";
import { makeMergeToken } from "./merge-fields";

/**
 * Server-only email renderer. @maily-to/render pulls in juice + @react-email,
 * which are heavy and Node-bound — never import this from a client component.
 * Editor documents are stored as Maily/Tiptap JSON in the `document` jsonb; the
 * `html` column is the source of send, produced here on save.
 */

/** Thrown when `document` is not renderable Maily JSON (e.g. a legacy BlockDoc
 * or a null column). Such rows keep their stored html and are never re-rendered. */
export class InvalidEmailDocumentError extends Error {
  constructor() {
    super("document is not renderable Maily JSON");
    this.name = "InvalidEmailDocumentError";
  }
}

/**
 * Maily hardcodes light-only color-scheme metas, which tells dark-mode clients
 * (Apple Mail, and the Gmail variants that honor the declaration) to keep the
 * email white. Declaring both schemes lets those clients apply their own dark
 * adaptation. Exact-match replaces; if a Maily upgrade changes the markup the
 * html passes through unchanged (still valid, just light-locked again).
 */
function declareDarkScheme(html: string): string {
  return html
    .replace(
      '<meta name="color-scheme" content="light"/>',
      '<meta name="color-scheme" content="light dark"/>',
    )
    .replace(
      '<meta name="supported-color-schemes" content="light"/>',
      '<meta name="supported-color-schemes" content="light dark"/>',
    );
}

/**
 * Render a stored Maily document to send-ready html + derived plain text. The
 * variable formatter emits our exact worker token grammar ({{{NAME}}} /
 * {{{NAME|fallback}}}) and never sets a value, so tokens ship unresolved for the
 * send worker to substitute per recipient.
 */
export async function renderEmailDocument(
  document: unknown,
): Promise<{ html: string; text: string }> {
  if (!isMailyDoc(document)) throw new InvalidEmailDocumentError();
  const maily = new Maily(document as JSONContent);
  maily.setVariableFormatter(({ variable, fallback }) =>
    makeMergeToken(variable, fallback || undefined),
  );
  const html = declareDarkScheme(await maily.render());
  return { html, text: htmlToText(html) };
}
