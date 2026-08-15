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
  const html = await maily.render();
  return { html, text: htmlToText(html) };
}
