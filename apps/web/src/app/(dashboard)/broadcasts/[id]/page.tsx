"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { Breakable } from "@/components/breakable";
import { CopyChip } from "@/components/copy-chip";
import { EmailContentPanel } from "@/components/email-content-panel";
import { EmailsTable } from "@/components/emails-table";
import { bannerLinkStyle, GradientBanner } from "@/components/gradient-banner";
import { HoldIcon, PauseIcon } from "@/components/icons/warmup-icons";
import { LoadError } from "@/components/load-error";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { Skeleton, SkeletonBadge, SkeletonChip } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { StatBlock, StatStrip } from "@/components/stat-block";
import { StepRail } from "@/components/step-rail";
import { mutedDash, Table } from "@/components/table";
import { Tooltip } from "@/components/tooltip";
import { PaceBand, warmupSentSteps, warmupTodayStep } from "@/components/warmup-rail";
import { formatPercent } from "@/lib/console-format";
import {
  formatDayTime,
  formatStepTime,
  formatUtcTimestamp,
  roundUpToQuarterHour,
  sendingDays,
} from "@/lib/format";
import { domainLimits } from "@/lib/new-domain-limit";
import { useTRPC } from "@/lib/trpc";
import { type WarmupSignalView, warmupPlanSteps, warmupReasons } from "@/lib/warmup";
import type { AppRouter } from "@/server/routers";
import { ListFooter, StateCard } from "../../emails/list-parts";
import { type BroadcastStatus, FinishCell, PacingSteps, SendingStatus } from "../parts";

type BroadcastWarmup = NonNullable<inferRouterOutputs<AppRouter>["broadcasts"]["get"]["warmup"]>;

function Microlabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="ms-microlabel" style={{ fontSize: 10.5 }}>
      {children}
    </div>
  );
}

