"use client";

import { type Ref, useImperativeHandle, useRef } from "react";
import { CodeHighlight, type HighlightLanguage } from "@/components/code-highlight";

export interface CodeEditorHandle {
  /** Replace the selection with `text` and leave the caret after it. */
  insert(text: string): void;
}

/**
 * Source editor: a transparent textarea over a highlighted <pre> with the same
 * font metrics, kept scroll-aligned from the textarea's scroll events. Tab
 * inserts two spaces (the palette lives under .ms-code-editor in
 * components.css).
 */
export function CodeEditor({
  id,
  value,
  onChange,
  language,
  ref,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  language: HighlightLanguage;
  ref?: Ref<CodeEditorHandle>;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  function insert(text: string) {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus();
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, "end");
    onChange(ta.value);
  }
  useImperativeHandle(ref, () => ({ insert }));

  return (
    <div className="ms-code-editor">
      {/* Trailing newline: a value ending in "\n" shows an empty last line in
          the textarea, and the mirror must scroll exactly as far. */}
      <pre ref={preRef} className="ms-hl ms-code-editor-hl" aria-hidden="true">
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
          const pre = preRef.current;
          if (!pre) return;
          pre.scrollTop = event.currentTarget.scrollTop;
          pre.scrollLeft = event.currentTarget.scrollLeft;
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
