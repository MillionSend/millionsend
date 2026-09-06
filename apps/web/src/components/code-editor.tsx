"use client";

import { type ReactNode, type Ref, useImperativeHandle, useRef } from "react";
import { CodeHighlight, type HighlightLanguage } from "@/components/code-highlight";
import type { MatchRange } from "@/lib/code-find";

export interface CodeEditorHandle {
  /** Replace the selection with `text` and leave the caret after it. */
  insert(text: string): void;
  /** Select `marks[index]` in the textarea (without taking focus) and scroll it into view. */
  select(index: number): void;
  readonly textarea: HTMLTextAreaElement | null;
}

/**
 * Source editor: a transparent textarea over a highlighted <pre> with the same
 * font metrics, kept scroll-aligned from the textarea's scroll events. Find
 * matches paint on a third layer under the highlight — plain text made
 * transparent, so its <mark>s land under the very same glyphs. Tab inserts
 * two spaces (the palette lives under .ms-code-editor in components.css).
 */
export function CodeEditor({
  id,
  value,
  onChange,
  language,
  marks = [],
  current = -1,
  ref,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  language: HighlightLanguage;
  /** Find matches to highlight; `current` is the index of the one in focus. */
  marks?: MatchRange[];
  current?: number;
  ref?: Ref<CodeEditorHandle>;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const marksRef = useRef<HTMLPreElement>(null);

  function insert(text: string) {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus();
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, "end");
    onChange(ta.value);
  }
  function select(index: number) {
    const ta = textareaRef.current;
    const range = marks[index];
    if (!ta || !range) return;
    ta.setSelectionRange(range.start, range.end);
    // The mark's offsets are the match's exact position in the textarea's
    // scroll space (same box, same metrics); recentre only when it is out of view.
    const mark = marksRef.current?.querySelectorAll("mark")[index];
    if (!mark) return;
    const top = mark.offsetTop;
    if (top < ta.scrollTop || top + mark.offsetHeight > ta.scrollTop + ta.clientHeight) {
      ta.scrollTop = Math.max(0, top - ta.clientHeight / 2);
    }
    const left = mark.offsetLeft;
    if (left < ta.scrollLeft || left + mark.offsetWidth > ta.scrollLeft + ta.clientWidth) {
      ta.scrollLeft = Math.max(0, left - ta.clientWidth / 2);
    }
  }
  useImperativeHandle(ref, () => ({
    insert,
    select,
    get textarea() {
      return textareaRef.current;
    },
  }));

  const marked: ReactNode[] = [];
  if (marks.length > 0) {
    let pos = 0;
    marks.forEach((m, i) => {
      marked.push(value.slice(pos, m.start));
      marked.push(
        <mark key={m.start} data-current={i === current || undefined}>
          {value.slice(m.start, m.end)}
        </mark>,
      );
      pos = m.end;
    });
    marked.push(value.slice(pos));
  }

  return (
    <div className="ms-code-editor">
      {/* Trailing newline: a value ending in "\n" shows an empty last line in
          the textarea, and the mirrors must scroll exactly as far. */}
      {marks.length > 0 ? (
        <pre
          // Mounted on the first match while the textarea may already be
          // scrolled: start where it is, the scroll handler keeps them together.
          ref={(el) => {
            marksRef.current = el;
            const ta = textareaRef.current;
            if (!el || !ta) return;
            el.scrollTop = ta.scrollTop;
            el.scrollLeft = ta.scrollLeft;
          }}
          className="ms-code-editor-hl ms-code-editor-marks"
          aria-hidden="true"
        >
          {marked}
          {"\n"}
        </pre>
      ) : null}
      <pre ref={preRef} className="ms-code-editor-hl ms-hl" aria-hidden="true">
        <CodeHighlight code={value} language={language} />
        {"\n"}
      </pre>
      <textarea
        ref={textareaRef}
        id={id}
        className="ms-code-editor-input"
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        onChange={(event) => onChange(event.target.value)}
        onScroll={(event) => {
          const { scrollTop, scrollLeft } = event.currentTarget;
          for (const layer of [preRef.current, marksRef.current]) {
            if (!layer) continue;
            layer.scrollTop = scrollTop;
            layer.scrollLeft = scrollLeft;
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== "Tab" || event.shiftKey || event.metaKey || event.ctrlKey) return;
          event.preventDefault();
          insert("  ");
        }}
      />
    </div>
  );
}