export default function BroadcastDetailPage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations("broadcasts");
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  // Engagement is counted live from the email rows; once they age out the
  // number is gone, not zero.
  const engagement = (count: number | null) => (count == null ? "—" : nf.format(count));

  const [cancelOpen, setCancelOpen] = useState(false);

  const query = useQuery(trpc.broadcasts.get.queryOptions({ id }, { retry: false }));
  const broadcast = query.data ?? null;
  const status = broadcast?.status as BroadcastStatus | undefined;

  const cancelMutation = useMutation(
    trpc.broadcasts.cancel.mutationOptions({
      onSuccess: () => {
        setCancelOpen(false);
        queryClient.invalidateQueries(trpc.broadcasts.pathFilter());
        // Canceling flips the queued sends listed below to canceled.
        queryClient.invalidateQueries(trpc.emails.list.pathFilter());
      },
    }),
  );
  const closeCancel = useCallback(() => setCancelOpen(false), []);
  const confirmCancel = () => {
    if (!cancelMutation.isPending) cancelMutation.mutate({ id });
  };

  if (query.isError) {
    return (
      <LoadError
        error={query.error}
        headline={t("detail.error")}
        notFoundHeadline={t("detail.notFound")}
        onRetry={() => query.refetch()}
        backHref="/broadcasts"
        backLabel={t("list.title")}
      />
    );
  }

  const title = broadcast ? (broadcast.name ?? broadcast.subject) : null;
  // A send in progress: its rows so far, and the forecast for the last one.
  const progress =
    broadcast && status === "sending" && broadcast.sentCount !== null
      ? {
          sentCount: broadcast.sentCount,
          parkedCount: broadcast.parkedCount,
          recipients: broadcast.stats.total,
          finishesAt: broadcast.finishesAt,
        }
      : null;
  const finishesAt = progress?.finishesAt ?? null;
  const waiting = progress ? Math.max(0, progress.recipients - (progress.sentCount ?? 0)) : 0;

  return (
    <>
      {broadcast && status ? (
        <PageHeader
          breadcrumb={
            <>
              <Crumb href="/broadcasts" label={t("list.title")} />
              <CrumbEnd label={t("detail.eyebrow")} />
            </>
          }
          title={title ?? ""}
          actions={
            status === "draft" ? (
              <Link className="ms-btn ms-btn-secondary" href={`/broadcasts/${id}/edit`}>
                {t("detail.editDraft")}
              </Link>
            ) : status === "scheduled" || status === "sending" ? (
              <button
                type="button"
                className="ms-btn ms-btn-destructive"
                onClick={() => setCancelOpen(true)}
              >
                {t(status === "sending" ? "detail.stopRest" : "detail.cancelSend")}
              </button>
            ) : undefined
          }
        />
      ) : (
        // Mirrors the loaded PageHeader's boxes so nothing shifts on load.
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 16,
            marginBottom: 28,
          }}
        >
          <div>
            <div style={{ display: "flex", fontSize: 13, lineHeight: 1, marginBottom: 10 }}>
              <Skeleton width={150} height="1lh" />
            </div>
            <h1
              className="ms-display"
              style={{ fontSize: "var(--ms-fs-h1)", fontWeight: 600, margin: 0, display: "flex" }}
            >
              <Skeleton width={220} height="1lh" />
            </h1>
          </div>
        </div>
      )}

      <div
        className="ms-meta-grid"
        style={{
          display: "grid",
          // Targeting and From get the room; a long From wraps at its address's
          // break points inside its share instead of widening its column.
          gridTemplateColumns: "minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr) minmax(0, 2fr)",
          gap: "22px 28px",
          padding: "22px 0",
          borderTop: "1px solid var(--ms-line)",
        }}
      >
        <div>
          <Microlabel>{t("detail.status")}</Microlabel>
          {broadcast && status ? (
            <SendingStatus
              status={status}
              progress={progress}
              planHold={broadcast.planHold?.resumesAt ?? null}
              held={broadcast.held}
              warmup={broadcast.warmup?.status ?? null}
              locale={locale}
            />
          ) : (
            <div style={{ marginTop: 6 }}>
              <SkeletonBadge width={74} />
            </div>
          )}
        </div>
        <div>
          <Microlabel>{t("detail.targeting")}</Microlabel>
          <div style={{ fontSize: 14, marginTop: 6 }}>
            {broadcast ? (
              (broadcast.segmentName ?? t("composer.segmentNone"))
            ) : (
              <span style={{ display: "flex" }}>
                <Skeleton width={110} height="1lh" />
              </span>
            )}
          </div>
          {broadcast?.topicName ? (
            <div style={{ fontSize: 12.5, color: "var(--ms-muted)", marginTop: 4 }}>
              {t("detail.topic")}: {broadcast.topicName}
            </div>
          ) : null}
          {broadcast?.warmup ? (
            <div style={{ fontSize: 12.5, color: "var(--ms-muted)", marginTop: 4 }}>
              {broadcast.warmupSkipped > 0
                ? t("detail.warmupOrderSkipped", { skipped: broadcast.warmupSkipped })
                : t("detail.warmupOrder")}
            </div>
          ) : null}
        </div>
        <div>
          <Microlabel>
            {broadcast?.sentAt
              ? t("detail.sent")
              : finishesAt
                ? t("detail.finishesAbout")
                : t("detail.scheduled")}
          </Microlabel>
          {broadcast && finishesAt ? (
            <FinishCell finishesAt={finishesAt} startedAt={broadcast.startedAt} locale={locale} />
          ) : (
            <div style={{ fontSize: 13, marginTop: 7 }}>
              {broadcast ? (
                (() => {
                  const at = broadcast.sentAt ?? broadcast.scheduledAt;
                  return at ? (
                    <span title={formatUtcTimestamp(at)}>{formatDayTime(at, locale)}</span>
                  ) : (
                    <span style={{ color: "var(--ms-faint)" }}>—</span>
                  );
                })()
              ) : (
                <span style={{ display: "flex" }}>
                  <Skeleton width={140} height="1lh" />
                </span>
              )}
            </div>
          )}
        </div>
        <div className="ms-meta-wide">
          <Microlabel>{t("detail.from")}</Microlabel>
          <div style={{ marginTop: 5 }}>
            {broadcast ? (
              <CopyChip value={broadcast.from} display={<Breakable text={broadcast.from} />} wrap />
            ) : (
              <SkeletonChip width={180} />
            )}
          </div>
        </div>
      </div>

      {broadcast?.warmup ? (
        <WarmupBand
          warmup={broadcast.warmup}
          sent={broadcast.sent}
          finishesAt={finishesAt}
          locale={locale}
        />
      ) : progress && broadcast && broadcast.releases.length > 0 ? (
        <PacingBand
          sent={broadcast.sent}
          releases={broadcast.releases}
          limit={broadcast.newDomainLimit}
          locale={locale}
        />
      ) : null}

      <StatStrip style={{ marginBottom: 26 }}>
        {progress ? (
          <StatBlock
            label={t("detail.sentSoFar")}
            value={nf.format(progress.sentCount ?? 0)}
            hint={t("detail.ofTotal", { total: nf.format(progress.recipients) })}
          />
        ) : (
          <StatBlock
            label={t("detail.stats.recipients")}
            value={broadcast ? nf.format(broadcast.stats.total) : null}
          />
        )}
        <StatBlock
          label={t("detail.stats.delivered")}
          value={broadcast ? nf.format(broadcast.stats.delivered) : null}
        />
        <StatBlock
          label={t("detail.stats.opened")}
          value={broadcast ? engagement(broadcast.stats.opened) : null}
          hint={
            broadcast?.stats.prefetched
              ? t("detail.stats.prefetched", { count: nf.format(broadcast.stats.prefetched) })
              : undefined
          }
        />
        <StatBlock
          label={t("detail.stats.clicked")}
          value={broadcast ? engagement(broadcast.stats.clicked) : null}
        />
        <StatBlock
          label={t("detail.stats.bounced")}
          value={broadcast ? nf.format(broadcast.stats.bounced) : null}
        />
        <StatBlock
          label={t("detail.stats.complaints")}
          value={broadcast ? nf.format(broadcast.stats.complained) : null}
        />
        <StatBlock
          label={t("detail.stats.unsubscribed")}
          value={broadcast ? engagement(broadcast.stats.unsubscribed) : null}
        />
      </StatStrip>

      {status === "sending" || status === "sent" || status === "canceled" ? (
        <ProvidersTable broadcastId={id} />
      ) : null}

      <div className="ms-microlabel">{t("detail.content")}</div>
      <div style={{ marginTop: 12 }}>
        {broadcast ? (
          <EmailContentPanel
            email={{
              id: broadcast.id,
              subject: broadcast.subject,
              html: broadcast.html,
              text: broadcast.text,
              insights: broadcast.insights,
              hiddenBySupportView: broadcast.hiddenBySupportView,
            }}
          />
        ) : (
          <div
            style={{
              background: "var(--ms-panel)",
              border: "1px solid var(--ms-line)",
              borderRadius: 14,
              padding: 28,
              display: "flex",
              justifyContent: "center",
            }}
          >
            <Skeleton width={560} height={480} radius={8} />
          </div>
        )}
      </div>

      <BroadcastEmails broadcastId={id} />

      <Modal
        open={cancelOpen}
        onClose={closeCancel}
        onConfirm={confirmCancel}
        title={t(progress ? "detail.stopTitle" : "detail.cancelTitle")}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            confirmCancel();
          }}
        >
          <p style={{ margin: "0 0 22px", color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
            {progress
              ? t("detail.stopBody", {
                  waiting: nf.format(waiting),
                  sent: nf.format(progress.sentCount ?? 0),
                })
              : t("detail.cancelBody", { name: title ?? "—" })}
          </p>
          <ModalFooter>
            <button type="button" className="ms-btn ms-btn-secondary" onClick={closeCancel}>
              {t(progress ? "detail.keepSending" : "detail.keep")}{" "}
              <span className="ms-keycap">Esc</span>
            </button>
            <button
              type="submit"
              className="ms-btn ms-btn-destructive"
              disabled={cancelMutation.isPending}
            >
              <BtnSpinner on={cancelMutation.isPending} />
              {t(progress ? "detail.stopConfirm" : "detail.cancelConfirm")} <ConfirmKeycap />
            </button>
          </ModalFooter>
        </form>
      </Modal>
    </>
  );
}

