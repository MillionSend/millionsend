"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { CopyButton } from "@/components/copy-chip";
import { Drawer } from "@/components/drawer";
import { Skeleton } from "@/components/skeleton";
import { formatScoreTenths } from "@/lib/score-band";
import { useTRPC } from "@/lib/trpc";

const CONTENT_WEIGHT = 0.4;
const OUTCOME_WEIGHT = 0.6;
/* The outcome ramps, as drawn: where each penalty starts and where it maxes.
   Mirrors outcomePenaltyTenths in @millionsend/core. */
const COMPLAINT_LINES = [
  { rate: 0.001, penaltyTenths: 0 },
  { rate: 0.003, penaltyTenths: 60 },
  { rate: 0.01, penaltyTenths: 100 },
];
const BOUNCE_LINES = [
  { rate: 0.02, penaltyTenths: 0 },
  { rate: 0.05, penaltyTenths: 40 },
  { rate: 0.1, penaltyTenths: 60 },
];

const SEVERITY_DOT: Record<string, string> = {
  critical: "var(--ms-danger)",
  major: "var(--ms-warn)",
  minor: "var(--ms-steel)",
  info: "transparent",
};

function Microlabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="ms-microlabel" style={{ margin: "20px 0 8px" }}>
      {children}
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ margin: "8px 0 0", fontSize: 12.5, color: "var(--ms-muted)", lineHeight: 1.5 }}>
      {children}
    </p>
  );
}

/** A rate against its penalty lines: a track, the lines as ticks, the team's rate as the dot. */
function RateTrack({
  rate,
  lines,
  format,
  formatPenalty,
}: {
  rate: number;
  lines: { rate: number; penaltyTenths: number }[];
  format: (rate: number) => string;
  formatPenalty: (tenths: number) => string;
}) {
  const max = lines[lines.length - 1]?.rate ?? 1;
  const at = (r: number) => `${Math.min(100, (r / max) * 100)}%`;
  const [warnStart, dangerStart] = [lines[0]?.rate ?? 0, lines[1]?.rate ?? max];
  return (
    <div style={{ position: "relative", height: 30, marginTop: 4 }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 10,
          height: 2,
          background: "var(--ms-line-strong)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: at(warnStart),
          width: `calc(${at(dangerStart)} - ${at(warnStart)})`,
          top: 10,
          height: 2,
          background: "color-mix(in srgb, var(--ms-warn) 55%, var(--ms-line-strong))",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: at(dangerStart),
          right: 0,
          top: 10,
          height: 2,
          background: "color-mix(in srgb, var(--ms-danger) 55%, var(--ms-line-strong))",
        }}
      />
      {lines.map((line, index) => (
        <div
          key={line.rate}
          style={{
            position: "absolute",
            left: at(line.rate),
            top: 4,
            width: 1,
            height: 14,
            background: "var(--ms-line-strong)",
          }}
        >
          <span
            className="ms-mono"
            style={{
              position: "absolute",
              top: 16,
              left: 0,
              transform: index === lines.length - 1 ? "translateX(-100%)" : "translateX(-50%)",
              fontSize: 10.5,
              color: "var(--ms-faint)",
              whiteSpace: "nowrap",
            }}
          >
            {format(line.rate)} · {formatPenalty(line.penaltyTenths)}
          </span>
        </div>
      ))}
      <div
        style={{
          position: "absolute",
          left: at(rate),
          top: 6,
          width: 10,
          height: 10,
          borderRadius: "50%",
          transform: "translateX(-50%)",
          background:
            rate >= dangerStart
              ? "var(--ms-danger)"
              : rate >= warnStart
                ? "var(--ms-warn)"
                : "var(--ms-success)",
          border: "2px solid var(--ms-panel)",
          boxShadow: "0 0 0 1px var(--ms-line-strong)",
        }}
      />
    </div>
  );
}

/**
 * The account score opened up, section by section: the blend and its caps,
 * the failing checks weighted by recipients, the outcome rates drawn against
 * their lines, and the single fix that would lift the score most.
 */
