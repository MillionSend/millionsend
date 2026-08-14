"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { BtnSpinner } from "@/components/spinner";
import { StatusBadge } from "@/components/status-badge";
import { jsSingleQuote, shellSingleQuote } from "@/lib/escape";
import { formatUtcMinute, maskApiKey } from "@/lib/format";
import { statusGlow } from "@/lib/status-glow";
import { useTRPC } from "@/lib/trpc";

/** Syntax-colored snippet token: k keyword, s string, w call, f comment. */
type Seg = { text: string; color?: "k" | "s" | "w" | "f" };

const SEG_COLORS = {
  k: "var(--ms-muted)",
  s: "var(--ms-info)",
  w: "var(--ms-warn)",
  f: "var(--ms-faint)",
} as const;

type SnippetParams = {
  apiUrl: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  apiKey: string;
  comment?: string;
};

function nodeSegs(p: SnippetParams): Seg[] {
  return [
    { text: "const", color: "k" },
    { text: " res = " },
    { text: "await", color: "k" },
    { text: " " },
    { text: "fetch", color: "w" },
    { text: "(" },
    { text: jsSingleQuote(`${p.apiUrl}/emails`), color: "s" },
    { text: ", {\n  method: " },
    { text: "'POST'", color: "s" },
    { text: ",\n  headers: {\n    Authorization: " },
    { text: jsSingleQuote(`Bearer ${p.apiKey}`), color: "s" },
    { text: "," },
    ...(p.comment ? [{ text: `  // ${p.comment}`, color: "f" as const }] : []),
    { text: "\n    " },
    { text: "'Content-Type'", color: "s" },
    { text: ": " },
    { text: "'application/json'", color: "s" },
    { text: "\n  },\n  body: JSON." },
    { text: "stringify", color: "w" },
    { text: "({\n    from: " },
    { text: jsSingleQuote(p.from), color: "s" },
    { text: ",\n    to: " },
    { text: jsSingleQuote(p.to), color: "s" },
    { text: ",\n    subject: " },
    { text: jsSingleQuote(p.subject), color: "s" },
    { text: ",\n    html: " },
    { text: jsSingleQuote(p.html), color: "s" },
    { text: "\n  })\n});" },
  ];
}

function curlSegs(p: SnippetParams): Seg[] {
  const body = JSON.stringify({ from: p.from, to: p.to, subject: p.subject, html: p.html });
  return [
    // The comment lives on its own line so any selection of the command
    // itself is valid shell — an inline comment after a trailing "\" breaks
    // the continuation when copied.
    ...(p.comment ? [{ text: `# ${p.comment}\n`, color: "f" as const }] : []),
    { text: "curl", color: "w" },
    { text: ` -X POST ${p.apiUrl}/emails \\\n  -H ` },
    { text: shellSingleQuote(`Authorization: Bearer ${p.apiKey}`), color: "s" },
    { text: " \\\n  -H " },
    { text: "'Content-Type: application/json'", color: "s" },
    { text: " \\\n  -d " },
    { text: shellSingleQuote(body), color: "s" },
  ];
}

function segsText(segs: Seg[]): string {
  return segs.map((s) => s.text).join("");
}

function SnippetPre({ segs }: { segs: Seg[] }) {
  return (
    <pre
      className="ms-mono"
      style={{
        margin: 0,
        padding: "14px 16px",
        fontSize: 13,
        lineHeight: 1.7,
        color: "var(--ms-bone)",
        overflowX: "auto",
      }}
    >
      {segs.map((seg, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: static token list, position is identity
          key={i}
          style={seg.color ? { color: SEG_COLORS[seg.color] } : undefined}
        >
          {seg.text}
        </span>
      ))}
    </pre>
  );
}

/** ⧉→✓ copy button (header variant of the .ms-chip affordance). */
function CopyGlyphButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1600);
      }}
      style={{
        background: "none",
        border: 0,
        cursor: "pointer",
        fontSize: 12,
        color: "var(--ms-muted)",
        padding: "0 6px",
      }}
    >
      {copied ? "✓" : "⧉"}
    </button>
  );
}

