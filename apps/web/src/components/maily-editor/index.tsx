"use client";

import { Editor, type EditorProps } from "@maily-to/core";
import {
  getVariableSuggestions,
  type Variable,
  VariableExtension,
} from "@maily-to/core/extensions";
import "@maily-to/core/style.css";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useRef, useState } from "react";
import { isMailyDoc, type MailyDoc } from "@/lib/email-doc";
import { htmlToText } from "@/lib/html";
import { MERGE_FIELDS_I18N_NS, type MergeFieldOption } from "@/lib/merge-fields";
import { sanitizeHtml } from "@/lib/sanitize-html";

/**
 * Maily-backed email editor. Design mode is Maily (Tiptap); merge fields serialize
 * to our worker token grammar server-side (see lib/email-render.ts), so the html
 * emitted here is only the last-known value — send html is re-rendered on save.
 * Code mode is the raw-html escape hatch and legacy fallback: a stored document
 * that is not Maily JSON opens in code mode against its stored html, which keeps
 * every pre-Maily template sending unchanged.
 *
 * Prop shape mirrors the previous BlockEditor so the pages are untouched.
 */
export interface MailyEditorValue {
  document: unknown | null;
  html: string;
}

export interface MailyEditorChange {
  document: unknown | null;
  html: string;
  text: string;
}

export interface MailyEditorProps {
  value: MailyEditorValue;
  onChange: (value: MailyEditorChange) => void;
  mergeFields: MergeFieldOption[];
}

// Derived from Maily's own props so we never import @tiptap/core directly.
type MailyContent = NonNullable<EditorProps["contentJson"]>;
type MailyTiptapEditor = Parameters<NonNullable<EditorProps["onUpdate"]>>[0];

function emptyMailyDoc(): MailyDoc {
  return { type: "doc", content: [{ type: "paragraph" }] };
}

export function MailyEditor({ value, onChange, mergeFields }: MailyEditorProps) {
  const t = useTranslations("block-editor");
  const tf = useTranslations(MERGE_FIELDS_I18N_NS);

  const initialDoc = isMailyDoc(value.document) ? value.document : null;
  const [mode, setMode] = useState<"design" | "code">(
    initialDoc ? "design" : value.html.trim() ? "code" : "design",
  );
  const [code, setCode] = useState(value.html);
  const [dirtyCode, setDirtyCode] = useState(false);
  // Snapshot of the Maily doc taken when entering code mode; null when we entered
  // code because the stored document was legacy/unparseable (design stays locked).
  const [docBeforeCode, setDocBeforeCode] = useState<MailyDoc | null>(initialDoc);
  // Bumped to force Maily to re-initialise when we restore a snapshot.
  const [editorKey, setEditorKey] = useState(0);

  const seedDoc = useRef<MailyDoc>(initialDoc ?? emptyMailyDoc());
  const liveDoc = useRef<MailyDoc>(seedDoc.current);

  // Kept in a ref so emitting never depends on the parent's callback identity.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const emitDesign = useCallback(() => {
    // Send html is re-rendered server-side on save; the last-known html carries here.
    onChangeRef.current({
      document: liveDoc.current,
      html: value.html,
      text: htmlToText(value.html),
    });
  }, [value.html]);

  const emitCode = useCallback((raw: string) => {
    const clean = sanitizeHtml(raw);
    onChangeRef.current({ document: null, html: clean, text: htmlToText(clean) });
  }, []);

  // Restrict variables to the merge-field list: a *function* source never appends
  // the free-typed query (an array source would), so no id can break MERGE_NAME_RE.
  const variables = useMemo<Variable[]>(
    () =>
      mergeFields.map((f) => ({
        name: f.name,
        label: f.labelKey ? tf(f.labelKey) : f.name,
      })),
    [mergeFields, tf],
  );
  const variableExtension = useMemo(
    () =>
      VariableExtension.configure({
        variables: ({ query }) =>
          variables.filter((v) => v.name.toLowerCase().startsWith(query.toLowerCase())),
        suggestion: getVariableSuggestions(),
      }),
    [variables],
  );

  const onEditorChange = useCallback(
    (editor: MailyTiptapEditor) => {
      liveDoc.current = editor.getJSON() as MailyDoc;
      emitDesign();
    },
    [emitDesign],
  );

  function enterCode() {
    setDocBeforeCode(liveDoc.current);
    setCode(value.html);
    setDirtyCode(false);
    setMode("code");
    emitCode(value.html);
  }
  function exitToDesign() {
    if (!docBeforeCode || dirtyCode) return;
    seedDoc.current = docBeforeCode;
    liveDoc.current = docBeforeCode;
    setEditorKey((k) => k + 1);
    setMode("design");
    emitDesign();
  }
  const designLocked = mode === "code" && (dirtyCode || docBeforeCode === null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        style={{
          display: "inline-flex",
          alignSelf: "flex-start",
          gap: 2,
          background: "var(--ms-inset)",
          padding: 2,
          borderRadius: "var(--ms-r-input)",
        }}
      >
        <button
          type="button"
          className="ms-btn"
          disabled={designLocked}
          title={designLocked ? t("mode.designLocked") : undefined}
          style={segStyle(mode === "design")}
          onClick={exitToDesign}
        >
          {t("mode.design")}
        </button>
        <button
          type="button"
          className="ms-btn"
          style={segStyle(mode === "code")}
          onClick={enterCode}
        >
          {"</>"} {t("mode.code")}
        </button>
      </div>

      {mode === "code" ? (
        <textarea
          className="ms-input ms-mono"
          style={{ width: "100%", minHeight: 340, resize: "vertical", lineHeight: 1.6 }}
          placeholder={t("code.placeholder")}
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            setDirtyCode(true);
            emitCode(e.target.value);
          }}
        />
      ) : (
        <div
          style={{
            border: "1px solid var(--ms-line)",
            borderRadius: "var(--ms-r-input)",
            background: "var(--ms-panel)",
          }}
        >
          <Editor
            key={editorKey}
            contentJson={seedDoc.current as MailyContent}
            extensions={[variableExtension]}
            config={{ immediatelyRender: false }}
            onCreate={onEditorChange}
            onUpdate={onEditorChange}
          />
        </div>
      )}
    </div>
  );
}

function segStyle(active: boolean): React.CSSProperties {
  return {
    height: 26,
    padding: "0 12px",
    border: 0,
    background: active ? "var(--ms-panel-raised)" : "transparent",
    color: active ? "var(--ms-bone)" : "var(--ms-muted)",
  };
}

export default MailyEditor;
