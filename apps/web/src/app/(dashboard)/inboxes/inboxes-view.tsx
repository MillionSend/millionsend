"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { BetaPill } from "@/components/beta-pill";
import { EmptyState } from "@/components/empty-state";
import { AsteriskIcon, BotIcon, MailsIcon, UsersIcon } from "@/components/icons/mail-icons";
import { PlusGlyph } from "@/components/icons/nav-icons";
import { LEAD_GLYPH, LeadCell, SkeletonLead } from "@/components/lead-cell";
import { ListFooter } from "@/components/list-footer";
import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { Skeleton } from "@/components/skeleton";
import { StatusTile, TONE_COLOR } from "@/components/status-tile";
import { Table } from "@/components/table";
import { Tooltip } from "@/components/tooltip";
import { Truncated } from "@/components/truncated";
import { formatTimeLeft } from "@/lib/format";
import { useTRPC } from "@/lib/trpc";
import { oneOf, useUrlState } from "@/lib/url-state";
import { StateCard } from "../emails/list-parts";
import { CreateInboxDialog } from "./create-inbox-dialog";
import { kindWord } from "./parts";

const TABS = ["all", "agent", "human"] as const;
// The overview rows count 30 days, so they open the list on the same range.
const RECEIVED_30D = "/inboxes/received?range=d30";

const none = <span style={{ color: "var(--ms-faint)" }}>—</span>;

function InboxesHead() {
  const t = useTranslations("inboxes");
  return (
    <thead>
      <tr>
        {/* Room for an address however narrow the window: the other columns give theirs first. */}
        <th style={{ minWidth: 160 }}>{t("col.inbox")}</th>
        <th style={{ width: 90 }}>{t("col.type")}</th>
        <th style={{ width: "22%" }}>{t("col.attention")}</th>
        <th className="right" style={{ width: 130 }}>
          {t("col.received30d")}
        </th>
        <th className="right" style={{ width: 120 }}>
          {t("col.last")}
        </th>
      </tr>
    </thead>
  );
}