/** The canvas's one theatrical moment: 74×100 digit boxes, last digit rolls in steel. */
function OdometerBoxes({ value }: { value: number }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // ponytail: 7 fixed boxes cap the display at 9,999,999; fine for a first-send flow.
  const digits = String(Math.min(value, 9_999_999)).padStart(7, "0").split("").map(Number);
  return (
    <div className="ms-odometer" style={{ gap: 8 }}>
      {digits.map((digit, i) => {
        const last = i === digits.length - 1;
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed 7 odometer positions, position is identity
            key={i}
            style={{
              width: 74,
              height: 100,
              background: "var(--ms-panel)",
              border: `1px solid var(${last ? "--ms-line-strong" : "--ms-line"})`,
              borderRadius: 12,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
            }}
          >
            <span className="ms-odo-col" style={{ fontSize: 60 }}>
              <span
                className="ms-odo-strip ms-digits"
                style={{
                  transform: mounted ? `translateY(-${digit}em)` : "translateY(0)",
                  color: last && digit > 0 ? "var(--ms-steel)" : "var(--ms-muted)",
                }}
              >
                {Array.from({ length: digit + 1 }, (_, n) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the strip is the ordered digits 0..d — the index IS the digit
                  <span key={n}>{n}</span>
                ))}
              </span>
            </span>
          </span>
        );
      })}
    </div>
  );
}

/** Statuses that can still progress to delivered (see emailStatusEnum). */
const IN_FLIGHT_STATUSES = new Set(["queued_quota", "queued", "sent", "delivery_delayed"]);

const stepCard: React.CSSProperties = {
  flex: 1,
  background: "var(--ms-panel)",
  border: "1px solid var(--ms-line-strong)",
  borderRadius: 14,
  padding: 22,
  marginBottom: 20,
};

const bankedCard: React.CSSProperties = {
  flex: 1,
  backgroundColor: "var(--ms-ground)",
  backgroundImage: statusGlow("success", 15),
  border: "1px solid var(--ms-success-border)",
  borderRadius: 14,
  padding: "16px 22px",
  marginBottom: 20,
};

