import { makeMergeToken } from "@/lib/merge-fields";
import type { TiptapEditor } from "./commands";

export interface VariableViewStrings {
  variable: string;
  fallback: string;
  fallbackPlaceholder: string;
}

const BRACES_SVG = `<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2.8c-2 .3-2.4 1.3-2.4 2.9 0 1.3-.2 2-1.3 2.3 1.1.3 1.3 1 1.3 2.3 0 1.6.4 2.6 2.4 2.9M10 2.8c2 .3 2.4 1.3 2.4 2.9 0 1.3.2 2 1.3 2.3-1.1.3-1.3 1-1.3 2.3 0 1.6-.4 2.6-2.4 2.9"/></svg>`;

interface VariableAttrs {
  id: string;
  label: string | null;
  fallback: string | null;
}

/** The subset of the Tiptap node-view renderer contract this view implements. */
interface NodeViewInstance {
  dom: HTMLElement;
  update: (node: { type: { name: string }; attrs: VariableAttrs }) => boolean;
  stopEvent: (event: Event) => boolean;
  ignoreMutation: () => boolean;
  selectNode: () => void;
  deselectNode: () => void;
  destroy: () => void;
}

/**
 * Framework-free node view for the in-content variable pill, replacing Maily's
 * VariableView so the edit popover is ours: our design system, our alignment,
 * and translated labels (Maily hardcodes "Variable"/"Default"/"ie. John
 * Doe..."). Vanilla DOM on purpose — a React node view would need a direct
 * @tiptap/react dependency, which this app deliberately avoids (all Tiptap
 * types are derived from Maily's surface).
 *
 * The popover edits the fallback via setNodeMarkup at the node's live position;
 * braces are stripped like the toolbar picker so a typed fallback can never
 * produce a malformed {{{NAME|fallback}}} token.
 */
export function createVariableNodeView(strings: VariableViewStrings) {
  return (props: { editor: TiptapEditor; node: unknown; getPos: () => number | undefined }) => {
    const editor = props.editor;
    const getPos = props.getPos;
    let attrs = (props.node as { attrs: VariableAttrs }).attrs;

    const wrap = document.createElement("span");
    wrap.className = "ms-varview";

    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "ms-maily-varpill";
    pill.innerHTML = BRACES_SVG;
    const labelSpan = document.createElement("span");
    pill.appendChild(labelSpan);

    const pop = document.createElement("span");
    pop.className = "ms-varpop";
    pop.hidden = true;

    const nameRow = document.createElement("span");
    nameRow.className = "ms-varpop-row";
    const nameLabel = document.createElement("span");
    nameLabel.className = "ms-varpop-label";
    nameLabel.textContent = strings.variable;
    const nameCode = document.createElement("code");
    nameCode.className = "ms-varpop-name";
    nameRow.append(nameLabel, nameCode);

    const fallbackRow = document.createElement("label");
    fallbackRow.className = "ms-varpop-row";
    const fallbackLabel = document.createElement("span");
    fallbackLabel.className = "ms-varpop-label";
    fallbackLabel.textContent = strings.fallback;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "ms-varpop-input";
    input.placeholder = strings.fallbackPlaceholder;
    input.autocomplete = "off";
    input.spellcheck = false;
    fallbackRow.append(fallbackLabel, input);

    pop.append(nameRow, fallbackRow);
    wrap.append(pill, pop);

    function sync() {
      labelSpan.textContent = attrs.label || attrs.id;
      nameCode.textContent = attrs.id;
      pill.title = makeMergeToken(attrs.id, attrs.fallback || undefined);
      if (document.activeElement !== input) input.value = attrs.fallback ?? "";
    }

    function setFallback(raw: string) {
      const value = raw.replace(/[{}]/g, "");
      const pos = getPos();
      if (typeof pos !== "number") return;
      const view = editor.view;
      const node = view.state.doc.nodeAt(pos);
      if (!node) return;
      view.dispatch(
        view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, fallback: value || null }),
      );
    }

    function onDocPointerDown(event: PointerEvent) {
      if (!wrap.contains(event.target as Node)) close();
    }
    function openPop() {
      pop.hidden = false;
      document.addEventListener("pointerdown", onDocPointerDown, true);
      input.focus();
    }
    function close(refocusEditor = false) {
      if (pop.hidden) return;
      pop.hidden = true;
      document.removeEventListener("pointerdown", onDocPointerDown, true);
      if (refocusEditor) editor.view.focus();
    }

    pill.addEventListener("click", () => {
      if (pop.hidden) openPop();
      else close();
    });
    input.addEventListener("input", () => setFallback(input.value));
    wrap.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !pop.hidden) {
        event.stopPropagation();
        close(true);
      } else if (event.key === "Enter" && event.target === input) {
        event.preventDefault();
        close(true);
      }
    });

    sync();

    const view: NodeViewInstance = {
      dom: wrap,
      update(node) {
        if (node.type.name !== "variable") return false;
        attrs = node.attrs;
        sync();
        return true;
      },
      // ProseMirror must not treat interactions inside the popover (typing a
      // fallback) or the pill toggle as document input.
      stopEvent(event) {
        const target = event.target as Node | null;
        return !!target && (pop.contains(target) || pill.contains(target));
      },
      ignoreMutation: () => true,
      selectNode() {
        pill.classList.add("is-selected");
      },
      deselectNode() {
        pill.classList.remove("is-selected");
        close();
      },
      destroy() {
        document.removeEventListener("pointerdown", onDocPointerDown, true);
      },
    };
    return view;
  };
}
