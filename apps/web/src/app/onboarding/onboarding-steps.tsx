"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { LANG_META, LangIcon } from "@/components/api-sheet";
import { CodeHighlight } from "@/components/code-highlight";
import { CopyGlyph } from "@/components/copy-chip";
import { DeliveredOdometer } from "@/components/delivered-odometer";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { StatusBadge } from "@/components/status-badge";
import { useTurnstile } from "@/components/turnstile";
import { MIGRATE_DOCS_URL } from "@/lib/docs-links";
import { formatDayTime, formatUtcTimestamp, maskApiKey } from "@/lib/format";
import { statusGlow } from "@/lib/status-glow";
import { useTRPC } from "@/lib/trpc";
import {
  onboardingSnippet,
  SNIPPET_HLJS,
  SNIPPET_LABELS,
  SNIPPET_LANGS,
  type SnippetLang,
  type SnippetParams,
} from "./snippets";

/** Statuses that can still progress to delivered (see emailStatusEnum). */
const IN_FLIGHT_STATUSES = new Set(["queued_quota", "queued", "sent", "delivery_delayed"]);

const EXPLORE = [
  { key: "domains", href: "/domains", recommended: true },
  { key: "mcp", href: "/settings/mcp" },
  { key: "webhooks", href: "/webhooks" },
  { key: "team", href: "/settings" },
  { key: "migrate", href: MIGRATE_DOCS_URL, external: true },
] as const;

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
      className="ms-stepper-rail"
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

/** A stepper card: title with a ✓ once done, one-line body, then the step's content. */
function StepCard({
  title,
  body,
  done = false,
  locked = false,
  children,
}: {
  title: string;
  body: string;
  done?: boolean;
  locked?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <section
      className="ms-card"
      style={{
        flex: 1,
        padding: 22,
        marginBottom: 20,
        ...(done ? { backgroundImage: statusGlow("success", 12) } : {}),
        ...(locked ? { opacity: 0.5 } : {}),
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "var(--ms-bone)" }}>
          {title}
        </h2>
        {done ? (
          <span aria-hidden="true" style={{ color: "var(--ms-success)", fontSize: 14 }}>
            ✓
          </span>
        ) : null}
      </div>
      <p style={{ margin: "4px 0 0", fontSize: 13.5, color: "var(--ms-muted)" }}>{body}</p>
      {children}
    </section>
  );
}

/** Hairline row: a ✓ or status badge, the sentence, and its time at the right. */
function StampRow({ children, at }: { children: React.ReactNode; at?: Date | string | undefined }) {
  const locale = useLocale();
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: 12,
        padding: "8px 2px",
        borderBottom: "1px solid var(--ms-line)",
        fontSize: 13.5,
        color: "var(--ms-muted)",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>{children}</span>
      {at ? (
        <span style={{ fontSize: 11, color: "var(--ms-faint)" }} title={formatUtcTimestamp(at)}>
          {formatDayTime(at, locale)}
        </span>
      ) : null}
    </div>
  );
}

