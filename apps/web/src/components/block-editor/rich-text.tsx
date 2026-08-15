import { type Editor, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useMemo } from "react";
import type { BlockOf } from "@/lib/email-blocks/model";
import { sanitizeHtml } from "@/lib/sanitize-html";
import { MergeField } from "./merge-field-node";
import { mergeSpansToTokens, tokensToMergeSpans, unwrapParagraph } from "./merge-token-html";
import { createSlashExtension, type SlashItem, type SlashKind } from "./slash-menu";

/**
 * Inline rich-text editor for a text or heading block. tiptap holds the block's
 * html with merge fields as chips; on every edit it emits the stored form —
 * literal {{{tokens}}}, inline-only for headings so the serializer can wrap them
 * in an <h*>. Marks are limited to bold/italic/underline/strike/link.
 */
export function RichText({
  block,
  slashItems,
  renderLabel,
  onSlash,
  onActive,
  onChange,
}: {
  block: BlockOf<"text"> | BlockOf<"heading">;
  slashItems: SlashItem[];
  renderLabel: (name: string, fallback: string | null) => string;
  onSlash: (kind: SlashKind, editor: Editor, range: { from: number; to: number }) => void;
  onActive: (editor: Editor) => void;
  onChange: (id: string, html: string) => void;
}) {
  const isHeading = block.type === "heading";

  // Built once per mount: re-creating extensions would tear down the editor.
  // biome-ignore lint/correctness/useExhaustiveDependencies: extensions are built once by design
  const extensions = useMemo(
    () => [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        codeBlock: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        horizontalRule: false,
        code: false,
        link: { openOnClick: false },
      }),
      MergeField.configure({ renderLabel }),
      createSlashExtension({ items: slashItems, onSelect: onSlash }),
    ],
    [],
  );

  const editor = useEditor({
    extensions,
    content: tokensToMergeSpans(block.html),
    immediatelyRender: false,
    editorProps: {
      attributes: { class: "ms-rte" },
      transformPastedHTML: (html) => tokensToMergeSpans(sanitizeHtml(html)),
    },
    onFocus: ({ editor: ed }) => onActive(ed),
    onUpdate: ({ editor: ed }) => {
      const stored = mergeSpansToTokens(ed.getHTML());
      onChange(block.id, isHeading ? unwrapParagraph(stored) : stored);
    },
  });

  return (
    <EditorContent
      editor={editor}
      style={{
        textAlign: block.align,
        color: block.color,
        fontSize: block.fontSize,
        fontWeight: isHeading ? 700 : 400,
        lineHeight: isHeading ? 1.3 : 1.5,
        outline: "none",
      }}
    />
  );
}
