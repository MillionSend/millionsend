"use client";

import { AUDIT_ACTIONS, type AuditAction } from "@millionsend/core/audit-actions";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { RelativeTime } from "@/components/relative-time";
import { Skeleton } from "@/components/skeleton";
import { Table } from "@/components/table";
import { Tooltip } from "@/components/tooltip";
import { Truncated } from "@/components/truncated";
import { useTRPC } from "@/lib/trpc";
import { ListFooter, StateCard } from "../../emails/list-parts";

const COL = { when: "16%", who: "24%", action: "28%" } as const;

const isKnownAction = (action: string): action is AuditAction =>
  (AUDIT_ACTIONS as readonly string[]).includes(action);

/** The one identifying fact the row carries, if any: a name, an address, a URL, a plan. */
function targetLabel(data: Record<string, unknown> | null, target: string | null): string {
  for (const key of ["name", "email", "url", "plan", "reference"]) {
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
        tone="error"
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
              <td className="ms-cell-fill">
                {row.actor.kind !== "user" ? (
                  <span className="ms-chip">{t(`actors.${row.actor.kind}`)}</span>
                ) : row.actor.name && row.actor.email ? (
                  // The address shows on hover even when the name is whole.
                  <Tooltip
                    inline
                    triggerClassName="ms-truncate-host"
                    text={`${row.actor.name}\n${row.actor.email}`}
                  >
                    <span className="ms-truncate">{row.actor.name}</span>
                  </Tooltip>
                ) : (
                  <Truncated text={row.actor.name ?? t("actors.deletedUser")} />
                )}
              </td>
              {/* next-intl reads "." as nesting, so the catalogue keys carry "_" in its place. */}
              <td className="ms-cell-fill">
                <Truncated
                  text={
                    isKnownAction(row.action)
                      ? t(`actions.${row.action.replace(".", "_")}`)
                      : row.action
                  }
                />
              </td>
              <td className="ms-cell-fill ms-mono" style={{ fontSize: 13 }}>
                <Truncated text={targetLabel(row.data, row.target)} />
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {query.hasNextPage ? (
        <ListFooter
          loadMore={{
            label: t("loadMore"),
            onClick: () => query.fetchNextPage(),
            loading: query.isFetchingNextPage,
          }}
        />
      ) : null}
    </>
  );
}
