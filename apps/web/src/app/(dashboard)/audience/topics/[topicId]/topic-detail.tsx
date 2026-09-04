"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { ContactAvatar } from "@/components/contact-avatar";
import { CopyChip } from "@/components/copy-chip";
import { LoadError } from "@/components/load-error";
import { MetaItem } from "@/components/meta-item";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { PopoverMenu } from "@/components/popover-menu";
import { RelativeTime } from "@/components/relative-time";
import { Select } from "@/components/select";
import { Skeleton, SkeletonBadge } from "@/components/skeleton";
import { Table } from "@/components/table";
import { useTRPC } from "@/lib/trpc";
import { useCopied } from "@/lib/use-copied";
import { ListFooter, StateCard } from "../../../emails/list-parts";
import { TopicDeleteModal, TopicEditModal, type TopicEditTarget } from "../topic-modals";

function ContactsHead() {
  const t = useTranslations("audience.contacts");
  return (
    <thead>
      <tr>
        <th style={{ width: "55%" }}>{t("email")}</th>
        <th style={{ width: "20%" }}>{t("status")}</th>
        <th className="right">{t("added")}</th>
      </tr>
    </thead>
  );
}

/** Mirrors the loaded contacts table: avatar + mono email, badge, time. */
function ContactsSkeleton() {
  const widths = ["58%", "42%", "66%"];
  return (
    <Table>
      <ContactsHead />
      <tbody>
        {widths.map((width) => (
          <tr key={width}>
            <td>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Skeleton width={24} height={24} radius="50%" />
                <Skeleton width={width} height={13} />
              </span>
            </td>
            <td>
              <SkeletonBadge width={82} />
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

export function TopicDetail({ id }: { id: string }) {
  const t = useTranslations("audience.topics");
  const tAud = useTranslations("audience");
  const tabs = useTranslations("audience.tabs");
  const common = useTranslations("common");
  const locale = useLocale();
  const trpc = useTRPC();
  const router = useRouter();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const { copied, copy } = useCopied();

  const [editTarget, setEditTarget] = useState<TopicEditTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [subFilter, setSubFilter] = useState<"" | "in" | "out">("");
  const [limit, setLimit] = useState(25);

  const query = useQuery(trpc.topics.get.queryOptions({ id }, { retry: false }));
  const contacts = useInfiniteQuery(
    trpc.topics.contacts.infiniteQueryOptions(
      { topicId: id, limit, ...(subFilter ? { subscribed: subFilter === "in" } : {}) },
      { getNextPageParam: (page) => page.nextCursor },
    ),
  );
  const items = contacts.data?.pages.flatMap((page) => page.items) ?? [];
  const total = contacts.data?.pages[0]?.total ?? 0;

  // Stable identities: Modal's focus effect depends on onClose.
  const closeEdit = useCallback(() => setEditTarget(null), []);
  const closeDelete = useCallback(() => setDeleteTarget(null), []);

  if (query.isError) {
    return (
      <LoadError
        error={query.error}
        headline={t("detail.error")}
        notFoundHeadline={t("detail.notFound")}
        onRetry={() => query.refetch()}
        backHref="/audience/topics"
        backLabel={tabs("topics")}
      />
    );
  }

  if (!query.isSuccess) {
    // Mirrors the loaded page's containers (breadcrumb + H1, meta strip) so
    // nothing shifts when data lands.
    return (
      <>
        <div style={{ marginBottom: 28 }}>
          <div style={{ display: "flex", fontSize: 13, lineHeight: 1, marginBottom: 10 }}>
            <Skeleton width={140} height="1lh" />
          </div>
          <h1
            className="ms-display"
            style={{ fontSize: "var(--ms-fs-h1)", margin: 0, display: "flex" }}
          >
            <Skeleton width={280} height="1lh" />
          </h1>
        </div>
        <div
          className="ms-meta-grid"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
            gap: 28,
            padding: "20px 0",
            borderTop: "1px solid var(--ms-line)",
            borderBottom: "1px solid var(--ms-line)",
          }}
        >
          <MetaItem label={t("detail.id")}>
            <Skeleton width={220} height={14} />
          </MetaItem>
          <MetaItem label={t("defaultLabel")}>
            <SkeletonBadge width={58} />
          </MetaItem>
          <MetaItem label={t("visibility")}>
            <Skeleton width={60} height={14} />
          </MetaItem>
          <MetaItem label={t("created")}>
            <Skeleton width={110} height={14} />
          </MetaItem>
        </div>
      </>
    );
  }

  const data = query.data;

  return (
    <>
      <PageHeader
        title={data.name}
        breadcrumb={
          <>
            <Crumb href="/audience/topics" label={tabs("topics")} />
            <CrumbEnd label={t("detail.eyebrow")} />
          </>
        }
        actions={
          <>
            {copied ? (
              <span style={{ color: "var(--ms-muted)", fontSize: 12.5 }}>✓ {common("copied")}</span>
            ) : null}
            <button
              type="button"
              className="ms-btn ms-btn-secondary"
              onClick={() =>
                setEditTarget({
                  id: data.id,
                  name: data.name,
                  description: data.description ?? "",
                  visibility: data.visibility,
                  defaultSubscribed: data.defaultSubscribed,
                })
              }
            >
              {t("editTitle")}
            </button>
            <PopoverMenu
              boxed
              ariaLabel={t("detail.moreActions")}
              items={[
                { label: t("copyId"), onSelect: () => copy(data.id) },
                null,
                {
                  label: t("delete"),
                  danger: true,
                  onSelect: () => setDeleteTarget({ id: data.id, name: data.name }),
                },
              ]}
            />
          </>
        }
      />

      <div
        className="ms-meta-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gap: 28,
          padding: "20px 0",
          borderTop: "1px solid var(--ms-line)",
          borderBottom: "1px solid var(--ms-line)",
        }}
      >
        <MetaItem label={t("detail.id")}>
          <CopyChip value={data.id} />
        </MetaItem>
        <MetaItem label={t("defaultLabel")}>
          <span
            className={`ms-badge ${data.defaultSubscribed ? "ms-badge-success" : "ms-badge-neutral"}`}
          >
            {data.defaultSubscribed ? t("optIn") : t("optOut")}
          </span>
        </MetaItem>
        <MetaItem label={t("visibility")}>
          {data.visibility === "public" ? t("visibilityPublic") : t("visibilityPrivate")}
        </MetaItem>
        <MetaItem label={t("created")}>
          <RelativeTime date={data.createdAt} />
        </MetaItem>
      </div>

      {data.description ? (
        <div style={{ padding: "20px 0", borderBottom: "1px solid var(--ms-line)" }}>
          <p className="ms-microlabel" style={{ margin: 0, fontSize: 10.5 }}>
            {t("detail.description")}
          </p>
          <p style={{ margin: "8px 0 0", fontSize: 14, color: "var(--ms-bone)" }}>
            {data.description}
          </p>
        </div>
      ) : null}

      <section style={{ marginTop: 26 }}>
        <div
          className="ms-filter-row"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            marginBottom: 14,
          }}
        >
          <p className="ms-microlabel" style={{ margin: 0 }}>
            {t("detail.contacts")}
          </p>
          <Select
            value={subFilter}
            onChange={(value) => setSubFilter(value === "in" || value === "out" ? value : "")}
            ariaLabel={t("detail.subscriptionFilter")}
            width={180}
            options={[
              { value: "", label: tAud("filters.allContacts") },
              { value: "in", label: tAud("contacts.subscribed") },
              { value: "out", label: tAud("contacts.unsubscribedBadge") },
            ]}
          />
        </div>

        {contacts.isPending ? (
          <ContactsSkeleton />
        ) : contacts.isError ? (
          <StateCard
            tone="error"
            headline={tAud("contacts.loadError")}
            actionLabel={tAud("contacts.retry")}
            onAction={() => contacts.refetch()}
          />
        ) : items.length === 0 ? (
          subFilter ? (
            <StateCard
              headline={t("detail.noMatch")}
              actionLabel={t("detail.clearFilter")}
              onAction={() => setSubFilter("")}
            />
          ) : (
            <p style={{ margin: 0, fontSize: 14, color: "var(--ms-muted)" }}>{t("detail.empty")}</p>
          )
        ) : (
          <>
            <Table>
              <ContactsHead />
              <tbody>
                {items.map((row) => {
                  const name = [row.firstName, row.lastName].filter(Boolean).join(" ");
                  const detailHref = `/audience/contacts/${row.id}`;
                  return (
                    <tr key={row.id} className="hoverable" onClick={() => router.push(detailHref)}>
                      <td>
                        <span
                          style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}
                        >
                          <ContactAvatar email={row.email} name={name} size={24} />
                          <Link
                            className="ms-mono"
                            style={{ fontSize: 13, flexShrink: 0 }}
                            href={detailHref}
                            onClick={(event) => event.stopPropagation()}
                          >
                            {row.email}
                          </Link>
                          {name ? (
                            <span
                              style={{
                                color: "var(--ms-muted)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {name}
                            </span>
                          ) : null}
                        </span>
                      </td>
                      <td>
                        <span
                          className={`ms-badge ${row.subscribed ? "ms-badge-success" : "ms-badge-neutral"}`}
                        >
                          {row.subscribed
                            ? tAud("contacts.subscribed")
                            : tAud("contacts.unsubscribedBadge")}
                        </span>
                      </td>
                      <td className="right" style={{ color: "var(--ms-muted)" }}>
                        <RelativeTime date={row.createdAt} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            <ListFooter
              left={tAud("contacts.pageOf", {
                pages: contacts.data?.pages.length ?? 1,
                total: nf.format(total),
              })}
              size={limit}
              onSize={setLimit}
              sizeLabel={(size) => tAud("contacts.pageSize", { count: size })}
              singlePage={!contacts.hasNextPage && (contacts.data?.pages.length ?? 1) === 1}
              loadMore={
                contacts.hasNextPage
                  ? {
                      label: tAud("contacts.loadMore"),
                      onClick: () => contacts.fetchNextPage(),
                      loading: contacts.isFetchingNextPage,
                    }
                  : undefined
              }
            />
          </>
        )}
      </section>

      <TopicEditModal target={editTarget} onClose={closeEdit} />
      <TopicDeleteModal
        target={deleteTarget}
        onClose={closeDelete}
        onDeleted={() => router.push("/audience/topics")}
      />
    </>
  );
}
