import { isMailyDoc } from "./email-doc";

/**
 * Which editor a body opens in. A row whose `document` is renderable Maily
 * JSON was authored in the block editor and keeps editing there; a body with
 * html and no such document was authored outside it — API, MCP, migration,
 * an html template applied to a broadcast — which Tiptap's parse would
 * flatten, so it edits as source until the user explicitly converts. An
 * empty body starts in the block editor.
 *
 * Two flags carry the user's explicit choice across the moment the stored
 * shape would say otherwise: `converting` keeps the block editor mounted on
 * an html seed until it emits its parse, and `asCode` keeps the source editor
 * while its html is still empty (a body that opened html-authored and was
 * cleared, or a new template the user chose to write as HTML).
 */
export type BodyEditorMode = "blocks" | "code";

export function bodyEditorMode(opts: {
  document: unknown;
  html: string;
  converting?: boolean;
  asCode?: boolean;
}): BodyEditorMode {
  if (opts.converting) return "blocks";
  if (opts.asCode) return "code";
  return isMailyDoc(opts.document) || opts.html.trim() === "" ? "blocks" : "code";
}

export interface TemplateSaveInput {
  name: string;
  subject: string;
  html: string;
  text: string;
  document: unknown;
}

/**
 * The fields a template save persists. Code mode always writes `document:
 * null` so the row stays html-authored — the client-side state may still hold
 * a legacy non-Maily document the server would reject.
 */
export function templateSaveInput(
  mode: BodyEditorMode,
  fields: TemplateSaveInput,
): TemplateSaveInput {
  return {
    name: fields.name.trim(),
    subject: fields.subject.trim(),
    html: fields.html,
    text: fields.text,
    document: mode === "code" ? null : fields.document,
  };
}

/** Name of the block-converted copy of an html-authored template. */
export function blocksCopyName(name: string): string {
  return `${name.trim()} (blocks)`;
}

/** Name of the html copy of a block-authored template. */
export function htmlCopyName(name: string): string {
  return `${name.trim()} (HTML)`;
}
