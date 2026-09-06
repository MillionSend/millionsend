import { isMailyDoc } from "./email-doc";

/**
 * Which editor a template opens in. A row whose `document` is renderable
 * Maily JSON was authored in the block editor and keeps editing there; any
 * other row (null document, or a pre-Maily shape) carries html authored
 * outside it — API, MCP, migration — which Tiptap's parse would flatten, so
 * it edits as source until the user explicitly converts.
 */
export type TemplateEditorMode = "blocks" | "code";

export function templateEditorMode(opts: {
  isNew: boolean;
  document: unknown;
  converting?: boolean;
}): TemplateEditorMode {
  return opts.isNew || opts.converting || isMailyDoc(opts.document) ? "blocks" : "code";
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
  mode: TemplateEditorMode,
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