function InboxesSkeleton() {
  return (
    <Table>
      <InboxesHead />
      <tbody>
        {["62%", "48%", "56%", "40%"].map((width) => (
          <tr key={width}>
            <td>
              <SkeletonLead width={width} />
            </td>
            <td>
              <Skeleton width={48} />
            </td>
            <td>
              <Skeleton width="60%" />
            </td>
            <td className="right">
              <Skeleton width={32} />
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

export function InboxesView() {
  const t = useTranslations("inboxes");
  const locale = useLocale();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const router = useRouter();
  const trpc = useTRPC();
  const [tabParam, setTab] = useUrlState("tab", "all");
  const tab = oneOf(TABS, tabParam, "all");
  const [limit, setLimit] = useState(50);
  const [createOpen, setCreateOpen] = useState(false);
  // Stable identity: Modal's focus effect depends on onClose.
  const closeCreate = useCallback(() => setCreateOpen(false), []);
  const options = useQuery(trpc.inboxes.options.queryOptions());
  const query = useInfiniteQuery(
    trpc.inboxes.list.infiniteQueryOptions(
      { limit, ...(tab === "all" ? {} : { kind: tab }) },
      { getNextPageParam: (page) => page.nextCursor },
    ),
  );
  const first = query.data?.pages[0];
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const counts = first?.counts ?? null;
  const overview = tab === "all" ? (first?.overview ?? null) : null;
  const plan = options.data?.plan ?? null;
  const atLimit = plan?.limit != null && plan.used >= plan.limit;
  // Nowhere to receive yet: no domain receives and the instance offers no shared domain.
  const nowhere =
    options.data !== undefined &&
    options.data.domains.length === 0 &&
    options.data.sharedDomain === null;
  const sharedOnly = options.data?.domains.length === 0 ? options.data.sharedDomain : null;
  const blocked = nowhere ? t("create.needsReceiving") : atLimit ? t("limit.full") : null;

  const createButton = (
    <button
      type="button"
      className="ms-btn ms-btn-primary"
      disabled={blocked !== null}
      onClick={() => setCreateOpen(true)}
    >
      <PlusGlyph size={14} />
      {t("create.title")}
    </button>
  );
  const createAction = blocked ? (
    <Tooltip inline text={blocked}>
      {createButton}
    </Tooltip>
  ) : (
    createButton
  );

  const total = counts ? counts.agent + counts.human : null;
  const tabCount = (key: (typeof TABS)[number]) =>
    counts ? (key === "all" ? (total ?? 0) : counts[key]) : null;
  const nothing =
    items.length === 0 &&
    tab === "all" &&
    (overview === null ||
      (overview.allReceived.received30d === 0 && overview.catchAll.length === 0));

  return (
    <>
      <PageHeader title={t("title")} badges={<BetaPill />} actions={createAction} />

      {atLimit && plan?.limit != null ? (
        <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--ms-warn)" }}>
          {t.rich("limit.reached", {
            limit: nf.format(plan.limit),
            link: (chunks) => (
              <Link href="/settings/billing" className="ms-link">
                {chunks}
              </Link>
            ),
          })}
        </p>
      ) : null}

      <div className="ms-tabs bleed" role="tablist" style={{ marginBottom: 14 }}>
        {TABS.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? "active" : undefined}
            onClick={() => setTab(key)}
          >
            {t(`tabs.${key}`)}
            {tabCount(key) !== null ? (
              <span className="count">{nf.format(tabCount(key) ?? 0)}</span>
            ) : null}
          </button>
        ))}
      </div>

      {query.isPending ? (
        <InboxesSkeleton />
      ) : query.isError ? (
        <StateCard
          tone="error"
          headline={t("loadError")}
          actionLabel={t("retry")}
          onAction={() => query.refetch()}
        />
      ) : nothing ? (
        <EmptyState
          area="emails"
          headline={t("empty.title")}
          body={
            nowhere
              ? t.rich("received.emptyHint", {
                  link: (chunks) => (
                    <Link href="/domains" className="ms-link">
                      {chunks}
                    </Link>
                  ),
                })
              : sharedOnly
                ? t("empty.sharedOnly", { domain: sharedOnly })
                : t("empty.body")
          }
          cta={nowhere ? undefined : createAction}
        />
      ) : (
        <>
          <Table>
            <InboxesHead />
            <tbody>
              {overview ? (
                <tr className="hoverable" onClick={() => router.push(RECEIVED_30D)}>
                  <LeadCell
                    tile={
                      <StatusTile color={TONE_COLOR.neutral} label={t("received.title")}>
                        <MailsIcon {...LEAD_GLYPH} />
                      </StatusTile>
                    }
                    value={t("received.title")}
                    href={RECEIVED_30D}
                    tail={t("received.hintShort")}
                  />
                  <td>{none}</td>
                  <td>{none}</td>
                  <td className="right ms-digits">{nf.format(overview.allReceived.received30d)}</td>
                  <td className="right" style={{ whiteSpace: "nowrap" }}>
                    {overview.allReceived.lastReceived ? (
                      <RelativeTime date={overview.allReceived.lastReceived} />
                    ) : (
                      none
                    )}
                  </td>
                </tr>
              ) : null}
              {overview?.catchAll.map((domain) => {
                const href = `${RECEIVED_30D}&inbox=catch_all`;
                return (
                  <tr key={domain.domainId} className="hoverable" onClick={() => router.push(href)}>
                    <LeadCell
                      tile={
                        <StatusTile color={TONE_COLOR.neutral} label={t("type.catchAll")}>
                          <AsteriskIcon {...LEAD_GLYPH} />
                        </StatusTile>
                      }
                      value={`*@${domain.name}`}
                      href={href}
                      mono
                      tail={t("catchAll.row")}
                      action={
                        <>
                          {"· "}
                          <Tooltip inline focusableChild text={t("catchAll.turnOff")}>
                            <Link
                              href={`/domains/${domain.domainId}`}
                              onClick={(event) => event.stopPropagation()}
                            >
                              {t("catchAll.turnOffLink")}
                            </Link>
                          </Tooltip>
                        </>
                      }
                    />
                    <td>{t("type.catchAll")}</td>
                    <td>{none}</td>
                    <td className="right ms-digits">{nf.format(domain.received30d)}</td>
                    <td className="right" style={{ whiteSpace: "nowrap" }}>
                      {domain.lastReceived ? <RelativeTime date={domain.lastReceived} /> : none}
                    </td>
                  </tr>
                );
              })}
              {items.map((inbox) => {
                const href = `/inboxes/${inbox.id}`;
                const attention = [
                  ...(inbox.pending_approval > 0
                    ? [t("attention.drafts", { count: inbox.pending_approval })]
                    : []),
                  // An agent's unread mail is its own queue, not a person's to-do.
                  ...(inbox.kind === "human" && inbox.unread > 0
                    ? [t("attention.unread", { count: inbox.unread })]
                    : []),
                  ...(inbox.quarantined > 0
                    ? [t("attention.quarantined", { count: nf.format(inbox.quarantined) })]
                    : []),
                ];
                const detail = [
                  ...(inbox.name ? [inbox.name] : []),
                  ...(inbox.expires_at
                    ? [
                        t("expiresIn", {
                          time: formatTimeLeft(Date.parse(inbox.expires_at) - Date.now()),
                        }),
                      ]
                    : []),
                  ...(inbox.forward_to[0]
                    ? [t("forwardsTo", { address: inbox.forward_to[0] })]
                    : []),
                ];
                return (
                  <tr key={inbox.id} className="hoverable" onClick={() => router.push(href)}>
                    <LeadCell
                      tile={
                        <StatusTile
                          color={TONE_COLOR.neutral}
                          label={t(inbox.kind === "human" ? "type.human" : "type.agent")}
                        >
                          {inbox.kind === "human" ? (
                            <UsersIcon {...LEAD_GLYPH} />
                          ) : (
                            <BotIcon {...LEAD_GLYPH} />
                          )}
                        </StatusTile>
                      }
                      value={inbox.email_address}
                      href={href}
                      mono
                      tail={detail.join(" · ")}
                    />
                    <td>{kindWord(t, inbox.kind)}</td>
                    {/* One line that ends in an ellipsis inside its own share of the row. */}
                    <td
                      className="ms-cell-fill"
                      style={attention.length > 0 ? { color: "var(--ms-bone)" } : undefined}
                    >
                      {attention.length > 0 ? <Truncated text={attention.join(" · ")} /> : none}
                    </td>
                    <td className="right ms-digits">{nf.format(inbox.received_30d)}</td>
                    <td className="right" style={{ whiteSpace: "nowrap" }}>
                      {inbox.last_received ? <RelativeTime date={inbox.last_received} /> : none}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <ListFooter
            {...(plan?.limit != null
              ? {
                  left: t("planUsage", {
                    used: nf.format(plan.used),
                    limit: nf.format(plan.limit),
                  }),
                }
              : total !== null
                ? { left: t("total", { count: total }) }
                : {})}
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
      )}

      {options.data ? (
        <CreateInboxDialog
          open={createOpen}
          onClose={closeCreate}
          domains={options.data.domains}
          sharedDomain={options.data.sharedDomain}
        />
      ) : null}
    </>
  );
}
