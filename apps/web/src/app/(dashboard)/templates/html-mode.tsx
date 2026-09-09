"use client";

import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { CodeEditor, type CodeEditorHandle } from "@/components/code-editor";
import { ChevronGlyph } from "@/components/icons/nav-icons";
import { SearchIcon } from "@/components/maily-editor/icons";
import { usePickerFields, VariablePicker } from "@/components/maily-editor/variable-picker";
import "@/components/maily-editor/maily-theme.css";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { PreviewSchemePills } from "@/components/preview-scheme-pills";
import { BtnSpinner } from "@/components/spinner";
import { findMatches, nearestMatch, stepMatch } from "@/lib/code-find";
import { emulateEmailScheme } from "@/lib/email-preview";
import { type MergeFieldOption, makeMergeToken } from "@/lib/merge-fields";
import { usePreviewScheme } from "@/lib/use-preview-scheme";
import { fillMergeSamples } from "../broadcasts/parts";

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
 * (container query under .ms-tpl-code in components.css). Each pane is a
 * toolbar row over a body of the shared height, so the two line up.
 */
export function HtmlCodeMode({
  id = "tpl-html",
  html,
  onChange,
  mergeFields,
  previewSamples,
  hasText,
}: {
  /** The source textarea's id, for the field label. */
  id?: string;
  html: string;
  onChange: (html: string) => void;
  mergeFields: MergeFieldOption[];
  previewSamples: Record<string, string>;
  /** Whether the row stores a plain-text part; code mode never rewrites it. */
  hasText: boolean;
}) {
  const t = useTranslations("templates");
  const common = useTranslations("common");
  const [pane, setPane] = useState<"source" | "preview">("source");
  const [debounced, setDebounced] = useState(html);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(html), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [html]);
  const editor = useRef<CodeEditorHandle>(null);
  const fields = usePickerFields(mergeFields);

  // Find: matches follow the text live; the textarea selection only moves on
  // an explicit jump (query change, Enter, arrows), never on an edit.
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(-1);
  const [jump, setJump] = useState<{ index: number } | null>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const matches = useMemo(
    () => (findOpen ? findMatches(html, query) : []),
    [findOpen, html, query],
  );
  // An edit can remove matches under the held index.
  const cur = Math.min(current, matches.length - 1);
  useEffect(() => {
    if (jump) editor.current?.select(jump.index);
  }, [jump]);
  useEffect(() => {
    if (!findOpen) return;
    findInput.current?.focus();
    findInput.current?.select();
  }, [findOpen]);

  function focusFind() {
    findInput.current?.focus();
    findInput.current?.select();
  }
  function openFind() {
    if (findOpen) focusFind();
    else setFindOpen(true);
  }
  function closeFind() {
    setFindOpen(false);
    editor.current?.textarea?.focus();
  }
  function goTo(index: number) {
    setCurrent(index);
    if (index >= 0) setJump({ index });
  }
  function changeQuery(next: string) {
    setQuery(next);
    const found = findMatches(html, next);
    goTo(nearestMatch(found, editor.current?.textarea?.selectionStart ?? 0));
  }

  return (
    <div className="ms-tpl-code" data-pane={pane}>
      <div className="ms-tpl-code-tabs">
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
      </div>
      <div className="ms-tpl-code-panes">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: ⌘F anywhere inside the code pane opens its own find; the browser's page find stays untouched elsewhere */}
        <div
          className="ms-tpl-code-source"
          onKeyDown={(e) => {
            if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
            if (e.key.toLowerCase() !== "f") return;
            e.preventDefault();
            openFind();
          }}
        >
          <div className="ms-tpl-code-head">
            {findOpen ? (
              <div className="ms-code-find">
                <SearchIcon size={14} />
                <input
                  ref={findInput}
                  type="text"
                  aria-label={t("html.find")}
                  placeholder={t("html.findPlaceholder")}
                  value={query}
                  onChange={(e) => changeQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      goTo(stepMatch(matches.length, cur, e.shiftKey ? -1 : 1));
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      closeFind();
                    }
                  }}
                />
                {query ? (
                  <span className="ms-code-find-count" aria-live="polite">
                    {t("html.findCount", { current: cur + 1, total: matches.length })}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="ms-maily-tool"
                  aria-label={t("html.findPrev")}
                  title={t("html.findPrev")}
                  disabled={matches.length === 0}
                  onClick={() => goTo(stepMatch(matches.length, cur, -1))}
                >
                  <ChevronGlyph direction="up" />
                </button>
                <button
                  type="button"
                  className="ms-maily-tool"
                  aria-label={t("html.findNext")}
                  title={t("html.findNext")}
                  disabled={matches.length === 0}
                  onClick={() => goTo(stepMatch(matches.length, cur, 1))}
                >
                  <ChevronGlyph />
                </button>
                <button
                  type="button"
                  className="ms-maily-tool"
                  aria-label={common("close")}
                  title={common("close")}
                  onClick={closeFind}
                >
                  ✕
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="ms-maily-tool ms-maily-tool-labeled"
                onClick={openFind}
              >
                <SearchIcon size={14} />
                {t("html.find")}
                <span className="ms-keycap">⌘F</span>
              </button>
            )}
            <span style={{ marginLeft: "auto", flex: "none" }}>
              <VariablePicker
                fields={fields}
                onInsert={(name, _label, fallback) =>
                  editor.current?.insert(makeMergeToken(name, fallback ?? undefined))
                }
              />
            </span>
          </div>
          <CodeEditor
            id={id}
            ref={editor}
            value={html}
            onChange={onChange}
            language="xml"
            marks={matches}
            current={cur}
          />
        </div>
        <div className="ms-tpl-code-preview">
          <CodePreview
            html={debounced}
            title={t("editor.previewTab")}
            samples={previewSamples}
            empty={t("editor.noHtml")}
          />
        </div>
      </div>
      <p className="ms-tpl-code-hint">{t(hasText ? "html.textStored" : "html.textNone")}</p>
    </div>
  );
}

