"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { NAV_ITEMS } from "@/components/sidebar";

interface PaletteItem {
  id: string;
  label: string;
  href: string;
}

export function CommandPalette() {
  const tNav = useTranslations("nav");
  const t = useTranslations("common.commandPalette");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((wasOpen) => !wasOpen);
        setQuery("");
        setIndex(0);
      } else if (event.key === "Escape") {
        // Window-level so Esc closes no matter where focus sits in the dialog.
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (items: PaletteItem[]) =>
      q ? items.filter((item) => item.label.toLowerCase().includes(q)) : items;
    return [
      {
        id: "navigate",
        label: t("navigate"),
        items: matches(
          NAV_ITEMS.map((item) => ({ id: item.key, label: tNav(item.key), href: item.href })),
        ),
      },
      {
        id: "actions",
        label: t("actions"),
        items: matches([
          { id: "createApiKey", label: t("createApiKey"), href: "/api-keys" },
          { id: "addDomain", label: t("addDomain"), href: "/domains/new" },
        ]),
      },
    ];
  }, [query, t, tNav]);
  const flat = groups.flatMap((group) => group.items);

  if (!open) return null;

  function go(item: PaletteItem | undefined) {
    if (!item) return;
    setOpen(false);
    router.push(item.href);
  }

  function onInputKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((i) => (flat.length ? (i + 1) % flat.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(flat[index]);
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: overlay click-to-dismiss; Esc handles keyboard
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: "var(--ms-z-modal)",
        background: "rgba(0,0,0,.72)",
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="ms-cmdk"
        style={{
          position: "absolute",
          left: "50%",
          top: 78,
          transform: "translateX(-50%)",
          width: 600,
          maxWidth: "calc(100vw - 32px)",
          background: "var(--ms-panel)",
          border: "1px solid var(--ms-line-strong)",
          borderRadius: 22,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "16px 18px",
            borderBottom: "1px solid var(--ms-line)",
          }}
        >
          <span style={{ color: "var(--ms-faint)", fontSize: 15 }}>⌕</span>
          <input
            // biome-ignore lint/a11y/noAutofocus: command palette convention — focus must land in the query field
            autoFocus
            className="ms-input"
            style={{
              flex: 1,
              background: "transparent",
              border: 0,
              boxShadow: "none",
              borderRadius: 0,
              padding: 0,
              fontSize: 15,
            }}
            placeholder={t("placeholder")}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            onKeyDown={onInputKeyDown}
          />
          <span className="ms-keycap">Esc</span>
        </div>
        <div className="ms-cmdk-list" style={{ padding: 10, maxHeight: 420, overflowY: "auto" }}>
          {flat.length === 0 ? (
            <div style={{ padding: "9px 12px", fontSize: 14, color: "var(--ms-muted)" }}>
              {t("noResults")}
            </div>
          ) : (
            groups.map((group) =>
              group.items.length === 0 ? null : (
                <div key={group.id}>
                  <div
                    className="ms-microlabel"
                    style={{ padding: "6px 12px 4px", fontSize: 10.5 }}
                  >
                    {group.label}
                  </div>
                  {group.items.map((item) => {
                    const selected = flat.indexOf(item) === index;
                    return (
                      <button
                        type="button"
                        key={item.id}
                        onClick={() => go(item)}
                        onMouseEnter={() => setIndex(flat.indexOf(item))}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          width: "100%",
                          padding: "9px 12px",
                          background: selected ? "var(--ms-panel-raised)" : "none",
                          border: 0,
                          borderRadius: 10,
                          cursor: "pointer",
                          textAlign: "left",
                          font: "inherit",
                        }}
                      >
                        <span
                          style={{
                            fontSize: 14,
                            color: selected ? "var(--ms-bone)" : "var(--ms-muted)",
                          }}
                        >
                          {item.label}
                        </span>
                        {selected ? <span className="ms-keycap">↵</span> : null}
                      </button>
                    );
                  })}
                </div>
              ),
            )
          )}
        </div>
        <div
          className="ms-cmdk-hints"
          style={{
            display: "flex",
            gap: 16,
            padding: "10px 18px",
            borderTop: "1px solid var(--ms-line)",
            fontSize: 11.5,
            color: "var(--ms-muted)",
          }}
        >
          <span>
            <span className="ms-keycap">↑</span> <span className="ms-keycap">↓</span>{" "}
            {t("hintNavigate")}
          </span>
          <span>
            <span className="ms-keycap">↵</span> {t("hintOpen")}
          </span>
          <span>
            <span className="ms-keycap">esc</span> {t("hintClose")}
          </span>
        </div>
      </div>
    </div>
  );
}
