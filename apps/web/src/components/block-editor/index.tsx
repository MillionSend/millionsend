"use client";

import type { Editor } from "@tiptap/react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { type BlockDoc, type BlockType, emptyBlockDoc } from "@/lib/email-blocks/model";
import { serialize } from "@/lib/email-blocks/serialize";
import { htmlToText } from "@/lib/html";
import { MERGE_FIELDS_I18N_NS, type MergeFieldOption, makeMergeToken } from "@/lib/merge-fields";
import { sanitizeHtml } from "@/lib/sanitize-html";
import "@/styles/block-editor.css";
import { addBlock, createBlock, moveBlock, removeBlock, updateBlock } from "./block-ops";
import { BlockView } from "./block-view";
import { MergePicker } from "./merge-picker";
import { RichText } from "./rich-text";
import type { SlashItem, SlashKind } from "./slash-menu";
import { StylePanel } from "./style-panel";

export interface BlockEditorValue {
  document: BlockDoc | null;
  html: string;
}

export interface BlockEditorChange {
  document: BlockDoc | null;
  html: string;
  text: string;
}

export interface BlockEditorProps {
  value: BlockEditorValue;
  onChange: (value: BlockEditorChange) => void;
  mergeFields: MergeFieldOption[];
}

const SLASH_KINDS: { kind: SlashKind; hint: string }[] = [
  { kind: "heading", hint: "H" },
  { kind: "text", hint: "¶" },
  { kind: "image", hint: "▦" },
  { kind: "button", hint: "▭" },
  { kind: "divider", hint: "—" },
  { kind: "spacer", hint: "␣" },
  { kind: "variable", hint: "{}" },
  { kind: "html", hint: "</>" },
];

export function BlockEditor({ value, onChange, mergeFields }: BlockEditorProps) {
  const t = useTranslations("block-editor");
  const tf = useTranslations(MERGE_FIELDS_I18N_NS);

  const [mode, setMode] = useState<"design" | "code">(
    value.document ? "design" : value.html.trim() ? "code" : "design",
  );
  const [doc, setDoc] = useState<BlockDoc>(value.document ?? emptyBlockDoc());
  const [code, setCode] = useState(value.html);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeEditor, setActiveEditor] = useState<Editor | null>(null);
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);
  const [dirtyCode, setDirtyCode] = useState(false);
  const [docBeforeCode, setDocBeforeCode] = useState<BlockDoc | null>(null);

  // onChange kept in a ref so the emit effect depends only on editor state,
  // never re-firing because the parent handed us a new callback identity.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    if (mode === "code") {
      const clean = sanitizeHtml(code);
      onChangeRef.current({ document: null, html: clean, text: htmlToText(clean) });
    } else {
      const { html, text } = serialize(doc);
      onChangeRef.current({ document: doc, html, text });
    }
  }, [mode, code, doc]);

  const labelOf = useCallback(
    (name: string) => {
      const field = mergeFields.find((f) => f.name === name);
      return field?.labelKey ? tf(field.labelKey) : name;
    },
    [mergeFields, tf],
  );
  const renderLabel = useCallback((name: string) => labelOf(name), [labelOf]);

  const slashItems: SlashItem[] = SLASH_KINDS.map(({ kind, hint }) => ({
    kind,
    label: t(`block.${kind}`),
    hint,
  }));

  function insertBlock(type: BlockType, afterId?: string) {
    const block = createBlock(type);
    setDoc((d) => addBlock(d, block, afterId ?? selectedId ?? undefined));
    setSelectedId(block.id);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: stable closure over setState; blockId arg is authoritative
  const handleSlash = useCallback(
    (blockId: string, kind: SlashKind, editor: Editor, range: { from: number; to: number }) => {
      editor.chain().focus().deleteRange(range).run();
      if (kind === "variable") {
        setActiveEditor(editor);
        const at = editor.view.coordsAtPos(editor.state.selection.from);
        setPicker({ x: at.left, y: at.bottom });
        return;
      }
      setSelectedId(blockId);
      insertBlock(kind, blockId);
    },
    [],
  );

  function pickField(name: string, fallback: string) {
    setPicker(null);
    const fb = fallback.trim();
    if (activeEditor && !activeEditor.isDestroyed) {
      activeEditor
        .chain()
        .focus()
        .insertContent({ type: "mergeField", attrs: { name, fallback: fb === "" ? null : fb } })
        .run();
      return;
    }
    const block = createBlock("text");
    if (block.type === "text") block.html = makeMergeToken(name, fb === "" ? undefined : fb);
    setDoc((d) => addBlock(d, block, selectedId ?? undefined));
    setSelectedId(block.id);
  }

  function enterCode() {
    setDocBeforeCode(doc);
    setCode(serialize(doc).html);
    setDirtyCode(false);
    setSelectedId(null);
    setMode("code");
  }
  function exitToDesign() {
    if (docBeforeCode && !dirtyCode) {
      setDoc(docBeforeCode);
      setMode("design");
    }
  }
  const designLocked = mode === "code" && (dirtyCode || docBeforeCode === null);

  const selected = doc.blocks.find((b) => b.id === selectedId) ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Toolbar
        t={t}
        mode={mode}
        designLocked={designLocked}
        onDesign={exitToDesign}
        onCode={enterCode}
        onInsert={(type) => insertBlock(type)}
        onVariables={(rect) => {
          setPicker({ x: rect.left, y: rect.bottom });
        }}
      />

      {mode === "code" ? (
        <textarea
          className="ms-input ms-mono"
          style={{ width: "100%", minHeight: 340, resize: "vertical", lineHeight: 1.6 }}
          placeholder={t("code.placeholder")}
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            setDirtyCode(true);
          }}
        />
      ) : (
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
          <div
            style={{
              flex: 1,
              minWidth: 0,
              border: "1px solid var(--ms-line)",
              borderRadius: "var(--ms-r-input)",
              background: "var(--ms-panel)",
              padding: 16,
            }}
          >
            {doc.blocks.length === 0 ? (
              <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
                {t("canvas.empty")}
              </p>
            ) : (
              doc.blocks.map((block) => (
                <BlockRow
                  key={block.id}
                  selected={block.id === selectedId}
                  t={t}
                  onSelect={() => setSelectedId(block.id)}
                  onMove={(dir) => setDoc((d) => moveBlock(d, block.id, dir))}
                  onRemove={() => {
                    setDoc((d) => removeBlock(d, block.id));
                    setSelectedId((id) => (id === block.id ? null : id));
                  }}
                >
                  {block.type === "text" || block.type === "heading" ? (
                    <RichText
                      block={block}
                      slashItems={slashItems}
                      renderLabel={renderLabel}
                      onActive={setActiveEditor}
                      onSlash={(kind, editor, range) => handleSlash(block.id, kind, editor, range)}
                      onChange={(id, html) => setDoc((d) => updateBlock(d, id, { html }))}
                    />
                  ) : (
                    <BlockView block={block} />
                  )}
                </BlockRow>
              ))
            )}
          </div>

          {selected ? (
            <div
              style={{
                width: 260,
                flexShrink: 0,
                border: "1px solid var(--ms-line)",
                borderRadius: "var(--ms-r-input)",
                background: "var(--ms-panel)",
                padding: 14,
              }}
            >
              <StylePanel
                block={selected}
                editor={
                  selected.type === "text" || selected.type === "heading" ? activeEditor : null
                }
                onChange={(patch) => setDoc((d) => updateBlock(d, selected.id, patch))}
              />
            </div>
          ) : null}
        </div>
      )}

      {picker ? (
        <MergePicker
          fields={mergeFields}
          renderLabel={renderLabel}
          at={picker}
          onPick={pickField}
          onClose={() => setPicker(null)}
        />
      ) : null}
    </div>
  );
}

