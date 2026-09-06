"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { CodeEditor, type CodeEditorHandle } from "@/components/code-editor";
import { usePickerFields, VariablePicker } from "@/components/maily-editor/variable-picker";
import "@/components/maily-editor/maily-theme.css";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { BtnSpinner } from "@/components/spinner";
import { type MergeFieldOption, makeMergeToken } from "@/lib/merge-fields";
import { ContentPreview } from "../broadcasts/parts";

const PREVIEW_DEBOUNCE_MS = 350;

const emptyStyle = {
  margin: 0,
  padding: "16px 18px",
  color: "var(--ms-muted)",
  fontSize: "var(--ms-fs-ui)",
} as const;

/**
 * Source editing for an html-authored template: the code editor beside a live
 * preview while the field is wide enough, one pane at a time below that
 * (container query under .ms-tpl-code in components.css).
 */
export function HtmlCodeMode({
  html,
  onChange,
  mergeFields,
  previewSamples,
  hasText,
}: {
  html: string;
  onChange: (html: string) => void;
  mergeFields: MergeFieldOption[];
  previewSamples: Record<string, string>;
  /** Whether the row stores a plain-text part; code mode never rewrites it. */
  hasText: boolean;
}) {
  const t = useTranslations("templates");
  const [pane, setPane] = useState<"source" | "preview">("source");
  const [debounced, setDebounced] = useState(html);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(html), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [html]);
  const editor = useRef<CodeEditorHandle>(null);
  const fields = usePickerFields(mergeFields);

  return (
    <div className="ms-tpl-code" data-pane={pane}>
      <div className="ms-tpl-code-bar">
        <span className="ms-tpl-code-tabs">
          {(["source", "preview"] as const).map((key) => (
            <button
              key={key}
              type="button"
              className={pane === key ? "ms-code-tab active" : "ms-code-tab"}
              aria-pressed={pane === key}
              onClick={() => setPane(key)}
            >
              {t(key === "source" ? "html.source" : "editor.previewTab")}
            </button>
          ))}
        </span>
        <span style={{ marginLeft: "auto" }}>
          <VariablePicker
            fields={fields}
            onInsert={(name, _label, fallback) =>
              editor.current?.insert(makeMergeToken(name, fallback ?? undefined))
            }
          />
        </span>
      </div>
      <div className="ms-tpl-code-panes">
        <div className="ms-tpl-code-source">
          <CodeEditor id="tpl-html" ref={editor} value={html} onChange={onChange} language="xml" />
          <p className="ms-tpl-code-hint">{t(hasText ? "html.textStored" : "html.textNone")}</p>
        </div>
        <div className="ms-tpl-code-preview">
          {debounced.trim() ? (
            <ContentPreview
              html={debounced}
              title={t("editor.previewTab")}
              samples={previewSamples}
            />
          ) : (
            <p style={emptyStyle}>{t("editor.noHtml")}</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Quiet notice over the preview of an html-authored template, with its two ways forward. */
export function HtmlAuthoredBanner({
  onEditHtml,
  onConvert,
}: {
  onEditHtml: () => void;
  onConvert: () => void;
}) {
  const t = useTranslations("templates");
  return (
    <div className="ms-tpl-html-banner" role="status">
      <span>{t("html.banner")}</span>
      <span className="ms-tpl-html-banner-actions">
        <button type="button" className="ms-btn ms-btn-secondary" onClick={onEditHtml}>
          {t("html.editHtml")}
        </button>
        <button type="button" className="ms-btn ms-btn-ghost" onClick={onConvert}>
          {t("html.convert")}
        </button>
      </span>
    </div>
  );
}

/**
 * The guarded html→blocks conversion: duplicating (primary, the original
 * untouched) or converting this template in place (destructive tone — the
 * stored html changes on the next save).
 */
export function ConvertBlocksDialog({
  open,
  busy,
  onClose,
  onDuplicate,
  onConvertInPlace,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onDuplicate: () => void;
  onConvertInPlace: () => void;
}) {
  const t = useTranslations("templates");
  const common = useTranslations("common");
  // Same guard as the primary button — Modal's ⌘↵ path routes through here too.
  const duplicate = () => {
    if (!busy) onDuplicate();
  };
  return (
    <Modal open={open} onClose={onClose} onConfirm={duplicate} title={t("html.convertTitle")}>
      <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
        {t("html.convertBody")}
      </p>
      <ModalFooter>
        <span className="ms-tpl-convert-actions">
          <button type="button" className="ms-btn ms-btn-secondary" onClick={onClose}>
            {common("cancel")} <span className="ms-keycap">Esc</span>
          </button>
          <button
            type="button"
            className="ms-btn ms-btn-destructive"
            disabled={busy}
            onClick={onConvertInPlace}
          >
            {t("html.convertInPlace")}
          </button>
          <button
            type="button"
            className="ms-btn ms-btn-primary"
            disabled={busy}
            onClick={duplicate}
          >
            <BtnSpinner on={busy} />
            {t("html.convertCopy")} <ConfirmKeycap />
          </button>
        </span>
      </ModalFooter>
    </Modal>
  );
}
