"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useDeferredValue, useMemo, useState } from "react";
import { EnvelopeGlyph } from "@/components/email-status-icon";
import { EmptyState } from "@/components/empty-state";
import {
  BugIcon,
  ClockIcon,
  LockIcon,
  PaperclipIcon,
  ShieldAlertIcon,
  ShieldHalfIcon,
  SpamIcon,
} from "@/components/icons/mail-icons";
import { LEAD_GLYPH, LeadCell, SkeletonLead } from "@/components/lead-cell";
import { RelativeTime } from "@/components/relative-time";
import { Select } from "@/components/select";
import { Skeleton } from "@/components/skeleton";
import { StatusTile, TONE_COLOR } from "@/components/status-tile";
import { Table } from "@/components/table";
import { Tooltip } from "@/components/tooltip";
import { Truncated } from "@/components/truncated";
import { type AuthCheck, authResultTone } from "@/lib/auth-result";
import { type RangeKey, rangeSince } from "@/lib/list-range";
import { isUuid } from "@/lib/log-body-links";
import {
  RECEIVED_STATE_TONE,
  type ReceivedState,
  type ReceivedVerdicts,
  receivedState,
} from "@/lib/received-state";
import { useTRPC } from "@/lib/trpc";
import { oneOf, useUrlState } from "@/lib/url-state";
import { ListFooter, SearchBox, StateCard } from "../../emails/list-parts";

const GLYPH = { success: "✓", danger: "✗", warn: "!", neutral: "–", info: "–" } as const;

/** One verdict as a badge: the check, then its result as a word, or as a glyph in a list row. */
export function AuthBadge({
  check,
  result,
  compact = false,
}: {
  check: AuthCheck;
  result: string;
  compact?: boolean;
}) {
  const tone = authResultTone(result);
  const name = check.toUpperCase();
  if (!compact) {
    return (
      <span className={`ms-badge ms-badge-${tone}`}>
        {name} <span className="ms-mono">{result}</span>
      </span>
    );
  }
  return (
    <Tooltip inline text={`${name} ${result}`}>
      <span role="img" aria-label={`${name} ${result}`} className={`ms-badge ms-badge-${tone}`}>
        {name} {GLYPH[tone]}
      </span>
    </Tooltip>
  );
}

const RANGE_KEYS: RangeKey[] = ["h24", "d7", "d15", "d30", "all"];
const VERDICTS = ["clean", "suspicious", "quarantined", "spam", "virus"] as const;

/** Per row state: the From tile's glyph and tooltip, and the subject's badge; clean mail carries none. */
const STATE_VIEW: Record<
  ReceivedState,
  { glyph: React.ReactNode; tip: string; badge: string | null }
> = {
  virus: {
    glyph: <BugIcon {...LEAD_GLYPH} />,
    tip: "received.verdict.virus",
    badge: "received.badge.virus",
  },
  quarantined: {
    glyph: <LockIcon {...LEAD_GLYPH} />,
    tip: "received.verdict.quarantined",
    badge: "received.badge.quarantined",
  },
  screening: {
    glyph: <ClockIcon {...LEAD_GLYPH} />,
    tip: "received.verdict.screening",
    badge: "received.badge.screening",
  },
  spam: {
    glyph: <SpamIcon {...LEAD_GLYPH} />,
    tip: "received.verdict.spam",
    badge: "received.badge.spam",
  },
  suspicious: {
    glyph: <ShieldAlertIcon {...LEAD_GLYPH} />,
    tip: "received.verdict.suspicious",
    badge: "received.verdict.suspicious",
  },
  unscanned: {
    glyph: <ShieldHalfIcon {...LEAD_GLYPH} />,
    tip: "virus.processing_failed",
    badge: "virus.none",
  },
  clean: { glyph: <EnvelopeGlyph />, tip: "received.verdict.clean", badge: null },
};

function ReceivedHead() {
  const t = useTranslations("inboxes");
  return (
    <thead>
      <tr>
        <th style={{ width: "24%" }}>{t("received.col.from")}</th>
        <th style={{ width: "24%" }}>{t("col.inbox")}</th>
        <th>{t("received.col.subject")}</th>
        <th className="right" style={{ width: 96 }}>
          {t("received.col.received")}
        </th>
      </tr>
    </thead>
  );
}

