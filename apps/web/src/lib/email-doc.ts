import { z } from "zod";

/**
 * The editor `document` jsonb once the editor is Maily: a Tiptap doc node
 * stored verbatim (editor.getJSON()). The `html` column, re-rendered from this
 * on save, stays the source of send. This module is client-safe — it carries no
 * heavy render deps — so both the editor and the server routers share the guard.
 */
export type MailyDoc = { type: "doc"; content?: unknown[] };

/**
 * True when a stored `document` is renderable Maily JSON (a Tiptap doc node).
 * Legacy BlockDoc rows carry `version`/`blocks` and no top-level `type: "doc"`,
 * so they fail this guard and route to their stored html instead of a re-render.
 */
export function isMailyDoc(value: unknown): value is MailyDoc {
  return (
    typeof value === "object" && value !== null && (value as { type?: unknown }).type === "doc"
  );
}

/**
 * True when a Maily document holds nothing the user wrote: no content, or
 * only paragraphs without text or inline nodes — the shape a fresh editor
 * emits. An image, a button or a divider on its own is content.
 */
export function isEmptyMailyDoc(value: unknown): boolean {
  if (!isMailyDoc(value)) return false;
  const nodes = value.content ?? [];
  return nodes.every((node) => {
    if (typeof node !== "object" || node === null) return false;
    const { type, content } = node as { type?: unknown; content?: unknown[] };
    return type === "paragraph" && (content === undefined || content.length === 0);
  });
}

/**
 * Permissive input guard for the stored `document`: any Tiptap doc node passes
 * and rides through unchanged (z.unknown keeps every key for storage); a legacy
 * BlockDoc or other shape is rejected so only Maily JSON reaches the renderer.
 */
export const mailyDocumentSchema = z
  .unknown()
  .refine(isMailyDoc, { message: "document is not renderable Maily JSON" });