export function OnboardingSteps({
  userEmail,
  apiUrl,
  showInstanceHint,
  turnstileSiteKey,
}: {
  userEmail: string;
  apiUrl: string;
  /** Instance settings exist only on self-host; cloud hides the pointer. */
  showInstanceHint: boolean;
  /** Set when the instance verifies a Turnstile token on the send. */
  turnstileSiteKey: string | null;
}) {
  const t = useTranslations("onboarding");
  const locale = useLocale();
  const mailLocale = locale === "pt-BR" ? "pt-BR" : "en";
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [lang, setLang] = useState<SnippetLang>("node");
  const turnstile = useTurnstile(turnstileSiteKey);
  const [captchaFailed, setCaptchaFailed] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  // Self-host: sending needs SES connected, so the stepper leads with that
  // when credentials are absent. Polls until connected (the SES settings
  // page is a different tab away); cloud always passes.
  const awsQuery = useQuery({
    ...trpc.system.awsReadiness.queryOptions(),
    enabled: showInstanceHint,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => (query.state.data?.credentialsConfigured ? false : 8000),
  });
  const sesReady = !showInstanceHint || awsQuery.data?.credentialsConfigured === true;
  // Extra leading step shifts the numbering below it.
  const marker = (step: number) => String(step + (sesReady ? 0 : 1)).padStart(2, "0");

  const features = useQuery(trpc.system.features.queryOptions());
  const sender = features.data?.onboardingSender ?? null;

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
  const emailCount = emailsQuery.data?.total ?? 0;

  // Keeps ticking while the page is open: the odometer rolls on every delivery.
  const metricsQuery = useQuery({
    ...trpc.metrics.window.queryOptions({}),
    enabled: firstEmail !== undefined,
    refetchInterval: 5000,
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
  const sendFirst = useMutation(
    trpc.onboarding.sendFirstEmail.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.emails.pathKey() }),
    }),
  );

  const maskedKey = token
    ? maskApiKey(token, token.slice(-4))
    : bankedKey
      ? maskApiKey(bankedKey.tokenPrefix, bankedKey.last4)
      : "ms_…";

  const snippetBase = {
    apiUrl,
    // The shared sender runs as written; otherwise the team's own domain.
    from: sender ?? (verifiedDomain ? `onboarding@${verifiedDomain}` : t("step2.fromPlaceholder")),
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
  const displayCode = onboardingSnippet(lang, displayParams);
  const copyCode = onboardingSnippet(lang, copyParams);

  // Everything the layout hinges on loads before anything paints, so a team
  // past its first email never flashes the stepper it already finished.
  const loading =
    keysQuery.isPending ||
    features.isPending ||
    (showInstanceHint && awsQuery.isPending) ||
    (hasKey && emailsQuery.isPending);

  const success = firstEmail !== undefined;
  const toDisplay = firstEmail?.to.join(", ") ?? userEmail;
  // detail is polled while in flight, so it is the fresher status source.
  const firstStatus = detail?.latestStatus ?? firstEmail?.latestStatus;

  const explore = (
    <div style={{ marginTop: 56 }}>
      <div className="ms-microlabel" style={{ marginBottom: 10 }}>
        {t("explore.label")}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 14,
        }}
      >
        {EXPLORE.map((card) => (
          <div
            key={card.key}
            className="ms-card"
            style={{ display: "flex", flexDirection: "column" }}
          >
            <div style={{ padding: 18, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 14.5, fontWeight: 600, color: "var(--ms-bone)" }}>
                  {t(`explore.${card.key}.title`)}
                </span>
                {"recommended" in card ? (
                  <span className="ms-badge ms-badge-success">{t("explore.recommended")}</span>
                ) : null}
              </div>
              <p
                style={{
                  fontSize: 12.5,
                  color: "var(--ms-muted)",
                  margin: "4px 0 0",
                  lineHeight: 1.5,
                }}
              >
                {t(`explore.${card.key}.body`)}
              </p>
            </div>
            <div style={{ borderTop: "1px solid var(--ms-line)", padding: "12px 18px" }}>
              <Link
                href={card.href}
                className="ms-btn ms-btn-secondary"
                {...("external" in card ? { target: "_blank", rel: "noreferrer" } : {})}
              >
                {t(`explore.${card.key}.cta`)}
                {"external" in card ? " ↗" : ""}
              </Link>
            </div>
          </div>
        ))}
      </div>
      {showInstanceHint ? (
        <p style={{ fontSize: 12.5, color: "var(--ms-muted)", margin: "14px 0 0" }}>
          {t.rich("explore.instance", {
            link: (chunks) => (
              <Link href="/settings" style={{ color: "var(--ms-bone)" }}>
                {chunks}
              </Link>
            ),
          })}
        </p>
      ) : null}
    </div>
  );

  if (loading) {
    return (
      <div>
        <h1 className="ms-display" style={{ fontSize: "var(--ms-fs-h1)", margin: 0 }}>
          {t("title")}
        </h1>
        <div style={{ marginTop: 32, display: "grid", gap: 20 }}>
          <Skeleton width="100%" height={132} radius="var(--ms-r-card)" />
          <Skeleton width="100%" height={320} radius="var(--ms-r-card)" />
        </div>
      </div>
    );
  }

  const keyField = (
    <div
      style={{
        marginTop: 14,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
        background: "var(--ms-inset)",
        border: "1px solid var(--ms-line-strong)",
        borderRadius: 10,
      }}
    >
      <span
        className="ms-mono"
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 13,
          color: "var(--ms-bone)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {token && revealed ? token : maskedKey}
      </span>
      {token ? (
        <>
          <button
            type="button"
            className="ms-btn ms-btn-ghost"
            style={{ height: "auto", padding: "2px 6px", fontSize: 12 }}
            onClick={() => setRevealed((v) => !v)}
          >
            {revealed ? t("step1.hide") : t("step1.show")}
          </button>
          <CopyGlyph value={token} />
        </>
      ) : (
        <span style={{ fontSize: 12, color: "var(--ms-muted)", flex: "none" }}>
          {t("step1.doneMeta")}
        </span>
      )}
    </div>
  );

  const codePanel = (
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
        role="tablist"
        aria-label={t("step2.title")}
        className="ms-scroll-x"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "7px 8px",
          borderBottom: "1px solid var(--ms-line)",
          overflowX: "auto",
        }}
      >
        {SNIPPET_LANGS.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={key === lang}
            className={key === lang ? "ms-code-tab active" : "ms-code-tab"}
            onClick={() => setLang(key)}
          >
            {key !== "curl" ? <LangIcon path={LANG_META[key].icon.path} /> : null}
            {SNIPPET_LABELS[key]}
          </button>
        ))}
        <span style={{ marginLeft: "auto", padding: "0 4px", flex: "none" }}>
          <CopyGlyph value={copyCode} />
        </span>
      </div>
      <pre
        className="ms-mono ms-hl"
        style={{
          margin: 0,
          padding: "14px 16px",
          fontSize: 13,
          lineHeight: 1.7,
          color: "var(--ms-bone)",
          overflowX: "auto",
        }}
      >
        <CodeHighlight code={displayCode} language={SNIPPET_HLJS[lang]} />
      </pre>
      {sender && hasKey ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 14px",
            borderTop: "1px solid var(--ms-line)",
          }}
        >
          <button
            type="button"
            className="ms-btn ms-btn-primary"
            disabled={verifying || sendFirst.isPending}
            onClick={async () => {
              setCaptchaFailed(false);
              setVerifying(true);
              try {
                const token = await turnstile.getToken();
                sendFirst.mutate({ locale: mailLocale, ...(token ? { captchaToken: token } : {}) });
              } catch {
                setCaptchaFailed(true);
              } finally {
                setVerifying(false);
              }
            }}
          >
            <BtnSpinner on={verifying || sendFirst.isPending} />
            {verifying || sendFirst.isPending ? t("step2.sending") : t("step2.sendCta")}
          </button>
          {turnstile.slot}
          {sendFirst.isSuccess ? (
            <span style={{ fontSize: 13, color: "var(--ms-muted)" }}>
              {t("step2.sentTo", { to: userEmail })}
            </span>
          ) : captchaFailed || sendFirst.error?.data?.code === "FORBIDDEN" ? (
            <span style={{ fontSize: 13, color: "var(--ms-danger)" }}>
              {t("step2.captchaFailed")}
            </span>
          ) : sendFirst.error?.data?.code === "TOO_MANY_REQUESTS" ? (
            <span style={{ fontSize: 13, color: "var(--ms-muted)" }}>{t("step2.sendLimited")}</span>
          ) : sendFirst.isError ? (
            <span style={{ fontSize: 13, color: "var(--ms-danger)" }}>{t("step2.sendError")}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  return (
    <div style={{ overflow: "hidden" }}>
      <h1 className="ms-display" style={{ fontSize: "var(--ms-fs-h1)", margin: 0 }}>
        {t("title")}
      </h1>
      <div style={{ fontSize: 14, color: "var(--ms-muted)", marginTop: 6 }}>{t("subtitle")}</div>

      {success ? (
        <>
          <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 8 }}>
            <StampRow at={bankedKey?.createdAt}>
              <span style={{ color: "var(--ms-success)" }}>✓</span>
              {t("success.keyAdded")}
            </StampRow>
            <StampRow at={firstEmail.createdAt}>
              {deliveredSeconds ? (
                <>
                  <span style={{ color: "var(--ms-success)" }}>✓</span>
                  {t("success.emailDelivered", { to: toDisplay, seconds: deliveredSeconds })}
                </>
              ) : (
                <>
                  {firstStatus ? <StatusBadge status={firstStatus} /> : null}
                  {t("success.emailPending", { to: toDisplay })}
                </>
              )}
            </StampRow>
          </div>

          <div style={{ textAlign: "center", marginTop: 56 }}>
            <DeliveredOdometer value={deliveredCount} locale={locale} />
            <div style={{ fontSize: 15, color: "var(--ms-bone)", marginTop: 18 }}>
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
            {/* The first send's route only reads as a story while it is the only one. */}
            {detail && emailCount <= 1 ? (
              <div
                className="ms-mono"
                style={{ fontSize: 12, color: "var(--ms-muted)", marginTop: 3 }}
              >
                {detail.from} → {toDisplay}
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <div style={{ marginTop: 32, display: "flex", flexDirection: "column" }}>
          {!sesReady ? (
            /* Leading step — connect AWS SES before anything can send */
            <div className="ms-step" style={{ display: "flex", gap: 18 }}>
              <StepRail marker="01" color="var(--ms-bone)" />
              <StepCard title={t("stepSes.title")} body={t("stepSes.body")}>
                <Link
                  href="/settings/ses"
                  className="ms-btn ms-btn-primary"
                  style={{ marginTop: 16 }}
                >
                  {t("stepSes.cta")}
                </Link>
              </StepCard>
            </div>
          ) : null}

          {/* Add an API key */}
          <div className="ms-step" style={{ display: "flex", gap: 18 }}>
            <StepRail
              marker={hasKey ? "✓" : marker(1)}
              color={hasKey ? "var(--ms-success)" : "var(--ms-bone)"}
            />
            <StepCard
              title={t("step1.title")}
              body={hasKey ? t("step1.done") : t("step1.body")}
              done={hasKey}
            >
              {hasKey ? (
                keyField
              ) : (
                <>
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
                    onClick={() => createKey.mutate({ name: t("step1.keyName") })}
                  >
                    <BtnSpinner on={createKey.isPending} />
                    {t("step1.cta")}
                  </button>
                </>
              )}
            </StepCard>
          </div>

          {/* Send an email */}
          <div className="ms-step" style={{ display: "flex", gap: 18 }}>
            <StepRail marker={marker(2)} color={hasKey ? "var(--ms-bone)" : "var(--ms-faint)"} />
            <StepCard
              title={t("step2.title")}
              body={hasKey ? t("step2.bodyReady") : t("step2.bodyLocked")}
              locked={!hasKey}
            >
              {codePanel}
              {showInstanceHint && lang !== "curl" ? (
                <p
                  className="ms-mono"
                  style={{ margin: "10px 0 0", fontSize: 12, color: "var(--ms-muted)" }}
                >
                  {t("step2.selfHostBase", { url: apiUrl })}
                </p>
              ) : null}
            </StepCard>
          </div>

          {/* Watch it arrive */}
          <div className="ms-step" style={{ display: "flex", gap: 18 }}>
            <StepRail marker={marker(3)} color="var(--ms-faint)" line={false} />
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <span style={{ fontSize: 14, color: hasKey ? "var(--ms-muted)" : "var(--ms-faint)" }}>
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
      )}

      {explore}
    </div>
  );
}
