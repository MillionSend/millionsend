"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { BetaPill } from "@/components/beta-pill";
import { confirmDialog } from "@/components/confirm-dialog";
import { LoadError } from "@/components/load-error";
import { NoticeStrip } from "@/components/notice-strip";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { PopoverMenu } from "@/components/popover-menu";
import { Skeleton } from "@/components/skeleton";
import { toast } from "@/components/toast";
import { formatTimeLeft } from "@/lib/format";
import { useTRPC } from "@/lib/trpc";
import { oneOf, useUrlState } from "@/lib/url-state";
import { useTeamRole } from "@/lib/use-team-role";
import { kindWord } from "../parts";
import { ActivityTab } from "./activity-tab";
import { EditDialog } from "./edit-dialog";
import { ReviewTab } from "./review-tab";
import { SafetyTab } from "./safety-tab";
import { SendDialog } from "./send-dialog";
import { ThreadsTab } from "./threads-tab";

const TABS = ["threads", "review", "safety", "activity"] as const;

export function InboxView() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations("inboxes");
  const locale = useLocale();
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const role = useTeamRole();
  const admin = role === "owner" || role === "admin";
  const [tabParam, setTab] = useUrlState("tab", "threads");
  const tab = oneOf(TABS, tabParam, "threads");
  const [sending, setSending] = useState(false);
  const closeSend = useCallback(() => setSending(false), []);
  const [editing, setEditing] = useState(false);
  const closeEdit = useCallback(() => setEditing(false), []);
  const query = useQuery(trpc.inboxes.get.queryOptions({ id }, { retry: false }));
  const remove = useMutation(
    trpc.inboxes.delete.mutationOptions({
      onSuccess: () => {
        // Dropped, not invalidated: a stale list would paint the deleted inbox until its refetch landed.
        queryClient.removeQueries(trpc.inboxes.list.pathFilter());
        void queryClient.invalidateQueries(trpc.inboxes.options.pathFilter());
        router.push("/inboxes");
      },
      onError: () => toast(t("deleteError"), "danger"),
    }),
  );

  if (query.isPending) {
    return (
      <div style={{ marginBottom: 28 }}>
        <Skeleton width={150} height={13} />
        <div style={{ marginTop: 12 }}>
          <Skeleton width={320} height={30} />
        </div>
      </div>
    );
  }
  if (query.isError || !query.data) {
    return (
      <LoadError
        error={query.error}
        headline={t("loadError")}
        notFoundHeadline={t("notFound")}
        onRetry={() => query.refetch()}
        backHref="/inboxes"
        backLabel={t("title")}
      />
    );
  }
  const inbox = query.data;
  const nf = new Intl.NumberFormat(locale);
  const channels = [
    ...(inbox.channels.webhook ? [t("channel.webhook")] : []),
    ...(inbox.channels.key ? [t("channel.key")] : []),
  ].join(" + ");
  const subtitle = [
    t("summary", { kind: kindWord(t, inbox.kind), count: nf.format(inbox.received_30d) }),
    ...(channels ? [channels] : []),
    ...(inbox.expires_at && !inbox.expired
      ? [t("expiresIn", { time: formatTimeLeft(Date.parse(inbox.expires_at) - Date.now()) })]
      : []),
  ].join(" · ");
  const review = inbox.pending_approval + inbox.quarantined;

  return (
    <>
      <PageHeader
        breadcrumb={
          <>
            <Crumb href="/inboxes" label={t("title")} />
            <CrumbEnd label={inbox.name || t("inbox")} />
          </>
        }
        title={inbox.email_address}
        badges={<BetaPill />}
        subtitle={subtitle}
        actions={
          <button
            type="button"
            className="ms-btn ms-btn-primary"
            disabled={inbox.expired}
            onClick={() => setSending(true)}
          >
            {t("sendEmail")}
          </button>
        }
        menu={
          <PopoverMenu
            boxed
            ariaLabel={t("more")}
            items={[
              { label: t("edit.title"), disabled: inbox.expired, onSelect: () => setEditing(true) },
              ...(admin
                ? [
                    null,
                    {
                      label: t("delete"),
                      danger: true,
                      onSelect: async () => {
                        const ok = await confirmDialog({
                          title: t("delete"),
                          message: t("deleteConfirm", { address: inbox.email_address }),
                          confirmLabel: t("delete"),
                          danger: true,
                        });
                        if (ok) remove.mutate({ id: inbox.id });
                      },
                    },
                  ]
                : []),
            ]}
          />
        }
      />

      {inbox.expired ? <NoticeStrip tone="warn" text={t("expired")} /> : null}

      <div className="ms-tabs bleed" role="tablist" style={{ marginBottom: 18 }}>
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
            {key === "review" && review > 0 ? (
              <span className="count">{nf.format(review)}</span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === "threads" ? (
        <ThreadsTab inbox={inbox} />
      ) : tab === "review" ? (
        <ReviewTab inbox={inbox} />
      ) : tab === "safety" ? (
        <SafetyTab inbox={inbox} admin={admin} />
      ) : (
        <ActivityTab inboxId={inbox.id} />
      )}

      <SendDialog
        open={sending}
        onClose={closeSend}
        inboxId={inbox.id}
        from={inbox.email_address}
      />
      <EditDialog inbox={inbox} open={editing} onClose={closeEdit} />
    </>
  );
}
