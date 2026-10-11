"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { Breakable } from "@/components/breakable";
import { EmptyState } from "@/components/empty-state";
import { RelativeTime } from "@/components/relative-time";
import { Skeleton, SkeletonBadge } from "@/components/skeleton";
import { Table } from "@/components/table";
import { Tooltip } from "@/components/tooltip";
import { AUTH_CHECKS, type AuthCheck, authResultTone } from "@/lib/auth-result";
import { useTRPC } from "@/lib/trpc";
import { ListFooter, StateCard } from "./list-parts";

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

function ReceivedHead() {
  const t = useTranslations("emails");
  return (
    <thead>
      <tr>
        <th style={{ width: "20%" }}>{t("detail.from")}</th>
        <th style={{ width: "20%" }}>{t("list.to")}</th>
        <th>{t("list.subject")}</th>
        <th style={{ width: 188 }}>{t("receiving.auth")}</th>
        <th className="right" style={{ width: 96 }}>
          {t("receiving.attachments")}
        </th>
        <th className="right" style={{ width: 88 }}>
          {t("receiving.received")}
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
              <Skeleton width={width} height={13} />
            </td>
            <td>
              <Skeleton width={widths[widths.length - 1 - row] ?? "50%"} height={13} />
            </td>
            <td>
              <Skeleton width={width} />
            </td>
            <td>
              <span style={{ display: "inline-flex", gap: 4 }}>
                <SkeletonBadge width={44} />
                <SkeletonBadge width={50} />
                <SkeletonBadge width={58} />
              </span>
            </td>
            <td className="right">
              <Skeleton width={12} />
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

export interface ReceivedRow {
  id: string;
  from: string;
  receivedFor: string[];
  subject: string;
  authentication: Record<AuthCheck, string>;
  attachmentCount: number;
  createdAt: Date | string;
}

/** The Receiving tab's rows: who wrote, which of the team's addresses got it, and how it checked out. */
export function ReceivedEmailsTable({ rows }: { rows: ReceivedRow[] }) {
  const t = useTranslations("emails");
  const router = useRouter();
  const locale = useLocale();
  const nf = new Intl.NumberFormat(locale);
  return (
    <Table>
      <ReceivedHead />
      <tbody>
        {rows.map((row) => {
          const href = `/emails/receiving/${row.id}`;
          return (
            <tr key={row.id} className="hoverable" onClick={() => router.push(href)}>
              <td className="ms-mono ms-cell-wrap">
                <Link href={href} onClick={(event) => event.stopPropagation()}>
                  {/* The null sender <> leaves no From address to show. */}
                  <Breakable text={row.from || "<>"} />
                </Link>
              </td>
              <td className="ms-mono ms-cell-wrap">
                <Breakable text={row.receivedFor[0] ?? ""} />
                {row.receivedFor.length > 1 ? (
                  <span style={{ color: "var(--ms-muted)", marginLeft: 8 }}>
                    +{row.receivedFor.length - 1}
                  </span>
                ) : null}
              </td>
              <td className="ms-cell-fill">
                <span
                  style={{
                    display: "block",
                    minWidth: 0,
                    maxWidth: 420,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: row.subject ? undefined : "var(--ms-muted)",
                  }}
                >
                  {row.subject || t("receiving.noSubject")}
                </span>
              </td>
              <td>
                <span style={{ display: "inline-flex", gap: 4 }}>
                  {AUTH_CHECKS.filter((check) => check !== "arc").map((check) => (
                    <AuthBadge
                      key={check}
                      check={check}
                      result={row.authentication[check]}
                      compact
                    />
                  ))}
                </span>
              </td>
              <td className="right ms-mono">
                {row.attachmentCount > 0 ? (
                  nf.format(row.attachmentCount)
                ) : (
                  <span style={{ color: "var(--ms-faint)" }}>—</span>
                )}
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

/** The Emails page's Receiving tab: received mail, newest first, keyset-paged like the sent list. */
export function ReceivedEmailsList() {
  const t = useTranslations("emails");
  const locale = useLocale();
  const trpc = useTRPC();
  const [limit, setLimit] = useState(40);
  const query = useInfiniteQuery(
    trpc.receiving.list.infiniteQueryOptions(
      { limit },
      { getNextPageParam: (page) => page.nextCursor },
    ),
  );
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;
  const nf = new Intl.NumberFormat(locale);

  if (query.isPending) return <ReceivedSkeleton />;
  if (query.isError) {
    return (
      <StateCard
        tone="error"
        headline={t("receiving.loadError")}
        actionLabel={t("list.retry")}
        onAction={() => query.refetch()}
      />
    );
  }
  if (items.length === 0) {
    return (
      <EmptyState
        area="emails"
        headline={t("receiving.empty")}
        body={t.rich("receiving.emptyHint", {
          link: (chunks) => (
            <Link href="/domains" className="ms-link">
              {chunks}
            </Link>
          ),
        })}
      />
    );
  }
  return (
    <>
      <ReceivedEmailsTable rows={items} />
      <ListFooter
        left={t("receiving.pageOf", {
          pages: query.data?.pages.length ?? 1,
          total: nf.format(total),
        })}
        size={limit}
        onSize={setLimit}
        sizeLabel={(size) => t("list.pageSize", { count: size })}
        singlePage={!query.hasNextPage && (query.data?.pages.length ?? 1) === 1}
        loadMore={
          query.hasNextPage
            ? {
                label: t("list.loadMore"),
                onClick: () => query.fetchNextPage(),
                loading: query.isFetchingNextPage,
              }
            : undefined
        }
      />
    </>
  );
}