/**
 * The pacing rail under the meta row, for a send that spans days: by its
 * sender domain's new domain limit while that paces it, else by capacity.
 */
function PacingBand({
  sent,
  releases,
  limit,
  locale,
}: {
  sent: { at: Date; count: number }[];
  releases: { at: Date; endsAt: Date; count: number }[];
  limit: { domain: string; cap: number } | null;
  locale: string;
}) {
  const t = useTranslations("broadcasts");
  if (sendingDays(sent, releases, new Date(), limit ? "utc" : "local").length < 2) return null;
  const note = limit
    ? t("guard.limitReason", {
        domain: limit.domain,
        cap: new Intl.NumberFormat(locale).format(limit.cap),
      })
    : t("guard.reason");
  return (
    <PaceBand label={t("detail.pacing")} note={note}>
      <PacingSteps sent={sent} releases={releases} locale={locale} resets={limit !== null} />
    </PaceBand>
  );
}

/**
 * The domain's warm-up while it holds rows of this send: a banner when the
 * last check held or cut the volume, or paused the warm-up, and while it
 * warms, this send's days on the rail (those it sent, today with its meter,
 * the rest of its plan).
 */
function WarmupBand({
  warmup,
  sent,
  finishesAt,
  locale,
}: {
  warmup: BroadcastWarmup;
  sent: { at: Date; count: number }[];
  finishesAt: Date | null;
  locale: string;
}) {
  const t = useTranslations("broadcasts");
  const tWarmup = useTranslations("warmup");
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const reasons = (signals: readonly WarmupSignalView[] | null) =>
    warmupReasons(signals ?? [], tWarmup, locale);
  if (warmup.status === "paused") {
    return (
      <GradientBanner
        variant="danger"
        icon={<PauseIcon />}
        title={tWarmup("row.pausedTitle")}
        action={
          <Link href={`/domains/${warmup.domainId}?tab=warmup`} style={bannerLinkStyle}>
            {t("detail.openWarmup")}
          </Link>
        }
        style={{ marginBottom: 6 }}
      >
        {t("detail.warmupPausedBody", { reasons: reasons(warmup.pauseSignals) }).trim()}
      </GradientBanner>
    );
  }
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const sentByDay = new Map<string, number>();
  for (const s of sent) {
    const day = new Date(s.at).toISOString().slice(0, 10);
    sentByDay.set(day, (sentByDay.get(day) ?? 0) + s.count);
  }
  const checked = new Map(warmup.days.map((d) => [d.day, d]));
  const steps = warmupSentSteps(
    [...sentByDay]
      .filter(([day]) => day < today)
      .map(([day, count]) => ({
        day,
        count,
        outcome: checked.get(day)?.outcome ?? null,
        signals: checked.get(day)?.signals ?? null,
      })),
    tWarmup,
    locale,
  );
  const sentToday = sentByDay.get(today) ?? 0;
  const planned = warmup.perDay[0]?.day === today ? warmup.perDay[0].count : 0;
  // Today leads the plan's rows when anything of this send goes out today.
  const ahead = warmup.perDay.filter((d) => d.count > 0 || (d.day === today && sentToday > 0));
  const finish = finishesAt ? roundUpToQuarterHour(finishesAt) : null;
  const rest = warmupPlanSteps({
    perDay: ahead,
    locale,
    t: tWarmup,
    labels: "dates",
    last: (count) =>
      finish
        ? t("guard.stepLast", { count, time: formatStepTime(finish, locale) })
        : tWarmup("rail.more", { count }),
  });
  if (ahead[0]?.day === today) {
    rest[0] = warmupTodayStep(
      {
        allowance: sentToday + planned,
        sent: sentToday,
        checked: warmup.checked,
        window: warmup.today,
      },
      tWarmup,
      locale,
    );
  }
  const latest = warmup.latest;
  return (
    <>
      {latest?.outcome === "held" || latest?.outcome === "stepped_back" ? (
        <GradientBanner
          variant="warn"
          icon={<HoldIcon />}
          title={t(latest.outcome === "held" ? "detail.warmupHeld" : "detail.warmupCut", {
            volume: nf.format(warmup.volume),
          })}
          style={{ marginBottom: 6 }}
        >
          {t("detail.warmupHeldBody", { reasons: reasons(latest.signals) }).trim()}
        </GradientBanner>
      ) : null}
      <PaceBand
        label={tWarmup("pace.label")}
        note={t("detail.warmupNote", { domain: warmup.domain ?? "" })}
      >
        <StepRail label={tWarmup("pace.label")} steps={[...steps, ...rest]} />
      </PaceBand>
    </>
  );
}