/** Left rail of a stepper row: marker (✓ or number) above the connector line. */
function StepRail({
  marker,
  color,
  line = true,
}: {
  marker: string;
  color: string;
  line?: boolean;
}) {
  return (
    <div
      style={{
        width: 30,
        flex: "none",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      <span className="ms-mono" style={{ fontSize: 11, color }}>
        {marker}
      </span>
      {line ? (
        <span style={{ flex: 1, width: 1, background: "var(--ms-line)", marginTop: 6 }} />
      ) : null}
    </div>
  );
}

export function OnboardingSteps({
  userEmail,
  accountCreatedAt,
  apiUrl,
}: {
  userEmail: string;
  accountCreatedAt: string;
  apiUrl: string;
}) {
  const t = useTranslations("onboarding");
  const common = useTranslations("common");
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<"node" | "curl">("node");
  const [token, setToken] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  const keysQuery = useQuery(trpc.apiKeys.list.queryOptions());
  const keys = keysQuery.data ?? [];
  // Oldest key = the one this flow banked (list is newest-first).
  const bankedKey = keys[keys.length - 1];
  const hasKey = keys.length > 0;

  const domainsQuery = useQuery(trpc.domains.list.queryOptions());
  const verifiedDomain = domainsQuery.data?.find((d) => d.status === "verified")?.name;

  // Oldest-first so the team's true first email is found even past 50 sends.
  const emailsQuery = useQuery({
    ...trpc.emails.list.queryOptions({ limit: 1, order: "asc" }),
    enabled: hasKey,
    refetchInterval: (query) => (query.state.data?.items.length ? false : 5000),
  });
  const firstEmail = emailsQuery.data?.items[0];

  const metricsQuery = useQuery({
    ...trpc.metrics.window.queryOptions({}),
    enabled: firstEmail !== undefined,
    // Keep counting until the first delivery lands.
    refetchInterval: (query) => ((query.state.data?.allTimeDelivered ?? 0) > 0 ? false : 5000),
  });
  const deliveredCount = metricsQuery.data?.allTimeDelivered ?? 0;

  const detailQuery = useQuery({
    ...trpc.emails.get.queryOptions({ id: firstEmail?.id ?? "" }),
    enabled: firstEmail !== undefined,
    // Poll while the first email is still in flight so its status stays honest.
    refetchInterval: (query) => {
      const status = query.state.data?.latestStatus;
      return status === undefined || IN_FLIGHT_STATUSES.has(status) ? 5000 : false;
    },
  });
  const detail = detailQuery.data;
  const deliveredEvent = detail?.events.find((e) => e.type === "delivered");
  const deliveredSeconds =
    detail && deliveredEvent
      ? (
          (new Date(deliveredEvent.occurredAt).getTime() - new Date(detail.createdAt).getTime()) /
          1000
        ).toFixed(1)
      : null;

  const createKey = useMutation(
    trpc.apiKeys.create.mutationOptions({
      onSuccess: (data) => {
        setToken(data.token);
        queryClient.invalidateQueries({ queryKey: trpc.apiKeys.list.queryKey() });
      },
    }),
  );

  const maskedKey = token
    ? maskApiKey(token, token.slice(-4))
    : bankedKey
      ? maskApiKey(bankedKey.tokenPrefix, bankedKey.last4)
      : "ms_live_…";

  const snippetBase = {
    apiUrl,
    from: verifiedDomain ? `onboarding@${verifiedDomain}` : t("step2.fromPlaceholder"),
    to: userEmail,
    subject: t("step2.subject"),
    html: t("step2.html"),
  };
  // Honest key handling: only while the real token is in memory may the
  // snippet promise (and deliver) the real key on copy. Otherwise both the
  // display and the copy carry the mask plus a replace-it instruction.
  const comment = token
    ? t("step2.keyComment")
    : hasKey
      ? t("step2.keyCommentReplace")
      : t("step2.keyCommentLocked");
  const displayParams: SnippetParams = { ...snippetBase, apiKey: maskedKey, comment };
  const copyParams: SnippetParams = token ? { ...snippetBase, apiKey: token } : displayParams;
  const displaySegs = tab === "node" ? nodeSegs(displayParams) : curlSegs(displayParams);
  const copyText = segsText(tab === "node" ? nodeSegs(copyParams) : curlSegs(copyParams));

  if (keysQuery.isPending) return null;

  const success = firstEmail !== undefined;
  const toDisplay = firstEmail?.to.join(", ") ?? userEmail;
  // detail is polled while in flight, so it is the fresher status source.
  const firstStatus = detail?.latestStatus ?? firstEmail?.latestStatus;

  const snippetBox = (
    <div
      style={{
        background: "var(--ms-inset)",
        border: "1px solid var(--ms-line)",
        borderRadius: 10,
        overflow: "hidden",
        marginTop: 14,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          padding: "7px 8px",
          borderBottom: "1px solid var(--ms-line)",
          flexWrap: "wrap",
        }}
      >
        {(["node", "curl"] as const).map((lang) => (
          <button
            key={lang}
            type="button"
            onClick={() => setTab(lang)}
            style={{
              border: 0,
              cursor: "pointer",
              fontSize: 12,
              padding: "3px 9px",
              borderRadius: 8,
              background: tab === lang ? "var(--ms-panel-raised)" : "none",
              color: tab === lang ? "var(--ms-bone)" : "var(--ms-muted)",
            }}
          >
            {lang === "node" ? "Node.js" : "cURL"}
          </button>
        ))}
        <span style={{ marginLeft: "auto" }}>
          <CopyGlyphButton text={copyText} label={common("copy")} />
        </span>
      </div>
      <SnippetPre segs={displaySegs} />
    </div>
  );

  return (
    <div style={{ overflow: "hidden" }}>
      <h1
        className="ms-display"
        style={{ fontSize: "var(--ms-fs-h1)", margin: 0, fontWeight: 500 }}
      >
        {t("title")}
      </h1>

      {success ? (
        <>
          <div
            style={{
              maxWidth: 860,
              marginTop: 24,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                padding: "8px 2px",
                borderBottom: "1px solid var(--ms-line)",
              }}
            >
              <span style={{ fontSize: 13.5, color: "var(--ms-muted)" }}>
                <span style={{ color: "var(--ms-success)" }}>✓</span>
                {"  "}
                {t("success.keyAdded")}
              </span>
              {bankedKey ? (
                <span className="ms-mono" style={{ fontSize: 11, color: "var(--ms-faint)" }}>
                  {formatUtcMinute(bankedKey.createdAt)}
                </span>
              ) : null}
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                padding: "8px 2px",
                borderBottom: "1px solid var(--ms-line)",
              }}
            >
              {deliveredSeconds ? (
                <span style={{ fontSize: 13.5, color: "var(--ms-muted)" }}>
                  <span style={{ color: "var(--ms-success)" }}>✓</span>
                  {"  "}
                  {t("success.emailDelivered", { to: toDisplay, seconds: deliveredSeconds })}
                </span>
              ) : (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 13.5,
                    color: "var(--ms-muted)",
                  }}
                >
                  {firstStatus ? <StatusBadge status={firstStatus} /> : null}
                  {t("success.emailPending", { to: toDisplay })}
                </span>
              )}
              {firstEmail ? (
                <span className="ms-mono" style={{ fontSize: 11, color: "var(--ms-faint)" }}>
                  {formatUtcMinute(firstEmail.createdAt)}
                </span>
              ) : null}
            </div>
          </div>

          <div style={{ maxWidth: 860, textAlign: "center", marginTop: 64 }}>
            <OdometerBoxes value={deliveredCount} />
            <div style={{ fontSize: 15, color: "var(--ms-bone)", marginTop: 22 }}>
              {t("success.counting", { count: deliveredCount })}
            </div>
            {deliveredSeconds ? (
              <div
                className="ms-mono"
                style={{ fontSize: 12, color: "var(--ms-muted)", marginTop: 8 }}
              >
                {t("success.deliveredIn", { seconds: deliveredSeconds })}
              </div>
            ) : null}
            {detail ? (
              <div
                className="ms-mono"
                style={{ fontSize: 12, color: "var(--ms-muted)", marginTop: 3 }}
              >
                {detail.from} → {toDisplay}
              </div>
            ) : null}
          </div>

          <div style={{ maxWidth: 860, marginTop: 56 }}>
            <div className="ms-microlabel" style={{ marginBottom: 10 }}>
              {t("explore.label")}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
              {(
                [
                  { key: "domains", href: "/domains" },
                  { key: "webhooks", href: "/webhooks" },
                  { key: "team", href: "/settings" },
                ] as const
              ).map((card) => (
                <Link
                  key={card.key}
                  href={card.href}
                  style={{
                    textDecoration: "none",
                    background: "var(--ms-panel)",
                    border: "1px solid var(--ms-line)",
                    borderRadius: 14,
                    padding: 18,
                  }}
                >
                  <div style={{ fontSize: 14.5, fontWeight: 600, color: "var(--ms-bone)" }}>
                    {t(`explore.${card.key}.title`)}
                  </div>
                  <div
                    style={{
                      fontSize: 12.5,
                      color: "var(--ms-muted)",
                      marginTop: 4,
                      lineHeight: 1.5,
                    }}
                  >
                    {t(`explore.${card.key}.body`)}
                  </div>
                  <div style={{ fontSize: 13, color: "var(--ms-muted)", marginTop: 10 }}>
                    {t(`explore.${card.key}.link`)}
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 14, color: "var(--ms-muted)", marginTop: 6 }}>
            {t("subtitle")}
          </div>
          <div style={{ marginTop: 32, maxWidth: 860, display: "flex", flexDirection: "column" }}>
            {/* Account created — banked at render */}
            <div style={{ display: "flex", gap: 18 }}>
              <StepRail marker="✓" color="var(--ms-success)" />
              <div
                style={{
                  paddingBottom: 20,
                  flex: 1,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                }}
              >
                <span style={{ fontSize: 14, color: "var(--ms-muted)" }}>
                  {t("accountCreated")}
                </span>
                <span className="ms-mono" style={{ fontSize: 11, color: "var(--ms-faint)" }}>
                  {formatUtcMinute(accountCreatedAt)}
                </span>
              </div>
            </div>

            {/* Step 01 — add an API key */}
            <div style={{ display: "flex", gap: 18 }}>
              <StepRail
                marker={hasKey ? "✓" : "01"}
                color={hasKey ? "var(--ms-success)" : "var(--ms-bone)"}
              />
              {hasKey && bankedKey ? (
                <div style={bankedCard}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span style={{ fontSize: 15, fontWeight: 600, color: "var(--ms-success)" }}>
                      {t("step1.done")}
                    </span>
                    <span className="ms-mono" style={{ fontSize: 11, color: "var(--ms-muted)" }}>
                      {formatUtcMinute(bankedKey.createdAt)}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
                    <span
                      className="ms-chip"
                      style={{ background: "color-mix(in srgb, var(--ms-void) 30%, transparent)" }}
                    >
                      {token && revealed ? token : maskedKey}
                      {token ? (
                        <>
                          <button
                            type="button"
                            style={{ width: "auto" }}
                            onClick={() => setRevealed((v) => !v)}
                          >
                            {revealed ? t("step1.hide") : t("step1.show")}
                          </button>
                          <button
                            type="button"
                            aria-label={common("copy")}
                            onClick={() => navigator.clipboard.writeText(token)}
                          >
                            ⧉
                          </button>
                        </>
                      ) : null}
                    </span>
                    <span style={{ fontSize: 12, color: "var(--ms-muted)" }}>
                      {t("step1.doneMeta")}
                    </span>
                  </div>
                </div>
              ) : (
                <div style={stepCard}>
                  <div style={{ fontSize: 16, fontWeight: 600 }}>{t("step1.title")}</div>
                  <div style={{ fontSize: 13.5, color: "var(--ms-muted)", marginTop: 4 }}>
                    {t("step1.body")}
                  </div>
                  {createKey.isError ? (
                    <div style={{ fontSize: 13, color: "var(--ms-danger)", marginTop: 10 }}>
                      {t("step1.error")}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className="ms-btn ms-btn-primary"
                    style={{ marginTop: 16 }}
                    disabled={createKey.isPending}
                    onClick={() => createKey.mutate({ name: t("step1.keyName"), mode: "live" })}
                  >
                    <BtnSpinner on={createKey.isPending} />
                    {t("step1.cta")}
                  </button>
                </div>
              )}
            </div>

            {/* Step 02 — send an email */}
            <div style={{ display: "flex", gap: 18 }}>
              <StepRail marker="02" color={hasKey ? "var(--ms-bone)" : "var(--ms-faint)"} />
              <div
                style={{
                  ...stepCard,
                  ...(hasKey ? {} : { border: "1px solid var(--ms-line)", opacity: 0.5 }),
                }}
              >
                <div style={{ fontSize: 16, fontWeight: 600 }}>{t("step2.title")}</div>
                <div style={{ fontSize: 13.5, color: "var(--ms-muted)", marginTop: 4 }}>
                  {hasKey ? t("step2.bodyReady") : t("step2.bodyLocked")}
                </div>
                {snippetBox}
              </div>
            </div>

            {/* Step 03 — watch it arrive */}
            <div style={{ display: "flex", gap: 18 }}>
              <StepRail marker="03" color="var(--ms-faint)" line={false} />
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <span
                  style={{ fontSize: 14, color: hasKey ? "var(--ms-muted)" : "var(--ms-faint)" }}
                >
                  {t("step3.title")}
                </span>
                {hasKey ? (
                  <span className="ms-mono" style={{ fontSize: 12, color: "var(--ms-muted)" }}>
                    {t("step3.waiting")}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
