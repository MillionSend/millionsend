"use client";

import { Editor, type EditorProps } from "@maily-to/core";
import {
  blockquote,
  bulletList,
  button,
  columns,
  divider,
  heading1,
  heading2,
  heading3,
  image,
  orderedList,
  section,
  spacer,
  text,
} from "@maily-to/core/blocks";
import {
  DEFAULT_RENDER_VARIABLE_FUNCTION,
  getSlashCommandSuggestions,
  getVariableSuggestions,
  PlaceholderExtension,
  SlashCommandExtension,
  type Variable,
  VariableExtension,
} from "@maily-to/core/extensions";
import "@maily-to/core/style.css";
import "./maily-theme.css";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useRef, useState } from "react";
import { isMailyDoc, type MailyDoc } from "@/lib/email-doc";
import { MERGE_FIELDS_I18N_NS, type MergeFieldOption, makeMergeToken } from "@/lib/merge-fields";
import { VariableIcon } from "./icons";
import { EditorToolbar, type TiptapEditor } from "./toolbar";
import { createVariableNodeView } from "./variable-node-view";
import type { PickerField } from "./variable-picker";
import { makeVariableSuggestionsPopover } from "./variable-suggestions";

/**
 * Maily-backed email editor (Tiptap). Formatting rides on our own toolbar (the
 * built-in menu bar is disabled) so it themes with the app and carries the
 * Insert-variable control; merge fields serialize to our worker token grammar
 * server-side (see lib/email-render.ts), so the html here is only the last-known
 * value — send html is re-rendered on save. A stored document that is not Maily
 * JSON (a pre-Maily template) imports through `contentHtml`, so it still edits
 * in place with no raw-html tab — but the lossy conversion is only emitted
 * after the first real edit, so opening and saving untouched preserves the
 * stored html byte-for-byte.
 *
 * The slash menu and empty-state placeholder are rebuilt from Maily's blocks
 * with our i18n strings (Maily ships hardcoded English; passing same-name
 * extensions replaces its defaults). The in-content variable pill is ours too:
 * themed, centered, and without Maily's required-⚠, which its default pill
 * shows for every variable lacking a fallback.
 *
 * Prop shape mirrors the previous editor so the pages are untouched.
 */
export interface MailyEditorValue {
  document: unknown | null;
  html: string;
}

export interface MailyEditorChange {
  /** The Maily/Tiptap document; send html is re-rendered from it on save. */
  document: unknown;
}

export interface MailyEditorProps {
  value: MailyEditorValue;
  onChange: (value: MailyEditorChange) => void;
  mergeFields: MergeFieldOption[];
}

type MailyContent = NonNullable<EditorProps["contentJson"]>;

/** The curated slash-menu blocks, paired with their i18n key. */
const SLASH_BLOCKS = [
  [text, "text"],
  [heading1, "heading1"],
  [heading2, "heading2"],
  [heading3, "heading3"],
  [bulletList, "bulletList"],
  [orderedList, "orderedList"],
  [image, "image"],
  [button, "button"],
  [divider, "divider"],
  [spacer, "spacer"],
  [blockquote, "blockquote"],
  [columns, "columns"],
  [section, "section"],
] as const;

/** Node types that render their own inner placeholder (or none at all). */
const NO_PLACEHOLDER_NODES = new Set([
  "columns",
  "column",
  "section",
  "repeat",
  "show",
  "blockquote",
  "htmlCodeBlock",
]);

function emptyMailyDoc(): MailyDoc {
  return { type: "doc", content: [{ type: "paragraph" }] };
}

export function MailyEditor({ value, onChange, mergeFields }: MailyEditorProps) {
  const t = useTranslations("block-editor");
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

  // Refs so the emit path is a stable callback — Maily re-inits if onUpdate's
  // identity changes.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const emit = useCallback(() => {
    onChangeRef.current({ document: liveDoc.current });
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
  // The '@' suggestion closure is captured when the Tiptap editor is created
  // (Maily's useEditor never re-applies extensions), so it must read the list
  // through a ref or async-loaded contact-property fields would never appear.
  const variablesRef = useRef(variables);
  variablesRef.current = variables;

  // Our in-content pill: themed, vertically centered, labelled with the human
  // name and carrying the raw token in the tooltip. Maily's default pill is
  // skipped for content variables only — the bubble/button variants keep it.
  const renderVariable = useCallback<typeof DEFAULT_RENDER_VARIABLE_FUNCTION>((opts) => {
    if (opts.from !== "content-variable") return DEFAULT_RENDER_VARIABLE_FUNCTION(opts);
    const { variable, fallback } = opts;
    return (
      <span
        className="ms-maily-varpill"
        title={makeMergeToken(variable.name, fallback || undefined)}
      >
        <VariableIcon size={11} />
        {variable.label || variable.name}
      </span>
    );
  }, []);

  const extensions = useMemo(
    () => [
      // Extended with our own node view: the in-content pill and its edit
      // popover become ours (translated Variable/Default labels, aligned rows)
      // instead of Maily's hardcoded-English VariableView. The '@' popover is
      // likewise ours via variableSuggestionsPopover — same ref contract
      // ({moveUp, moveDown, select}) that Maily's VariableList drives.
      VariableExtension.extend({
        addNodeView() {
          return createVariableNodeView({
            variable: t("varpop.variable"),
            fallback: t("varpop.fallback"),
            fallbackPlaceholder: t("varpop.fallbackPlaceholder"),
          }) as never;
        },
      }).configure({
        variables: ({ query }) =>
          variablesRef.current.filter((v) => v.name.toLowerCase().startsWith(query.toLowerCase())),
        suggestion: getVariableSuggestions(),
        renderVariable,
        variableSuggestionsPopover: makeVariableSuggestionsPopover({
          header: t("suggest.header"),
          navigate: t("suggest.navigate"),
          empty: t("suggest.empty"),
        }),
      }),
      // Same-name extensions replace Maily's defaults — that is how the slash
      // menu and placeholder become localizable at all.
      SlashCommandExtension.configure({
        suggestion: getSlashCommandSuggestions([
          {
            title: t("slash.group"),
            commands: SLASH_BLOCKS.map(([block, key]) => ({
              ...block,
              title: t(`slash.${key}.title`),
              description: t(`slash.${key}.desc`),
            })),
          },
        ]),
      }),
      PlaceholderExtension.configure({
        placeholder: ({ node }) => {
          if (node.type.name === "heading") {
            return t("ph.heading", { level: node.attrs.level as number });
          }
          return NO_PLACEHOLDER_NODES.has(node.type.name) ? "" : t("ph.body");
        },
        includeChildren: true,
      }),
    ],
    [renderVariable, t],
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

  // A contentHtml seed means a pre-Maily raw-HTML document, and Tiptap's parse
  // of it is lossy. Emitting it from onCreate would hand the parent a converted
  // document with zero user action — an untouched open-then-save would then
  // silently rewrite the stored html. So the conversion is only emitted from
  // onUpdate, i.e. after a deliberate edit; until then the stored html stands.
  const seededFromHtml = seed.current.contentHtml !== undefined;

  const onCreate = useCallback(
    (ed: TiptapEditor) => {
      liveDoc.current = ed.getJSON() as MailyDoc;
      setEditor(ed);
      ed.on("transaction", () => setTick((n) => n + 1));
      if (!seededFromHtml) emit();
    },
    [emit, seededFromHtml],
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
