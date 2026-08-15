import { Node, type NodeViewProps, NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import { MERGE_FALLBACK_ATTR, MERGE_NAME_ATTR } from "./merge-token-html";

/**
 * Inline atom node for a merge field. It parses/renders the same
 * <span data-merge-field> that merge-token-html converts to and from the
 * literal {{{NAME|fallback}}} token, and shows a non-editable chip carrying the
 * human label supplied via the `renderLabel` option (set from the editor with
 * next-intl, since a node view renders outside component scope).
 */

export interface MergeFieldOptions {
  renderLabel: (name: string, fallback: string | null) => string;
}

function MergeChip({ node, extension }: NodeViewProps) {
  const name = node.attrs.name as string;
  const fallback = (node.attrs.fallback as string | null) ?? null;
  const label = (extension.options as MergeFieldOptions).renderLabel(name, fallback);
  return (
    <NodeViewWrapper
      as="span"
      className="ms-merge-chip"
      contentEditable={false}
      title={fallback ? `${name} · ${fallback}` : name}
    >
      {label}
    </NodeViewWrapper>
  );
}

export const MergeField = Node.create<MergeFieldOptions>({
  name: "mergeField",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return { renderLabel: (name) => name };
  },

  addAttributes() {
    return {
      name: {
        default: "",
        parseHTML: (el) => el.getAttribute(MERGE_NAME_ATTR) ?? "",
        renderHTML: (attrs) => ({ [MERGE_NAME_ATTR]: attrs.name }),
      },
      fallback: {
        default: null,
        parseHTML: (el) => el.getAttribute(MERGE_FALLBACK_ATTR),
        renderHTML: (attrs) => (attrs.fallback ? { [MERGE_FALLBACK_ATTR]: attrs.fallback } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: `span[${MERGE_NAME_ATTR}]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", HTMLAttributes];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MergeChip);
  },
});
