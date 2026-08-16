"use client";

import { Editor, type EditorProps } from "@maily-to/core";
import {
  getVariableSuggestions,
  type Variable,
  VariableExtension,
} from "@maily-to/core/extensions";
import "@maily-to/core/style.css";
import "./maily-theme.css";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useRef, useState } from "react";
import { isMailyDoc, type MailyDoc } from "@/lib/email-doc";
import { htmlToText } from "@/lib/html";
import { MERGE_FIELDS_I18N_NS, type MergeFieldOption } from "@/lib/merge-fields";
import { EditorToolbar, type TiptapEditor } from "./toolbar";
import type { PickerField } from "./variable-picker";

/**
 * Maily-backed email editor (Tiptap). Formatting rides on our own toolbar (the
 * built-in menu bar is disabled) so it themes with the app and carries the
 * Insert-variable control; merge fields serialize to our worker token grammar
 * server-side (see lib/email-render.ts), so the html here is only the last-known
 * value — send html is re-rendered on save. A stored document that is not Maily
 * JSON (a pre-Maily template) imports through `contentHtml`, so it still edits
 * in place with no raw-html tab.
 *
 * Prop shape mirrors the previous editor so the pages are untouched.
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

type MailyContent = NonNullable<EditorProps["contentJson"]>;

function emptyMailyDoc(): MailyDoc {
  return { type: "doc", content: [{ type: "paragraph" }] };
}

export function MailyEditor({ value, onChange, mergeFields }: MailyEditorProps) {
  const tf = useTranslations(MERGE_FIELDS_I18N_NS);

  const [editor, setEditor] = useState<TiptapEditor | null>(null);
  // Bumped on every editor transaction so the toolbar's active/can() states
  // track the selection. The Maily <Editor> keeps stable props, so it never
  // re-initialises from these re-renders.
  const [, setTick] = useState(0);

  const initialDoc = isMailyDoc(value.document) ? value.document : null;
  const seed = useRef<{ contentJson?: MailyContent; contentHtml?: string }>(
    initialDoc
      ? { contentJson: initialDoc as MailyContent }
      : value.html.trim()
        ? { contentHtml: value.html }
        : { contentJson: emptyMailyDoc() as MailyContent },
  );
  const liveDoc = useRef<MailyDoc>(initialDoc ?? emptyMailyDoc());

  // Refs so the emit path is a stable callback (Maily re-inits if onUpdate's
  // identity changes); html carries the last-known render, refreshed by parent.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const htmlRef = useRef(value.html);
  htmlRef.current = value.html;

  const emit = useCallback(() => {
    onChangeRef.current({
      document: liveDoc.current,
      html: htmlRef.current,
      text: htmlToText(htmlRef.current),
    });
  }, []);

  // Restrict variables to the merge-field list; a *function* source never
  // appends the free-typed query, so no id can break MERGE_NAME_RE.
  const variables = useMemo<Variable[]>(
    () =>
      mergeFields.map((f) => ({
        name: f.name,
        label: f.labelKey ? tf(f.labelKey) : f.name,
      })),
    [mergeFields, tf],
  );
  const extensions = useMemo(
    () => [
      VariableExtension.configure({
        variables: ({ query }) =>
          variables.filter((v) => v.name.toLowerCase().startsWith(query.toLowerCase())),
        suggestion: getVariableSuggestions(),
      }),
    ],
    [variables],
  );

  const fields = useMemo<PickerField[]>(
    () =>
      mergeFields.map((f) => ({
        name: f.name,
        label: f.labelKey ? tf(f.labelKey) : f.name,
        description: f.labelKey ? tf(`desc.${f.labelKey}`) : tf("desc.custom"),
        // UNSUBSCRIBE_URL is generated per recipient, so it never takes a fallback.
        allowsFallback: f.name !== "UNSUBSCRIBE_URL",
      })),
    [mergeFields, tf],
  );

  const config = useMemo(
    () => ({
      hasMenuBar: false,
      immediatelyRender: false,
      wrapClassName: "ms-maily-wrap",
      contentClassName: "ms-maily-content",
      bodyClassName: "ms-maily-body",
      spellCheck: true,
    }),
    [],
  );

  const onCreate = useCallback(
    (ed: TiptapEditor) => {
      liveDoc.current = ed.getJSON() as MailyDoc;
      setEditor(ed);
      ed.on("transaction", () => setTick((n) => n + 1));
      emit();
    },
    [emit],
  );
  const onUpdate = useCallback(
    (ed: TiptapEditor) => {
      liveDoc.current = ed.getJSON() as MailyDoc;
      emit();
    },
    [emit],
  );

  return (
    <div className="ms-maily">
      <EditorToolbar editor={editor} fields={fields} />
      <div className="ms-maily-surface">
        {/* Spread the seed so only the one set key (contentJson OR contentHtml)
            is passed — exactOptionalPropertyTypes rejects an explicit undefined. */}
        <Editor
          {...seed.current}
          extensions={extensions}
          config={config}
          onCreate={onCreate}
          onUpdate={onUpdate}
        />
      </div>
    </div>
  );
}

export default MailyEditor;
