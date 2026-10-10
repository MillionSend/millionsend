"use client";

import { useMutation } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { KvRow } from "@/components/kv-row";
import { BtnSpinner } from "@/components/spinner";
import { toast } from "@/components/toast";
import { useTRPC } from "@/lib/trpc";
import type { AppRouter } from "@/server/routers";
import { useRegionFormats } from "./formatters";

type RegionList = inferRouterOutputs<AppRouter>["console"]["regions"]["list"];

const cardTitle: React.CSSProperties = {
  margin: "0 0 4px",
  fontSize: "var(--ms-fs-section)",
  fontWeight: 600,
};
const cardSub: React.CSSProperties = { margin: 0, fontSize: 13, color: "var(--ms-muted)" };
const hintStyle: React.CSSProperties = {
  margin: "10px 0 0",
  fontSize: 12.5,
  color: "var(--ms-muted)",
};

/**
 * The one operator number behind broadcast pacing: the percent of every
 * region's 24-hour quota broadcasts never touch. Shown beside the regions it
 * splits, with the week's transactional peak as a hint the operator applies
 * by hand.
 */
export function ReserveCard({ list, onChanged }: { list: RegionList; onChanged: () => void }) {
  const t = useTranslations("console.regions.reserve");
  const common = useTranslations("console.common");
  const trpc = useTRPC();
  const f = useRegionFormats();
  const { reserve } = list;
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? String(reserve.percent);
  const parsed = Number.parseInt(value, 10);
  const valid = Number.isInteger(parsed) && parsed >= reserve.min && parsed <= reserve.max;
  const dirty = draft !== null && parsed !== reserve.percent;
  const save = useMutation(
    trpc.console.regions.setReserve.mutationOptions({
      onSuccess: (result) => {
        toast(t("toast", { percent: f.pct0(result.percent / 100) }));
        setDraft(null);
        onChanged();
      },
      onError: (error) => toast(error.message, "danger"),
    }),
  );
  const submit = () => {
    if (!dirty || !valid || save.isPending) return;
    save.mutate({ percent: parsed });
  };
  const { hint } = reserve;
  const hintValues = {
    peak: f.n(hint.txPeak7d),
    suggested: f.pct0(hint.suggested / 100),
  };

  return (
    <div className="ms-card" style={{ padding: 20 }}>
      <div style={{ marginBottom: 16 }}>
        <h3 style={cardTitle}>{t("title")}</h3>
        <p style={cardSub}>{t("help")}</p>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="ms-field" style={{ maxWidth: 260 }}>
          <label htmlFor="reserve-percent">{t("label")}</label>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input
              id="reserve-percent"
              type="number"
              min={reserve.min}
              max={reserve.max}
              step={1}
              className="ms-input mono"
              style={{ width: 90 }}
              value={value}
              disabled={save.isPending}
              onChange={(event) => setDraft(event.target.value)}
            />
            <span style={{ fontSize: 13, color: "var(--ms-muted)", whiteSpace: "nowrap" }}>
              {t("unit", { min: reserve.min, max: reserve.max })}
            </span>
          </div>
        </div>
        <p style={hintStyle}>
          {hint.usableReserveNow
            ? t("hint", { ...hintValues, share: f.pct0(hint.txPeak7d / hint.usableReserveNow) })
            : t("hintNoQuota", hintValues)}
        </p>
        <dl className="ms-kv" style={{ marginTop: 14 }}>
          {list.served.map((r) => (
            <KvRow key={r.region} label={r.region}>
              {r.share !== null && r.usableReserve !== null
                ? t("regionRow", { share: f.n(r.share), usable: f.n(r.usableReserve) })
                : r.account
                  ? t("regionUnlimited")
                  : t("regionUnreachable")}
            </KvRow>
          ))}
        </dl>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "flex-end",
            gap: 10,
            marginTop: 18,
          }}
        >
          <button
            type="button"
            className="ms-btn ms-btn-secondary"
            disabled={!dirty || save.isPending}
            onClick={() => setDraft(null)}
          >
            {common("cancel")}
          </button>
          <button
            type="submit"
            className="ms-btn ms-btn-primary"
            disabled={!dirty || !valid || save.isPending}
          >
            <BtnSpinner on={save.isPending} />
            {t("save")}
          </button>
        </div>
      </form>
    </div>
  );
}
