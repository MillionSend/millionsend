"use client";

import { AUDIT_ACTIONS, type AuditAction } from "@millionsend/core/audit-actions";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useMemo } from "react";
import { ListFooter } from "@/components/list-footer";
import { RelativeTime } from "@/components/relative-time";
import { Skeleton } from "@/components/skeleton";
import { Table } from "@/components/table";
import { Tooltip } from "@/components/tooltip";
import { useTRPC } from "@/lib/trpc";
import { auditDetail } from "./detail";

const COL = { when: "10%", actor: "16%", action: "24%", target: "16%", ip: "10%" } as const;

const isKnownAction = (action: string): action is AuditAction =>
  (AUDIT_ACTIONS as readonly string[]).includes(action);

/** The catalogue keys carry "_" where the action has "." (next-intl reads "." as nesting). */
export function useActionLabel() {
  const t = useTranslations("settings");
  return (action: string) =>
    isKnownAction(action) ? t(`audit.actions.${action.replace(".", "_")}`) : action;
}

export function useAuditQuery(action: string, limit: number) {
  const trpc = useTRPC();
  return useInfiniteQuery(
    trpc.console.audit.list.infiniteQueryOptions(
      { limit, ...(action === "all" ? {} : { action }) },
      { getNextPageParam: (page) => page.nextCursor },
    ),
  );
}

function Head() {
  const t = useTranslations("console.audit.columns");
  return (
    <thead>
      <tr>
        <th style={{ width: COL.when }}>{t("when")}</th>
        <th style={{ width: COL.actor }}>{t("actor")}</th>
        <th style={{ width: COL.action }}>{t("action")}</th>
        <th style={{ width: COL.target }}>{t("target")}</th>
        <th>{t("detail")}</th>
        <th style={{ width: COL.ip }}>{t("ip")}</th>
      </tr>
    </thead>
  );
}

function AuditSkeleton() {
  return (
    <Table className="nowrap">
      <Head />
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
              <Skeleton width="60%" height={13} />
            </td>
            <td>
              <Skeleton width={width} height={13} />
            </td>
            <td>
              <Skeleton width="80%" height={13} />
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function AuditView({
  query,
  limit,
  onLimit,
}: {
  query: ReturnType<typeof useAuditQuery>;
  limit: number;
  onLimit: (size: number) => void;
}) {
  const t = useTranslations("console.audit");
  const common = useTranslations("console.common");
  const locale = useLocale();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const actionLabel = useActionLabel();
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const total = query.data?.pages[0]?.total ?? items.length;
  const bool = (value: boolean) => common(value ? "yes" : "no");

  if (query.isError) {
    return (
      <div className="ms-card ms-state">
        <span className="ms-state-glyph" aria-hidden="true">
          !
        </span>
        <p className="ms-state-headline">{common("loadError")}</p>
        <div className="ms-state-actions">
          <button type="button" className="ms-btn ms-btn-secondary" onClick={() => query.refetch()}>
            {common("retry")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ms-card" style={{ padding: 0 }}>
      {query.isPending ? (
        <AuditSkeleton />
      ) : items.length === 0 ? (
        <p
          style={{
            margin: 0,
            padding: 24,
            color: "var(--ms-muted)",
            fontSize: "var(--ms-fs-label)",
          }}
        >
          {t("empty")}
        </p>
      ) : (
        <Table className="nowrap">
          <Head />
          <tbody>
            {items.map((row) => {
              const detail = auditDetail(row.data, bool);
              return (
                <tr key={row.id}>
                  <td style={{ color: "var(--ms-muted)", whiteSpace: "nowrap" }}>
                    <RelativeTime date={row.createdAt} />
                  </td>
                  <td>
                    {row.actor.kind === "user" ? (
                      row.actor.email ? (
                        <Tooltip inline text={row.actor.email}>
                          {row.actor.name ?? row.actor.email}
                        </Tooltip>
                      ) : (
                        <span style={{ color: "var(--ms-muted)" }}>{t("actors.deletedUser")}</span>
                      )
                    ) : (
                      <span className="ms-chip">{t(`actors.${row.actor.kind}`)}</span>
                    )}
                  </td>
                  <td>
                    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                      {actionLabel(row.action)}
                      <span className="ms-chip">{row.action}</span>
                    </span>
                  </td>
                  <td>
                    {row.teamName ? (
                      row.teamName
                    ) : row.teamId === null ? (
                      <span style={{ color: "var(--ms-muted)" }}>{t("instance")}</span>
                    ) : (
                      <span className="ms-mono" style={{ fontSize: 13 }}>
                        {row.target ?? common("none")}
                      </span>
                    )}
                  </td>
                  <td style={{ color: "var(--ms-muted)", fontSize: 13 }}>
                    {detail || common("none")}
                  </td>
                  <td className="ms-mono" style={{ fontSize: 13, whiteSpace: "nowrap" }}>
                    {row.ip ?? common("none")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {query.isSuccess && items.length > 0 ? (
        <div style={{ padding: "0 16px 14px" }}>
          <ListFooter
            left={t("count", { shown: nf.format(items.length), total: nf.format(total) })}
            size={limit}
            onSize={onLimit}
            sizeLabel={(size) => common("perPage", { n: size })}
            singlePage={!query.hasNextPage && query.data.pages.length === 1}
            loadMore={
              query.hasNextPage
                ? {
                    label: common("loadMore"),
                    onClick: () => query.fetchNextPage(),
                    loading: query.isFetchingNextPage,
                  }
                : undefined
            }
          />
        </div>
      ) : null}
    </div>
  );
}
