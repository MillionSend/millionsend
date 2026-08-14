"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useDeferredValue, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { StatusBadge } from "@/components/status-badge";
import { Table } from "@/components/table";
import { useTRPC } from "@/lib/trpc";
import { EnvelopeTile } from "./envelope-tile";

// Keep in enum order (packages/db schema.emailStatusEnum) — the router input
// rejects anything outside it at typecheck time.
const STATUSES = [
  "queued_quota",
  "queued",
  "sent",
  "delivery_delayed",
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
  "suppressed",
  "failed",
] as const;

type EmailStatus = (typeof STATUSES)[number];

export default function EmailsPage() {
  const t = useTranslations("emails");
  const common = useTranslations("common");
  const trpc = useTRPC();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<EmailStatus | "all">("all");
  const deferredSearch = useDeferredValue(search.trim());

  const query = useInfiniteQuery(
    trpc.emails.list.infiniteQueryOptions(
      {
        limit: 25,
        ...(status !== "all" ? { status } : {}),
        ...(deferredSearch ? { search: deferredSearch } : {}),
      },
      { getNextPageParam: (page) => page.nextCursor },
    ),
  );
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <>
      <PageHeader
        title={t("list.title")}
        actions={
          <>
            <Link className="ms-btn ms-btn-secondary" href="/emails/suppressions">
              {t("list.suppressionList")}
            </Link>
            <a className="ms-btn ms-btn-icon" href="#emails-api" aria-label={t("list.apiDocs")}>
              {"</>"}
            </a>
          </>
        }
      />

      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <input
          className="ms-input"
          style={{ flex: 1, maxWidth: 320 }}
          placeholder={t("list.searchPlaceholder")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          className="ms-input"
          value={status}
          onChange={(event) => setStatus(event.target.value as EmailStatus | "all")}
        >
          <option value="all">{t("list.allStatuses")}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {common(`status.${s}`)}
            </option>
          ))}
        </select>
      </div>

      {query.isPending ? (
        <p style={{ color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>{t("loading")}</p>
      ) : items.length === 0 ? (
        <EmptyState headline={t("list.empty")} body={t("list.emptyHint")} />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <th>{t("list.to")}</th>
                <th>{t("list.status")}</th>
                <th>{t("list.subject")}</th>
                <th className="right">{t("list.sent")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.id}>
                  <td>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                      <EnvelopeTile status={row.latestStatus} />
                      <Link className="ms-mono" href={`/emails/${row.id}`}>
                        {row.to[0] ?? row.subject}
                      </Link>
                      {row.to.length > 1 ? (
                        <span className="ms-mono" style={{ color: "var(--ms-muted)" }}>
                          +{row.to.length - 1}
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td>
                    <StatusBadge status={row.latestStatus} />
                  </td>
                  <td>{row.subject}</td>
                  <td className="right">
                    <RelativeTime date={row.createdAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          {query.hasNextPage ? (
            <div style={{ marginTop: 16 }}>
              <button
                type="button"
                className="ms-btn ms-btn-secondary"
                onClick={() => query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
              >
                {t("list.loadMore")}
              </button>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