/**
 * The code pane's live preview: ContentPreview's frame, but keeping its scroll
 * position across the srcDoc swaps that every debounced edit makes — otherwise
 * editing the footer means scrolling back down after each keystroke. Reading
 * and restoring the scroll needs allow-same-origin; scripts stay disallowed,
 * so nothing in the message can reach the dashboard through that origin.
 */
function CodePreview({
  html,
  title,
  samples,
  empty,
}: {
  html: string;
  title: string;
  samples: Record<string, string>;
  empty: string;
}) {
  const [scheme, setScheme] = usePreviewScheme();
  const scrollY = useRef(0);
  const filled = html.trim() !== "";
  return (
    <>
      <div className="ms-tpl-code-head">
        <span style={{ marginLeft: "auto", flex: "none" }}>
          <PreviewSchemePills scheme={scheme} onChange={setScheme} />
        </span>
      </div>
      <div
        className="ms-tpl-code-frame"
        style={filled ? { background: scheme === "dark" ? "#111113" : "#ffffff" } : undefined}
      >
        {filled ? (
          <iframe
            title={title}
            sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            srcDoc={emulateEmailScheme(fillMergeSamples(html, samples), scheme)}
            onLoad={(event) => {
              const win = event.currentTarget.contentWindow;
              if (!win) return;
              // scrollTo clamps to the new document's height; the listener
              // dies with this document, the next load attaches its own.
              win.scrollTo(0, scrollY.current);
              win.addEventListener("scroll", () => {
                scrollY.current = win.scrollY;
              });
            }}
          />
        ) : (
          <p style={emptyStyle}>{empty}</p>
        )}
      </div>
    </>
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
 * The guarded html→blocks conversion. A row that can be copied (a template)
 * offers duplicating as the primary path, the original untouched, beside
 * converting in place; a one-off body (a broadcast) only converts in place.
 * In place is destructive in tone — the stored html changes on the next save.
 */
export function ConvertBlocksDialog({
  open,
  busy = false,
  onClose,
  onDuplicate,
  onConvertInPlace,
  inPlaceLabel,
}: {
  open: boolean;
  busy?: boolean;
  onClose: () => void;
  onDuplicate?: () => void;
  onConvertInPlace: () => void;
  /** Names what converts in place: this template, this broadcast. */
  inPlaceLabel: string;
}) {
  const t = useTranslations("templates");
  const common = useTranslations("common");
  // Same guard as the primary button — Modal's ⌘↵ path routes through here too.
  const primary = onDuplicate ?? onConvertInPlace;
  const confirm = () => {
    if (!busy) primary();
  };
  return (
    <Modal open={open} onClose={onClose} onConfirm={confirm} title={t("html.convertTitle")}>
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
            {onDuplicate ? (
              inPlaceLabel
            ) : (
              <>
                {inPlaceLabel} <ConfirmKeycap />
              </>
            )}
          </button>
          {onDuplicate ? (
            <button
              type="button"
              className="ms-btn ms-btn-primary"
              disabled={busy}
              onClick={confirm}
            >
              <BtnSpinner on={busy} />
              {t("html.convertCopy")} <ConfirmKeycap />
            </button>
          ) : null}
        </span>
      </ModalFooter>
    </Modal>
  );
}
