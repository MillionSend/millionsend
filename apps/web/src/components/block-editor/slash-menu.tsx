import { type Editor, Extension, type Range, ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionProps } from "@tiptap/suggestion";
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import type { BlockType } from "@/lib/email-blocks/model";

/** "/" menu entries: every insertable block plus the inline variable pill. */
export type SlashKind = BlockType | "variable";

export interface SlashItem {
  kind: SlashKind;
  label: string;
  hint: string;
}

export interface SlashListRef {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

interface SlashListProps {
  items: SlashItem[];
  command: (item: SlashItem) => void;
}

const SlashList = forwardRef<SlashListRef, SlashListProps>(function SlashList(props, ref) {
  const [index, setIndex] = useState(0);
  // A fresh filter resets the highlight to the top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is keyed off the items list changing
  useEffect(() => setIndex(0), [props.items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: (event) => {
      const count = props.items.length;
      if (count === 0) return false;
      if (event.key === "ArrowDown") {
        setIndex((i) => (i + 1) % count);
        return true;
      }
      if (event.key === "ArrowUp") {
        setIndex((i) => (i - 1 + count) % count);
        return true;
      }
      if (event.key === "Enter") {
        const item = props.items[index];
        if (item) props.command(item);
        return true;
      }
      return false;
    },
  }));

  if (props.items.length === 0) return null;
  return (
    <div className="ms-menu" style={{ minWidth: 200, maxHeight: 280, overflowY: "auto" }}>
      {props.items.map((item, i) => (
        <button
          key={item.kind}
          type="button"
          role="menuitem"
          className={`ms-menu-item${i === index ? " active" : ""}`}
          onMouseEnter={() => setIndex(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            props.command(item);
          }}
        >
          <span>{item.label}</span>
          <span style={{ color: "var(--ms-faint)", fontSize: "var(--ms-fs-micro)" }}>
            {item.hint}
          </span>
        </button>
      ))}
    </div>
  );
});

function place(el: HTMLElement | null, rect: (() => DOMRect | null) | null | undefined) {
  const box = rect?.();
  if (!el || !box) return;
  el.style.top = `${box.bottom + 4}px`;
  el.style.left = `${box.left}px`;
}

interface SlashConfig {
  items: SlashItem[];
  onSelect: (kind: SlashKind, editor: Editor, range: Range) => void;
}

export function createSlashExtension(config: SlashConfig): Extension {
  return Extension.create({
    name: "slashCommands",
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashItem>({
          editor: this.editor,
          char: "/",
          startOfLine: false,
          items: ({ query }) =>
            config.items.filter((i) => i.label.toLowerCase().includes(query.toLowerCase())),
          command: ({ editor, range, props }) => config.onSelect(props.kind, editor, range),
          render: () => {
            let renderer: ReactRenderer<SlashListRef, SlashListProps> | null = null;
            let el: HTMLElement | null = null;
            return {
              onStart: (props: SuggestionProps<SlashItem>) => {
                renderer = new ReactRenderer(SlashList, {
                  props: { items: props.items, command: props.command },
                  editor: props.editor,
                });
                el = renderer.element as HTMLElement;
                el.style.position = "fixed";
                // matches --ms-z-popover; the wrapper is a real DOM node, not a styled .ms-menu
                el.style.zIndex = "500";
                document.body.appendChild(el);
                place(el, props.clientRect);
              },
              onUpdate: (props: SuggestionProps<SlashItem>) => {
                renderer?.updateProps({ items: props.items, command: props.command });
                place(el, props.clientRect);
              },
              onKeyDown: (props: { event: KeyboardEvent }) => {
                if (props.event.key === "Escape") return false;
                return renderer?.ref?.onKeyDown(props.event) ?? false;
              },
              onExit: () => {
                el?.remove();
                renderer?.destroy();
                renderer = null;
                el = null;
              },
            };
          },
        }),
      ];
    },
  });
}
