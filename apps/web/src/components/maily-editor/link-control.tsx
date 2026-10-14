"use client";

import { useTranslations } from "next-intl";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDismiss } from "@/components/popover-menu";
import { clampInto } from "@/lib/panel-placement";
import { chain, type TiptapEditor } from "./commands";
import { LinkIcon } from "./icons";

/** Room the link box keeps from the toolbar's edges. */
const BOX_INSET = 8;

/**
 * Link control: a small popover with a URL field, applying/removing a link on
 * the current selection. Prefills the existing href when the caret sits in a
 * link, so it doubles as edit + remove. Kept inline (not window.prompt) to stay
 * on-theme and non-blocking.
 */
export function LinkControl({ editor }: { editor: TiptapEditor | null }) {
  const t = useTranslations("block-editor");
  const [open, setOpen] = useState(false);
  const [href, setHref] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useDismiss(rootRef, open, () => setOpen(false));
  // The box hangs from the toolbar, under its button where it fits, shifted to
  // stay inside the editor: a dialog's scroll box would clip it, a phone scroll sideways.
  useLayoutEffect(() => {
    const box = boxRef.current;
    const toolbar = box?.offsetParent;
    if (!open || !box || !(toolbar instanceof HTMLElement) || !triggerRef.current) return;
    box.style.maxWidth = `${toolbar.clientWidth - 2 * BOX_INSET}px`;
    const left = clampInto(
      triggerRef.current.offsetLeft,
      box.offsetWidth,
      toolbar.clientWidth,
      BOX_INSET,
    );
    box.style.left = `${left}px`;
  }, [open]);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const active = editor?.isActive("link") ?? false;
  // A link needs a range to attach to; disable on an empty selection unless the
  // caret is already inside a link (edit/remove still make sense there).
  const canLink = !!editor && (active || !editor.state.selection.empty);

  function toggle() {
    if (!editor) return;
    if (open) {
      setOpen(false);
      return;
    }
    setHref((editor.getAttributes("link").href as string) ?? "");
    setOpen(true);
  }

  function apply() {
    if (!editor) return;
    const url = href.trim();
    const c = chain(editor).focus().extendMarkRange("link");
    if (url) c.setLink({ href: url }).run();
    else c.unsetLink().run();
    setOpen(false);
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape-anywhere dismissal for the popover; interactive children handle their own input
    <div
      ref={rootRef}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="ms-maily-tool"
        data-active={active || undefined}
        disabled={!canLink}
        aria-label={t("panel.link")}
        title={t("panel.link")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
      >
        <LinkIcon />
      </button>
      {open ? (
        <div ref={boxRef} className="ms-maily-linkbox" role="dialog" aria-label={t("panel.link")}>
          <input
            ref={inputRef}
            type="url"
            className="ms-mono"
            placeholder={t("panel.linkPrompt")}
            value={href}
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                apply();
              }
            }}
          />
          <button type="button" className="ms-maily-tool ms-maily-tool-labeled" onClick={apply}>
            {href.trim() ? t("panel.apply") : t("panel.removeLink")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