/**
 * The broadcast's sends by recipient mailbox provider. Delivered, bounced
 * and delayed are shares of what went out, complaints of what went out to
 * providers that report them (as the guardrail counts), opened and clicked
 * of what was delivered: a provider filing the mail as spam shows as a low
 * open share.
 */
function ProvidersTable({ broadcastId }: { broadcastId: string }) {
  const t = useTranslations("broadcasts");
  const common = useTranslations("common");
  const locale = useLocale();
  const trpc = useTRPC();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const query = useQuery(trpc.broadcasts.providers.queryOptions({ id: broadcastId }));
  const rows = query.data;
  // Nothing out yet: no provider to show.
  if (rows?.length === 0) return null;
  const share = (n: number, of: number) => (of > 0 ? formatPercent(n / of, locale, 1) : "—");
  const label = (
    <div className="ms-microlabel" style={{ marginBottom: 12 }}>
      {t("detail.providers.label")}
    </div>
  );
  if (query.isError) {
    return (
      <div style={{ marginBottom: 26 }}>
        {label}
        <StateCard
          tone="error"
          headline={t("detail.providers.loadError")}
          actionLabel={common("loadError.retry")}
          onAction={() => query.refetch()}
        />
      </div>
    );
  }
  return (
    <div style={{ marginBottom: 26 }}>
      {label}
      <Table className="baseline">
        <thead>
          <tr>
            <th>{t("detail.providers.provider")}</th>
            <th className="right">{t("detail.providers.sent")}</th>
            <th className="right">{t("detail.providers.delivered")}</th>
            <th className="right">{t("detail.providers.opened")}</th>
            <th className="right">{t("detail.providers.clicked")}</th>
            <th className="right">{t("detail.providers.bounced")}</th>
            <th className="right">{t("detail.providers.complained")}</th>
            <th className="right">{t("detail.providers.delayed")}</th>
          </tr>
        </thead>
        <tbody>
          {rows
            ? rows.map((row) => (
                <tr key={row.provider}>
                  <td>{t(`detail.providers.${row.provider}`)}</td>
                  <td className="right num">{nf.format(row.sent)}</td>
                  <td className="right num">{share(row.delivered, row.sent)}</td>
                  <td className="right num">{share(row.opened, row.delivered)}</td>
                  <td className="right num">{share(row.clicked, row.delivered)}</td>
                  <td className="right num">{share(row.bounced, row.sent)}</td>
                  <td className="right num">
                    {row.complaintSent > 0 ? (
                      formatPercent(row.complained / row.complaintSent, locale, 2)
                    ) : (
                      <Tooltip inline text={t("detail.providers.noComplaints")}>
                        {mutedDash}
                      </Tooltip>
                    )}
                  </td>
                  {/* The table mutes its last column; these figures read alike. */}
                  <td className="right num" style={{ color: "var(--ms-bone)" }}>
                    {share(row.delayed, row.sent)}
                  </td>
                </tr>
              ))
            : ["gmail", "microsoft", "other"].map((key) => (
                <tr key={key}>
                  <td>
                    <span style={{ display: "flex" }}>
                      <Skeleton width={72} height="1lh" />
                    </span>
                  </td>
                  {[0, 1, 2, 3, 4, 5, 6].map((cell) => (
                    <td key={cell} className="right num">
                      <span style={{ display: "flex", justifyContent: "flex-end" }}>
                        <Skeleton width={44} height="1lh" />
                      </span>
                    </td>
                  ))}
                </tr>
              ))}
        </tbody>
      </Table>
      <p style={{ margin: "8px 0 0", fontSize: 12.5, color: "var(--ms-muted)" }}>
        {t("detail.providers.note")}
      </p>
    </div>
  );
}

