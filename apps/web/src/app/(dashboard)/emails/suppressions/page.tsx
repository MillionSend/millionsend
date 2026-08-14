"use client";

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useDeferredValue, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { Modal } from "@/components/modal";
import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { Table } from "@/components/table";
import { useTRPC } from "@/lib/trpc";

type Reason = "hard_bounce" | "complaint" | "manual" | "one_click_unsubscribe";

const REASON_VARIANT: Record<Reason, "warn" | "danger" | "neutral"> = {
  complaint: "warn",
  hard_bounce: "danger",
  manual: "neutral",
  one_click_unsubscribe: "neutral",
};

export default function SuppressionsPage() {
  const t = useTranslations("emails");
  const common = useTranslations("common");
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const [addOpen, setAddOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [removeTarget, setRemoveTarget] = useState<{ id: string; email: string | null } | null>(
    null,
  );

  const query = useInfiniteQuery(
    trpc.emails.suppressions.list.infiniteQueryOptions(
      { limit: 25, ...(deferredSearch ? { search: deferredSearch } : {}) },
      { getNextPageParam: (page) => page.nextCursor },
    ),
  );
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  const invalidate = () =>
    queryClient.invalidateQueries(trpc.emails.suppressions.list.pathFilter());

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

  return (
    <>
      <Link href="/emails" style={{ fontSize: "var(--ms-fs-label)", color: "var(--ms-muted)" }}>
        ← {t("list.title")}
      </Link>
      <div style={{ height: 12 }} />
      <PageHeader
        title={t("suppressions.title")}
        actions={
          <button type="button" className="ms-btn ms-btn-primary" onClick={() => setAddOpen(true)}>
            {t("suppressions.add")}
          </button>
        }
      />

      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <input
          className="ms-input"
          style={{ flex: 1, maxWidth: 320 }}
          placeholder={t("suppressions.searchPlaceholder")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      {query.isPending ? (
        <p style={{ color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>{t("loading")}</p>
      ) : items.length === 0 ? (
        <EmptyState headline={t("suppressions.empty")} body={t("suppressions.emptyHint")} />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <th>{t("suppressions.email")}</th>
                <th>{t("suppressions.origin")}</th>
                <th className="right">{t("suppressions.added")}</th>
                {/* Overflow-action column — no header label. */}
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.id}>
                  <td>
                    {row.email ? (
                      <span className="ms-mono">{row.email}</span>
                    ) : (
                      <span style={{ color: "var(--ms-faint)" }}>—</span>
                    )}
                  </td>
                  <td>
                    <span className={`ms-badge ms-badge-${REASON_VARIANT[row.reason]}`}>
                      {t(`suppressions.reason.${row.reason}`)}
                    </span>
                  </td>
                  <td className="right">
                    <RelativeTime date={row.createdAt} />
                  </td>
                  <td className="right" style={{ width: 40 }}>
                    <button
                      type="button"
                      className="ms-btn ms-btn-ghost"
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
