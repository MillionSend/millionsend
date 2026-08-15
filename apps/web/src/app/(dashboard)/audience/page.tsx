"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { PlusGlyph } from "@/components/icons/nav-icons";
import { PageHeader } from "@/components/page-header";
import { readLastAudience, writeLastAudience } from "@/lib/last-audience";
import { useTRPC } from "@/lib/trpc";
import { AudienceTabs } from "./audience-tabs";
import { AudienceContactsView, CreateAudienceModal } from "./contacts-view";

/**
 * The Contacts tab's landing page: renders the Contacts surface of the
 * currently-selected audience (the one last viewed, else the team's first by
 * createdAt). /audience/[id] is the canonical per-audience URL; this resolves
 * to a default so the tab always has a contacts table to show.
 */
export default function AudiencePage() {
  const t = useTranslations("audience");
  const trpc = useTRPC();
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);

  const team = useQuery(trpc.team.list.queryOptions());
  const audiences = useQuery(trpc.audience.audiences.list.queryOptions());

  if (audiences.isPending || team.isPending) {
    return (
      <>
        <PageHeader title={t("list.title")} />
        <AudienceTabs />
      </>
    );
  }

  const list = audiences.data ?? [];
  if (list.length === 0) {
    const teamId = team.data?.activeTeamId ?? null;
    return (
      <>
        <PageHeader title={t("list.title")} />
        <AudienceTabs />
        <EmptyState
          area="audience"
          headline={t("list.empty")}
          body={t("list.emptyHint")}
          cta={
            <button
              type="button"
              className="ms-btn ms-btn-primary"
              onClick={() => setCreateOpen(true)}
            >
              <PlusGlyph size={14} />
              {t("list.create")}
            </button>
          }
        />
        <CreateAudienceModal
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            if (teamId) writeLastAudience(teamId, id);
            router.push(`/audience/${id}`);
          }}
        />
      </>
    );
  }

  const teamId = team.data?.activeTeamId ?? null;
  const persisted = teamId ? readLastAudience(teamId) : null;
  const earliest = [...list].sort(
    (a, b) => +new Date(a.createdAt) - +new Date(b.createdAt),
  )[0] as (typeof list)[number];
  const defaultId = persisted && list.some((a) => a.id === persisted) ? persisted : earliest.id;

  return <AudienceContactsView key={defaultId} audienceId={defaultId} />;
}