/** The broadcast's own sends, the emails list scoped to it, newest first. */
function BroadcastEmails({ broadcastId }: { broadcastId: string }) {
  const t = useTranslations("broadcasts");
  const emails = useTranslations("emails");
  const locale = useLocale();
  const trpc = useTRPC();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const query = useInfiniteQuery(
    trpc.emails.list.infiniteQueryOptions(
      { limit: 25, broadcastId },
      { getNextPageParam: (page) => page.nextCursor },
    ),
  );
  const domains = useQuery(trpc.domains.list.queryOptions());
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;
  if (!query.isSuccess || items.length === 0) return null;
  return (
    <div style={{ marginTop: 26 }}>
      <div className="ms-microlabel" style={{ marginBottom: 12 }}>
        {t("detail.emails")}
      </div>
      <EmailsTable rows={items} broadcastChip={false} limits={domainLimits(domains.data)} />
      <ListFooter
        left={emails("list.pageOf", {
          pages: query.data.pages.length,
          total: nf.format(total),
        })}
        singlePage={!query.hasNextPage && query.data.pages.length === 1}
        loadMore={
          query.hasNextPage
            ? {
                label: emails("list.loadMore"),
                onClick: () => query.fetchNextPage(),
                loading: query.isFetchingNextPage,
              }
            : undefined
        }
      />
    </div>
  );
}