/** Loading stand-in with the loaded table's header and column shapes. No spinners on lists. */
function ReceivedSkeleton() {
  const widths = ["58%", "42%", "66%", "50%", "38%", "62%", "46%", "54%"];
  return (
    <Table>
      <ReceivedHead />
      <tbody>
        {widths.map((width, row) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows, position is identity
          <tr key={row}>
            <td>
              <SkeletonLead width={width} />
            </td>
            <td>
              <Skeleton width={widths[widths.length - 1 - row] ?? "50%"} height={13} />
            </td>
            <td>
              <Skeleton width={width} />
            </td>
            <td className="right">
              <Skeleton width={48} />
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export interface ReceivedRow extends ReceivedVerdicts {
  id: string;
  from: string;
  fromName: string;
  receivedFor: string[];
  subject: string;
  attachmentCount: number;
  extractedKinds: ("code" | "link")[];
  createdAt: Date | string;
}

/** Received mail rows: who wrote, which address got it, what it is about and how it was judged. */
export function ReceivedEmailsTable({ rows }: { rows: ReceivedRow[] }) {
  const t = useTranslations("inboxes");
  const router = useRouter();
  const locale = useLocale();
  const nf = new Intl.NumberFormat(locale);
  return (
    <Table>
      <ReceivedHead />
      <tbody>
        {rows.map((row) => {
          const href = `/inboxes/received/${row.id}`;
          const state = receivedState(row);
          const view = STATE_VIEW[state];
          const tone = RECEIVED_STATE_TONE[state];
          const attachments = t("detail.attachmentCount", { count: row.attachmentCount });
          return (
            <tr key={row.id} className="hoverable" onClick={() => router.push(href)}>
              <LeadCell
                tile={
                  <StatusTile color={TONE_COLOR[tone]} label={t(view.tip)}>
                    {view.glyph}
                  </StatusTile>
                }
                // The null sender <> leaves no From address to show.
                value={row.from || "<>"}
                href={href}
                mono
              />
              <LeadCell value={row.receivedFor[0] ?? ""} more={row.receivedFor.slice(1)} mono />
              <td className="ms-cell-fill">
                <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <span
                    style={{
                      minWidth: 0,
                      maxWidth: 420,
                      color: row.subject ? undefined : "var(--ms-muted)",
                    }}
                  >
                    <Truncated text={row.subject || t("noSubject")} />
                  </span>
                  {row.attachmentCount > 0 ? (
                    <Tooltip inline text={attachments}>
                      <span
                        role="img"
                        aria-label={attachments}
                        className="ms-mono"
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 3,
                          color: "var(--ms-muted)",
                          fontSize: 12,
                        }}
                      >
                        <PaperclipIcon size={12} strokeWidth={2} />
                        {nf.format(row.attachmentCount)}
                      </span>
                    </Tooltip>
                  ) : null}
                  {/* Kinds only: a code's value shows on the email's own page, never in a list. */}
                  {row.extractedKinds.map((kind) => (
                    <Tooltip key={kind} inline text={t(`chip.${kind}Tip`)}>
                      <span className="ms-chip" style={{ fontSize: 10.5, padding: "1px 7px" }}>
                        {t(`chip.${kind}`)}
                      </span>
                    </Tooltip>
                  ))}
                  {view.badge ? (
                    <span className={`ms-badge ms-badge-${tone}`}>{t(view.badge)}</span>
                  ) : null}
                </span>
              </td>
              <td className="right" style={{ whiteSpace: "nowrap" }}>
                <RelativeTime date={row.createdAt} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

/** All received: every email the team's domains took, newest first, keyset-paged like the sent list. */
export function ReceivedEmailsList() {
  const t = useTranslations("inboxes");
  const locale = useLocale();
  const trpc = useTRPC();
  const [search, setSearch] = useUrlState("q");
  const [rangeParam, setRange] = useUrlState("range", "d15");
  const [inbox, setInbox] = useUrlState("inbox", "all");
  const [verdictParam, setVerdict] = useUrlState("verdict", "all");
  const range: RangeKey = oneOf(RANGE_KEYS, rangeParam, "d15");
  const verdict = oneOf(VERDICTS, verdictParam, "all");
  const deferredSearch = useDeferredValue(search.trim());
  const since = useMemo(() => rangeSince(range), [range]);
  const [limit, setLimit] = useState(40);
  const inboxes = useQuery(trpc.inboxes.list.queryOptions({ limit: 100 }));
  const inboxFilter = inbox === "catch_all" || isUuid(inbox) ? inbox : null;
  const query = useInfiniteQuery(
    trpc.receiving.list.infiniteQueryOptions(
      {
        limit,
        ...(deferredSearch ? { search: deferredSearch } : {}),
        ...(since ? { since } : {}),
        ...(inboxFilter ? { inbox: inboxFilter } : {}),
        ...(verdict !== "all" ? { verdict } : {}),
      },
      { getNextPageParam: (page) => page.nextCursor },
    ),
  );
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;
  const nf = new Intl.NumberFormat(locale);
  const filtered = deferredSearch !== "" || inboxFilter !== null || verdict !== "all";

  const filters = (
    <div
      className="ms-filter-row"
      style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 18 }}
    >
      <SearchBox value={search} onChange={setSearch} placeholder={t("received.search")} />
      <Select
        value={range}
        onChange={setRange}
        width={160}
        ariaLabel={t(`received.range.${range}`)}
        options={RANGE_KEYS.map((key) => ({ value: key, label: t(`received.range.${key}`) }))}
      />
      <Select
        value={inboxFilter ?? "all"}
        onChange={setInbox}
        width={240}
        ariaLabel={t("received.filter.allInboxes")}
        options={[
          { value: "all", label: t("received.filter.allInboxes") },
          { value: "catch_all", label: t("received.filter.catchAllOnly") },
          ...(inboxes.data?.items ?? []).map((i) => ({ value: i.id, label: i.email_address })),
        ]}
      />
      <Select
        value={verdict}
        onChange={setVerdict}
        width={170}
        ariaLabel={t("received.filter.allVerdicts")}
        options={[
          { value: "all", label: t("received.filter.allVerdicts") },
          ...VERDICTS.map((value) => ({ value, label: t(`received.verdict.${value}`) })),
        ]}
      />
    </div>
  );

  let body: React.ReactNode;
  if (query.isPending) body = <ReceivedSkeleton />;
  else if (query.isError) {
    body = (
      <StateCard
        tone="error"
        headline={t("received.loadError")}
        actionLabel={t("retry")}
        onAction={() => query.refetch()}
      />
    );
  } else if (items.length === 0) {
    body = filtered ? (
      <StateCard
        headline={t("received.noMatch")}
        actionLabel={t("received.clearFilters")}
        onAction={() => {
          setSearch("");
          setInbox("all");
          setVerdict("all");
        }}
      />
    ) : (
      <EmptyState
        area="emails"
        headline={t("received.empty")}
        body={t.rich("received.emptyHint", {
          link: (chunks) => (
            <Link href="/domains" className="ms-link">
              {chunks}
            </Link>
          ),
        })}
      />
    );
  } else {
    body = (
      <>
        <ReceivedEmailsTable rows={items} />
        <ListFooter
          left={t("received.pageOf", {
            pages: query.data?.pages.length ?? 1,
            total: nf.format(total),
          })}
          size={limit}
          onSize={setLimit}
          sizeLabel={(size) => t("pageSize", { count: size })}
          singlePage={!query.hasNextPage && (query.data?.pages.length ?? 1) === 1}
          loadMore={
            query.hasNextPage
              ? {
                  label: t("loadMore"),
                  onClick: () => query.fetchNextPage(),
                  loading: query.isFetchingNextPage,
                }
              : undefined
          }
        />
      </>
    );
  }
  return (
    <>
      {filters}
      {body}
    </>
  );
}