export function ScoreDetailsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("metrics.score.details");
  const score = useTranslations("metrics.score");
  const insights = useTranslations("emails.insights");
  const common = useTranslations("common");
  const locale = useLocale();
  const trpc = useTRPC();
  const query = useQuery(
    trpc.metrics.accountScoreDetails.queryOptions(undefined, { enabled: open }),
  );
  const fmt = new Intl.NumberFormat(locale);
  const pct2 = new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const pctLine = new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  const points = (tenths: number) => formatScoreTenths(Math.round(tenths), locale);
  const signed = (tenths: number) => (tenths > 0 ? `−${points(tenths)}` : points(0));
  const data = query.data;

  return (
    <Drawer open={open} onClose={onClose} title={t("title")}>
      {!data ? (
        <div style={{ display: "grid", gap: 12, marginTop: 18 }}>
          <Skeleton width={220} height={14} />
          <Skeleton width={180} height={14} />
          <Skeleton width={260} height={14} />
        </div>
      ) : (
        <>
          <p
            className="ms-mono"
            style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ms-muted)" }}
          >
            {t("window", { days: data.windowDays, sent: fmt.format(data.sent) })}
          </p>

          <Microlabel>{t("composition")}</Microlabel>
          {data.blendTenths !== null &&
          data.contentScoreTenths !== null &&
          data.outcomeScoreTenths !== null ? (
            <div
              className="ms-digits"
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto auto auto",
                gap: "8px 18px",
                alignItems: "baseline",
                fontWeight: 500,
              }}
            >
              <span>{score("content")}</span>
              <span
                className="ms-mono"
                style={{ color: "var(--ms-faint)", fontSize: 12, textAlign: "right" }}
              >
                {points(data.contentScoreTenths)}
              </span>
              <span
                className="ms-mono"
                style={{ color: "var(--ms-muted)", fontSize: 12, textAlign: "right" }}
              >
                × {CONTENT_WEIGHT * 100}%
              </span>
              <span style={{ textAlign: "right", fontWeight: 800 }}>
                {points(data.contentScoreTenths * CONTENT_WEIGHT)}
              </span>
              <span>{score("outcome")}</span>
              <span
                className="ms-mono"
                style={{ color: "var(--ms-faint)", fontSize: 12, textAlign: "right" }}
              >
                {points(data.outcomeScoreTenths)}
              </span>
              <span
                className="ms-mono"
                style={{ color: "var(--ms-muted)", fontSize: 12, textAlign: "right" }}
              >
                × {OUTCOME_WEIGHT * 100}%
              </span>
              <span style={{ textAlign: "right", fontWeight: 800 }}>
                {points(data.outcomeScoreTenths * OUTCOME_WEIGHT)}
              </span>
              <span
                style={{
                  gridColumn: "1 / -1",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  borderTop: "1px solid var(--ms-line)",
                  marginTop: 4,
                  paddingTop: 10,
                }}
              >
                <span>{score("title")}</span>
                <span style={{ fontSize: 20, fontWeight: 800 }}>
                  {data.scoreTenths !== null ? points(data.scoreTenths) : "—"}
                </span>
              </span>
            </div>
          ) : (
            <Note>{data.insufficientOutcomeData ? score("insufficient") : t("contentOnly")}</Note>
          )}
          <div
            style={{
              display: "flex",
              gap: 18,
              flexWrap: "wrap",
              marginTop: 10,
              fontSize: 12.5,
              color: "var(--ms-faint)",
            }}
          >
            {data.governorCapTenths !== null && data.blendTenths !== null ? (
              <span>
                <span style={{ color: "var(--ms-muted)" }}>{t("governor")}</span>{" "}
                {t("governorLine", { value: points(data.governorCapTenths) })} ·{" "}
                {data.blendTenths > data.governorCapTenths ? t("applied") : t("notApplied")}
              </span>
            ) : null}
            <span>
              <span style={{ color: "var(--ms-muted)" }}>{t("guardrail")}</span>{" "}
              {data.guardrailCapTenths !== null
                ? t("guardrailCapped", { value: points(data.guardrailCapTenths) })
                : t("guardrailOk")}
            </span>
          </div>
          <Note>{t("compositionNote")}</Note>

          <Microlabel>{t("contentSection")}</Microlabel>
          {data.factors.length === 0 ? (
            <Note>{t("noFactors")}</Note>
          ) : (
            <div>
              {data.factors.map((factor, index) => (
                <div
                  key={factor.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "10px 1fr auto",
                    gap: 12,
                    alignItems: "center",
                    padding: "9px 0",
                    borderTop: index === 0 ? 0 : "1px solid var(--ms-line)",
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      boxSizing: "border-box",
                      background: SEVERITY_DOT[factor.severity] ?? "var(--ms-muted)",
                      border: factor.severity === "info" ? "1px solid var(--ms-faint)" : 0,
                    }}
                  />
                  <span>
                    <span style={{ color: "var(--ms-bone)" }}>
                      {insights(`check.${factor.id}.title`)}
                    </span>
                    <span
                      className="ms-mono"
                      style={{
                        display: "block",
                        fontSize: 12,
                        color: "var(--ms-muted)",
                        marginTop: 2,
                      }}
                    >
                      {t("factorMeta", {
                        emails: factor.emails,
                        recipients: fmt.format(factor.recipients),
                      })}
                    </span>
                  </span>
                  <span
                    className="ms-digits"
                    style={{
                      color: factor.penaltyTenths > 0 ? "var(--ms-warn)" : "var(--ms-faint)",
                      fontWeight: factor.penaltyTenths > 0 ? 800 : 500,
                      minWidth: 44,
                      textAlign: "right",
                    }}
                  >
                    {signed(factor.penaltyTenths)}
                  </span>
                </div>
              ))}
            </div>
          )}
          <p
            style={{
              margin: 0,
              paddingTop: 10,
              borderTop: "1px solid var(--ms-line)",
              fontSize: 12.5,
              color: "var(--ms-muted)",
            }}
          >
            {t("passing", { count: Math.max(0, data.checksTotal - data.factors.length) })}
          </p>

          <Microlabel>{t("outcomeSection")}</Microlabel>
          {data.insufficientOutcomeData ? (
            <Note>{score("insufficient")}</Note>
          ) : (
            <div style={{ display: "grid", gap: 16 }}>
              {[
                { label: score("complaintRate"), rate: data.complaintRate, lines: COMPLAINT_LINES },
                { label: score("hardBounceRate"), rate: data.hardBounceRate, lines: BOUNCE_LINES },
              ].map((row) => (
                <div key={row.label}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "baseline",
                    }}
                  >
                    <span style={{ color: "var(--ms-bone)" }}>{row.label}</span>
                    <span className="ms-digits">{pct2.format(row.rate)}</span>
                  </div>
                  <RateTrack
                    rate={row.rate}
                    lines={row.lines}
                    format={(rate) => pctLine.format(rate)}
                    formatPenalty={(tenths) => signed(tenths)}
                  />
                </div>
              ))}
              <Note>{t("outcomeNote", { sent: fmt.format(data.sent) })}</Note>
            </div>
          )}

          <Microlabel>{t("lift")}</Microlabel>
          {(() => {
            const best = [...data.factors].sort((a, b) => b.liftTenths - a.liftTenths)[0];
            if (!best || best.liftTenths === 0 || data.scoreTenths === null) {
              return <Note>{t("liftNone")}</Note>;
            }
            return (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  padding: "12px 14px",
                  border: "1px solid var(--ms-line-strong)",
                  borderRadius: 12,
                  background: "var(--ms-panel-raised)",
                }}
              >
                <span
                  className="ms-digits"
                  style={{ fontSize: 20, color: "var(--ms-success)", whiteSpace: "nowrap" }}
                >
                  +{points(best.liftTenths)}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ color: "var(--ms-bone)" }}>
                    {insights(`check.${best.id}.advice`)}
                  </span>
                  <span
                    style={{
                      display: "block",
                      fontSize: 12,
                      color: "var(--ms-muted)",
                      marginTop: 2,
                    }}
                  >
                    {t("liftLine", {
                      title: insights(`check.${best.id}.title`),
                      score: points(data.scoreTenths + best.liftTenths),
                    })}
                  </span>
                </span>
                <CopyButton
                  value={t("agentPrompt", {
                    score: points(data.scoreTenths),
                    title: insights(`check.${best.id}.title`),
                    emails: best.emails,
                    recipients: fmt.format(best.recipients),
                    points: points(best.penaltyTenths),
                    description: insights(`check.${best.id}.description`),
                    advice: insights(`check.${best.id}.advice`),
                  })}
                  label={common("copy")}
                />
              </div>
            );
          })()}
        </>
      )}
    </Drawer>
  );
}
