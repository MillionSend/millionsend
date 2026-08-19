"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { Odometer } from "@/components/odometer";
import { Skeleton } from "@/components/skeleton";
import { Table } from "@/components/table";
import { formatDayUtc } from "@/lib/format";
import { useTRPC } from "@/lib/trpc";

/* Ring geometry — 40px face, 4px stroke, faint full-circle track. */
const RING_SIZE = 40;
const RING_STROKE = 4;
const RING_R = (RING_SIZE - RING_STROKE) / 2;
const RING_C = 2 * Math.PI * RING_R;

/** Utilization tint: healthy under 70%, warn under 100%, danger at/over. */
function ringTint(frac: number): string {
  if (frac >= 1) return "var(--ms-danger)";
  if (frac >= 0.7) return "var(--ms-warn)";
  return "var(--ms-success)";
}

/** Circular quota gauge; no limit (self-host) leaves the track empty. */
function ProgressRing({ used, limit }: { used: number; limit: number | null }) {
  const frac = limit === null || limit === 0 ? null : Math.min(1, used / limit);
  return (
    <svg width={RING_SIZE} height={RING_SIZE} aria-hidden="true" style={{ flex: "none" }}>
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_R}
        fill="none"
        stroke="var(--ms-line)"
        strokeWidth={RING_STROKE}
      />
      {frac !== null && frac > 0 ? (
        // rotate(-90): progress starts at 12 o'clock like every quota dial.
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_R}
          fill="none"
          stroke={ringTint(frac)}
          strokeWidth={RING_STROKE}
          strokeLinecap="round"
          strokeDasharray={`${(frac * RING_C).toFixed(2)} ${RING_C.toFixed(2)}`}
          transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
        />
      ) : null}
    </svg>
  );
}

/** Quota row: ring, label + reset hint, right-aligned "used / limit". */
function QuotaRow({
  label,
  hint,
  used,
  limit,
}: {
  label: string;
  hint: string;
  used: number;
  limit: number | null;
}) {
  const t = useTranslations("settings.usage");
  const locale = useLocale();
  const fmt = new Intl.NumberFormat(locale);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <ProgressRing used={used} limit={limit} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, color: "var(--ms-bone)" }}>{label}</div>
        <div style={{ fontSize: 12.5, color: "var(--ms-muted)", marginTop: 2 }}>{hint}</div>
      </div>
      <div style={{ marginLeft: "auto", textAlign: "right" }}>
        <div className="ms-digits" style={{ fontSize: 18, color: "var(--ms-bone)" }}>
          <Odometer formatted={fmt.format(used)} />
          <span style={{ color: "var(--ms-muted)", fontWeight: 500 }}>
            {" / "}
            {limit === null ? "∞" : fmt.format(limit)}
          </span>
        </div>
        {limit === null ? (
          <div style={{ fontSize: 11, color: "var(--ms-faint)", marginTop: 1 }}>
            {t("unlimited")}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function HistoryHead() {
  const t = useTranslations("settings.usage");
  return (
    <thead>
      <tr>
        <th>{t("day")}</th>
        <th className="right">{t("sent")}</th>
        <th className="right">{t("delivered")}</th>
        <th className="right">{t("bounced")}</th>
        <th className="right">{t("complained")}</th>
      </tr>
    </thead>
  );
}

/** Mirrors the loaded layout (quota row card, dense history table). */
function UsageSkeleton() {
  const t = useTranslations("settings.usage");
  return (
    <div style={{ display: "grid", gap: 20 }}>
      <section className="ms-card" style={{ padding: "20px 24px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <Skeleton width={RING_SIZE} height={RING_SIZE} radius="50%" />
          <div>
            <div style={{ fontSize: 14, display: "flex" }}>
              <Skeleton width={110} height="1lh" />
            </div>
            <div style={{ fontSize: 12.5, marginTop: 2, display: "flex" }}>
              <Skeleton width={150} height="1lh" />
            </div>
          </div>
          <div className="ms-digits" style={{ marginLeft: "auto", fontSize: 18, display: "flex" }}>
            <Skeleton width={90} height="1lh" />
          </div>
        </div>
      </section>

      <section>
        <div className="ms-microlabel" style={{ marginBottom: 12 }}>
          {t("history")}
        </div>
        <Table>
          <HistoryHead />
          <tbody>
            {[0, 1, 2].map((row) => (
              <tr key={row}>
                <td>
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

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <section className="ms-card" style={{ padding: "20px 24px" }}>
        {/* The deployment's one real quota — the instance/plan daily cap.
            Self-host has none, reported honestly as unlimited. */}
        <QuotaRow
          label={t("sentToday")}
          hint={t("resetsMidnightUtc")}
          used={accepted}
          limit={limit}
        />
      </section>

      <section>
        <div className="ms-microlabel" style={{ marginBottom: 12 }}>
          {t("history")}
        </div>
        {data.rows.length === 0 ? (
          <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-label)" }}>
            {t("empty")}
          </p>
        ) : (
          <Table>
            <HistoryHead />
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.day}>
                  {/* formatDayUtc pins the label to the UTC day key — plain
                      locale formatting would shift it in negative offsets. */}
                  <td title={row.day}>{formatDayUtc(row.day, locale)}</td>
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