function Toolbar({
  t,
  mode,
  designLocked,
  onDesign,
  onCode,
  onInsert,
  onVariables,
}: {
  t: (key: string) => string;
  mode: "design" | "code";
  designLocked: boolean;
  onDesign: () => void;
  onCode: () => void;
  onInsert: (type: BlockType) => void;
  onVariables: (rect: DOMRect) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <div
        style={{
          display: "inline-flex",
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
          onClick={onDesign}
        >
          {t("mode.design")}
        </button>
        <button type="button" className="ms-btn" style={segStyle(mode === "code")} onClick={onCode}>
          {"</>"} {t("mode.code")}
        </button>
      </div>

      {mode === "design" ? (
        <>
          <span style={{ width: 1, height: 20, background: "var(--ms-line)" }} />
          <button
            type="button"
            className="ms-btn ms-btn-secondary"
            onClick={() => onInsert("text")}
          >
            {t("toolbar.text")}
          </button>
          <button
            type="button"
            className="ms-btn ms-btn-secondary"
            onClick={() => onInsert("image")}
          >
            {t("toolbar.image")}
          </button>
          <button
            type="button"
            className="ms-btn ms-btn-secondary"
            onClick={(e) => onVariables(e.currentTarget.getBoundingClientRect())}
          >
            {t("toolbar.variables")}
          </button>
        </>
      ) : null}
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

function BlockRow({
  selected,
  t,
  onSelect,
  onMove,
  onRemove,
  children,
}: {
  selected: boolean;
  t: (key: string) => string;
  onSelect: () => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  children: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: selecting a block on pointer-down; the block's own controls remain keyboard-reachable
    <div
      onMouseDown={onSelect}
      style={{
        position: "relative",
        borderRadius: 8,
        padding: 8,
        marginBottom: 6,
        outline: selected ? "2px solid var(--ms-focus-border)" : "1px solid var(--ms-line)",
      }}
    >
      {children}
      {selected ? (
        <div style={{ position: "absolute", top: -12, right: 6, display: "flex", gap: 2 }}>
          <button
            type="button"
            className="ms-btn ms-btn-icon"
            aria-label={t("row.moveUp")}
            onClick={() => onMove(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="ms-btn ms-btn-icon"
            aria-label={t("row.moveDown")}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
          <button
            type="button"
            className="ms-btn ms-btn-icon"
            aria-label={t("row.remove")}
            onClick={onRemove}
          >
            ✕
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default BlockEditor;
