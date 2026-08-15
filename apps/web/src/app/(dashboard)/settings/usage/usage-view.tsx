"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { Skeleton } from "@/components/skeleton";
import { Table } from "@/components/table";
import { useTRPC } from "@/lib/trpc";
import { meterClass } from "@/lib/usage-meter";

/** Mirrors the loaded cards (KPI + meter, daily table with real headers). */
function UsageSkeleton() {
  const t = useTranslations("settings.usage");
  return (
    <div style={{ display: "grid", gap: 20 }}>
      <section className="ms-card" style={{ padding: 24 }}>
        <div className="ms-microlabel">{t("acceptedToday")}</div>
        <div
          className="ms-digits"
          style={{ fontSize: "var(--ms-fs-kpi)", marginTop: 6, display: "flex" }}
        >
          <Skeleton width={90} height="1lh" />
        </div>
        <div style={{ marginTop: 18 }}>
          <div className="ms-meter-label">
            <span style={{ display: "flex" }}>
              <Skeleton width={60} height="1lh" />
            </span>
            <span style={{ display: "flex" }}>
              <Skeleton width={90} height="1lh" />
            </span>
          </div>
          <div className="ms-meter-track" />
        </div>
      </section>

      <section className="ms-card" style={{ padding: 24 }}>
        <Table>
          <thead>
            <tr>
              <th>{t("day")}</th>
              <th className="right">{t("accepted")}</th>
              <th className="right">{t("delivered")}</th>
              <th className="right">{t("bounced")}</th>
              <th className="right">{t("complained")}</th>
            </tr>
          </thead>
          <tbody>
            {[0, 1, 2].map((row) => (
              <tr key={row}>
                <td className="ms-mono">
                  <Skeleton width={80} height={13} />
                </td>
                {[0, 1, 2, 3].map((cell) => (
                  <td key={cell} className="right ms-mono">
                    <Skeleton width={24} height={13} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>
      </section>
    </div>
  );
}

export function UsageView() {
  const t = useTranslations("settings.usage");
  const locale = useLocale();
  const trpc = useTRPC();
  const { data } = useQuery(trpc.settings.usage.recent.queryOptions({}));
  if (!data) return <UsageSkeleton />;

  const { accepted, limit } = data.today;
  const fmt = new Intl.NumberFormat(locale);
  const ratio = limit === null || limit === 0 ? 0 : accepted / limit;

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <section className="ms-card" style={{ padding: 24 }}>
        <div className="ms-microlabel">{t("acceptedToday")}</div>
        <div
          className="ms-digits"
          style={{ fontSize: "var(--ms-fs-kpi)", color: "var(--ms-bone)", marginTop: 6 }}
        >
          {fmt.format(accepted)}
        </div>
        {limit === null ? (
          <p
            style={{ margin: "14px 0 0", color: "var(--ms-muted)", fontSize: "var(--ms-fs-label)" }}
          >
            {t("noLimit")}
          </p>
        ) : (
          <div className={meterClass(ratio)} style={{ marginTop: 18 }}>
            <div className="ms-meter-label">
              <span>{t("dailyLimit")}</span>
              <span className="ms-digits">
                {fmt.format(accepted)} / {fmt.format(limit)}
              </span>
            </div>
            <div className="ms-meter-track">
              <div className="ms-meter-fill" style={{ width: `${Math.min(100, ratio * 100)}%` }} />
            </div>
          </div>
        )}
      </section>

      <section className="ms-card" style={{ padding: 24 }}>
        {data.rows.length === 0 ? (
          <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-label)" }}>
            {t("empty")}
          </p>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>{t("day")}</th>
                <th className="right">{t("accepted")}</th>
                <th className="right">{t("delivered")}</th>
                <th className="right">{t("bounced")}</th>
                <th className="right">{t("complained")}</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.day}>
                  {/* Raw UTC day key — locale date formatting would shift the
                      day in negative-offset timezones. */}
                  <td className="ms-mono">{row.day}</td>
                  <td className="right ms-mono">{row.accepted}</td>
                  <td className="right ms-mono">{row.delivered}</td>
                  <td className="right ms-mono">{row.bounced}</td>
                  <td className="right ms-mono">{row.complained}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </div>
  );
}
