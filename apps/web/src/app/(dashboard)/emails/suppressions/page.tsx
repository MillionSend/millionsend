"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useDeferredValue, useMemo, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { Modal } from "@/components/modal";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { Table } from "@/components/table";
import { useTRPC } from "@/lib/trpc";
import { FilterSelect, ListFooter, ListSkeleton, SearchBox, StateCard } from "../list-parts";

const REASONS = ["hard_bounce", "complaint", "manual", "one_click_unsubscribe"] as const;
type Reason = (typeof REASONS)[number];

const REASON_VARIANT: Record<Reason, "warn" | "danger" | "neutral"> = {
  complaint: "warn",
  hard_bounce: "danger",
  manual: "neutral",
  one_click_unsubscribe: "neutral",
};

const RANGE_HOURS = { h24: 24, d7: 168, d30: 720 } as const;
type RangeKey = keyof typeof RANGE_HOURS | "all";
const RANGE_KEYS: RangeKey[] = ["all", "h24", "d7", "d30"];

export default function SuppressionsPage() {
  const t = useTranslations("emails");
  const common = useTranslations("common");
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  const [search, setSearch] = useState("");
  const [reason, setReason] = useState<Reason | "all">("all");
  const [range, setRange] = useState<RangeKey>("all");
  const [limit, setLimit] = useState(40);
  const deferredSearch = useDeferredValue(search.trim());
  const since = useMemo(
    () => (range === "all" ? undefined : new Date(Date.now() - RANGE_HOURS[range] * 3_600_000)),
    [range],
  );
  const [addOpen, setAddOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [removeTarget, setRemoveTarget] = useState<{ id: string; email: string | null } | null>(
    null,
  );

  const query = useInfiniteQuery(
    trpc.emails.suppressions.list.infiniteQueryOptions(
      {
        limit,
        ...(deferredSearch ? { search: deferredSearch } : {}),
        ...(reason !== "all" ? { reason } : {}),
        ...(since ? { since } : {}),
      },
      { getNextPageParam: (page) => page.nextCursor },
    ),
  );
  const stats = useQuery(trpc.emails.suppressions.stats.queryOptions());
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;

  const byReason = stats.data?.byReason;
  const subtitle = stats.data
    ? [
        t("suppressions.statsBlocked", { count: nf.format(stats.data.total) }),
        ...REASONS.filter((r) => (byReason?.[r] ?? 0) > 0).map((r) =>
          t(`suppressions.reasonCount.${r}`, { count: nf.format(byReason?.[r] ?? 0) }),
        ),
      ].join(" · ")
    : undefined;

  const invalidate = () => queryClient.invalidateQueries(trpc.emails.suppressions.pathFilter());

  const addMutation = useMutation(
    trpc.emails.suppressions.add.mutationOptions({
      onSuccess: () => {
        setAddOpen(false);
        setNewEmail("");
        invalidate();
      },
    }),
  );
  const removeMutation = useMutation(
    trpc.emails.suppressions.remove.mutationOptions({
      onSuccess: () => {
        setRemoveTarget(null);
        invalidate();
      },
    }),
  );

  const hasFilters = deferredSearch !== "" || reason !== "all" || range !== "all";

  function clearFilters() {
    setSearch("");
    setReason("all");
    setRange("all");
  }

  return (
    <>
      <PageHeader
        breadcrumb={
          <>
            <Crumb href="/emails" label={t("list.title")} />
            <CrumbEnd label={t("suppressions.title")} />
          </>
        }
        title={t("suppressions.title")}
        {...(subtitle ? { subtitle } : {})}
        actions={
          <>
            <a className="ms-btn ms-btn-icon" href="#emails-api" aria-label={t("list.apiDocs")}>
              {"</>"}
            </a>
            <button
              type="button"
              className="ms-btn ms-btn-primary"
              onClick={() => setAddOpen(true)}
            >
              {t("suppressions.add")}
            </button>
          </>
        }
      />

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 18 }}>
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder={t("suppressions.searchPlaceholder")}
        />
        <FilterSelect
          value={reason}
          onChange={(value) => setReason(value as Reason | "all")}
          width={120}
          ariaLabel={t("suppressions.origin")}
        >
          <option value="all">{t("suppressions.allOrigins")}</option>
          {REASONS.map((r) => (
            <option key={r} value={r}>
              {t(`suppressions.reason.${r}`)}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect
          value={range}
          onChange={(value) => setRange(value as RangeKey)}
          width={110}
          ariaLabel={t(`list.range.${range === "all" ? "all" : range}`)}
        >
          {RANGE_KEYS.map((key) => (
            <option key={key} value={key}>
              {t(`list.range.${key}`)}
            </option>
          ))}
        </FilterSelect>
      </div>

      {query.isPending ? (
        <ListSkeleton />
      ) : query.isError ? (
        <StateCard
          headline={t("suppressions.loadError")}
          actionLabel={t("suppressions.retry")}
          onAction={() => query.refetch()}
        />
      ) : items.length === 0 ? (
        hasFilters ? (
          <StateCard
            headline={t("suppressions.noMatch")}
            actionLabel={t("suppressions.clearFilters")}
            onAction={clearFilters}
          />
        ) : (
          <EmptyState headline={t("suppressions.empty")} body={t("suppressions.emptyHint")} />
        )
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <th style={{ width: "40%" }}>{t("suppressions.email")}</th>
                <th style={{ width: "18%" }}>{t("suppressions.origin")}</th>
                <th>{t("suppressions.added")}</th>
                {/* Overflow-action column — no header label. */}
                <th className="right" />
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.id}>
                  <td className="ms-mono" style={{ fontSize: 13 }}>
                    {row.email ? (
                      <Link href={`/emails/suppressions/${row.id}`}>{row.email}</Link>
                    ) : (
                      <span style={{ color: "var(--ms-faint)" }}>—</span>
                    )}
                  </td>
                  <td>
                    <span className={`ms-badge ms-badge-${REASON_VARIANT[row.reason]}`}>
                      {t(`suppressions.reason.${row.reason}`)}
                    </span>
                  </td>
                  <td style={{ color: "var(--ms-muted)" }}>
                    <RelativeTime date={row.createdAt} />
                  </td>
                  <td className="right" style={{ width: 40 }}>
                    <button
                      type="button"
                      className="ms-btn ms-btn-ghost"
                      style={{ padding: "0 4px", color: "var(--ms-faint)" }}
                      aria-label={t("suppressions.remove")}
                      onClick={() => setRemoveTarget({ id: row.id, email: row.email })}
                    >
                      …
                    </button>
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
                {t("suppressions.loadMore")}
              </button>
            </div>
          ) : null}
          <ListFooter
            left={t("suppressions.pageOf", {
              pages: query.data?.pages.length ?? 1,
              total: nf.format(total),
            })}
            size={limit}
            onSize={setLimit}
            sizeLabel={(size) => t("suppressions.pageSize", { count: size })}
          />
        </>
      )}

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title={t("suppressions.addTitle")}>
        <p style={{ margin: "0 0 18px", color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
          {t("suppressions.addBody")}
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            addMutation.mutate({ email: newEmail.trim(), reason: "manual" });
          }}
        >
          <div className="ms-field">
            <label htmlFor="suppression-email">{t("suppressions.emailLabel")}</label>
            <input
              id="suppression-email"
              className={`ms-input mono${addMutation.isError ? " error" : ""}`}
              style={{ width: "100%" }}
              placeholder={t("suppressions.emailPlaceholder")}
              value={newEmail}
              onChange={(event) => setNewEmail(event.target.value)}
            />
          </div>
          {addMutation.isError ? (
            <p
              style={{
                margin: "8px 0 0",
                color: "var(--ms-danger)",
                fontSize: "var(--ms-fs-label)",
              }}
            >
              {t("suppressions.invalidEmail")}
            </p>
          ) : null}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 22 }}>
            <button type="button" className="ms-btn ms-btn-ghost" onClick={() => setAddOpen(false)}>
              {common("cancel")}
            </button>
            <button
              type="submit"
              className="ms-btn ms-btn-primary"
              disabled={addMutation.isPending || newEmail.trim().length === 0}
            >
              {t("suppressions.addConfirm")} <span className="ms-keycap">↵</span>
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        title={t("suppressions.removeTitle")}
      >
        <p style={{ margin: "0 0 22px", color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
          {t("suppressions.removeBody", { email: removeTarget?.email ?? "—" })}
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button
            type="button"
            className="ms-btn ms-btn-ghost"
            onClick={() => setRemoveTarget(null)}
          >
            {common("cancel")}
          </button>
          <button
            type="button"
            className="ms-btn ms-btn-destructive"
            disabled={removeMutation.isPending}
            onClick={() => {
              if (removeTarget) removeMutation.mutate({ id: removeTarget.id });
            }}
          >
            {t("suppressions.removeConfirm")}
          </button>
        </div>
      </Modal>
    </>
  );
}
