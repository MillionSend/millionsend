import type { EditorProps } from "@maily-to/core";

/** The Tiptap editor instance Maily hands back from onCreate/onUpdate. */
export type TiptapEditor = Parameters<NonNullable<EditorProps["onCreate"]>>[0];

/**
 * A minimal, honest facade over Tiptap's command chain. Maily bundles the
 * text-align/list extensions, so these commands exist at runtime, but their
 * `declare module` augmentations aren't all in our type graph — typing exactly
 * what we call keeps the toolbar type-safe without pulling in mismatched
 * @tiptap/extension-* dev deps.
 */
export interface EditorChain {
  focus(): EditorChain;
  toggleBold(): EditorChain;
  toggleItalic(): EditorChain;
  toggleUnderline(): EditorChain;
  toggleStrike(): EditorChain;
  toggleHeading(attrs: { level: number }): EditorChain;
  toggleBulletList(): EditorChain;
  toggleOrderedList(): EditorChain;
  setTextAlign(align: string): EditorChain;
  unsetAllMarks(): EditorChain;
  clearNodes(): EditorChain;
  extendMarkRange(name: string): EditorChain;
  setLink(attrs: { href: string }): EditorChain;
  unsetLink(): EditorChain;
  insertContent(content: unknown): EditorChain;
  run(): boolean;
}

export interface EditorCan {
  toggleHeading(attrs: { level: number }): boolean;
  toggleBulletList(): boolean;
  toggleOrderedList(): boolean;
}

export function chain(editor: TiptapEditor): EditorChain {
  return editor.chain() as unknown as EditorChain;
}

export function can(editor: TiptapEditor): EditorCan {
  return editor.can() as unknown as EditorCan;
}
