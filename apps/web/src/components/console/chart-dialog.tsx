"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Modal } from "@/components/modal";
import { ModalFooter } from "@/components/modal-footer";

export const PERIOD_KEYS = ["24h", "7d", "30d", "90d"] as const;
export type PeriodKey = (typeof PERIOD_KEYS)[number];
/** A preset, or a custom UTC date range (inclusive). Mirrors the router's periodSchema. */
export type Period = PeriodKey | { from: string; to: string };

export function isPeriodKey(value: unknown): value is PeriodKey {
  return typeof value === "string" && (PERIOD_KEYS as readonly string[]).includes(value);
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The period selector every console chart carries: four presets and a
 * custom range that opens two date fields with Apply, "Presets" bringing
 * the row back. Native date inputs: the platform picker beats a widget.
 */
export function PeriodBar({
  value,
  onChange,
  allowCustom = true,
}: {
  value: Period;
  onChange: (period: Period) => void;
  allowCustom?: boolean;
}) {
  const t = useTranslations("console.common");
  const [custom, setCustom] = useState(typeof value !== "string");
  const [from, setFrom] = useState(
    typeof value === "string" ? isoDay(new Date(Date.now() - 29 * 86_400_000)) : value.from,
  );
  const [to, setTo] = useState(typeof value === "string" ? isoDay(new Date()) : value.to);
  const btn = (active: boolean): React.CSSProperties => ({
    background: active ? "var(--ms-panel-raised)" : "none",
    border: `1px solid ${active ? "var(--ms-line-strong)" : "transparent"}`,
    borderRadius: 8,
    padding: "3px 9px",
    fontSize: 12,
    color: active ? "var(--ms-bone)" : "var(--ms-muted)",
    cursor: "pointer",
    font: "inherit",
  });
  if (custom) {
    return (
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="date"
          className="ms-input"
          aria-label={t("from")}
          value={from}
          max={to}
          onChange={(e) => setFrom(e.target.value)}
          style={{ height: 26, fontSize: 12, padding: "2px 8px", width: "auto" }}
        />
        <span style={{ fontSize: 12, color: "var(--ms-muted)" }}>{t("to")}</span>
        <input
          type="date"
          className="ms-input"
          aria-label={t("to")}
          value={to}
          min={from}
          max={isoDay(new Date())}
          onChange={(e) => setTo(e.target.value)}
          style={{ height: 26, fontSize: 12, padding: "2px 8px", width: "auto" }}
        />
        <button
          type="button"
          style={btn(true)}
          disabled={!from || !to || from > to}
          onClick={() => onChange({ from, to })}
        >
          {t("apply")}
        </button>
        <button
          type="button"
          style={btn(false)}
          onClick={() => {
            setCustom(false);
            onChange("30d");
          }}
        >
          {t("presets")}
        </button>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
      {PERIOD_KEYS.map((key) => (
        <button key={key} type="button" style={btn(value === key)} onClick={() => onChange(key)}>
          {t(`periodShort.${key}`)}
        </button>
      ))}
      {allowCustom ? (
        <button type="button" style={btn(false)} onClick={() => setCustom(true)}>
          {t("custom")}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The history dialog behind every KPI card, stat tile and health row: a
 * period bar, whatever chart the caller renders for that period, and a
 * caption. `children` renders the chart for the period the dialog holds.
 */
export function ChartDialog({
  open,
  onClose,
  title,
  initialPeriod = "30d",
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  initialPeriod?: Period;
  children: (period: Period) => React.ReactNode;
}) {
  const t = useTranslations("console.common");
  const [period, setPeriod] = useState<Period>(initialPeriod);
  return (
    <Modal open={open} onClose={onClose} title={title} size="wide">
      <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--ms-muted)" }}>{t("hoverHint")}</p>
      <div style={{ marginBottom: 14 }}>
        <PeriodBar value={period} onChange={setPeriod} />
      </div>
      {children(period)}
      <ModalFooter>
        <button type="button" className="ms-btn ms-btn-secondary" onClick={onClose}>
          {t("close")} <span className="ms-keycap">Esc</span>
        </button>
      </ModalFooter>
    </Modal>
  );
}
