"use client";

import { AUDIT_ACTIONS, type AuditAction } from "@millionsend/core/audit-actions";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { RelativeTime } from "@/components/relative-time";
import { Skeleton } from "@/components/skeleton";
import { Table } from "@/components/table";
import { useTRPC } from "@/lib/trpc";
import { StateCard } from "../../emails/list-parts";

const COL = { when: "16%", who: "24%", action: "28%" } as const;

const isKnownAction = (action: string): action is AuditAction =>
  (AUDIT_ACTIONS as readonly string[]).includes(action);

/** The one identifying fact the row carries, if any: a name, an address, a URL, a plan. */
function targetLabel(data: Record<string, unknown> | null, target: string | null): string {
  for (const key of ["name", "email", "url", "plan"]) {
    const value = data?.[key];
    if (typeof value === "string" && value) return value;
  }
  return target ?? "";
}

function AuditSkeleton({ headers }: { headers: [string, string, string, string] }) {
  return (
    <Table>
      <thead>
        <tr>
          <th style={{ width: COL.when }}>{headers[0]}</th>
          <th style={{ width: COL.who }}>{headers[1]}</th>
          <th style={{ width: COL.action }}>{headers[2]}</th>
          <th>{headers[3]}</th>
        </tr>
      </thead>
      <tbody>
        {["46%", "62%", "54%", "38%", "58%"].map((width, row) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows, position is identity
          <tr key={row}>
            <td>
              <Skeleton width={48} />
            </td>
            <td>
              <Skeleton width="70%" height={13} />
            </td>
            <td>
              <Skeleton width={width} height={13} />
            </td>
            <td>
              <Skeleton width="50%" height={13} />
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function AuditView() {
  const t = useTranslations("settings.audit");
  const trpc = useTRPC();
  const query = useInfiniteQuery(
    trpc.audit.list.infiniteQueryOptions(
      { limit: 40 },
      { getNextPageParam: (page) => page.nextCursor, retry: false },
    ),
  );
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const headers: [string, string, string, string] = [t("when"), t("who"), t("action"), t("target")];

  if (query.isPending) return <AuditSkeleton headers={headers} />;
  if (query.isError) {
    if (query.error.data?.code === "FORBIDDEN") {
      return (
        <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-label)" }}>
          {t("forbidden")}
        </p>
      );
    }
    return (
      <StateCard
        headline={t("loadError")}
        actionLabel={t("retry")}
        onAction={() => query.refetch()}
      />
    );
  }
  if (items.length === 0) {
    return (
      <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-label)" }}>
        {t("empty")}
      </p>
    );
  }

  return (
    <>
      <Table>
        <thead>
          <tr>
            <th style={{ width: COL.when }}>{headers[0]}</th>
            <th style={{ width: COL.who }}>{headers[1]}</th>
            <th style={{ width: COL.action }}>{headers[2]}</th>
            <th>{headers[3]}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((row) => (
            <tr key={row.id}>
              <td>
                <RelativeTime date={row.createdAt} />
              </td>
              <td>
                {row.actor.kind === "user" ? (
                  <span title={row.actor.email}>{row.actor.name ?? t("actors.deletedUser")}</span>
                ) : (
                  <span className="ms-chip">{t(`actors.${row.actor.kind}`)}</span>
                )}
              </td>
              <td>{isKnownAction(row.action) ? t(`actions.${row.action}`) : row.action}</td>
              <td
                className="ms-mono"
                title={row.target ?? undefined}
                style={{
                  fontSize: 13,
                  maxWidth: 360,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {targetLabel(row.data, row.target)}
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
            {t("loadMore")}
          </button>
        </div>
      ) : null}
    </>
  );
}
