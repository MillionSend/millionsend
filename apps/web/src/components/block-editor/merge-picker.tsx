import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { useDismiss } from "@/components/popover-menu";
import type { MergeFieldOption } from "@/lib/merge-fields";

/**
 * Field picker shared by the toolbar Variables tool and the "/" Variable entry.
 * A single optional fallback applies to whichever field the author picks; the
 * caller turns the choice into an inline chip (design) or a literal token.
 */
export function MergePicker({
  fields,
  renderLabel,
  at,
  onPick,
  onClose,
}: {
  fields: MergeFieldOption[];
  renderLabel: (name: string) => string;
  at: { x: number; y: number };
  onPick: (name: string, fallback: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("block-editor");
  const ref = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [fallback, setFallback] = useState("");
  useDismiss(ref, true, onClose);

  const shown = fields.filter(
    (f) =>
      renderLabel(f.name).toLowerCase().includes(query.toLowerCase()) ||
      f.name.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div
      ref={ref}
      className="ms-menu"
      style={{
        position: "fixed",
        top: at.y + 4,
        left: at.x,
        minWidth: 220,
        maxHeight: 320,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <input
        className="ms-menu-search"
        placeholder={t("picker.search")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        // biome-ignore lint/a11y/noAutofocus: popover opened by explicit user action; focus belongs in its search
        autoFocus
      />
      <div style={{ overflowY: "auto" }}>
        {shown.length === 0 ? (
          <div className="ms-menu-item static">{t("picker.empty")}</div>
        ) : (
          shown.map((f) => (
            <button
              key={f.name}
              type="button"
              role="menuitem"
              className="ms-menu-item"
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(f.name, fallback);
              }}
            >
              <span>{renderLabel(f.name)}</span>
              <span
                className="ms-mono"
                style={{ color: "var(--ms-faint)", fontSize: "var(--ms-fs-micro)" }}
              >
                {f.name}
              </span>
            </button>
          ))
        )}
      </div>
      <input
        className="ms-input"
        style={{ margin: "4px", width: "calc(100% - 8px)" }}
        placeholder={t("picker.fallback")}
        value={fallback}
        onChange={(e) => setFallback(e.target.value)}
      />
    </div>
  );
}
